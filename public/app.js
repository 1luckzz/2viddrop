const API = '';
let selectedFormat = 'bestvideo[height<=1080]+bestaudio/best';

function cleanUrl(url) {
  try {
    const u = new URL(url);
    ['list','index','start_radio','pp','si','feature','ab_channel','utm_source','utm_medium'].forEach(p => u.searchParams.delete(p));
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
  btnText.textContent = 'Buscando...';
  hideAll();

  try {
    const res = await fetch(`${API}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro ao buscar vídeo.');
    renderVideoInfo(data, url);
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Buscar';
  }
}

function renderVideoInfo(data, url) {
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
    { label: '1080p', format: 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b' },
    { label: '720p',  format: 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b' },
    { label: '480p',  format: 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/bv*[height<=480]+ba/b[height<=480]/b' },
    { label: 'MP3',   format: 'bestaudio/best', audio: true },
  ];

  options.forEach(({ label, format, audio }, i) => {
    const tab = document.createElement('button');
    tab.className = 'format-tab' + (i === 0 ? ' active' : '');
    tab.textContent = label;
    tab.dataset.format = format;
    tab.dataset.audio = audio ? '1' : '0';
    if (i === 0) selectedFormat = format;
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

  hasRealProgress = false;
  hideAll();
  show('progressSection');
  setProgress(0, 'Iniciando...');

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

let hasRealProgress = false;

function handleEvent(evt) {
  if (evt.type === 'progress') {
    // Se tem porcentagem real, ignora updates de MB do heartbeat
    if (evt.percent >= 0) hasRealProgress = true;
    if (evt.percent < 0 && hasRealProgress) return;

    const pct = (evt.percent !== null && evt.percent >= 0) ? evt.percent : null;
    setProgress(pct, evt.status);
    const sp = document.getElementById('progressSpeed');
    sp.textContent = evt.speed ? `${evt.speed}${evt.eta ? ' · ETA ' + evt.eta : ''}` : '';
  }
  if (evt.type === 'done') {
    setProgress(100, 'Concluído');
    document.getElementById('progressSpeed').textContent = '';
    setTimeout(() => triggerDownload(evt.filename, evt.url), 400);
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
  if (pct !== null) {
    fill.style.width = pct + '%';
    pctEl.textContent = Math.round(pct) + '%';
  }
  document.getElementById('progressText').textContent = text;
}

function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
  show('errorBox');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function hideAll() { ['videoInfo','progressSection','errorBox'].forEach(hide); }

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
