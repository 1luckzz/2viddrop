'use strict';

// Módulo de auth montado num Express de teste, com repositório em memória.
// Sem Supabase: o que se testa aqui é cookie, guardas e rotas.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert  = require('node:assert');
const http    = require('node:http');
const express = require('express');

const { montarAuth }  = require('../auth');
const { criarSessao } = require('../auth/sessao');
const { criarRepositorioMemoria } = require('./apoio/repositorio-memoria');

const ADMIN   = 'Dono@Meekz.com';     // maiúsculas de propósito: a comparação ignora caixa
const SEGREDO = 'segredo-de-teste-com-bastante-tamanho';
const SENHA   = 'senha-forte-123';
const { assinar } = criarSessao(SEGREDO);

// ── servidor de teste ─────────────────────────────────────────
function subir() {
  const app  = express();
  const repo = criarRepositorioMemoria();
  app.use(express.json());
  const mw = montarAuth(app, { repositorio: repo, adminEmail: ADMIN, segredoSessao: SEGREDO });

  app.get('/pagina',     mw.exigirAprovadoPagina, (req, res) => res.send('pagina'));
  app.post('/protegida', mw.exigirAprovadoApi,    (req, res) => res.json({ ok: true, email: req.usuario.email }));
  app.get('/painel',     mw.exigirAdminPagina,    (req, res) => res.send('painel'));
  app.get('/so-admin',   mw.exigirAdminApi,       (req, res) => res.json({ ok: true }));
  app.get('/entrar',     mw.redirecionarLogado,   (req, res) => res.send('entrar'));
  app.get('/espera',     mw.exigirAguardando,     (req, res) => res.send('espera'));

  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ server, repo, porta: server.address().port })));
}

