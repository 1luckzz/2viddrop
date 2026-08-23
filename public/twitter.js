// Painel Twitter/X — isolado do downloader M3U8.
// Só mexe em elementos com id próprio (mode*, tw*); nada do app.js é usado.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const btnM3u8    = $('modeM3u8');
  const btnTwitter = $('modeTwitter');
  const paneM3u8   = $('paneM3u8');
  const paneTw     = $('paneTwitter');
  if (!btnM3u8 || !btnTwitter || !paneM3u8 || !paneTw) return;

  const input   = $('twInput');
  const buscar  = $('twBtn');
  const status  = $('twStatus');
  const erro    = $('twErro');
  const result  = $('twResult');
  const thumb   = $('twThumb');
  const autor   = $('twAuthor');
  const texto   = $('twText');
  const duracao = $('twDur');
  const lista   = $('twFormats');

  // ── troca de modo (sem recarregar a página) ────────────────
  function selecionar(modo) {
    const ehTw = modo === 'twitter';
    paneM3u8.classList.toggle('hidden', ehTw);
    paneTw.classList.toggle('hidden', !ehTw);
    btnM3u8.classList.toggle('is-active', !ehTw);
    btnTwitter.classList.toggle('is-active', ehTw);
    btnM3u8.setAttribute('aria-selected', String(!ehTw));
    btnTwitter.setAttribute('aria-selected', String(ehTw));
    if (ehTw) input.focus();
  }

  btnM3u8.addEventListener('click', () => selecionar('m3u8'));
  btnTwitter.addEventListener('click', () => selecionar('twitter'));

  // ── formatação ────────────────────────────────────────────
  function formatarDuracao(seg) {
    if (typeof seg !== 'number' || seg <= 0) return '';
    const m = Math.floor(seg / 60);
    const s = Math.floor(seg % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatarTamanho(bytes) {
    if (typeof bytes !== 'number' || bytes <= 0) return '';
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
  }

  // ── estados da tela ───────────────────────────────────────
  function mostrarErro(msg) {
    status.classList.add('hidden');
    result.classList.add('hidden');
    erro.textContent = msg;
    erro.classList.remove('hidden');
  }

  function mostrarStatus(msg) {
    erro.classList.add('hidden');
    status.textContent = msg;
    status.classList.remove('hidden');
  }

  function limpar() {
    erro.classList.add('hidden');
    status.classList.add('hidden');
    result.classList.add('hidden');
    lista.textContent = '';
  }

  // ── render dos formatos ───────────────────────────────────
  function renderFormatos(formats) {
    lista.textContent = '';

    formats.forEach(f => {
      const linha = document.createElement('div');
      linha.className = 'tw-format';

      const info = document.createElement('div');
      info.className = 'tw-format-info';

      const q = document.createElement('span');
      q.className = 'tw-quality';
      q.textContent = `${f.quality} — ${String(f.ext || 'mp4').toUpperCase()}`;

      const det = document.createElement('span');
      det.className = 'tw-detail';
      const partes = [];
      if (f.width && f.height) partes.push(`${f.width}×${f.height}`);
      if (f.bitrate) partes.push(`${f.bitrate} kbps`);
      const tam = formatarTamanho(f.filesize);
      if (tam) partes.push(`~${tam}`);
      det.textContent = partes.join(' · ');

      info.append(q, det);

      // O href usa só o token emitido pelo servidor — o cliente nunca
      // manipula a URL real da mídia.
      const baixar = document.createElement('a');
      baixar.className = 'tw-download';
      baixar.href = `/api/twitter/download/${encodeURIComponent(f.token)}`;
      baixar.textContent = 'Baixar';
      baixar.setAttribute('download', '');

      linha.append(info, baixar);
      lista.appendChild(linha);
    });
  }

  function renderResultado(data) {
    if (data.thumbnail) {
      thumb.src = data.thumbnail;
      thumb.parentElement.classList.remove('hidden');
    } else {
      thumb.removeAttribute('src');
      thumb.parentElement.classList.add('hidden');
    }

    // textContent em tudo: o texto do post é conteúdo de terceiro
    autor.textContent   = data.author ? `@${String(data.author).replace(/^@/, '')}` : '';
    texto.textContent   = data.title || '';
    duracao.textContent = formatarDuracao(data.duration);

    renderFormatos(data.formats || []);

    status.classList.add('hidden');
    erro.classList.add('hidden');
    result.classList.remove('hidden');
  }

  // ── busca ─────────────────────────────────────────────────
  let buscando = false;

  async function resolver() {
    if (buscando) return;
    const url = (input.value || '').trim();
    if (!url) return mostrarErro('Cole um link válido de um post do Twitter/X.');

    buscando = true;
    buscar.disabled = true;
    limpar();
    mostrarStatus('Buscando vídeo...');

    try {
      const res = await fetch('/api/twitter/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      let data = {};
      try { data = await res.json(); } catch {}

      if (!res.ok || !data.success) {
        return mostrarErro(data.error || 'Não foi possível processar o vídeo agora. Tente novamente.');
      }
      if (!data.formats || !data.formats.length) {
        return mostrarErro('Esse post não contém um vídeo.');
      }
      renderResultado(data);
    } catch {
      mostrarErro('Não foi possível processar o vídeo agora. Tente novamente.');
    } finally {
      buscando = false;
      buscar.disabled = false;
    }
  }

  buscar.addEventListener('click', resolver);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') resolver(); });
})();
