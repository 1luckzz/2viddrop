// Exercita public/app.js num DOM mínimo, com /playlist, /extract e /download simulados.
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const assert = require('assert');
const test   = require('node:test');

const APP = path.join(__dirname, '..', 'public', 'app.js');

// ── DOM mínimo ────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: tag, children: [], _classes: new Set(), style: {}, dataset: {},
    textContent: '', title: '', type: '', checked: false, disabled: false,
    classList: {
      add:    c => el._classes.add(c),
      remove: c => el._classes.delete(c),
      toggle: (c, on) => { const v = on === undefined ? !el._classes.has(c) : on;
                           v ? el._classes.add(c) : el._classes.delete(c); },
      contains: c => el._classes.has(c),
    },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    append(...cs)  { cs.forEach(c => el.appendChild(c)); },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(c => c !== el); },
    // innerHTML só recebe markup fixo do próprio app.js: extraímos os ids
    set innerHTML(html) {
      el.children = [];
      for (const m of html.matchAll(/<(\w+)[^>]*id="([^"]+)"[^>]*>/g)) {
        const c = makeEl(m[1]); c.id = m[2]; el.appendChild(c);
      }
    },
    querySelector(sel) {
      const id = sel.replace('#', '');
      const walk = n => n.children.find(c => c.id === id) ||
                        n.children.reduce((a, c) => a || walk(c), null);
      return walk(el);
    },
  };
  Object.defineProperty(el, 'className', { set: v => { el._classes = new Set(v.split(/\s+/).filter(Boolean)); },
                                           get: () => [...el._classes].join(' ') });
  return el;
}

function makeDom() {
  const byId = {};
  for (const id of ['urlInput','dlBtn','playlist','progress','bar','pct','status','speed','error']) {
    byId[id] = makeEl('div'); byId[id].id = id;
  }
  byId.urlInput.value = '';
  return {
    byId,
    document: {
      getElementById: id => byId[id] || null,
      createElement: makeEl,
      addEventListener: () => {},
      body: makeEl('body'),
    },
  };
}

// ── carrega app.js num sandbox ────────────────────────────────
function load(fetchImpl) {
  const dom = makeDom();
  const saves = [];
  const ctx = {
    document: dom.document,
    fetch: fetchImpl,
    URL, TextDecoder, console,
    setTimeout, clearTimeout, Promise, Math, Date, JSON, String, Number, Array, Object, Set,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(APP, 'utf8'), ctx);

  // `queue` é declarado com let: não vira propriedade do global do sandbox
  const read = expr => vm.runInContext(expr, ctx);
  // triggerSave usa <a>.click(), que o DOM mínimo não tem: registramos as chamadas
  ctx.triggerSave = (url, name) => saves.push({ url, name });

  const settle = () => read('Promise.allSettled(queue.map(i => i.pending))');
  return { ctx, dom, saves, read, q: () => read('queue'), settle };
}

// resposta SSE de um download que vai a 50% e conclui
function sseBody(filename) {
  const linhas = [
    `data: ${JSON.stringify({ type: 'start', jobId: 'j1' })}\n`,
    `data: ${JSON.stringify({ type: 'progress', percent: 50, status: 'Baixando...', speed: '2MiB/s' })}\n`,
    `data: ${JSON.stringify({ type: 'done', url: '/f/' + filename, filename })}\n`,
  ];
  let i = 0;
  return { getReader: () => ({ read: async () => i < linhas.length
      ? { done: false, value: Buffer.from(linhas[i++]) }
      : { done: true, value: undefined } }) };
}

// SSE de um download que morre no meio com uma mensagem do yt-dlp
function sseErro(msg) {
  const linhas = [
    `data: ${JSON.stringify({ type: 'start', jobId: 'j1' })}\n`,
    `data: ${JSON.stringify({ type: 'error', message: msg })}\n`,
  ];
  let i = 0;
  return { getReader: () => ({ read: async () => i < linhas.length
      ? { done: false, value: Buffer.from(linhas[i++]) }
      : { done: true, value: undefined } }) };
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// ── fila ──────────────────────────────────────────────────────
test('três links diferentes viram três itens e baixam todos, em ordem', async () => {
  const baixados = [];
  const { ctx, dom, saves, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({ error: 'sem lista' }) };
    if (url.endsWith('/download')) { baixados.push(body.url); return { ok: true, body: sseBody('v.mp4') }; }
    return { ok: true, json: async () => ({}) };
  });

  dom.byId.urlInput.value = 'https://site.com/a https://site.com/b\nhttps://site.com/c';
  ctx.addToQueue();
  assert.strictEqual(q().length, 3, 'os três links entram na fila');
  await settle();

  await ctx.startBatch();
  assert.deepStrictEqual(baixados,
    ['https://site.com/a', 'https://site.com/b', 'https://site.com/c'],
    'baixa um de cada vez, na ordem da fila');
  assert.deepStrictEqual(Array.from(q(), i => i.status), ['done', 'done', 'done']);
  assert.strictEqual(saves.length, 3, 'um arquivo salvo por item');
});

