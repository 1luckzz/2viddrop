// Painel XVIDEOS/M3U8 — fila de links.
// Colar um link não baixa nada: ele entra na fila e é analisado em segundo
// plano. O download só começa em "Baixar todos", um item de cada vez.
const API = '';
const selectedFormat = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b';

let queue = [];
let seq = 0;
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

// ── streaming SSE de um download ───────────────────────────────
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

// ── entrada: um link ou vários de uma vez ──────────────────────
function extractLinks(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(t => /^https?:\/\/.+/i.test(t));
}

function makeItem(data) {
  return {
    id: ++seq,
    url: data.url,
    title: data.title || data.url,
    duration: data.duration || 0,
    thumbnail: data.thumbnail || '',
    m3u8: '',            // resolvido uma vez só, reusado se o item for re-tentado
    selected: true,
    status: 'idle',      // idle | analyzing | downloading | done | error
    percent: 0,
    note: '',
    pending: null,       // promessa da análise, aguardada antes do lote começar
    row: null,
  };
}

function addToQueue() {
  const input = document.getElementById('urlInput');
  const links = extractLinks(input.value);
  if (!links.length) return showError('Cole um link de vídeo válido.');

  hideError();

  let novos = 0;
  for (const raw of links) {
    const url = cleanUrl(raw);
    if (queue.some(i => i.url === url)) continue;
    const item = makeItem({ url });
    item.status = 'analyzing';
    item.note   = 'Analisando link...';
    queue.push(item);
    novos++;
    item.pending = resolveItem(item);
  }

  input.value = '';
  if (!novos) showError('Esses links já estão na fila.');
  render();
}

