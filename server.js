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

function sanitizeFilename(name) {
  if (!name || name === 'Stream HLS') return 'video';
  return name
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'video';
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


// ── EXTRACT (pega m3u8 e título de uma URL de página) ────────
app.post('/extract', async (req, res) => {
  const pageUrl = req.body.url || '';
  if (!pageUrl) return res.status(400).json({ error: 'URL obrigatória.' });

  const https = require('https');
  const http  = require('http');

  function fetchHtml(url, redirectCount) {
    redirectCount = redirectCount || 0;
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) return reject(new Error('Muitos redirecionamentos'));
      const client = url.startsWith('https') ? https : http;
      const parsed = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'identity',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        }
      };
      const req2 = client.get(options, r => {
        if ([301,302,303,307,308].includes(r.statusCode) && r.headers.location) {
          const next = r.headers.location.startsWith('http')
            ? r.headers.location
            : parsed.origin + r.headers.location;
          r.resume();
          return resolve(fetchHtml(next, redirectCount + 1));
        }
        if (r.statusCode >= 400) {
          r.resume();
          return reject(new Error('Página não encontrada (HTTP ' + r.statusCode + '). Verifique se o link está correto.'));
        }
        let data = '';
        r.on('data', d => data += d);
        r.on('end', () => resolve(data));
      });
      req2.on('error', reject);
      req2.setTimeout(15000, () => { req2.destroy(); reject(new Error('Timeout ao carregar a página.')); });
    });
  }

  try {
    const html = await fetchHtml(pageUrl);

    // Extrai título
    let title = '';
    const ogMatch = /property="og:title"s+content="([^"]+)"/i.exec(html)
                 || /content="([^"]+)"s+property="og:title"/i.exec(html);
    const titleMatch = /\<title[^>]*\>([^<]+)<\/title>/i.exec(html);
    if (ogMatch) title = ogMatch[1];
    else if (titleMatch) title = titleMatch[1];
    title = title.replace(/ [-–|] [^-–|]+$/, '').trim();

    // Extrai UUID do vazounudes
    const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(html);
    if (uuidMatch) {
      const uuid = uuidMatch[0];
      const m3u8 = 'https://vazounudes.net/hls/' + uuid + '/480p/video.m3u8';
      console.log('[extract] UUID:', uuid, '| Título:', title);
      return res.json({ m3u8, title: title || 'video', uuid });
    }

    // Tenta m3u8 direto no HTML
    const m3u8Match = /https?:\/\/[^\s"']+\.m3u8[^\s"']*/i.exec(html);
    if (m3u8Match) {
      return res.json({ m3u8: m3u8Match[0], title: title || 'video' });
    }

    // Tenta iframe src
    const iframeMatch = /iframe[^>]+src="([^"]+)"/i.exec(html);
    if (iframeMatch) {
      console.log('[extract] iframe encontrado:', iframeMatch[1]);
      return res.status(400).json({ error: 'Vídeo em iframe externo — cole o link m3u8 diretamente.' });
    }

    return res.status(400).json({ error: 'Não foi possível encontrar o vídeo nesta página.' });

  } catch (err) {
    console.error('[extract]', err.message);
    res.status(500).json({ error: err.message });
  }
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
  const url       = cleanUrl(req.body.url || '');
  const format    = req.body.format || 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';
  const audioOnly = !!req.body.audioOnly;
  const title     = req.body.title || '';

  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send  = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const jobId = uuidv4();

  if (isHLS(url) && !audioOnly) {
    runFfmpegHLS(url, jobId, send, res, req);
  } else {
    runYtDlp(url, format, audioOnly, jobId, send, res);
  }
});