// cliente HTTP mínimo que guarda o cookie entre pedidos
function cliente(porta) {
  let cookie = '';
  async function pedir(metodo, caminho, corpo, opcoes = {}) {
    const headers = { ...(opcoes.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let body;
    if (corpo !== undefined) {
      headers['Content-Type'] = opcoes.contentType || 'application/json';
      body = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
    }
    const res = await fetch(`http://127.0.0.1:${porta}${caminho}`, { method: metodo, headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    const texto = await res.text();
    try { json = JSON.parse(texto); } catch {}
    return { status: res.status, json, texto, local: res.headers.get('location'), setCookie: set };
  }
  return { pedir, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
}

let ctx;
before(async () => { ctx = await subir(); });
after(() => ctx.server.close());

// Cria a conta direto no repositório e põe o cookie no cliente, sem passar
// pelas rotas (que só existem na Tarefa 4). Devolve o perfil.
async function entrarDireto(c, email, senha = SENHA) {
  const perfil = await ctx.repo.criarUsuario(email, senha);
  c.cookie = `meekz_sessao=${assinar({ id: perfil.id, email: perfil.email })}`;
  return perfil;
}

// ── guardas ───────────────────────────────────────────────────
describe('anônimo', () => {
  test('página protegida redireciona para /login', async () => {
    const r = await cliente(ctx.porta).pedir('GET', '/pagina');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.local, '/login');
  });

  test('API protegida responde 401 com mensagem', async () => {
    const r = await cliente(ctx.porta).pedir('POST', '/protegida', {});
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.json.error, 'Faça login para continuar.');
  });

  test('/entrar mostra a página; /espera manda para /login', async () => {
    const c = cliente(ctx.porta);
    assert.strictEqual((await c.pedir('GET', '/entrar')).status, 200);
    const r = await c.pedir('GET', '/espera');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.local, '/login');
  });

  test('cookie adulterado é tratado como anônimo', async () => {
    const c = cliente(ctx.porta);
    c.cookie = 'meekz_sessao=abc.def';
    const r = await c.pedir('POST', '/protegida', {});
    assert.strictEqual(r.status, 401);
  });
});

describe('pendente', () => {
  test('página protegida redireciona para /aguardando e API responde 403', async () => {
    const c = cliente(ctx.porta);
    await entrarDireto(c, 'pendente@exemplo.com');
    const pagina = await c.pedir('GET', '/pagina');
    assert.strictEqual(pagina.status, 302);
    assert.strictEqual(pagina.local, '/aguardando');
    const api = await c.pedir('POST', '/protegida', {});
    assert.strictEqual(api.status, 403);
    assert.strictEqual(api.json.error, 'Sua conta ainda não foi aprovada.');
  });

  test('/entrar manda para /aguardando; /espera mostra a página; /painel manda para /aguardando', async () => {
    const c = cliente(ctx.porta);
    await entrarDireto(c, 'pendente2@exemplo.com');
    assert.strictEqual((await c.pedir('GET', '/entrar')).local, '/aguardando');
    assert.strictEqual((await c.pedir('GET', '/espera')).status, 200);
    assert.strictEqual((await c.pedir('GET', '/painel')).local, '/aguardando');
  });
});

describe('aprovado e bloqueado', () => {
  test('aprovado passa nas guardas de página e API, e é mandado de /entrar e /espera para /', async () => {
    const c = cliente(ctx.porta);
    const perfil = await entrarDireto(c, 'aprovado@exemplo.com');
    await ctx.repo.mudarStatus(perfil.id, 'approved');

    assert.strictEqual((await c.pedir('GET', '/pagina')).status, 200);
    const api = await c.pedir('POST', '/protegida', {});
    assert.strictEqual(api.status, 200);
    assert.strictEqual(api.json.email, 'aprovado@exemplo.com');
    assert.strictEqual((await c.pedir('GET', '/entrar')).local, '/');
    assert.strictEqual((await c.pedir('GET', '/espera')).local, '/');
    assert.strictEqual((await c.pedir('GET', '/painel')).local, '/', 'aprovado comum não é admin');
    assert.strictEqual((await c.pedir('GET', '/so-admin')).status, 403);
  });

  test('bloqueado recebe 403 com a mensagem de bloqueio', async () => {
    const c = cliente(ctx.porta);
    const perfil = await entrarDireto(c, 'bloqueado@exemplo.com');
    await ctx.repo.mudarStatus(perfil.id, 'blocked');
    const api = await c.pedir('POST', '/protegida', {});
    assert.strictEqual(api.status, 403);
    assert.strictEqual(api.json.error, 'Seu acesso foi bloqueado.');
    assert.strictEqual((await c.pedir('GET', '/pagina')).local, '/aguardando');
  });
});

describe('admin', () => {
  test('ADMIN_EMAIL pendente é aprovado e admin, mesmo cadastrado em minúsculas', async () => {
    const c = cliente(ctx.porta);
    await entrarDireto(c, 'dono@meekz.com');
    assert.strictEqual((await c.pedir('GET', '/pagina')).status, 200);
    assert.strictEqual((await c.pedir('GET', '/painel')).status, 200);
    assert.strictEqual((await c.pedir('GET', '/so-admin')).status, 200);
  });
});

describe('cookie de usuário que sumiu do banco', () => {
  test('vira anônimo e o cookie é limpo', async () => {
    const c = cliente(ctx.porta);
    const perfil = await entrarDireto(c, 'sumido@exemplo.com');
    ctx.repo.apagar(perfil.id);
    const r = await c.pedir('GET', '/pagina');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.local, '/login');
    assert.match(r.setCookie, /Max-Age=0/);
  });
});

describe('banco fora do ar', () => {
  beforeEach(() => { ctx.repo.fora = false; });
  after(() => { ctx.repo.fora = false; });

  test('API responde 503; página responde 503 sem redirecionar', async () => {
    const c = cliente(ctx.porta);
    await entrarDireto(c, 'fora@exemplo.com');
    ctx.repo.fora = true;
    const api = await c.pedir('POST', '/protegida', {});
    assert.strictEqual(api.status, 503);
    assert.strictEqual(api.json.error, 'Serviço de login indisponível. Tente de novo.');
    const pagina = await c.pedir('GET', '/pagina');
    assert.strictEqual(pagina.status, 503);
    assert.strictEqual(pagina.local, null);
  });
});

// ── rotas /auth/* ─────────────────────────────────────────────
// Daqui em diante as contas entram pela rota, como no site.
async function cadastrar(c, email, senha = SENHA) {
  const r = await c.pedir('POST', '/auth/cadastro', { email, senha });
  assert.strictEqual(r.status, 201, `cadastro falhou: ${r.texto}`);
  return r;
}

describe('cadastro', () => {
  test('cria pendente, grava cookie e /auth/eu reflete', async () => {
    const c = cliente(ctx.porta);
    const r = await cadastrar(c, 'nova@exemplo.com');
    assert.deepStrictEqual(r.json, { status: 'pending', aprovado: false });
    assert.match(r.setCookie, /^meekz_sessao=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const eu = await c.pedir('GET', '/auth/eu');
    assert.strictEqual(eu.status, 200);
    assert.deepStrictEqual(eu.json, { email: 'nova@exemplo.com', status: 'pending', admin: false, aprovado: false });
  });

  test('normaliza o e-mail (espaços e maiúsculas)', async () => {
    const c = cliente(ctx.porta);
    await cadastrar(c, '  Ana@Exemplo.COM ');
    const eu = await c.pedir('GET', '/auth/eu');
    assert.strictEqual(eu.json.email, 'ana@exemplo.com');
  });

  test('e-mail repetido responde 409', async () => {
    const c = cliente(ctx.porta);
    await cadastrar(c, 'repetida@exemplo.com');
    const r = await cliente(ctx.porta).pedir('POST', '/auth/cadastro', { email: 'REPETIDA@exemplo.com', senha: SENHA });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.error, 'E-mail já cadastrado.');
  });

  test('e-mail inválido ou senha curta respondem 400 sem tocar no repositório', async () => {
    const c = cliente(ctx.porta);
    const antes = (await ctx.repo.listarPerfis()).length;
    let r = await c.pedir('POST', '/auth/cadastro', { email: 'sem-arroba', senha: SENHA });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'Informe um e-mail válido.');
    r = await c.pedir('POST', '/auth/cadastro', { email: 'curta@exemplo.com', senha: '1234567' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'A senha precisa ter pelo menos 8 caracteres.');
    assert.strictEqual((await ctx.repo.listarPerfis()).length, antes);
  });

  test('corpo ausente ou não-JSON responde 400, não 500', async () => {
    const c = cliente(ctx.porta);
    let r = await c.pedir('POST', '/auth/cadastro');
    assert.strictEqual(r.status, 400);
    r = await c.pedir('POST', '/auth/cadastro', 'isso não é json', { contentType: 'application/json' });
    assert.strictEqual(r.status, 400);
    r = await c.pedir('POST', '/auth/login');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'Informe e-mail e senha.');
  });

  test('repositório fora responde 503', async () => {
    ctx.repo.fora = true;
    try {
      const r = await cliente(ctx.porta).pedir('POST', '/auth/cadastro', { email: 'fora2@exemplo.com', senha: SENHA });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.error, 'Serviço de login indisponível. Tente de novo.');
    } finally { ctx.repo.fora = false; }
  });
});