test('link duplicado não entra duas vezes', async () => {
  const { ctx, dom, q, settle } = load(async () => ({ ok: false, json: async () => ({}) }));
  dom.byId.urlInput.value = 'https://site.com/a';
  ctx.addToQueue();
  dom.byId.urlInput.value = 'https://site.com/a';
  ctx.addToQueue();
  await settle();
  assert.strictEqual(q().length, 1);
  assert.ok(!dom.byId.error.classList.contains('hidden'), 'avisa que já está na fila');
});

test('página com vários vídeos é expandida em N itens', async () => {
  const { ctx, dom, q, settle } = load(async (url) => {
    if (url.endsWith('/playlist')) return { ok: true, json: async () => ({ entries: [
      { url: 'https://site.com/v1', title: 'Um',   duration: 61 },
      { url: 'https://site.com/v2', title: 'Dois', duration: 30 },
    ] }) };
    return { ok: false, json: async () => ({}) };
  });

  dom.byId.urlInput.value = 'https://site.com/canal';
  ctx.addToQueue();
  await settle();
  assert.strictEqual(q().length, 2);
  assert.deepStrictEqual(Array.from(q(), i => i.title), ['Um', 'Dois']);
  assert.strictEqual(ctx.formatDuration(61), '1:01');
});

test('um link quebrado no meio não derruba os outros', async () => {
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/extract'))  return { ok: false, json: async () => ({ error: 'nada na página' }) };
    if (url.endsWith('/download')) {
      if (body.url.includes('/ruim')) return { ok: false, json: async () => ({ error: 'Vídeo indisponível.' }) };
      return { ok: true, body: sseBody('v.mp4') };
    }
  });

  dom.byId.urlInput.value = 'https://site.com/ok1 https://site.com/ruim https://site.com/ok2';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();

  assert.deepStrictEqual(Array.from(q(), i => i.status), ['done', 'error', 'done']);
  assert.strictEqual(q()[1].note, 'Vídeo indisponível.');
  assert.strictEqual(dom.byId.error.textContent, '1 link(s) falharam. Os demais foram baixados.');
});

test('.m3u8 direto pula a análise e não passa pelo /extract', async () => {
  const chamadas = [];
  const { ctx, dom, q, settle } = load(async (url) => {
    chamadas.push(url);
    if (url.endsWith('/download')) return { ok: true, body: sseBody('v.mp4') };
    return { ok: false, json: async () => ({}) };
  });

  dom.byId.urlInput.value = 'https://cdn.com/stream.m3u8';
  ctx.addToQueue();
  await settle();
  assert.strictEqual(q()[0].title, 'Link direto .m3u8');
  await ctx.startBatch();
  assert.deepStrictEqual(chamadas, ['/download'], 'nem /playlist nem /extract são chamados');
});

test('cancelar no meio interrompe a fila e não baixa o restante', async () => {
  const baixados = [];
  let ctxRef;
  const { ctx, dom, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.startsWith('/cancel')) return { ok: true, json: async () => ({}) };
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/download')) {
      baixados.push(body.url);
      await ctxRef.cancelCurrentJob();   // cancela assim que o primeiro começa
      return { ok: true, body: sseBody('v.mp4') };
    }
  });
  ctxRef = ctx;

  dom.byId.urlInput.value = 'https://site.com/a https://site.com/b https://site.com/c';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();

  assert.strictEqual(baixados.length, 1, 'só o primeiro chegou a iniciar');
  assert.strictEqual(dom.byId.error.textContent, 'Downloads cancelados.');
});

test('desmarcado fica de fora e concluído não repete', async () => {
  const baixados = [];
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/download')) { baixados.push(body.url); return { ok: true, body: sseBody('v.mp4') }; }
  });

  dom.byId.urlInput.value = 'https://site.com/a https://site.com/b';
  ctx.addToQueue();
  await settle();
  q()[1].selected = false;

  await ctx.startBatch();
  assert.deepStrictEqual(baixados, ['https://site.com/a']);

  // segunda rodada: 'a' já está done, só 'b' (remarcado) deve baixar
  q()[1].selected = true;
  await ctx.startBatch();
  assert.deepStrictEqual(baixados, ['https://site.com/a', 'https://site.com/b']);
});

test('limpar fila esvazia e esconde a caixa', async () => {
  const { ctx, dom, q, settle } = load(async () => ({ ok: false, json: async () => ({}) }));
  dom.byId.urlInput.value = 'https://site.com/a https://site.com/b';
  ctx.addToQueue();
  await settle();
  assert.ok(!dom.byId.playlist.classList.contains('hidden'));
  ctx.clearQueue();
  assert.strictEqual(q().length, 0);
  assert.ok(dom.byId.playlist.classList.contains('hidden'));
});

