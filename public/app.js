const API = '';
let selectedFormat = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b';

function cleanUrl(url) {
  try {
    const u = new URL(url);
    ['list','index','start_radio','pp','si','feature','ab_channel'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

// IDs do HTML atual:
// #urlInput, #dlBtn, #progress, #bar, #status, #pct, #speed, #error

function showProgress() {
  document.getElementById('progress').classList.remove('hidden');
  document.getElementById('error').classList.add('hidden');
}

function hideProgress() {
  document.getElementById('progress').classList.add('hidden');
}

function setProgress(pct, status) {
  const bar    = document.getElementById('bar');
  const pctEl  = document.getElementById('pct');
  const statEl = document.getElementById('status');
  if (bar && pct !== null)    bar.style.width = pct + '%';
  if (pctEl && pct !== null)  pctEl.textContent = Math.round(pct) + '%';
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

async function startDownload() {
  const raw = document.getElementById('urlInput').value.trim();
  if (!raw) return showError('Cole um link de vídeo válido.');

  const url = cleanUrl(raw);
  document.getElementById('urlInput').value = url;

  showProgress();
  setProgress(0, 'Preparando...');
  setSpeed('');

  const btn = document.getElementById('dlBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`${API}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, format: selectedFormat, audioOnly: false }),
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
    setProgress(100, 'Concluído!');
    setSpeed('');
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
    if (evt.speed || evt.eta) {
      setSpeed(evt.speed || '');
    } else {
      setSpeed('');
    }
    return;
  }

  if (evt.type === 'done') {
    setProgress(100, 'Concluído!');
    setSpeed('');
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = evt.url;
      a.download = evt.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      hideProgress();
    }, 400);
    return;
  }

  if (evt.type === 'error') {
    showError(evt.message);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('urlInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') startDownload();
  });
});
