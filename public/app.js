const API = '';
let selectedFormat = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b';
let pageTitle = '';
let resolvedM3u8 = '';
let playlistItems = [];
let batchRunning = false;
let currentJobId = null;
let cancelRequested = false;

async function cancelCurrentJob() {
  cancelRequested = true;
  if (!currentJobId) return;
  try { await fetch(`${API}/cancel/${currentJobId}`, { method: 'POST' }); } catch {}
}

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

function formatDuration(secs) {
  if (!secs || secs < 0) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

function showProgress() {
  const el = document.getElementById('progress');
  if (el) { el.classList.remove('hidden'); el.classList.remove('is-done'); }
  hideError();
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

function hideError() {
  const el = document.getElementById('error');
  if (el) el.classList.add('hidden');
}

function setBusy(busy) {
  const btn = document.getElementById('dlBtn');
  if (btn) btn.disabled = busy;
}

function triggerSave(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `video_${Date.now()}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── streaming SSE compartilhado entre download único e em lote ──
async function runDownload(url, title, onEvent) {
  const res = await fetch(`${API}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, format: selectedFormat, audioOnly: false, title }),
  });

  if (!res.ok) {
    let err = {};
    try { err = await res.json(); } catch {}
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
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === 'start') { currentJobId = evt.jobId; continue; }
        onEvent(evt);
      } catch {}
    }
  }
}

