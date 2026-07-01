const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

function getYtDlpBin() {
  const local = path.join(__dirname, 'yt-dlp.exe');
  if (fs.existsSync(local)) return local;
  return process.env.YTDLP_BIN || 'yt-dlp';
}

function getFfmpegBin() {
  const local = path.join(__dirname, 'ffmpeg.exe');
  if (fs.existsSync(local)) return local;
  return process.env.FFMPEG_BIN || 'ffmpeg';
}

function isHLS(url) {
  return /\.m3u8/i.test(url) || url.includes('/hls/');
}

function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    ['list','index','start_radio','pp','si','feature','ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return raw; }
}

// ── DIAGNÓSTICO ──────────────────────────────────────────────
app.get('/test', (req, res) => {
  const ytdlp = getYtDlpBin();
  const args  = ['--version'];
  let out = '', err = '';
  const proc = spawn(ytdlp, args, { stdio: ['ignore','pipe','pipe'] });
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    res.json({ ytdlp, ffmpeg: getFfmpegBin(), version: out.trim(), code, err: err.trim() });
  });
});

// ── INFO ─────────────────────────────────────────────────────
app.post('/info', (req, res) => {
  const url = cleanUrl(req.body.url || '');
  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  if (isHLS(url)) {
    return res.json({ title: 'Stream HLS', thumbnail: null, duration: null });
  }

  const args = ['--dump-json', '--no-playlist', '--no-warnings', url];
  let out = '', err = '';
  const proc = spawn(getYtDlpBin(), args, { stdio: ['ignore','pipe','pipe'] });
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    if (code !== 0 || !out.trim()) {
      const msg = err.split('\n').filter(l => l && !l.startsWith('[debug]') && !l.startsWith('WARNING'))[0] || 'Erro ao buscar vídeo.';
      return res.status(400).json({ error: msg.trim() });
    }
    try {
      const info = JSON.parse(out.trim().split('\n')[0]);
      res.json({ title: info.title, thumbnail: info.thumbnail, duration: info.duration });
    } catch {
      res.status(500).json({ error: 'Falha ao processar resposta.' });
    }
  });
});

// ── DOWNLOAD ─────────────────────────────────────────────────
app.post('/download', (req, res) => {
  const url      = cleanUrl(req.body.url || '');
  const format   = req.body.format || 'bestvideo[height<=1080]+bestaudio/best';
  const audioOnly = !!req.body.audioOnly;

  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const jobId = uuidv4();

  if (isHLS(url) && !audioOnly) {
    runFfmpeg(url, jobId, send, res, format);
  } else {
    runYtDlp(url, format, audioOnly, jobId, send, res);
  }
});

function runFfmpeg(url, jobId, send, res, format) {
  const outFile   = path.join(DOWNLOADS_DIR, `${jobId}.mp4`);
  const ffmpegBin = getFfmpegBin();
  const args = [
    '-nostdin', '-y',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36',
    '-i', url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
    outFile,
  ];

  console.log('[ffmpeg] iniciando HLS download');
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore','pipe','pipe'] });
  let log = '', totalSecs = 0;

  const hb = setInterval(() => {
    try {
      if (!fs.existsSync(outFile)) return;
      const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
      if (parseFloat(mb) > 0) send({ type:'progress', percent:-1, status:`Baixando... ${mb} MB`, speed:null, eta:null });
    } catch {}
  }, 2000);

  proc.stderr.on('data', d => {
    const t = d.toString(); log += t;
    const dm = /Duration:\s+(\d+):(\d+):(\d+)/.exec(t);
    if (dm && !totalSecs) totalSecs = +dm[1]*3600 + +dm[2]*60 + +dm[3];
    const tm = /time=(\d+):(\d+):(\d+)/.exec(t);
    if (tm && totalSecs) {
      const cur = +tm[1]*3600 + +tm[2]*60 + +tm[3];
      send({ type:'progress', percent: Math.min(99, Math.round(cur/totalSecs*100)), status:'Baixando...', speed:null, eta:null });
    }
  });

  proc.on('close', code => {
    clearInterval(hb);
    if (code !== 0 || !fs.existsSync(outFile)) {
      console.log('[ffmpeg falhou] fallback yt-dlp');
      send({ type:'progress', percent:0, status:'Tentando método alternativo...', speed:null, eta:null });
      runYtDlp(url, format || 'bestvideo[height<=1080]+bestaudio/best', false, jobId, send, res);
      return;
    }
    finish(outFile, send, res);
  });

  req_cleanup(res, proc);
}

