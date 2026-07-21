const API = '';
let selectedFormat = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b';
let pageTitle = '';
let resolvedM3u8 = '';

function cleanUrl(url) {
  try {
    const u = new URL(url);
    ['list','index','start_radio','pp','si','feature','ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

function isM3u8(url) {
  return /\.m3u8/i.test(url) || url.includes('/hls/');
}

function isPageUrl(url) {
  return !isM3u8(url) && /^https?:\/\/.+\/.+/.test(url);
}

// Extrai UUID/m3u8 do HTML via fetch do BROWSER (não do servidor)
// O browser tem IP real, não é bloqueado
async function extractFromPage(url) {
  try {
    // Tenta buscar via proxy CORS público
    const corsProxy = 'https://api.allorigins.win/get?url=';
    const response = await fetch(corsProxy + encodeURIComponent(url));
    const data = await response.json();
    const html = data.contents || '';

    if (!html) throw new Error('Página vazia');

    // Extrai título
    let title = '';
    const ogMatch = /property="og:title"\s+content="([^"]+)"/i.exec(html)
                 || /content="([^"]+)"\s+property="og:title"/i.exec(html);
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    if (ogMatch) title = ogMatch[1];
    else if (titleMatch) title = titleMatch[1];
    title = title.replace(/ [-–|] [^-–|]+$/, '').trim();

    // Extrai UUID do vazounudes
    const uuidMatch = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(html);
    if (uuidMatch) {
      const uuid = uuidMatch[0];
      return {
        m3u8: `https://vazounudes.net/hls/${uuid}/480p/video.m3u8`,
        title: title || 'video'
      };
    }

    // Tenta m3u8 direto no HTML
    const m3u8Match = /https?:\/\/[^\s"']+\.m3u8[^\s"']*/i.exec(html);
    if (m3u8Match) return { m3u8: m3u8Match[0], title: title || 'video' };

    throw new Error('Não foi possível encontrar o vídeo nesta página.');
  } catch (err) {
    throw new Error(err.message || 'Erro ao processar a página.');
  }
}

function showProgress() {
  const el = document.getElementById('progress');
  if (el) el.classList.remove('hidden');
  const err = document.getElementById('error');
  if (err) err.classList.add('hidden');
}

function hideProgress() {
  const el = document.getElementById('progress');
  if (el) el.classList.add('hidden');
}

function setProgress(pct, status) {
  const bar    = document.getElementById('bar');
  const pctEl  = document.getElementById('pct');
  const statEl = document.getElementById('status');
  if (bar && pct !== null)   bar.style.width = pct + '%';
  if (pctEl && pct !== null) pctEl.textContent = Math.round(pct) + '%';
  if (statEl) statEl.textContent = status || '';
}

function setSpeed(text) {
  const el = document.getElementById('speed');
  if (el) el.textContent = text || '';
}

function showError(msg) {
  hideProgress();
  const el = document.getElementById('error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function showDone() {
  setProgress(100, '✅ Download concluído!');
  setSpeed('');
  setTimeout(() => {
    hideProgress();
    const input = document.getElementById('urlInput');
    if (input) input.value = '';
    pageTitle = '';
    resolvedM3u8 = '';
  }, 3000);
}

async function startDownload() {
  let raw = document.getElementById('urlInput').value.trim();
  if (!raw) return showError('Cole um link de vídeo válido.');

  const url = cleanUrl(raw);
  document.getElementById('urlInput').value = url;

  const btn = document.getElementById('dlBtn');
  if (btn) btn.disabled = true;

  showProgress();
  setProgress(0, 'Analisando link...');
  setSpeed('');

  try {
    let downloadUrl = url;
    let title = pageTitle;

    // Se for URL de página, extrai m3u8 no browser
    if (isPageUrl(url) && !resolvedM3u8) {
      setProgress(0, 'Extraindo vídeo da página...');
      const extracted = await extractFromPage(url);
      downloadUrl = extracted.m3u8;
      title = extracted.title;
      resolvedM3u8 = downloadUrl;
      pageTitle = title;
    } else if (resolvedM3u8) {
      downloadUrl = resolvedM3u8;
    }

    setProgress(0, 'Iniciando download...');

    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: downloadUrl, format: selectedFormat, audioOnly: false, title }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Falha no download.');
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { handleEvent(JSON.parse(line.slice(6))); } catch {}
      }
    }
  } catch (err) {
    showError(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleEvent(evt) {
  if (evt.type === 'stream') {
    showDone();
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = evt.streamUrl;
      a.download = `video_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, 300);
    return;
  }

  if (evt.type === 'progress') {
    const pct = (typeof evt.percent === 'number' && evt.percent >= 0) ? evt.percent : null;
    setProgress(pct, evt.status || 'Baixando...');
    setSpeed(evt.speed || '');
    return;
  }

  if (evt.type === 'done') {
    const a = document.createElement('a');
    a.href = evt.url;
    a.download = evt.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showDone();
    return;
  }

  if (evt.type === 'error') {
    resolvedM3u8 = '';
    showError(evt.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') startDownload();
  });
  document.getElementById('urlInput').addEventListener('input', () => {
    pageTitle = '';
    resolvedM3u8 = '';
  });
});
