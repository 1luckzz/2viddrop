const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { spawn, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { segundosParaCortar, cortarInicio } = require('./video/trim');

const app  = express();
const PORT = process.env.PORT || 3000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Teto de segurança: um m3u8 de transmissão ao vivo (ou que nunca fecha) faz o
// downloader escrever pra sempre e encher o disco do servidor. Nada no caminho
// de download tinha limite antes disto.
const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES) || 4 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_MS    = Number(process.env.MAX_DOWNLOAD_MS)    || 60 * 60 * 1000;

// Soma o que o job já escreveu (HLS gera vários arquivos por job).
function bytesDoJob(jobId) {
  try {
    return fs.readdirSync(DOWNLOADS_DIR)
      .filter(n => n.startsWith(jobId))
      .reduce((total, n) => {
        try { return total + fs.statSync(path.join(DOWNLOADS_DIR, n)).size; } catch { return total; }
      }, 0);
  } catch { return 0; }
}

function formatarTeto(bytes) {
  return bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(bytes % 1073741824 ? 1 : 0)} GB`
    : `${Math.round(bytes / 1048576)} MB`;
}

function formatarTempo(ms) {
  const min = ms / 60000;
  return min >= 1 ? `${Math.round(min)} minutos` : `${Math.round(ms / 1000)} segundos`;
}

function motivoDoLimite(bytes, inicio) {
  if (bytes > MAX_DOWNLOAD_BYTES) {
    return `Esse vídeo passou de ${formatarTeto(MAX_DOWNLOAD_BYTES)} e foi interrompido. `
         + 'Pode ser uma transmissão ao vivo, que não tem fim.';
  }
  if (Date.now() - inicio > MAX_DOWNLOAD_MS) {
    return `O download passou de ${formatarTempo(MAX_DOWNLOAD_MS)} e foi interrompido. `
         + 'Pode ser uma transmissão ao vivo, que não tem fim.';
  }
  return null;
}

// ── JOBS ATIVOS (pra permitir cancelar downloads em andamento) ─
const activeJobs = new Map(); // jobId -> { proc, cancelled }

function varrerArquivosDoJob(jobId) {
  try {
    fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(jobId)).forEach(f => {
      try { fs.unlinkSync(path.join(DOWNLOADS_DIR, f)); } catch {}
    });
  } catch {}
}

function cleanupJobFiles(jobId) {
  varrerArquivosDoJob(jobId);
  // killProcessTree é assíncrono (taskkill no Windows, SIGTERM no Linux) e os
  // fragmentos concorrentes seguem gravando por alguns instantes — sem estas
  // passadas extras sobra lixo no disco, que é justamente o que queremos evitar.
  setTimeout(() => varrerArquivosDoJob(jobId), 3000).unref();
  setTimeout(() => varrerArquivosDoJob(jobId), 12000).unref();
}

// proc.kill() só derruba o processo direto — mas o yt-dlp.exe (empacotado com
// PyInstaller) no Windows sobe um processo filho pra fazer o download de
// verdade, que fica orfão e continua rodando se só matarmos o pai. taskkill
// /T mata a árvore inteira.
function killProcessTree(proc) {
  if (!proc || !proc.pid || proc.killed) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => {});
  } else {
    try { proc.kill(); } catch {}
  }
}

app.post('/cancel/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado ou já finalizado.' });
  job.cancelled = true;
  killProcessTree(job.proc);
  res.json({ ok: true });
});

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

// Corta a abertura do vídeo quando a origem pede isso (ver video/trim.js).
// Devolve o caminho a entregar — o original, se o corte não der certo.
async function aplicarCorte(url, arquivo, send) {
  const segundos = segundosParaCortar(url);
  if (!segundos) return arquivo;

  send({ type: 'progress', percent: 100, status: 'Cortando abertura...', speed: null, eta: null });
  const cortado = await cortarInicio(arquivo, segundos, getFfmpegBin());

  if (cortado === arquivo) console.log(`[trim] corte não aplicado em ${path.basename(arquivo)}`);
  else console.log(`[trim] ${segundos}s cortados de ${path.basename(cortado)}`);
  return cortado;
}

// Sites atrás de Cloudflare rejeitam o TLS fingerprint padrão do yt-dlp e devolvem 403.
// Com curl_cffi disponível (ver Dockerfile) o extractor genérico imita um browser real.
const IMPERSONATE_ARGS = ['--extractor-args', 'generic:impersonate'];

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

// ── FETCH HTML (usado por /extract e pelo fallback de /playlist) ──
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];

function fetchHtmlDirect(pageUrl) {
  const https = require('https');
  const http  = require('http');
  const ua    = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  return new Promise((resolve, reject) => {
    function fail(publicMessage, status) {
      const e = new Error(publicMessage);
      e.publicMessage = publicMessage;
      e.status = status || 500;
      reject(e);
    }

    function doFetch(url, redirects) {
      redirects = redirects || 0;
      if (redirects > 5) return fail('Muitos redirecionamentos.', 500);

      let parsed;
      try { parsed = new URL(url); } catch { return fail('URL inválida.', 400); }
      const client  = url.startsWith('https') ? https : http;
      const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers: {
          'User-Agent':                ua,
          'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language':           'pt-BR,pt;q=0.9',
          'Accept-Encoding':           'identity',
          'Connection':                'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Referer':                   parsed.origin + '/',
        },
      };

      const r = client.get(options, resp => {
        if ([301,302,303,307,308].includes(resp.statusCode) && resp.headers.location) {
          resp.resume();
          const next = resp.headers.location.startsWith('http')
            ? resp.headers.location
            : parsed.origin + resp.headers.location;
          return doFetch(next, redirects + 1);
        }
        if (resp.statusCode >= 400) {
          resp.resume();
          return fail(resp.statusCode === 403
            ? 'O site recusou a conexão do servidor (bloqueio anti-bot).'
            : 'Página não encontrada (HTTP ' + resp.statusCode + '). Verifique o link.', 400);
        }

        let html = '';
        resp.on('data', d => html += d);
        resp.on('end', () => resolve(html));
      });
      r.on('error', err => fail('Erro de rede: ' + err.message, 500));
      r.setTimeout(15000, () => { r.destroy(); fail('Timeout ao carregar a página.', 500); });
    }

    doFetch(pageUrl);
  });
}

// O Cloudflare rejeita o TLS fingerprint do Node em IPs de datacenter e devolve 403.
// O yt-dlp tem curl_cffi e passa — então usamos ele só como buscador de HTML.
// --dump-pages imprime cada página baixada em base64 numa única linha do stdout.
function fetchHtmlViaYtDlp(pageUrl) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-pages', '--skip-download', '--no-warnings',
                  ...IMPERSONATE_ARGS, pageUrl];
    const proc = spawn(getYtDlpBin(), args, { stdio: ['ignore','pipe','pipe'] });
    const killer = setTimeout(() => killProcessTree(proc), 45000);

    let out = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', () => {});

    proc.on('error', e => { clearTimeout(killer); reject(e); });
    proc.on('close', () => {
      clearTimeout(killer);
      // Ignoramos o exit code de propósito: o yt-dlp sai != 0 quando não acha vídeo
      // na página, mas o dump do HTML já veio antes disso.
      const b64 = out.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 500 && /^[A-Za-z0-9+/=]+$/.test(l))
        .sort((a, b) => b.length - a.length)[0];
      if (!b64) return reject(new Error('yt-dlp não retornou a página.'));
      resolve(Buffer.from(b64, 'base64').toString('utf8'));
    });
  });
}

// /playlist e /extract pedem a mesma página com segundos de diferença. Guardar o
// HTML por pouco tempo corta uma busca inteira do caminho até o primeiro byte.
const HTML_TTL  = 60000;
const htmlCache = new Map();

function htmlCacheGet(url) {
  const hit = htmlCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > HTML_TTL) { htmlCache.delete(url); return null; }
  return hit.html;
}

function htmlCacheSet(url, html) {
  if (htmlCache.size > 40) htmlCache.clear();   // teto simples, sem política fina
  htmlCache.set(url, { at: Date.now(), html });
}

// Tenta o cliente HTTP do Node (rápido) e só cai pro yt-dlp se o site bloquear.
async function fetchHtml(pageUrl) {
  const cached = htmlCacheGet(pageUrl);
  if (cached) return cached;

  try {
    const html = await fetchHtmlDirect(pageUrl);
    htmlCacheSet(pageUrl, html);
    return html;
  } catch (e) {
    try {
      const html = await fetchHtmlViaYtDlp(pageUrl);
      htmlCacheSet(pageUrl, html);
      console.log('[fetchHtml] bloqueado no acesso direto, resolvido via yt-dlp:', pageUrl);
      return html;
    } catch {
      throw e;  // a mensagem do fetch direto é mais útil pro usuário
    }
  }
}

function decodeEntities(s) {
  if (!s) return s;
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Tema de "tube" WordPress (ex.: xvideosputaria.com) sem extractor no yt-dlp:
// páginas de listagem (categoria/tag/página) mostram uma grade de vídeos com
// `<a href="URL" title="TÍTULO" class="thumb"><img ... (data-)src="THUMB" ...`.
// Páginas de vídeo único embutem um player (iframe vazounudes.net/video/...) —
// nesse caso NÃO tratamos como listagem, mesmo que existam thumbs de "relacionados".
function scrapeListingEntries(html, baseUrl) {
  if (/vazounudes\.net\/video\/|video-player-d\.php/i.test(html)) return [];

  const seen = new Set();
  const entries = [];
  const itemRe = /href="([^"]+)"\s+title="([^"]+)"\s+class="thumb">[\s\S]{0,400}?(?:data-src|src)="([^"]+?)"/g;
  let m;
  while ((m = itemRe.exec(html)) && entries.length < PLAYLIST_MAX) {
    let url;
    try { url = new URL(m[1], baseUrl).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const thumb = m[3] && !m[3].startsWith('data:') ? m[3] : null;
    entries.push({
      url,
      title:     decodeEntities(m[2]).trim() || 'Sem título',
      duration:  null,
      thumbnail: thumb,
    });
  }
  return entries;
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

  let html;
  try {
    html = await fetchHtml(pageUrl);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.publicMessage || 'Falha ao carregar página.' });
  }

  // Extrai título
  let title = '';
  const og = /property="og:title"\s+content="([^"]+)"/i.exec(html)
          || /content="([^"]+)"\s+property="og:title"/i.exec(html);
  const tt = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  if (og) title = og[1];
  else if (tt) title = tt[1];
  title = decodeEntities(title.replace(/ [-–|] [^-–|]+$/, '').trim());

  // Extrai UUID do vazounudes (embutido em iframes de players tipo xvideosputaria.com)
  const uid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(html);
  if (uid) {
    return res.json({ m3u8: 'https://vazounudes.net/hls/' + uid[0] + '/480p/video.m3u8', title: title || 'video' });
  }

  // Tenta m3u8 direto
  const m3 = /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i.exec(html);
  if (m3) return res.json({ m3u8: m3[0], title: title || 'video' });

  res.status(400).json({ error: 'Vídeo não encontrado na página. Cole o link m3u8 diretamente.' });
});

// ── PLAYLIST (lista os vídeos de uma página) ──────────────────
const PLAYLIST_MAX = 200;

// Igual ao cleanUrl, mas preserva `list`/`index` — sem eles a playlist some.
function cleanPlaylistUrl(raw) {
  try {
    const u = new URL(raw);
    ['start_radio','pp','si','feature','ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return raw; }
}

function pickThumb(e) {
  if (e.thumbnail) return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    const t = e.thumbnails[e.thumbnails.length - 1];
    return t && t.url ? t.url : null;
  }
  return null;
}

function entryUrl(e) {
  if (e.webpage_url) return e.webpage_url;
  if (e.url && /^https?:\/\//i.test(e.url)) return e.url;
  if (e.id && e.ie_key === 'Youtube') return 'https://www.youtube.com/watch?v=' + e.id;
  return e.url || null;
}

// yt-dlp cospe "ERROR: [generic] slug: msg (caused by ...)" — só a msg interessa.
function tidyYtdlpError(raw, fallback, useLast) {
  const all = raw || '';
  // O yt-dlp devolve blocos longos e técnicos (com links e flags de linha de comando)
  // que não fazem sentido pra quem só colou um link no site.
  if (/impersonat/i.test(all))
    return 'Este site bloqueia downloads automáticos. Tente novamente mais tarde.';
  if (/HTTP Error 403|Forbidden/i.test(all))
    return 'O site recusou a conexão do servidor (bloqueio anti-bot).';
  if (/Unsupported URL/i.test(all))
    return 'Este site não é suportado. Cole o link direto do vídeo (.m3u8 ou .mp4).';

  const lines = all.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('[debug]') && !l.startsWith('WARNING') && !l.startsWith('[youtube]'));
  const line = useLast ? lines[lines.length - 1] : lines[0];
  if (!line) return fallback;
  let msg = line.replace(/^ERROR:\s*/i, '').replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '');
  msg = msg.replace(/\s*\(caused by .*$/is, '').trim();
  if (msg.length > 160) msg = msg.slice(0, 157).trimEnd() + '...';
  return msg || fallback;
}

// Canais vêm como playlist de playlists (abas), então achatamos recursivamente.
function collectEntries(node, seen, out) {
  if (!node || out.length >= PLAYLIST_MAX) return;
  if (Array.isArray(node.entries)) {
    for (const child of node.entries) collectEntries(child, seen, out);
    return;
  }
  const url = entryUrl(node);
  if (!url || seen.has(url)) return;
  seen.add(url);
  out.push({
    url,
    title:     node.title || 'Sem título',
    duration:  typeof node.duration === 'number' ? node.duration : null,
    thumbnail: pickThumb(node),
  });
}

app.post('/playlist', (req, res) => {
  const url = cleanPlaylistUrl(req.body.url || '');
  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  const args = ['--flat-playlist', '--dump-single-json', '--no-warnings',
                '--playlist-end', String(PLAYLIST_MAX), ...IMPERSONATE_ARGS];
  const cookiesFile = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);
  args.push(url);

  let out = '', err = '', finished = false;
  const proc = spawn(getYtDlpBin(), args, { stdio: ['ignore','pipe','pipe'] });
  const killer = setTimeout(() => killProcessTree(proc), 90000);

  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);

  proc.on('close', async code => {
    clearTimeout(killer);
    if (finished) return;
    finished = true;

    if (code !== 0 || !out.trim()) {
      // yt-dlp não tem extractor pra esse site (ex.: tubes WordPress) — tenta
      // extrair a listagem direto do HTML antes de desistir.
      try {
        const html    = await fetchHtml(url);
        const entries = scrapeListingEntries(html, url);
        if (entries.length) {
          console.log(`[playlist] ${entries.length} vídeo(s) via scraping em ${url}`);
          return res.json({ title: '', entries });
        }
      } catch {}

      return res.status(400).json({
        error: tidyYtdlpError(err, 'Não foi possível listar os vídeos desta página.'),
      });
    }

    let data;
    try { data = JSON.parse(out.trim().split('\n')[0]); }
    catch { return res.status(500).json({ error: 'Falha ao processar a lista.' }); }

    const entries = [];
    collectEntries(data, new Set(), entries);
    if (!entries.length) return res.status(400).json({ error: 'Nenhum vídeo encontrado nesta página.' });

    console.log(`[playlist] ${entries.length} vídeo(s) em ${url}`);
    res.json({ title: data.title || '', entries });
  });

  proc.on('error', e => {
    clearTimeout(killer);
    if (finished) return;
    finished = true;
    res.status(500).json({ error: 'Erro ao executar yt-dlp: ' + e.message });
  });
});

// ── INFO ─────────────────────────────────────────────────────
app.post('/info', (req, res) => {
  const url = cleanUrl(req.body.url || '');
  if (!url) return res.status(400).json({ error: 'URL obrigatória.' });

  if (isHLS(url)) {
    return res.json({ title: 'Stream HLS', thumbnail: null, duration: null });
  }

  const args = ['--dump-json', '--no-playlist', '--no-warnings', ...IMPERSONATE_ARGS, url];
  let out = '', err = '';
  const proc = spawn(getYtDlpBin(), args, { stdio: ['ignore','pipe','pipe'] });
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    if (code !== 0 || !out.trim()) {
      return res.status(400).json({ error: tidyYtdlpError(err, 'Erro ao buscar vídeo.') });
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
  send({ type: 'start', jobId });

  if (isHLS(url) && !audioOnly) {
    // downloader nativo do yt-dlp baixa fragmentos em paralelo — muito mais
    // rápido que o ffmpeg (que busca os .ts um de cada vez numa só conexão).
    // 'b' primeiro (stream já combinado, sem merge); só se não existir é que
    // pegamos vídeo+áudio separados — antes disso caía no ffmpeg por engano.
    runYtDlp(url, 'b/bv*+ba', false, jobId, send, res, title);
  } else {
    runYtDlp(url, format, audioOnly, jobId, send, res, title);
  }
});

// ── HLS via ffmpeg (fallback caso o downloader nativo do yt-dlp falhe) ──
function runFfmpegHLS(url, jobId, send, res, title) {
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
    '-fs', String(MAX_DOWNLOAD_BYTES),   // o próprio ffmpeg para no teto
    outFile,
  ];

  console.log(`[ffmpeg HLS] iniciando job ${jobId.slice(0,8)}`);
  const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const job  = { proc, cancelled: false };
  activeJobs.set(jobId, job);

  let totalSecs = 0;
  let lastPct   = 0;

  // Heartbeat — mostra MB em disco e aplica o mesmo teto do yt-dlp
  const inicioJob = Date.now();
  const hb = setInterval(() => {
    try {
      if (!fs.existsSync(outFile)) return;
      const bytes = fs.statSync(outFile).size;
      const excedeu = motivoDoLimite(bytes, inicioJob);
      if (excedeu) {
        job.limiteExcedido = excedeu;
        clearInterval(hb);
        killProcessTree(proc);
        return;
      }
      if (bytes > 0) {
        const mb = (bytes / 1048576).toFixed(1);
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

  proc.on('close', async code => {
    clearInterval(hb);
    activeJobs.delete(jobId);

    if (job.cancelled) {
      try { fs.unlinkSync(outFile); } catch {}
      send({ type: 'cancelled' });
      return res.end();
    }

    if (res.destroyed) {
      // cliente desconectou (fechou a aba, caiu a rede) — não há mais ninguém ouvindo
      try { fs.unlinkSync(outFile); } catch {}
      return;
    }

    if (job.limiteExcedido) {
      try { fs.unlinkSync(outFile); } catch {}
      send({ type: 'error', message: job.limiteExcedido });
      return res.end();
    }

    if (code !== 0 || !fs.existsSync(outFile)) {
      send({ type: 'error', message: 'Falha no download (método alternativo também falhou).' });
      return res.end();
    }

    const pronto    = await aplicarCorte(url, outFile, send);
    const basename  = path.basename(pronto);
    const safeTitle = sanitizeFilename(title);
    const newName   = path.join(DOWNLOADS_DIR, `${safeTitle}_${jobId.slice(0,6)}.mp4`);
    try { fs.renameSync(pronto, newName); } catch {}
    const finalName = fs.existsSync(newName) ? path.basename(newName) : basename;
    send({ type: 'done', filename: finalName, url: `/files/${encodeURIComponent(finalName)}` });
    res.end();
    const cleanPath = fs.existsSync(newName) ? newName : pronto;
    setTimeout(() => { try { fs.unlinkSync(cleanPath); } catch {} }, 10*60*1000);
  });

  res.on('close', () => { clearInterval(hb); killProcessTree(proc); activeJobs.delete(jobId); });
}

// ── yt-dlp ───────────────────────────────────────────────────
function runYtDlp(url, format, audioOnly, jobId, send, res, title) {
  const hls    = isHLS(url);
  const ext    = audioOnly ? '%(ext)s' : 'mp4';
  const outTpl = path.join(DOWNLOADS_DIR, `${jobId}_%(epoch)s.${ext}`);
  const bin    = getYtDlpBin();

  const cookiesFile = path.join(__dirname, 'cookies.txt');
  const args = [
    '--no-playlist', '--newline', '--force-overwrites',
    '--concurrent-fragments', '8',
    ...IMPERSONATE_ARGS,
    '-o', outTpl,
  ];

  if (fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile);

  if (hls) {
    args.push('--hls-prefer-native');
    args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    try { args.push('--referer', new URL(url).origin + '/'); } catch {}
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', format);
    args.push('--merge-output-format', 'mp4');
  }
  args.push(url);

  console.log(`[yt-dlp] job ${jobId.slice(0,8)} formato: ${format}`);

  const proc = spawn(bin, args, { stdio: ['ignore','pipe','pipe'] });
  const job  = { proc, cancelled: false };
  activeJobs.set(jobId, job);
  res.on('close', () => killProcessTree(proc));

  let filename = null, errLog = '';
  const rePct  = /(\d+\.?\d*)%/;
  const reSpd  = /(\d+\.?\d*\s*[KMGkmg]i?B\/s)/;
  const reEta  = /ETA\s+([\d:]+)/;
  const reDest = /Destination:\s+(.+)/;
  const reFrag = /frag\s+(\d+)\/(\d+)/i;

  const inicioJob = Date.now();
  const hb = setInterval(() => {
    try {
      const bytes = bytesDoJob(jobId);
      const excedeu = motivoDoLimite(bytes, inicioJob);
      if (excedeu) {
        job.limiteExcedido = excedeu;   // impede o fallback pro ffmpeg
        clearInterval(hb);
        killProcessTree(proc);
        return;
      }
      if (bytes > 0) {
        const mb = (bytes / 1048576).toFixed(1);
        send({ type:'progress', percent:-1, status:`Baixando... ${mb} MB`, speed:null, eta:null });
      }
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

  proc.on('close', async code => {
    clearInterval(hb);
    activeJobs.delete(jobId);

    if (job.cancelled) {
      cleanupJobFiles(jobId);
      send({ type: 'cancelled' });
      return res.end();
    }

    if (res.destroyed) {
      // cliente desconectou (fechou a aba, caiu a rede) — não há mais ninguém ouvindo,
      // não faz sentido tentar o fallback pro ffmpeg
      cleanupJobFiles(jobId);
      return;
    }

    if (job.limiteExcedido) {
      cleanupJobFiles(jobId);
      send({ type:'error', message: job.limiteExcedido });
      return res.end();
    }

    if (code !== 0) {
      if (hls) {
        // downloader nativo falhou — tenta o método antigo (ffmpeg) como último recurso
        console.log('[yt-dlp] HLS nativo falhou, tentando ffmpeg...');
        cleanupJobFiles(jobId);
        send({ type: 'progress', percent: 0, status: 'Tentando método alternativo...', speed: null, eta: null });
        return runFfmpegHLS(url, jobId, send, res, title);
      }
      send({ type:'error', message: tidyYtdlpError(errLog, 'Falha no download.', true) });
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

    const pronto2   = await aplicarCorte(url, filename, send);
    const basename  = path.basename(pronto2);
    const ytTitle   = sanitizeFilename(title);
    const ext2      = path.extname(basename) || '.mp4';
    const newName2  = path.join(DOWNLOADS_DIR, `${ytTitle}_${jobId.slice(0,6)}${ext2}`);
    try { fs.renameSync(pronto2, newName2); } catch {}
    const finalName2 = fs.existsSync(newName2) ? path.basename(newName2) : basename;
    send({ type:'done', filename: finalName2, url:`/files/${encodeURIComponent(finalName2)}` });
    res.end();
    const cleanPath2 = fs.existsSync(newName2) ? newName2 : pronto2;
    setTimeout(() => { try { fs.unlinkSync(cleanPath2); } catch {} }, 10*60*1000);
  });
}

// ── TWITTER/X ────────────────────────────────────────────────
// Feature isolada: router próprio sob /api/twitter, sem relação com as rotas
// de M3U8 acima (/extract, /playlist, /info, /download).
app.use('/api/twitter', require('./twitter/routes'));

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
