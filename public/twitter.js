// Painel Twitter/X — fila de posts, isolada do downloader M3U8.
// Só mexe em elementos com id próprio (mode*, tw*); nada do app.js é usado.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const btnM3u8    = $('modeM3u8');
  const btnTwitter = $('modeTwitter');
  const paneM3u8   = $('paneM3u8');
  const paneTw     = $('paneTwitter');
  if (!btnM3u8 || !btnTwitter || !paneM3u8 || !paneTw) return;

  const input       = $('twInput');
  const btnAdd      = $('twBtn');
  const erroGeral   = $('twErro');
  const caixaFila   = $('twFila');
  const contador    = $('twCount');
  const listaEl     = $('twLista');
  const btnLimpar   = $('twLimpar');
  const btnTodos    = $('twBaixarTodos');

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

  // ── estado ────────────────────────────────────────────────
  let fila = [];
  let seq  = 0;

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

  function mostrarErroGeral(msg) {
    erroGeral.textContent = msg;
    erroGeral.classList.remove('hidden');
  }
  function limparErroGeral() { erroGeral.classList.add('hidden'); }

  // ── entrada: aceita um link ou vários de uma vez ───────────
  function extrairLinks(texto) {
    return String(texto || '')
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(t => t.length > 6 && /(^https?:\/\/|^(www\.|mobile\.|m\.)?(x|twitter)\.com)/i.test(t));
  }

  function adicionar() {
    limparErroGeral();
    const links = extrairLinks(input.value);
    if (!links.length) {
      return mostrarErroGeral('Cole um link válido de um post do Twitter/X.');
    }

    let novos = 0;
    for (const url of links) {
      // o mesmo post duas vezes não precisa de duas buscas
      if (fila.some(i => i.url === url)) continue;
      const item = { id: ++seq, url, status: 'buscando', dados: null, escolha: 0, erro: '' };
      fila.push(item);
      novos++;
      resolver(item);   // busca já na entrada: quando for baixar, já está pronto
    }

    input.value = '';
    if (!novos) mostrarErroGeral('Esses links já estão na fila.');
    render();
  }

  // ── resolução (uma requisição por item, em paralelo) ───────
  // O servidor corta em 25s; damos folga e desistimos em 45s. Sem isto, uma
  // resposta que nunca chega deixa o item preso em "Buscando..." pra sempre.
  const TIMEOUT_MS = 45000;

  async function resolver(item) {
    const corte = new AbortController();
    const alarme = setTimeout(() => corte.abort(), TIMEOUT_MS);
    try {
      const res = await fetch('/api/twitter/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.url }),
        signal: corte.signal,
      });

      let data = {};
      try { data = await res.json(); } catch {}

      if (!res.ok || !data.success || !data.formats || !data.formats.length) {
        item.status = 'erro';
        item.erro = data.error || 'Não foi possível processar o vídeo agora. Tente novamente.';
      } else {
        item.status = 'pronto';
        item.dados = data;
      }
    } catch (e) {
      item.status = 'erro';
      item.erro = e && e.name === 'AbortError'
        ? 'O servidor demorou demais para responder. Tente novamente.'
        : 'Não foi possível processar o vídeo agora. Tente novamente.';
    } finally {
      clearTimeout(alarme);
    }
    render();
  }

  // ── download ──────────────────────────────────────────────
  function baixarItem(item) {
    if (item.status !== 'pronto') return;
    const f = item.dados.formats[item.escolha] || item.dados.formats[0];
    const a = document.createElement('a');
    a.href = `/api/twitter/download/${encodeURIComponent(f.token)}`;
    a.setAttribute('download', '');
    document.body.appendChild(a);
    a.click();
    a.remove();
    item.status = 'baixado';
    render();
  }

  async function baixarTodos() {
    const prontos = fila.filter(i => i.status === 'pronto');
    if (!prontos.length) return;
    btnTodos.disabled = true;
    // um de cada vez, com folga: o navegador bloqueia downloads em rajada
    for (const item of prontos) {
      baixarItem(item);
      await new Promise(r => setTimeout(r, 900));
    }
    btnTodos.disabled = false;
  }

  function remover(item) {
    fila = fila.filter(i => i !== item);
    render();
  }

  // ── render ────────────────────────────────────────────────
  function render() {
    caixaFila.classList.toggle('hidden', fila.length === 0);
    listaEl.textContent = '';

    const prontos = fila.filter(i => i.status === 'pronto').length;
    const buscando = fila.filter(i => i.status === 'buscando').length;

    contador.textContent = fila.length === 1 ? '1 link na fila' : `${fila.length} links na fila`
      + (buscando ? ` · ${buscando} buscando` : '');

    btnTodos.textContent = `Baixar todos (${prontos})`;
    btnTodos.disabled = prontos === 0;

    for (const item of fila) listaEl.appendChild(linha(item));
  }

  function linha(item) {
    const row = document.createElement('div');
    row.className = 'tw-item';
    if (item.status === 'erro')    row.classList.add('is-error');
    if (item.status === 'baixado') row.classList.add('is-done');

    // miniatura
    const thumb = document.createElement('div');
    thumb.className = 'tw-item-thumb';
    if (item.dados && item.dados.thumbnail) {
      const img = document.createElement('img');
      img.src = item.dados.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      thumb.appendChild(img);
    }

    // informação
    const info = document.createElement('div');
    info.className = 'tw-item-info';

    const topo = document.createElement('div');
    topo.className = 'tw-item-topo';
    // textContent sempre: o texto do post é conteúdo de terceiro
    topo.textContent = item.dados && item.dados.author
      ? `@${String(item.dados.author).replace(/^@/, '')}`
      : item.url;

    const meio = document.createElement('div');
    meio.className = 'tw-item-texto';
    if (item.status === 'buscando')   meio.textContent = 'Buscando vídeo...';
    else if (item.status === 'erro')  meio.textContent = item.erro;
    else if (item.dados)              meio.textContent = item.dados.title || '';

    info.append(topo, meio);

    // duração + escolha de qualidade
    if (item.status === 'pronto' || item.status === 'baixado') {
      const baixo = document.createElement('div');
      baixo.className = 'tw-item-baixo';

      const dur = formatarDuracao(item.dados.duration);
      if (dur) {
        const d = document.createElement('span');
        d.className = 'tw-item-dur';
        d.textContent = dur;
        baixo.appendChild(d);
      }

      const sel = document.createElement('select');
      sel.className = 'tw-select';
      sel.setAttribute('aria-label', 'Qualidade');
      item.dados.formats.forEach((f, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        const tam = formatarTamanho(f.filesize);
        o.textContent = `${f.quality} — ${String(f.ext || 'mp4').toUpperCase()}`
                      + (tam ? ` · ~${tam}` : '');
        sel.appendChild(o);
      });
      sel.value = String(item.escolha);
      sel.onchange = () => { item.escolha = Number(sel.value); };
      baixo.appendChild(sel);

      info.appendChild(baixo);
    }

    // ações
    const acoes = document.createElement('div');
    acoes.className = 'tw-item-acoes';

    if (item.status === 'pronto' || item.status === 'baixado') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tw-download';
      b.textContent = item.status === 'baixado' ? 'Baixar de novo' : 'Baixar';
      b.onclick = () => { item.status = 'pronto'; baixarItem(item); };
      acoes.appendChild(b);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tw-del';
    del.textContent = '×';
    del.title = 'Remover da fila';
    del.onclick = () => remover(item);
    acoes.appendChild(del);

    row.append(thumb, info, acoes);
    return row;
  }

  // ── eventos ───────────────────────────────────────────────
  btnAdd.addEventListener('click', adicionar);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') adicionar(); });
  btnLimpar.addEventListener('click', () => { fila = []; limparErroGeral(); render(); });
  btnTodos.addEventListener('click', baixarTodos);
})();