describe('login', () => {
  test('entra com a senha certa e recebe status e cookie; e-mail com caixa diferente também entra', async () => {
    await cadastrar(cliente(ctx.porta), 'login@exemplo.com', 'minha-senha-123');
    const c = cliente(ctx.porta);
    const r = await c.pedir('POST', '/auth/login', { email: 'LOGIN@Exemplo.com', senha: 'minha-senha-123' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { status: 'pending', aprovado: false });
    assert.match(r.setCookie, /^meekz_sessao=/);
    assert.strictEqual((await c.pedir('GET', '/auth/eu')).json.email, 'login@exemplo.com');
  });

  test('senha errada e e-mail inexistente dão a mesma resposta 401', async () => {
    await cadastrar(cliente(ctx.porta), 'certa@exemplo.com', 'minha-senha-123');
    const c = cliente(ctx.porta);
    const errada = await c.pedir('POST', '/auth/login', { email: 'certa@exemplo.com', senha: 'outra-senha-123' });
    const semConta = await c.pedir('POST', '/auth/login', { email: 'ninguem@exemplo.com', senha: 'outra-senha-123' });
    assert.strictEqual(errada.status, 401);
    assert.strictEqual(semConta.status, 401);
    assert.deepStrictEqual(errada.json, semConta.json);
    assert.strictEqual(errada.json.error, 'E-mail ou senha incorretos.');
    assert.strictEqual(errada.setCookie, null, 'não grava cookie em falha');
  });

  test('admin pendente recebe aprovado: true no login', async () => {
    // a conta do dono já foi criada na suíte "admin" (Tarefa 3), com a senha padrão
    const r = await cliente(ctx.porta).pedir('POST', '/auth/login', { email: 'dono@meekz.com', senha: SENHA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.aprovado, true);
  });

  test('login de conta sem perfil cria o perfil pendente', async () => {
    // simula usuário criado direto no Supabase Auth, sem linha em viddrop_profiles
    const { id } = await ctx.repo.criarUsuario('semperfil@exemplo.com', SENHA);
    ctx.repo.apagarSoPerfil(id);
    const c = cliente(ctx.porta);
    const r = await c.pedir('POST', '/auth/login', { email: 'semperfil@exemplo.com', senha: SENHA });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'pending');
    assert.ok(await ctx.repo.buscarPerfil(id), 'perfil recriado');
  });
});

describe('sair', () => {
  test('limpa o cookie e o pedido seguinte é anônimo', async () => {
    const c = cliente(ctx.porta);
    await cadastrar(c, 'sair@exemplo.com');
    const r = await c.pedir('POST', '/auth/sair');
    assert.strictEqual(r.status, 204);
    assert.match(r.setCookie, /^meekz_sessao=; .*Max-Age=0/);
    assert.strictEqual((await c.pedir('GET', '/auth/eu')).status, 401);
  });
});
