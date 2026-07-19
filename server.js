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
  let out = '', err = '';
  const proc = spawn(ytdlp, ['--version'], { stdio: ['ignore','pipe','pipe'] });
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

// ── STREAM HLS → MP4 (pipe direto, sem salvar em disco) ──────
// ffmpeg lê o m3u8 e faz pipe do MP4 direto para o browser
// Cada request é independente — múltiplos simultâneos funcionam
app.get('/stream', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL obrigatória');

  const ffmpeg = getFfmpegBin();
  const args = [
    '-nostdin',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36',
    '-i', url,
    '-c', 'copy',           // sem re-encode — rápido, leve
    '-movflags', 'frag_keyframe+empty_moov+faststart',  // MP4 streamável
    '-f', 'mp4',
    'pipe:1',               // output direto para stdout
  ];

  console.log(`[stream] iniciando HLS pipe: ${url.slice(0, 60)}...`);

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="video_${Date.now()}.mp4"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  proc.stdout.pipe(res);

  proc.stderr.on('data', d => {
    // Só loga erros relevantes, não o progresso normal do ffmpeg
    const line = d.toString();
    if (line.includes('Error') || line.includes('error')) {
      console.error('[stream ffmpeg]', line.trim());
    }
  });

  proc.on('close', code => {
    console.log(`[stream] finalizado com código ${code}`);
    if (!res.headersSent) res.end();
  });

  // Se o cliente cancelar, mata o ffmpeg
  req.on('close', () => {
    try { proc.kill('SIGTERM'); } catch {}
  });
});

// ── DOWNLOAD (para não-HLS via yt-dlp) ───────────────────────
app.post('/download', (req, res) => {
  const url       = cleanUrl(req.body.url || '');
  const format    = req.body.format || 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';
  const audioOnly = !!req.body.audioOnly;

  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  // HLS → redireciona para o stream pipe
  if (isHLS(url) && !audioOnly) {
    return res.json({ 
      type: 'stream',
      streamUrl: `/stream?url=${encodeURIComponent(url)}` 
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send  = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const jobId = uuidv4();

  runYtDlp(url, format, audioOnly, jobId, send, res);
});

function runYtDlp(url, format, audioOnly, jobId, send, res) {
  const ext    = audioOnly ? '%(ext)s' : 'mp4';
  const outTpl = path.join(DOWNLOADS_DIR, `${jobId}_%(epoch)s.${ext}`);
  const bin    = getYtDlpBin();

  const cookiesFile = path.join(__dirname, 'cookies.txt');
  const args = [
    '--no-playlist', '--newline', '--force-overwrites',
    '--concurrent-fragments', '4',
    '-o', outTpl,
  ];

  if (fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', format);
    args.push('--merge-output-format', 'mp4');
  }
  args.push(url);

  const proc = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] });
  res.on('close', () => { try { proc.kill(); } catch {} });

  let filename = null, errLog = '';
  const rePct  = /(\d+\.?\d*)%/;
  const reSpd  = /(\d+\.?\d*\s*[KMGkmg]i?B\/s)/;
  const reEta  = /ETA\s+([\d:]+)/;
  const reDest = /Destination:\s+(.+)/;
  const reFrag = /frag\s+(\d+)\/(\d+)/i;

  const hb = setInterval(() => {
    try {
      const f = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId));
      if (!f.length) return;
      const mb = (fs.statSync(path.join(DOWNLOADS_DIR, f[0])).size / 1048576).toFixed(1);
      if (parseFloat(mb) > 0) send({ type:'progress', percent:-1, status:`Baixando... ${mb} MB`, speed:null, eta:null });
    } catch {}
  }, 6000);

  function parse(line) {
    if (!line.trim()) return;
    const dm = reDest.exec(line);
    if (dm) filename = dm[1].trim();
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
  proc.stderr.on('data', d => { const t = d.toString(); errLog += t; t.split('\n').forEach(parse); });

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

    const basename = path.basename(filename);
    send({ type:'done', filename: basename, url:`/files/${encodeURIComponent(basename)}` });
    res.end();
    setTimeout(() => { try { fs.unlinkSync(filename); } catch {} }, 10*60*1000);
  });
}

// ── ARQUIVOS ─────────────────────────────────────────────────
app.use('/files', (req, res, next) => {
  const file = path.join(DOWNLOADS_DIR, decodeURIComponent(path.basename(req.path)));
  if (fs.existsSync(file)) return res.download(file);
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

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
  console.log(`🎞  ffmpeg:  ${getFfmpegBin()}\n`);
});