// ── HLS via ffmpeg (salva em disco, serve depois) ─────────────
function runFfmpegHLS(url, jobId, send, res, req) {
  const outFile   = path.join(DOWNLOADS_DIR, `${jobId}_${Date.now()}.mp4`);
  const ffmpegBin = getFfmpegBin();

  const args = [
    '-nostdin', '-y',
    '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36',
    '-headers', 'Accept: */*\r\nAccept-Language: pt-BR,pt;q=0.9\r\n',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-thread_queue_size', '4096',
    '-i', url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-bufsize', '8M',
    outFile,
  ];

  console.log(`[ffmpeg HLS] iniciando job ${jobId.slice(0,8)}`);
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let totalSecs = 0;
  let lastPct   = 0;

  // Heartbeat — mostra MB em disco enquanto ffmpeg trabalha
  const hb = setInterval(() => {
    try {
      if (!fs.existsSync(outFile)) return;
      const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
      if (parseFloat(mb) > 0) {
        send({ type: 'progress', percent: lastPct, status: `Baixando... ${mb} MB`, speed: null, eta: null });
      }
    } catch {}
  }, 3000);

  proc.stderr.on('data', chunk => {
    const text = chunk.toString();

    // Pega duração total
    const dm = /Duration:\s+(\d+):(\d+):(\d+)/.exec(text);
    if (dm && !totalSecs) {
      totalSecs = +dm[1]*3600 + +dm[2]*60 + +dm[3];
    }

    // Progresso por tempo
    const tm = /time=(\d+):(\d+):(\d+)/.exec(text);
    if (tm && totalSecs > 0) {
      const cur = +tm[1]*3600 + +tm[2]*60 + +tm[3];
      lastPct = Math.min(99, Math.round((cur / totalSecs) * 100));
      const remaining = totalSecs - cur;
      const eta = remaining > 0 ? `${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}` : null;
      send({ type: 'progress', percent: lastPct, status: 'Baixando...', speed: null, eta });
    }
  });

  proc.on('close', code => {
    clearInterval(hb);

    if (code !== 0 || !fs.existsSync(outFile)) {
      // Fallback para yt-dlp se ffmpeg falhar
      console.log('[ffmpeg HLS] falhou, tentando yt-dlp...');
      send({ type: 'progress', percent: 0, status: 'Tentando método alternativo...', speed: null, eta: null });
      runYtDlp(url.replace(/\?.*/, ''), 'b', false, jobId, send, res);
      return;
    }

    const basename = path.basename(outFile);
    const title    = sanitizeFilename(req.body.title);
    const newName  = path.join(DOWNLOADS_DIR, `${title}_${jobId.slice(0,6)}.mp4`);
    try { fs.renameSync(outFile, newName); } catch {}
    const finalName = fs.existsSync(newName) ? path.basename(newName) : basename;
    send({ type: 'done', filename: finalName, url: `/files/${encodeURIComponent(finalName)}` });
    res.end();
    const cleanPath = fs.existsSync(newName) ? newName : outFile;
    setTimeout(() => { try { fs.unlinkSync(cleanPath); } catch {} }, 10*60*1000);
  });

  res.on('close', () => { clearInterval(hb); try { proc.kill('SIGTERM'); } catch {} });
}

// ── yt-dlp (para não-HLS) ─────────────────────────────────────
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

  console.log(`[yt-dlp] job ${jobId.slice(0,8)} formato: ${format}`);

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

    const basename  = path.basename(filename);
    const ytTitle   = sanitizeFilename(title);
    const ext2      = path.extname(basename) || '.mp4';
    const newName2  = path.join(DOWNLOADS_DIR, `${ytTitle}_${jobId.slice(0,6)}${ext2}`);
    try { fs.renameSync(filename, newName2); } catch {}
    const finalName2 = fs.existsSync(newName2) ? path.basename(newName2) : basename;
    send({ type:'done', filename: finalName2, url:`/files/${encodeURIComponent(finalName2)}` });
    res.end();
    const cleanPath2 = fs.existsSync(newName2) ? newName2 : filename;
    setTimeout(() => { try { fs.unlinkSync(cleanPath2); } catch {} }, 10*60*1000);
  });
}

// ── ARQUIVOS ─────────────────────────────────────────────────
app.use('/files', (req, res, next) => {
  const file = path.join(DOWNLOADS_DIR, decodeURIComponent(path.basename(req.path)));
  if (fs.existsSync(file)) return res.download(file);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

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

// ── TRATAMENTO DE ERROS GLOBAIS ──────────────────────────────
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err.message);
  // Não deixa o servidor morrer por erro não tratado
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