// ── análise (uma requisição por link, em paralelo) ─────────────
// Não marca erro quando a análise falha: o yt-dlp ainda pode dar conta do
// link direto na hora do download. Só o download decide se o item falhou.
async function resolveItem(item) {
  if (isM3u8(item.url)) {
    if (item.title === item.url) item.title = 'Link direto .m3u8';
    setItemState(item, 'idle', 0, '');
    return;
  }

  let entries = null;
  try {
    const res  = await fetch(`${API}/playlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url }),
    });
    const data = await res.json();
    if (res.ok && Array.isArray(data.entries)) entries = data.entries;
  } catch {}

  const pos = queue.indexOf(item);
  if (pos === -1) return;   // removido da fila enquanto analisava

  if (!entries || !entries.length) {
    setItemState(item, 'idle', 0, '');
    return;
  }

  if (entries.length === 1) {
    const e = entries[0];
    item.url       = e.url || item.url;
    item.title     = e.title || item.title;
    item.duration  = e.duration || 0;
    item.thumbnail = e.thumbnail || '';
    setItemState(item, 'idle', 0, '');
    return;
  }

  // página com vários vídeos: vira N itens na fila, no lugar deste
  const novos = entries
    .filter(e => e.url && !queue.some(i => i.url === e.url))
    .map(e => makeItem(e));
  queue.splice(pos, 1, ...novos);
  render();
}

// ── render da fila ─────────────────────────────────────────────
function render() {
  const box = document.getElementById('playlist');
  if (!box) return;

  box.textContent = '';
  box.classList.toggle('hidden', queue.length === 0);
  if (!queue.length) return;

  const head = document.createElement('div');
  head.className = 'pl-head';
  head.innerHTML =
    `<span id="plCount"></span>` +
    `<span class="pl-actions">` +
      `<button type="button" class="pl-link" id="plAll">Marcar todos</button>` +
      `<button type="button" class="pl-link" id="plNone">Desmarcar todos</button>` +
      `<button type="button" class="pl-link" id="plClear">Limpar fila</button>` +
    `</span>`;
  box.appendChild(head);

  const list = document.createElement('div');
  list.className = 'pl-list';
  box.appendChild(list);
  queue.forEach(item => list.appendChild(buildRow(item)));

  const foot = document.createElement('div');
  foot.className = 'pl-foot';
  foot.innerHTML =
    `<button type="button" id="plStart" class="pl-start"></button>` +
    `<button type="button" id="plCancel" class="pl-cancel hidden">Cancelar downloads</button>`;
  box.appendChild(foot);

  head.querySelector('#plAll').onclick   = () => setAllSelected(true);
  head.querySelector('#plNone').onclick  = () => setAllSelected(false);
  head.querySelector('#plClear').onclick = clearQueue;
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

  // textContent sempre: título e URL vêm de páginas de terceiros
  const title = document.createElement('div');
  title.className = 'pl-title';
  title.textContent = item.title;
  title.title = item.url;

  const meta = document.createElement('div');
  meta.className = 'pl-meta';

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
  del.title = 'Remover da fila';
  del.onclick = () => removeItem(item);

  row.append(cb, thumb, info, del);
  item.row = { root: row, meta, track, fill, check: cb, del };
  applyRowState(item);
  return row;
}

function removeItem(item) {
  if (item.status === 'downloading') return;
  queue = queue.filter(i => i !== item);
  render();
}

function clearQueue() {
  if (batchRunning) return;
  queue = [];
  hideError();
  render();
}

function setAllSelected(value) {
  queue.forEach(i => {
    if (i.status === 'done' || i.status === 'downloading') return;
    i.selected = value;
    if (i.row) i.row.check.checked = value;
  });
  updateCounts();
}

function updateCounts() {
  const total      = queue.length;
  const analisando = queue.filter(i => i.status === 'analyzing').length;
  const aBaixar    = queue.filter(i => i.selected && i.status !== 'done').length;

  const countEl = document.getElementById('plCount');
  if (countEl) {
    countEl.textContent = `${total} ${total === 1 ? 'link' : 'links'} na fila`
      + (analisando ? ` · ${analisando} analisando` : '');
  }

  const btn = document.getElementById('plStart');
  if (btn) {
    btn.disabled = batchRunning || aBaixar === 0;
    btn.textContent = `Baixar todos (${aBaixar})`;
    btn.classList.toggle('hidden', batchRunning);
  }

  const cancelBtn = document.getElementById('plCancel');
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !batchRunning);
}

// ── estado visual de um item ───────────────────────────────────
function applyRowState(item) {
  if (!item.row) return;
  const { root, meta, track, fill, check, del } = item.row;

  root.classList.toggle('is-done',  item.status === 'done');
  root.classList.toggle('is-error', item.status === 'error');
  check.disabled = del.disabled = (item.status === 'downloading');

  track.classList.toggle('hidden', item.status !== 'downloading');
  fill.style.width = Math.max(0, Math.min(100, item.percent)) + '%';

  meta.textContent = item.note || formatDuration(item.duration);
}

function setItemState(item, status, percent, note) {
  item.status = status;
  if (typeof percent === 'number') item.percent = percent;
  if (note !== undefined) item.note = note;
  applyRowState(item);
  updateCounts();
}

// ── download de um item da fila ────────────────────────────────
// Duas tentativas, nesta ordem:
//   1. a URL como o usuário colou — o yt-dlp tem extractor próprio para a
//      maioria dos sites e resolve sozinho;
//   2. só se a primeira falhar, o /extract raspa o m3u8 embutido na página
//      (vazounudes e os players que o incorporam).
// A ordem inversa quebrava todo site suportado pelo yt-dlp: o /extract
// devolvia um m3u8 fabricado e o download morria antes de começar.
async function downloadItem(item, posicao, total) {
  setItemState(item, 'downloading', 0, 'Iniciando...');
  const rotulo = `Link ${posicao} de ${total}`;
  setProgress(0, rotulo);
  setSpeed('');

  const primeira = await tryDownload(item, item.m3u8 || item.url, rotulo);
  if (primeira.ok || primeira.cancelled || cancelRequested) return finishItem(item, primeira);

  if (!item.m3u8 && isPageUrl(item.url)) {
    const m3u8 = await extractM3u8(item);
    if (m3u8) {
      item.m3u8 = m3u8;
      setItemState(item, 'downloading', 0, 'Tentando método alternativo...');
      const segunda = await tryDownload(item, m3u8, rotulo);
      if (segunda.ok || segunda.cancelled) return finishItem(item, segunda);
      // o erro do yt-dlp diz o que houve ("vídeo privado"); o do scraper não
      return finishItem(item, { ...segunda, erro: primeira.erro || segunda.erro });
    }
  }

  finishItem(item, primeira);
}

async function tryDownload(item, url, rotulo) {
  let ok = false, cancelled = false, erro = null;

  try {
    await runDownload(url, item.title, evt => {
      if (evt.type === 'progress') {
        const temPct = typeof evt.percent === 'number' && evt.percent >= 0;
        const pct    = temPct ? evt.percent : item.percent;
        // a linha do item mostra o número; a faixa de 4px sozinha é discreta demais
        const texto  = temPct ? `${evt.status || 'Baixando...'} ${Math.round(pct)}%`
                              : (evt.status || 'Baixando...');
        setItemState(item, 'downloading', pct, texto);
        setProgress(temPct ? pct : null, rotulo);
        setSpeed(evt.speed || '');
      } else if (evt.type === 'done') {
        triggerSave(evt.url, evt.filename);
        ok = true;
      } else if (evt.type === 'stream') {
        triggerSave(evt.streamUrl, `${item.title || 'video'}.mp4`);
        ok = true;
      } else if (evt.type === 'cancelled') {
        cancelled = true;
      } else if (evt.type === 'error') {
        erro = evt.message;
      }
    });
  } catch (err) {
    erro = err.message;
  }

  return { ok, cancelled, erro };
}

async function extractM3u8(item) {
  setItemState(item, 'downloading', 0, 'Extraindo vídeo da página...');
  try {
    const res  = await fetch(`${API}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: item.url }),
    });
    const data = await res.json();
    if (res.ok && data.m3u8) {
      if (data.title && item.title === item.url) item.title = data.title;
      return data.m3u8;
    }
  } catch {
    // sem extração: o erro da primeira tentativa é o que vale
  }
  return '';
}

