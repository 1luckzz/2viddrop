const API = '';
let selectedFormat = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b';

function safeT(key, fallback) {
  try { return (typeof t === 'function') ? t(key) : fallback; } catch { return fallback; }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    ['list','index','start_radio','pp','si','feature','ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

async function fetchInfo() {
  let url = document.getElementById('urlInput').value.trim();
  if (!url) return showError('Cole um link de vídeo válido.');

  url = cleanUrl(url);
  document.getElementById('urlInput').value = url;

  const btn = document.getElementById('fetchBtn');
  const btnText = document.getElementById('fetchBtnText');
  btn.disabled = true;
  btnText.textContent = safeT('btn_searching', 'Buscando...');
  hideAll();

  try {
    const res = await fetch(`${API}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao buscar vídeo.');
    renderVideoInfo(data);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = safeT('btn_search', 'Baixar');
  }
}

function renderVideoInfo(data) {
  const thumb = document.getElementById('thumbnail');
  if (data.thumbnail) {
    thumb.src = data.thumbnail;
    thumb.style.display = 'block';
  } else {
    thumb.style.display = 'none';
  }

  document.getElementById('videoTitle').textContent = data.title || 'Vídeo encontrado';
  const dur = document.getElementById('videoDuration');
  if (data.duration) {
    dur.textContent = formatDuration(data.duration);
    dur.style.display = 'inline-block';
  } else {
    dur.style.display = 'none';
  }

  const tabs = document.getElementById('formatTabs');
  tabs.innerHTML = '';

  const options = [
    { label: '4K',    format: 'b[ext=mp4][height<=2160]/b[height<=2160]/b' },
    { label: '1080p', format: 'b[ext=mp4][height<=1080]/b[height<=1080]/b' },
    { label: '720p',  format: 'b[ext=mp4][height<=720]/b[height<=720]/b'   },
    { label: '480p',  format: 'b[ext=mp4][height<=480]/b[height<=480]/b'   },
    { label: 'MP3',   format: 'bestaudio', audio: true                      },
  ];

  options.forEach(({ label, format, audio }, i) => {
    const tab = document.createElement('button');
    tab.className = 'format-tab' + (i === 1 ? ' active' : '');
    tab.textContent = label;
    tab.dataset.format = format;
    tab.dataset.audio = audio ? '1' : '0';
    if (i === 1) selectedFormat = format;
    tab.onclick = () => {
      document.querySelectorAll('.format-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      selectedFormat = format;
    };
    tabs.appendChild(tab);
  });

  show('videoInfo');
}

async function startDownload() {
  const url     = document.getElementById('urlInput').value.trim();
  const isAudio = document.querySelector('.format-tab.active')?.dataset.audio === '1';

  if (!url) return showError('Cole um link de vídeo válido.');

  hideAll();
  show('progressSection');
  setProgress(0, safeT('preparing', 'Preparando...'));

  try {
    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: selectedFormat, audioOnly: isAudio }),
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
    hide('progressSection');
    showError(err.message);
  }
}

function handleEvent(evt) {
  if (evt.type === 'stream') {
    setProgress(100, safeT('done', 'Concluído'));
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
    // Mostra sempre — sem filtros complicados
    const pct = (typeof evt.percent === 'number' && evt.percent >= 0) ? evt.percent : null;
    setProgress(pct, evt.status || 'Baixando...');
    const sp = document.getElementById('progressSpeed');
    if (sp) {
      if (evt.speed) {
        sp.textContent = evt.speed + (evt.eta ? ' · ETA ' + evt.eta : '');
      } else if (evt.eta) {
        sp.textContent = 'ETA ' + evt.eta;
      } else {
        sp.textContent = '';
      }
    }
    return;
  }

  if (evt.type === 'done') {
    setProgress(100, safeT('done', 'Concluído'));
    const sp = document.getElementById('progressSpeed');
    if (sp) sp.textContent = '';
    setTimeout(() => triggerDownload(evt.filename, evt.url), 400);
    return;
  }

  if (evt.type === 'error') {
    hide('progressSection');
    showError(evt.message);
  }
}

function triggerDownload(filename, fileUrl) {
  const a = document.createElement('a');
  a.href = fileUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function setProgress(pct, text) {
  const fill  = document.getElementById('progressBar');
  const pctEl = document.getElementById('progressPct');
  const textEl = document.getElementById('progressText');
  if (fill && pct !== null)  fill.style.width = pct + '%';
  if (pctEl && pct !== null) pctEl.textContent = Math.round(pct) + '%';
  if (textEl) textEl.textContent = text;
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  if (el) el.textContent = msg;
  show('errorBox');
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function hideAll() {
  ['videoInfo','progressSection','errorBox'].forEach(hide);
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') fetchInfo();
  });
  document.getElementById('urlInput').addEventListener('paste', e => {
    setTimeout(() => {
      const val = document.getElementById('urlInput').value.trim();
      document.getElementById('urlInput').value = cleanUrl(val);
    }, 50);
  });
});