// ── ordem das tentativas de download ──────────────────────────
test('o yt-dlp tenta a URL da página primeiro; o /extract nem é chamado', async () => {
  // era o bug do Pornhub: o /extract fabricava um m3u8 e o download morria
  const chamadas = [];
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    chamadas.push(url);
    if (url.endsWith('/playlist')) return { ok: true, json: async () => ({ entries: [
      { url: body.url, title: 'Vídeo do site', duration: 867 },
    ] }) };
    if (url.endsWith('/download')) return { ok: true, body: sseBody('v.mp4') };
    return { ok: false, json: async () => ({}) };
  });

  dom.byId.urlInput.value = 'https://pt.pornhub.com/view_video.php?viewkey=abc';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();

  assert.deepStrictEqual(chamadas, ['/playlist', '/download']);
  assert.ok(!chamadas.includes('/extract'), 'o scraper fica fora do caminho feliz');
  assert.strictEqual(q()[0].status, 'done');
});

test('quando o yt-dlp falha, o /extract entra como segunda tentativa', async () => {
  const chamadas = [];
  const baixados = [];
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    chamadas.push(url);
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/extract'))  return { ok: true, json: async () => ({
      m3u8: 'https://vazounudes.net/hls/UID/480p/video.m3u8', title: 'Do scraper' }) };
    if (url.endsWith('/download')) {
      baixados.push(body.url);
      return body.url.includes('.m3u8')
        ? { ok: true, body: sseBody('v.mp4') }
        : { ok: true, body: sseErro('Unsupported URL') };
    }
  });

  dom.byId.urlInput.value = 'https://xvideosputaria.com/video123';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();

  assert.deepStrictEqual(chamadas, ['/playlist', '/download', '/extract', '/download']);
  assert.deepStrictEqual(baixados, [
    'https://xvideosputaria.com/video123',
    'https://vazounudes.net/hls/UID/480p/video.m3u8',
  ], 'a página primeiro, o m3u8 raspado depois');
  assert.strictEqual(q()[0].status, 'done');
  assert.strictEqual(q()[0].m3u8, 'https://vazounudes.net/hls/UID/480p/video.m3u8',
    'o m3u8 fica guardado no item para uma re-tentativa');
});

test('falhando as duas tentativas, o erro mostrado é o do yt-dlp', async () => {
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/extract'))  return { ok: true, json: async () => ({ m3u8: 'https://x.com/f.m3u8' }) };
    if (url.endsWith('/download')) {
      return body.url.includes('.m3u8')
        ? { ok: true, body: sseErro('Falha no download (método alternativo também falhou).') }
        : { ok: true, body: sseErro('Vídeo privado.') };
    }
  });

  dom.byId.urlInput.value = 'https://site.com/privado';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();

  assert.strictEqual(q()[0].status, 'error');
  assert.strictEqual(q()[0].note, 'Vídeo privado.',
    'a mensagem do yt-dlp diz o que houve; a do scraper não');
});

// ── análise não bloqueia o download ───────────────────────────
test('o download do primeiro começa antes de a análise dos outros terminar', async () => {
  let liberar;
  const preso = new Promise(r => { liberar = r; });
  const eventos = [];

  const { ctx, dom, q } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) {
      if (body.url.includes('/lento')) await preso;
      eventos.push('analisou ' + body.url);
      return { ok: false, json: async () => ({}) };
    }
    if (url.endsWith('/download')) { eventos.push('baixou ' + body.url); return { ok: true, body: sseBody('v.mp4') }; }
    return { ok: false, json: async () => ({}) };
  });

  dom.byId.urlInput.value = 'https://site.com/rapido https://site.com/lento';
  ctx.addToQueue();
  await tick();                     // a análise do rápido termina; a do lento fica presa

  const lote = ctx.startBatch();    // não espera a análise do lento
  await tick();

  assert.deepStrictEqual(eventos, [
    'analisou https://site.com/rapido',
    'baixou https://site.com/rapido',
  ], 'baixou o primeiro com o segundo ainda em análise');

  liberar();
  await lote;

  assert.deepStrictEqual(eventos.slice(2), [
    'analisou https://site.com/lento',
    'baixou https://site.com/lento',
  ], 'o segundo entra assim que a análise dele termina');
  assert.deepStrictEqual(Array.from(q(), i => i.status), ['done', 'done']);
});

test('a fila não gira em falso quando nada mais pode ser baixado', async () => {
  const { ctx, dom, q, settle } = load(async (url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    if (url.endsWith('/playlist')) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/download')) return { ok: true, body: sseBody('v.mp4') };
  });

  dom.byId.urlInput.value = 'https://site.com/a';
  ctx.addToQueue();
  await settle();
  q()[0].selected = false;

  // nenhum item elegível: precisa retornar em vez de girar no while
  await ctx.startBatch();
  assert.strictEqual(dom.byId.error.textContent, 'Selecione ao menos um link.');
});
