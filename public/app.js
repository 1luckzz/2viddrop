let hasRealProgress = false;

async function startDownload() {
  const url = document.getElementById('urlInput').value.trim();
  if (!url) return;

  hasRealProgress = false;
  hide('error');
  show('progress');
  setProgress(0, 'Iniciando...');
  document.getElementById('dlBtn').disabled = true;

  try {
    const res = await fetch('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
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
    hide('progress');
    showError(err.message);
  } finally {
    document.getElementById('dlBtn').disabled = false;
  }
}

function handleEvent(evt) {
  if (evt.type === 'progress') {
    if (evt.percent >= 0) hasRealProgress = true;
    if (evt.percent < 0 && hasRealProgress) return;
    setProgress(evt.percent >= 0 ? evt.percent : null, evt.status);
    document.getElementById('speed').textContent =
      evt.speed ? `${evt.speed}${evt.eta ? ' · ETA ' + evt.eta : ''}` : '';
  }
  if (evt.type === 'done') {
    setProgress(100, 'Concluído');
    document.getElementById('speed').textContent = '';
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = evt.url;
      a.download = evt.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, 400);
  }
  if (evt.type === 'error') {
    hide('progress');
    showError(evt.message);
  }
}

function setProgress(pct, text) {
  if (pct !== null) {
    document.getElementById('bar').style.width = pct + '%';
    document.getElementById('pct').textContent = Math.round(pct) + '%';
  }
  document.getElementById('status').textContent = text;
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});