function runYtDlp(url, format, audioOnly, jobId, send, res) {
  const ext    = audioOnly ? '%(ext)s' : 'mp4';
  const outTpl = path.join(DOWNLOADS_DIR, `${jobId}_%(epoch)s.${ext}`);
  const bin    = getYtDlpBin();

  const cookiesFile = path.join(__dirname, 'cookies.txt');
  const args = [
    '--no-playlist',
    '--newline',
    '--force-overwrites',
    '--ffmpeg-location', getFfmpegBin(),
    '--concurrent-fragments', '4',
    '-o', outTpl,
  ];

  // Usa cookies se disponível (para vídeos com restrição de idade)
  if (fs.existsSync(cookiesFile)) {
    args.push('--cookies', cookiesFile);
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', format);
    args.push('--merge-output-format', 'mp4');
    // Converte áudio para AAC para garantir compatibilidade com mp4
    args.push('--postprocessor-args', 'ffmpeg:-c:a aac');
  }
  args.push(url);

  console.log('[yt-dlp] formato:', format, '| audioOnly:', audioOnly);
  console.log('[yt-dlp] args:', args.join(' '));

  const proc = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] });
  let filename = null, errLog = '';

  const rePct  = /(\d+\.?\d*)%/;
  const reSpd  = /(\d+\.?\d*\s*[KMGkmg]i?B\/s)/;
  const reEta  = /ETA\s+([\d:]+)/;
  const reDest = /Destination:\s+(.+)/;
  const reFrag = /frag\s+(\d+)\/(\d+)/i;
  const reAlready = /already been downloaded/;

  const hb = setInterval(() => {
    try {
      const f = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
      if (!f.length) return;
      const mb = (fs.statSync(path.join(DOWNLOADS_DIR, f[0])).size / 1048576).toFixed(1);
      if (parseFloat(mb) > 0) send({ type:'progress', percent:-1, status:`Baixando... ${mb} MB`, speed:null, eta:null });
    } catch {}
  }, 3000);

  function parse(line) {
    if (!line.trim()) return;
    const dm = reDest.exec(line);
    if (dm) filename = dm[1].trim();

    if (reAlready.test(line) && filename) {
      clearInterval(hb); finish(filename, send, res); proc.kill(); return;
    }

    const pm = rePct.exec(line);
    if (pm) {
      send({ type:'progress', percent: parseFloat(pm[1]), status:'Baixando...',
        speed: (reSpd.exec(line)||[])[1]||null, eta: (reEta.exec(line)||[])[1]||null });
      return;
    }

    const fm = reFrag.exec(line);
    if (fm) {
      const [,c,t] = fm;
      send({ type:'progress', percent: Math.round(+c/+t*100), status:`Fragmento ${c}/${t}`, speed:null, eta:null });
    }
  }

  proc.stdout.on('data', d => d.toString().split('\n').forEach(parse));
  proc.stderr.on('data', d => {
    const t = d.toString(); errLog += t;
    t.split('\n').forEach(l => { if(l) console.error('[yt-dlp stderr]', l); parse(l); });
  });

  proc.on('close', code => {
    clearInterval(hb);
    if (code !== 0) {
      const msg = errLog.split('\n').filter(l => l && !l.startsWith('[debug]') && !l.startsWith('WARNING') && !l.startsWith('[youtube]')).pop() || 'Falha no download.';
      send({ type:'error', message: msg.trim() });
      return res.end();
    }

    if (!filename || !fs.existsSync(filename)) {
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => f.startsWith(jobId))
        .map(f => path.join(DOWNLOADS_DIR, f))
        .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      filename = files[0];
    }

    if (!filename || !fs.existsSync(filename)) {
      send({ type:'error', message:'Arquivo não encontrado após download.' });
      return res.end();
    }

    finish(filename, send, res);
  });
}

function finish(filePath, send, res) {
  const basename = path.basename(filePath);
  send({ type:'done', filename: basename, url:`/files/${encodeURIComponent(basename)}` });
  res.end();
  setTimeout(() => { try { fs.unlinkSync(filePath); } catch {} }, 10*60*1000);
}

function req_cleanup(res, proc) {
  res.on('close', () => { try { proc.kill(); } catch {} });
}

// ── ARQUIVOS ─────────────────────────────────────────────────
app.use('/files', (req, res, next) => {
  const file = path.join(DOWNLOADS_DIR, decodeURIComponent(path.basename(req.path)));
  if (fs.existsSync(file)) return res.download(file);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Limpeza a cada 1h
setInterval(() => {
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < Date.now() - 3600000) fs.unlinkSync(fp); } catch {}
    });
  } catch {}
}, 3600000);

app.listen(PORT, () => {
  console.log(`\n🟢 VidDrop rodando em http://localhost:${PORT}`);
  console.log(`📁 Downloads: ${DOWNLOADS_DIR}`);
  console.log(`🔧 yt-dlp:   ${getYtDlpBin()}`);
  console.log(`🎞  ffmpeg:   ${getFfmpegBin()}\n`);
});