function finishItem(item, r) {
  if (r.ok)        return setItemState(item, 'done', 100, 'Concluído');
  if (r.cancelled) return setItemState(item, 'error', item.percent, 'Cancelado');
  setItemState(item, 'error', item.percent, r.erro || 'Falha no download.');
}

// ── fila sequencial ────────────────────────────────────────────
// O lote não espera a análise de todos os links: começa pelo primeiro que
// ficar pronto e os demais seguem sendo analisados durante o download. Assim
// a análise de cada item se esconde atrás do download do anterior, e um link
// lento (ou que estoura o tempo) não trava a fila inteira.
function isQueued(item) {
  return item.selected && item.status !== 'done' && item.status !== 'downloading';
}

async function startBatch() {
  if (batchRunning) return;
  if (!queue.some(isQueued)) return showError('Selecione ao menos um link.');

  hideError();
  cancelRequested = false;
  batchRunning = true;
  setBusy(true);
  updateCounts();
  showProgress();   // o medidor acompanha o item atual da fila

  const feitos = new Set();
  let posicao  = 0;
  let esperas  = 0;   // trava de segurança: nunca girar sem alguém para esperar

  while (!cancelRequested) {
    const item = queue.find(i => isQueued(i) && !feitos.has(i) && i.status !== 'analyzing');

    if (!item) {
      const analisando = queue.filter(i => i.status === 'analyzing' && i.pending);
      if (!analisando.length || ++esperas > queue.length + 5) break;
      setProgress(0, 'Analisando links...');
      setSpeed('');
      await Promise.race(analisando.map(i => i.pending));
      continue;
    }

    esperas = 0;
    feitos.add(item);
    posicao++;
    // o total cresce se uma página se expandir em vários vídeos no meio do caminho
    const total = posicao + queue.filter(i => isQueued(i) && !feitos.has(i)).length;
    await downloadItem(item, posicao, total);
  }

  batchRunning = false;
  currentJobId = null;
  setBusy(false);
  updateCounts();
  hideProgress();

  if (cancelRequested) return showError('Downloads cancelados.');

  const falhas = queue.filter(i => i.status === 'error').length;
  if (falhas) showError(`${falhas} link(s) falharam. Os demais foram baixados.`);
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('urlInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') addToQueue();
    });
  }
  render();
});