// ── ponto de entrada: decide entre lista e download único ──────
async function startDownload() {
  const input = document.getElementById('urlInput');
  const raw   = input.value.trim();
  if (!raw) return showError('Cole um link de vídeo válido.');

  hideError();
  setBusy(true);

  try {
    // m3u8 direto não tem playlist pra listar
    if (isM3u8(raw)) return await singleDownload(cleanUrl(raw));

    showProgress();
    setProgress(0, 'Analisando link...');
    setSpeed('');

    let entries = null;
    try {
      const res  = await fetch(`${API}/playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: raw }),
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.entries)) entries = data.entries;
    } catch {
      // sem lista: cai no fluxo de vídeo único abaixo
    }

    if (entries && entries.length > 1) {
      hideProgress();
      renderPlaylist(entries);
      return;
    }

    const single = entries && entries.length === 1 ? entries[0].url : cleanUrl(raw);
    if (entries && entries.length === 1) pageTitle = entries[0].title || '';
    await singleDownload(single);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

// ── download de um vídeo só (fluxo original) ───────────────────
async function singleDownload(url) {
  document.getElementById('urlInput').value = url;
  clearPlaylist();
  cancelRequested = false;
  currentJobId = null;
  showProgress();
  setProgress(0, 'Analisando link...');
  setSpeed('');

  let downloadUrl = url;
  let title = pageTitle;

  // URL de página → servidor extrai o m3u8
  if (isPageUrl(url) && !resolvedM3u8) {
    setProgress(0, 'Extraindo vídeo da página...');
    const extRes = await fetch(`${API}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const extData = await extRes.json();
    if (extRes.ok && extData.m3u8) {
      downloadUrl = extData.m3u8;
      title = extData.title || title;
      resolvedM3u8 = downloadUrl;
      pageTitle = title;
    }
    // se /extract falhar, tenta a URL original direto no yt-dlp
  } else if (resolvedM3u8) {
    downloadUrl = resolvedM3u8;
  }

  setProgress(0, 'Iniciando download...');
  await runDownload(downloadUrl, title, handleEvent);
}

function handleEvent(evt) {
  if (evt.type === 'stream') {
    showDone();
    setTimeout(() => triggerSave(evt.streamUrl, `video_${Date.now()}.mp4`), 300);
    return;
  }
  if (evt.type === 'progress') {
    const pct = (typeof evt.percent === 'number' && evt.percent >= 0) ? evt.percent : null;
    setProgress(pct, evt.status || 'Baixando...');
    setSpeed(evt.speed || '');
    return;
  }
  if (evt.type === 'done') {
    triggerSave(evt.url, evt.filename);
    showDone();
    return;
  }
  if (evt.type === 'cancelled') {
    currentJobId = null;
    resolvedM3u8 = '';
    showError('Download cancelado.');
    return;
  }
  if (evt.type === 'error') {
    currentJobId = null;
    resolvedM3u8 = '';
    showError(evt.message);
  }
}

function showDone() {
  currentJobId = null;
  const box = document.getElementById('progress');
  if (box) box.classList.add('is-done');
  setProgress(100, 'Download concluído!');
  setSpeed('');
  setTimeout(() => {
    hideProgress();
    const input = document.getElementById('urlInput');
    if (input) input.value = '';
    pageTitle = '';
    resolvedM3u8 = '';
  }, 3000);
}

// ── lista de vídeos da página ──────────────────────────────────
function clearPlaylist() {
  playlistItems = [];
  const box = document.getElementById('playlist');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

function renderPlaylist(entries) {
  playlistItems = entries.map((e, i) => ({
    id: i, url: e.url, title: e.title, duration: e.duration, thumbnail: e.thumbnail,
    selected: true, status: 'idle', percent: 0, row: null,
  }));

  const box = document.getElementById('playlist');
  box.innerHTML = '';
  box.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'pl-head';
  head.innerHTML =
    `<span id="plCount"></span>` +
    `<span class="pl-actions">` +
      `<button type="button" class="pl-link" id="plAll">Marcar todos</button>` +
      `<button type="button" class="pl-link" id="plNone">Desmarcar todos</button>` +
    `</span>`;
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'pl-list';
  box.appendChild(list);

  playlistItems.forEach(item => list.appendChild(buildRow(item)));

  const foot = document.createElement('div');
  foot.className = 'pl-foot';
  foot.innerHTML =
    `<button type="button" id="plStart" class="pl-start"></button>` +
    `<button type="button" id="plCancel" class="pl-cancel hidden">Cancelar downloads</button>`;
  box.appendChild(foot);

  head.querySelector('#plAll').onclick  = () => setAllSelected(true);
  head.querySelector('#plNone').onclick = () => setAllSelected(false);
  foot.querySelector('#plStart').onclick  = startBatch;
  foot.querySelector('#plCancel').onclick = cancelCurrentJob;

  updateCounts();
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'pl-item';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = item.selected;
  cb.className = 'pl-check';
  cb.onchange = () => { item.selected = cb.checked; updateCounts(); };

  const thumb = document.createElement('div');
  thumb.className = 'pl-thumb';
  if (item.thumbnail) {
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = () => img.remove();
    thumb.appendChild(img);
  }

  const info = document.createElement('div');
  info.className = 'pl-info';

  const title = document.createElement('div');
  title.className = 'pl-title';
  title.textContent = item.title;
  title.title = item.title;

  const meta = document.createElement('div');
  meta.className = 'pl-meta';
  meta.textContent = formatDuration(item.duration);

  const track = document.createElement('div');
  track.className = 'pl-track hidden';
  const fill = document.createElement('div');
  fill.className = 'pl-fill';
  track.appendChild(fill);

  info.append(title, meta, track);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'pl-del';
  del.textContent = '×';
  del.title = 'Remover da lista';
  del.onclick = () => removeItem(item);

  row.append(cb, thumb, info, del);
  item.row = { root: row, meta, track, fill, check: cb, del };
  return row;
}

function removeItem(item) {
  if (item.status === 'downloading') return;
  playlistItems = playlistItems.filter(i => i !== item);
  if (item.row) item.row.root.remove();
  if (!playlistItems.length) return clearPlaylist();
  updateCounts();
}

function setAllSelected(value) {
  playlistItems.forEach(i => {
    if (i.status === 'done' || i.status === 'downloading') return;
    i.selected = value;
    if (i.row) i.row.check.checked = value;
  });
  updateCounts();
}

function updateCounts() {
  const total    = playlistItems.length;
  const selected = playlistItems.filter(i => i.selected && i.status !== 'done').length;

  const countEl = document.getElementById('plCount');
  if (countEl) countEl.textContent = `${total} vídeo${total === 1 ? '' : 's'} encontrado${total === 1 ? '' : 's'}`;

  const btn = document.getElementById('plStart');
  if (btn) {
    btn.disabled = batchRunning || selected === 0;
    btn.textContent = `Baixar selecionados (${selected})`;
    btn.classList.toggle('hidden', batchRunning);
  }

  const cancelBtn = document.getElementById('plCancel');
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !batchRunning);
}

function setItemState(item, status, percent, text) {
  item.status = status;
  if (typeof percent === 'number') item.percent = percent;
  if (!item.row) return;

  const { root, meta, track, fill, check, del } = item.row;
  root.classList.toggle('is-done',  status === 'done');
  root.classList.toggle('is-error', status === 'error');
  check.disabled = del.disabled = (status === 'downloading');

  if (status === 'downloading') {
    track.classList.remove('hidden');
    fill.style.width = Math.max(0, Math.min(100, item.percent)) + '%';
  } else if (status === 'done') {
    track.classList.add('hidden');
  }

  if (text) meta.textContent = text;
  else meta.textContent = formatDuration(item.duration);
}

// ── fila sequencial ────────────────────────────────────────────
async function downloadItem(item) {
  setItemState(item, 'downloading', 0, 'Iniciando...');
  let failure = null;
  let wasCancelled = false;
  let downloadUrl = item.url;

  try {
    // URL de página → tenta extrair o m3u8 antes de baixar (mesma lógica do download único).
    // Se falhar (ex.: sites que o yt-dlp já suporta direto, como YouTube), usa a URL original.
    if (isPageUrl(item.url)) {
      setItemState(item, 'downloading', 0, 'Extraindo vídeo da página...');
      try {
        const extRes = await fetch(`${API}/extract`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: item.url }),
        });
        const extData = await extRes.json();
        if (extRes.ok && extData.m3u8) downloadUrl = extData.m3u8;
      } catch {
        // sem extração: cai no fluxo original com item.url
      }
    }

    await runDownload(downloadUrl, item.title, evt => {
      if (evt.type === 'progress') {
        const pct = (typeof evt.percent === 'number' && evt.percent >= 0) ? evt.percent : item.percent;
        setItemState(item, 'downloading', pct, evt.status || 'Baixando...');
      } else if (evt.type === 'done') {
        triggerSave(evt.url, evt.filename);
        setItemState(item, 'done', 100, 'Concluído');
      } else if (evt.type === 'stream') {
        triggerSave(evt.streamUrl, `${item.title || 'video'}.mp4`);
        setItemState(item, 'done', 100, 'Concluído');
      } else if (evt.type === 'cancelled') {
        wasCancelled = true;
      } else if (evt.type === 'error') {
        failure = evt.message;
      }
    });
  } catch (err) {
    failure = err.message;
  }

  if (wasCancelled) setItemState(item, 'error', item.percent, '⏹ Cancelado');
  else if (failure) setItemState(item, 'error', item.percent, failure);
  else if (item.status !== 'done') setItemState(item, 'error', item.percent, 'Falha no download.');
}

async function startBatch() {
  if (batchRunning) return;

  const queue = playlistItems.filter(i => i.selected && i.status !== 'done');
  if (!queue.length) return showError('Selecione ao menos um vídeo.');

  hideError();
  cancelRequested = false;
  batchRunning = true;
  setBusy(true);
  updateCounts();

  for (const item of queue) {
    if (cancelRequested) break;
    // pode ter sido removido ou desmarcado enquanto a fila andava
    if (!playlistItems.includes(item) || !item.selected) continue;
    await downloadItem(item);
  }

  batchRunning = false;
  currentJobId = null;
  setBusy(false);
  updateCounts();

  if (cancelRequested) {
    showError('Downloads cancelados.');
  } else {
    const failed = playlistItems.filter(i => i.status === 'error').length;
    if (failed) showError(`${failed} vídeo(s) falharam. Os demais foram baixados.`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('urlInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') startDownload();
  });
  input.addEventListener('input', () => {
    pageTitle = '';
    resolvedM3u8 = '';
    if (!batchRunning) clearPlaylist();
  });
});
