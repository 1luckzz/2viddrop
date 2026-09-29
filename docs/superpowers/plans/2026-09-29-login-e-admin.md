# Login, aprovação de usuários e painel /admin — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trancar o Meekz Drop atrás de um login com e-mail e senha, onde só o dono (admin) aprova quem pode baixar.

**Architecture:** Supabase Auth (projeto `spm-homolog`) guarda contas e senhas; uma tabela `viddrop_profiles` guarda o status (pending / approved / blocked). O Express emite um cookie de sessão próprio, assinado com HMAC, e um módulo `auth/` isolado (sessão, repositório, middlewares, rotas) protege todas as rotas de download e serve as páginas de login, espera e admin. O repositório é injetável: os testes usam uma versão em memória.

**Tech Stack:** Node 20+, Express 4, `@supabase/supabase-js` 2.x (fixado), `crypto` nativo, `node --test`, HTML/CSS/JS vanilla.

**Spec:** `docs/superpowers/specs/2026-09-29-login-e-admin-design.md`

## Global Constraints

- Node `>=20.6.0` (o `--env-file` local exige isso; o Dockerfile já usa `node:20-slim`).
- Única dependência nova: `@supabase/supabase-js`, versão **fixada** (sem `^`), `package-lock.json` commitado.
- Sem biblioteca de cookie nem de JWT: só `crypto` nativo.
- Todo texto de interface, mensagem de erro e comentário em **português do Brasil**, com acentos.
- Chave de erro nas respostas JSON é sempre `error` (é a que `app.js` e `twitter.js` já leem).
- Nome do cookie: `meekz_sessao`. Validade: 30 dias. `HttpOnly; SameSite=Lax; Path=/`; `Secure` só quando `req.secure`.
- Status válidos: exatamente `pending`, `approved`, `blocked`.
- E-mail sempre normalizado com `trim()` + `toLowerCase()` antes de qualquer uso (cadastro, login, comparação com `ADMIN_EMAIL`).
- Variáveis obrigatórias: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `ADMIN_EMAIL`. Sem elas o servidor não sobe.
- Projeto Supabase: `spm-homolog`, id `ujyaacvsalqzgepczxri`, URL `https://ujyaacvsalqzgepczxri.supabase.co`.
- Testes: `npm test` (`node --test test/*.test.js`) tem que passar ao fim de cada tarefa, sem precisar de Supabase nem de `.env`.
- Commits: nesta sessão do app desktop a escrita em `.git` está bloqueada (`index.lock` falha). Se o commit falhar por isso, deixe o passo de commit anotado como "pendente para o dono" e siga; não tente contornar.

## Review Focus

1. **E-mail com maiúsculas ou espaços** (`" Ana@X.com "` no cadastro, `ana@x.com` no login): a mesma conta tem que entrar. Teste na Tarefa 4.
2. **Cookie válido de usuário que sumiu do banco**: tem que virar anônimo (302 `/login`) e o cookie ser limpo, sem erro 500. Teste na Tarefa 3.
3. **Corpo ausente ou não-JSON em `/auth/login` e `/auth/cadastro`**: 400 com mensagem, nunca 500. Teste na Tarefa 4.
4. **`ADMIN_EMAIL` com maiúsculas** (`Dono@Meekz.com`) e cadastro em minúsculas: continua admin. Teste na Tarefa 3.
5. **Status inventado vindo do painel** (`"admin"`, `"approved "`): 400, nada gravado. Teste na Tarefa 5.

---

### Task 1: Tabela `viddrop_profiles` no Supabase

**Files:**
- Nenhum arquivo no repositório. A migração roda no projeto `spm-homolog` pelo MCP do Supabase (ou pelo SQL Editor do painel, como reserva).

**Interfaces:**
- Produces: tabela `public.viddrop_profiles (id uuid pk, email text, status text, created_at timestamptz, reviewed_at timestamptz)`, RLS ligado, sem policies, sem acesso de `anon`/`authenticated`.

- [ ] **Step 1: Confirmar que a tabela ainda não existe**

Pelo MCP `mcp__supabase-pat__execute_sql` no projeto `ujyaacvsalqzgepczxri`:

```sql
select to_regclass('public.viddrop_profiles') as existe;
```

Expected: `existe` = `null`.

- [ ] **Step 2: Aplicar a migração**

Pelo MCP `mcp__supabase-pat__apply_migration` com `project_id = "ujyaacvsalqzgepczxri"`, `name = "viddrop_profiles"` e este SQL (reserva: colar o mesmo SQL no SQL Editor do painel do spm-homolog):

```sql
create table public.viddrop_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'blocked')),
  created_at  timestamptz not null default now(),
  reviewed_at timestamptz
);

comment on table public.viddrop_profiles is
  'Usuários do Meekz Drop (viddrop) e status de aprovação. Só o servidor acessa, com a chave secreta: RLS ligado sem policies.';

alter table public.viddrop_profiles enable row level security;

revoke all on table public.viddrop_profiles from anon, authenticated;
```

- [ ] **Step 3: Verificar a tabela, o RLS e os privilégios**

```sql
select relname, relrowsecurity
from pg_class where oid = 'public.viddrop_profiles'::regclass;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'viddrop_profiles'
  and grantee in ('anon', 'authenticated');
```

Expected: primeira consulta devolve `relrowsecurity = true`; segunda devolve **zero** linhas.

- [ ] **Step 4: Rodar os advisors de segurança**

Pelo MCP `mcp__supabase-pat__get_advisors` com `type = "security"`. Expected: nenhum aviso citando `viddrop_profiles`. (Avisos sobre outras tabelas do spm-homolog são de outro app: ignorar.)

- [ ] **Step 5: Registrar no plano**

Nada a commitar no repositório. Marque a tarefa como concluída anotando a data e o nome da migração (`viddrop_profiles`) aqui:

`Aplicada em: ____`

---

### Task 2: Erros do módulo e cookie de sessão assinado

**Files:**
- Create: `auth/erros.js`
- Create: `auth/sessao.js`
- Test: `test/sessao.test.js`

**Interfaces:**
- Produces:
  - `class ErroEmailExistente extends Error` (`codigo = 'email_existente'`, mensagem `'E-mail já cadastrado.'`)
  - `class ErroIndisponivel extends Error` (`codigo = 'indisponivel'`, `causa`, mensagem `'Serviço de login indisponível. Tente de novo.'`)
  - `criarSessao(segredo) → { assinar({ id, email }, agora?) → string, verificar(valor, agora?) → { id, email, exp } | null, lerCookie(req) → string | null, gravarCookie(req, res, valor), limparCookie(req, res) }`
  - Constantes `NOME_COOKIE = 'meekz_sessao'`, `VALIDADE_MS = 30 dias`.

- [ ] **Step 1: Criar `auth/erros.js`**

```js
'use strict';

// Erros que o repositório lança e as rotas traduzem em status HTTP.
// Qualquer outro erro vindo do Supabase vira ErroIndisponivel (503).

class ErroEmailExistente extends Error {
  constructor() {
    super('E-mail já cadastrado.');
    this.codigo = 'email_existente';
  }
}

class ErroIndisponivel extends Error {
  constructor(causa) {
    super('Serviço de login indisponível. Tente de novo.');
    this.codigo = 'indisponivel';
    this.causa = causa;
  }
}

module.exports = { ErroEmailExistente, ErroIndisponivel };
```

- [ ] **Step 2: Escrever os testes do cookie (falhando)**

`test/sessao.test.js`:

```js
'use strict';

// Cookie de sessão assinado: o servidor confia só no que ele mesmo assinou.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { criarSessao, NOME_COOKIE, VALIDADE_MS } = require('../auth/sessao');

const SEGREDO = 'segredo-de-teste-com-bastante-tamanho';
const DADOS   = { id: '3f2c1a00-0000-4000-8000-000000000001', email: 'ana@exemplo.com' };

describe('assinar e verificar', () => {
  test('o que foi assinado volta igual, com exp 30 dias à frente', () => {
    const s = criarSessao(SEGREDO);
    const agora = 1_700_000_000_000;
    const valor = s.assinar(DADOS, agora);
    const lido  = s.verificar(valor, agora + 1000);
    assert.deepStrictEqual(lido, { ...DADOS, exp: agora + VALIDADE_MS });
  });

  test('valor tem duas partes separadas por ponto, sem caracteres fora de base64url', () => {
    const valor = criarSessao(SEGREDO).assinar(DADOS);
    assert.match(valor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('vencido devolve null', () => {
    const s = criarSessao(SEGREDO);
    const agora = 1_700_000_000_000;
    const valor = s.assinar(DADOS, agora);
    assert.strictEqual(s.verificar(valor, agora + VALIDADE_MS), null, 'no instante exato já venceu');
    assert.strictEqual(s.verificar(valor, agora + VALIDADE_MS + 1), null);
  });

  test('assinatura adulterada devolve null', () => {
    const s = criarSessao(SEGREDO);
    const valor = s.assinar(DADOS);
    const [payload, assinatura] = valor.split('.');
    const trocada = assinatura[0] === 'A' ? 'B' + assinatura.slice(1) : 'A' + assinatura.slice(1);
    assert.strictEqual(s.verificar(`${payload}.${trocada}`), null);
  });

  test('payload adulterado devolve null', () => {
    const s = criarSessao(SEGREDO);
    const [, assinatura] = s.assinar(DADOS).split('.');
    const outro = Buffer.from(JSON.stringify({ ...DADOS, email: 'x@y.z', exp: Date.now() + 1e9 })).toString('base64url');
    assert.strictEqual(s.verificar(`${outro}.${assinatura}`), null);
  });

  test('segredo diferente devolve null', () => {
    const valor = criarSessao(SEGREDO).assinar(DADOS);
    assert.strictEqual(criarSessao('outro-segredo-igualmente-longo').verificar(valor), null);
  });

  test('lixo devolve null sem lançar', () => {
    const s = criarSessao(SEGREDO);
    for (const lixo of ['', 'sem-ponto', 'a.b', '.', 'YQ==.', undefined, null, 42]) {
      assert.strictEqual(s.verificar(lixo), null, `deveria rejeitar ${JSON.stringify(lixo)}`);
    }
  });

  test('segredo curto é recusado na criação', () => {
    assert.throws(() => criarSessao('curto'), /SESSION_SECRET/);
  });
});

describe('cookie HTTP', () => {
  const s = criarSessao(SEGREDO);

  test('lerCookie acha o nosso cookie no meio de outros', () => {
    const req = { headers: { cookie: `tema=dark; ${NOME_COOKIE}=abc.def; outro=1` } };
    assert.strictEqual(s.lerCookie(req), 'abc.def');
  });

  test('lerCookie devolve null sem header ou sem o cookie', () => {
    assert.strictEqual(s.lerCookie({ headers: {} }), null);
    assert.strictEqual(s.lerCookie({ headers: { cookie: 'tema=dark' } }), null);
  });

  test('gravarCookie manda HttpOnly, SameSite=Lax, Path=/ e Max-Age de 30 dias', () => {
    const headers = [];
    const res = { append: (n, v) => headers.push([n, v]) };
    s.gravarCookie({ secure: false }, res, 'abc.def');
    assert.strictEqual(headers.length, 1);
    const [nome, valor] = headers[0];
    assert.strictEqual(nome, 'Set-Cookie');
    assert.match(valor, new RegExp(`^${NOME_COOKIE}=abc\\.def; `));
    assert.match(valor, /HttpOnly/);
    assert.match(valor, /SameSite=Lax/);
    assert.match(valor, /Path=\//);
    assert.match(valor, /Max-Age=2592000/);
    assert.doesNotMatch(valor, /Secure/);
  });

  test('gravarCookie adiciona Secure quando o pedido é HTTPS', () => {
    const headers = [];
    s.gravarCookie({ secure: true }, { append: (n, v) => headers.push(v) }, 'abc.def');
    assert.match(headers[0], /; Secure$/);
  });

  test('limparCookie zera o valor com Max-Age=0', () => {
    const headers = [];
    s.limparCookie({ secure: false }, { append: (n, v) => headers.push(v) });
    assert.match(headers[0], new RegExp(`^${NOME_COOKIE}=; `));
    assert.match(headers[0], /Max-Age=0/);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test test/sessao.test.js`
Expected: FAIL com `Cannot find module '../auth/sessao'`.

- [ ] **Step 4: Criar `auth/sessao.js`**

```js
'use strict';

// Cookie de sessão assinado com HMAC. O cookie leva só id e e-mail: o status
// (pendente / aprovado / bloqueado) é lido do banco a cada pedido guardado,
// pra bloquear alguém valer na hora.
const crypto = require('crypto');

const NOME_COOKIE = 'meekz_sessao';
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

function criarSessao(segredo) {
  if (typeof segredo !== 'string' || segredo.length < 16) {
    throw new Error('SESSION_SECRET precisa ter pelo menos 16 caracteres');
  }

  const assinatura = payload =>
    crypto.createHmac('sha256', segredo).update(payload).digest('base64url');

  function assinar({ id, email }, agora = Date.now()) {
    const payload = Buffer.from(JSON.stringify({ id, email, exp: agora + VALIDADE_MS }))
      .toString('base64url');
    return `${payload}.${assinatura(payload)}`;
  }

  function verificar(valor, agora = Date.now()) {
    if (typeof valor !== 'string') return null;
    const ponto = valor.indexOf('.');
    if (ponto <= 0) return null;

    const payload  = valor.slice(0, ponto);
    const recebida = Buffer.from(valor.slice(ponto + 1));
    const esperada = Buffer.from(assinatura(payload));
    if (recebida.length !== esperada.length) return null;
    if (!crypto.timingSafeEqual(recebida, esperada)) return null;

    let dados;
    try { dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
    catch { return null; }
    if (!dados || typeof dados.id !== 'string' || typeof dados.email !== 'string') return null;
    if (typeof dados.exp !== 'number' || dados.exp <= agora) return null;

    return { id: dados.id, email: dados.email, exp: dados.exp };
  }

  function lerCookie(req) {
    const header = (req.headers && req.headers.cookie) || '';
    for (const parte of header.split(';')) {
      const igual = parte.indexOf('=');
      if (igual === -1) continue;
      if (parte.slice(0, igual).trim() !== NOME_COOKIE) continue;
      try { return decodeURIComponent(parte.slice(igual + 1).trim()); }
      catch { return null; }
    }
    return null;
  }

  function montar(valor, maxAgeSegundos, secure) {
    const partes = [
      `${NOME_COOKIE}=${encodeURIComponent(valor)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSegundos}`,
    ];
    if (secure) partes.push('Secure');
    return partes.join('; ');
  }

  function gravarCookie(req, res, valor) {
    res.append('Set-Cookie', montar(valor, VALIDADE_MS / 1000, !!req.secure));
  }

  function limparCookie(req, res) {
    res.append('Set-Cookie', montar('', 0, !!req.secure));
  }

  return { assinar, verificar, lerCookie, gravarCookie, limparCookie };
}

module.exports = { criarSessao, NOME_COOKIE, VALIDADE_MS };
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/sessao.test.js`
Expected: todos os testes PASS (13 testes).

Run: `npm test`
Expected: PASS (os testes antigos continuam verdes).

- [ ] **Step 6: Commit**

```bash
git add auth/erros.js auth/sessao.js test/sessao.test.js
git commit -m "Cookie de sessão assinado e erros do módulo de auth"
```

---

### Task 3: Middlewares de guarda com repositório em memória

**Files:**
- Create: `test/apoio/repositorio-memoria.js`
- Create: `auth/middleware.js`
- Create: `auth/index.js`
- Test: `test/auth.test.js` (parte 1: guardas)

**Interfaces:**
- Consumes: `criarSessao` (Tarefa 2), `ErroEmailExistente`, `ErroIndisponivel` (Tarefa 2).
- Produces:
  - Interface do repositório (a mesma que a Tarefa 6 implementa com Supabase):
    - `criarUsuario(email, senha) → Promise<perfil>` (lança `ErroEmailExistente`)
    - `loginComSenha(email, senha) → Promise<{ id, email } | null>` (`null` = credenciais erradas)
    - `buscarPerfil(id) → Promise<perfil | null>`
    - `garantirPerfil(id, email) → Promise<perfil>` (cria pendente se não existir)
    - `listarPerfis() → Promise<perfil[]>` (mais novo primeiro)
    - `mudarStatus(id, status) → Promise<perfil | null>`
    - `perfil = { id, email, status, created_at (ISO), reviewed_at (ISO | null) }`
  - `criarMiddlewares({ sessao, repositorio, adminEmail }) → mw` com:
    - `mw.carregarSessao(req, res, next)` — só cookie, preenche `req.sessao = { id, email, exp } | null`
    - `mw.carregarUsuario(req, res) → Promise<usuario | null>`, `usuario = { id, email, status, admin, aprovado }`, guarda em `req.usuario`
    - `mw.exigirAprovadoPagina`, `mw.exigirAprovadoApi`, `mw.exigirAdminPagina`, `mw.exigirAdminApi`, `mw.redirecionarLogado`, `mw.exigirAguardando` (middlewares Express)
    - `mw.ehAdmin(email) → boolean`
    - `mw.MSG = { login, pendente, bloqueado, indisponivel }`
  - `montarAuth(app, { repositorio, adminEmail, segredoSessao }) → mw` (registra `carregarSessao` e as rotas; as rotas entram na Tarefa 4).

- [ ] **Step 1: Criar o repositório em memória**

`test/apoio/repositorio-memoria.js` (fica fora do glob `test/*.test.js`, então não roda como teste):

```js
'use strict';

// Repositório em memória com a mesma interface de auth/repositorio.js.
// `fora = true` simula o Supabase indisponível: toda operação lança ErroIndisponivel.
const crypto = require('crypto');
const { ErroEmailExistente, ErroIndisponivel } = require('../../auth/erros');

function criarRepositorioMemoria() {
  const contas  = new Map();   // email -> { id, senha }
  const perfis  = new Map();   // id -> perfil
  let relogio = 0;             // created_at crescente e determinístico

  const repo = {
    fora: false,

    async criarUsuario(email, senha) {
      checar();
      if (contas.has(email)) throw new ErroEmailExistente();
      const id = crypto.randomUUID();
      contas.set(email, { id, senha });
      return repo.garantirPerfil(id, email);
    },

    async loginComSenha(email, senha) {
      checar();
      const conta = contas.get(email);
      return conta && conta.senha === senha ? { id: conta.id, email } : null;
    },

    async buscarPerfil(id) {
      checar();
      return perfis.get(id) || null;
    },

    async garantirPerfil(id, email) {
      checar();
      if (!perfis.has(id)) {
        perfis.set(id, {
          id, email, status: 'pending',
          created_at: new Date(1_700_000_000_000 + (relogio++) * 1000).toISOString(),
          reviewed_at: null,
        });
      }
      return perfis.get(id);
    },

    async listarPerfis() {
      checar();
      return [...perfis.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    async mudarStatus(id, status) {
      checar();
      const perfil = perfis.get(id);
      if (!perfil) return null;
      perfil.status = status;
      perfil.reviewed_at = new Date().toISOString();
      return perfil;
    },

    // só para os testes: simula usuário apagado no Supabase
    apagar(id) {
      perfis.delete(id);
      for (const [email, conta] of contas) if (conta.id === id) contas.delete(email);
    },

    // só para os testes: conta existe no Auth mas sem linha de perfil
    apagarSoPerfil(id) { perfis.delete(id); },
  };

  function checar() { if (repo.fora) throw new ErroIndisponivel(new Error('simulado')); }

  return repo;
}

module.exports = { criarRepositorioMemoria };
```

- [ ] **Step 2: Escrever os testes das guardas (falhando)**

`test/auth.test.js`:

```js
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
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test test/auth.test.js`
Expected: FAIL com `Cannot find module '../auth'`.

- [ ] **Step 4: Criar `auth/middleware.js`**

```js
'use strict';

// Guardas. `carregarSessao` roda em todo pedido e só olha o cookie (barato).
// A consulta ao perfil acontece só nas rotas guardadas, via `carregarUsuario`.

const MSG = {
  login:        'Faça login para continuar.',
  pendente:     'Sua conta ainda não foi aprovada.',
  bloqueado:    'Seu acesso foi bloqueado.',
  soAdmin:      'Só o admin pode fazer isso.',
  indisponivel: 'Serviço de login indisponível. Tente de novo.',
};

function normalizar(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function criarMiddlewares({ sessao, repositorio, adminEmail }) {
  const admin = normalizar(adminEmail);
  if (!admin) throw new Error('ADMIN_EMAIL vazio');

  const ehAdmin = email => normalizar(email) === admin;

  function carregarSessao(req, res, next) {
    const valor = sessao.lerCookie(req);
    req.sessao = valor ? sessao.verificar(valor) : null;
    next();
  }

  async function carregarUsuario(req, res) {
    if (req.usuario !== undefined) return req.usuario;
    if (!req.sessao) return (req.usuario = null);

    const perfil = await repositorio.buscarPerfil(req.sessao.id);
    if (!perfil) {
      sessao.limparCookie(req, res);   // conta sumiu do banco: o cookie não vale mais
      return (req.usuario = null);
    }
    const souAdmin = ehAdmin(perfil.email);
    req.usuario = {
      id:       perfil.id,
      email:    perfil.email,
      status:   perfil.status,
      admin:    souAdmin,
      aprovado: souAdmin || perfil.status === 'approved',
    };
    return req.usuario;
  }

  const mensagemStatus = u => (u.status === 'blocked' ? MSG.bloqueado : MSG.pendente);

  function indisponivel(res, api) {
    return api
      ? res.status(503).json({ error: MSG.indisponivel })
      : res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><p>${MSG.indisponivel}</p>`);
  }

  // Guarda genérica: api decide JSON x redirect; admin exige o e-mail do dono.
  function guarda({ api, admin: precisaAdmin }) {
    return async (req, res, next) => {
      let u;
      try { u = await carregarUsuario(req, res); }
      catch (e) { console.error('[auth] perfil indisponível:', e.message); return indisponivel(res, api); }

      if (!u)          return api ? res.status(401).json({ error: MSG.login })          : res.redirect('/login');
      if (!u.aprovado) return api ? res.status(403).json({ error: mensagemStatus(u) })  : res.redirect('/aguardando');
      if (precisaAdmin && !u.admin)
                       return api ? res.status(403).json({ error: MSG.soAdmin })        : res.redirect('/');
      next();
    };
  }

  // /login e /cadastro: quem já está logado vai pro lugar dele.
  async function redirecionarLogado(req, res, next) {
    let u;
    try { u = await carregarUsuario(req, res); }
    catch (e) { console.error('[auth] perfil indisponível:', e.message); return next(); }   // banco fora: deixa ver a página
    if (!u) return next();
    res.redirect(u.aprovado ? '/' : '/aguardando');
  }

  // /aguardando: só logado não aprovado.
  async function exigirAguardando(req, res, next) {
    let u;
    try { u = await carregarUsuario(req, res); }
    catch (e) { console.error('[auth] perfil indisponível:', e.message); return indisponivel(res, false); }
    if (!u) return res.redirect('/login');
    if (u.aprovado) return res.redirect('/');
    next();
  }

  return {
    MSG, ehAdmin, carregarSessao, carregarUsuario,
    exigirAprovadoPagina: guarda({ api: false, admin: false }),
    exigirAprovadoApi:    guarda({ api: true,  admin: false }),
    exigirAdminPagina:    guarda({ api: false, admin: true }),
    exigirAdminApi:       guarda({ api: true,  admin: true }),
    redirecionarLogado,
    exigirAguardando,
  };
}

module.exports = { criarMiddlewares, normalizar, MSG };
```

- [ ] **Step 5: Criar `auth/index.js` (por enquanto sem rotas)**

```js
'use strict';

// Ponto de entrada do módulo de auth. server.js e os testes chamam montarAuth
// e usam as guardas devolvidas nas rotas que precisam.
const { criarSessao }      = require('./sessao');
const { criarMiddlewares } = require('./middleware');

function montarAuth(app, { repositorio, adminEmail, segredoSessao }) {
  const sessao = criarSessao(segredoSessao);
  const mw     = criarMiddlewares({ sessao, repositorio, adminEmail });
  app.use(mw.carregarSessao);
  return mw;
}

module.exports = { montarAuth };
```

- [ ] **Step 6: Rodar e ver passar**

Run: `node --test test/auth.test.js`
Expected: PASS em todos (12 testes). Run: `npm test` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/apoio/repositorio-memoria.js auth/middleware.js auth/index.js test/auth.test.js
git commit -m "Guardas de auth com repositório em memória"
```

---

### Task 4: Rotas `/auth/*` (cadastro, login, sair, eu)

**Files:**
- Create: `auth/rotas.js`
- Modify: `auth/index.js`
- Test: `test/auth.test.js` (parte 2)

**Interfaces:**
- Consumes: `mw` (Tarefa 3), `sessao` (Tarefa 2), repositório (interface da Tarefa 3).
- Produces:
  - `criarRotas({ sessao, repositorio, mw }) → express.Router` com `POST /auth/cadastro`, `POST /auth/login`, `POST /auth/sair`, `GET /auth/eu`.
  - Respostas: cadastro `201 { status: 'pending', aprovado }`; login `200 { status, aprovado }`; eu `200 { email, status, admin, aprovado }`.
  - `montarAuth` passa a registrar o router.

- [ ] **Step 1: Acrescentar os testes das rotas de auth**

No fim de `test/auth.test.js`:

```js
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
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/auth.test.js`
Expected: FAIL nos testes de `/auth/*` com status 404.

- [ ] **Step 3: Criar `auth/rotas.js`**

```js
'use strict';

// Rotas de conta (/auth/*) e do painel (/admin/usuarios*).
// Toda resposta de erro é JSON com a chave `error`, como o resto do servidor.
const express = require('express');
const { ErroEmailExistente } = require('./erros');
const { normalizar } = require('./middleware');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS   = ['pending', 'approved', 'blocked'];

function criarRotas({ sessao, repositorio, mw }) {
  const router = express.Router();

  function responderErro(res, e) {
    if (e instanceof ErroEmailExistente) return res.status(409).json({ error: e.message });
    console.error('[auth]', e && e.message);
    return res.status(503).json({ error: mw.MSG.indisponivel });
  }

  function entrar(req, res, perfil) {
    sessao.gravarCookie(req, res, sessao.assinar({ id: perfil.id, email: perfil.email }));
    return { status: perfil.status, aprovado: mw.ehAdmin(perfil.email) || perfil.status === 'approved' };
  }

  router.post('/auth/cadastro', async (req, res) => {
    const email = normalizar(req.body && req.body.email);
    const senha = req.body && req.body.senha;
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
    if (typeof senha !== 'string' || senha.length < 8) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    }
    try {
      const perfil = await repositorio.criarUsuario(email, senha);
      res.status(201).json(entrar(req, res, perfil));
    } catch (e) { responderErro(res, e); }
  });

  router.post('/auth/login', async (req, res) => {
    const email = normalizar(req.body && req.body.email);
    const senha = req.body && req.body.senha;
    if (!email || typeof senha !== 'string' || !senha) return res.status(400).json({ error: 'Informe e-mail e senha.' });
    try {
      const usuario = await repositorio.loginComSenha(email, senha);
      if (!usuario) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
      const perfil = (await repositorio.buscarPerfil(usuario.id))
                  || (await repositorio.garantirPerfil(usuario.id, usuario.email));
      res.json(entrar(req, res, perfil));
    } catch (e) { responderErro(res, e); }
  });

  router.post('/auth/sair', (req, res) => {
    sessao.limparCookie(req, res);
    res.status(204).end();
  });

  router.get('/auth/eu', async (req, res) => {
    let u;
    try { u = await mw.carregarUsuario(req, res); }
    catch (e) { return responderErro(res, e); }
    if (!u) return res.status(401).json({ error: mw.MSG.login });
    res.json({ email: u.email, status: u.status, admin: u.admin, aprovado: u.aprovado });
  });

  return router;
}

module.exports = { criarRotas, STATUS };
```

JSON malformado: o `express.json()` lança antes de chegar no router, então o handler de erro que padroniza o 400 fica no `app`, registrado em `auth/index.js` (Step 4).

- [ ] **Step 4: Registrar o router e o handler de JSON em `auth/index.js`**

Substitua o arquivo inteiro:

```js
'use strict';

// Ponto de entrada do módulo de auth. server.js e os testes chamam montarAuth
// e usam as guardas devolvidas nas rotas que precisam.
const { criarSessao }      = require('./sessao');
const { criarMiddlewares } = require('./middleware');
const { criarRotas }       = require('./rotas');

function montarAuth(app, { repositorio, adminEmail, segredoSessao }) {
  const sessao = criarSessao(segredoSessao);
  const mw     = criarMiddlewares({ sessao, repositorio, adminEmail });

  app.use(mw.carregarSessao);
  app.use(criarRotas({ sessao, repositorio, mw }));

  // express.json() responde JSON malformado com 400 mas sem corpo; padroniza.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Corpo inválido.' });
    next(err);
  });

  return mw;
}

module.exports = { montarAuth };
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test test/auth.test.js`
Expected: PASS em todos os testes das Tarefas 3 e 4.

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add auth/rotas.js auth/index.js test/auth.test.js
git commit -m "Rotas de cadastro, login, sair e /auth/eu"
```

---

### Task 5: Rotas do painel `/admin/usuarios`

**Files:**
- Modify: `auth/rotas.js`
- Test: `test/auth.test.js` (parte 3)

**Interfaces:**
- Consumes: `mw.exigirAdminApi`, `mw.ehAdmin`, `repositorio.listarPerfis`, `repositorio.mudarStatus`.
- Produces: `GET /admin/usuarios → 200 { usuarios: [{ id, email, status, created_at, reviewed_at, admin }] }`; `POST /admin/usuarios/:id/status { status } → 200 { id, status }`.

- [ ] **Step 1: Acrescentar os testes do painel**

No fim de `test/auth.test.js`:

```js
// ── painel /admin/usuarios ────────────────────────────────────
describe('painel do admin', () => {
  async function entrarComoAdmin() {
    const c = cliente(ctx.porta);
    const r = await c.pedir('POST', '/auth/login', { email: 'dono@meekz.com', senha: SENHA });
    if (r.status !== 200) await cadastrar(c, 'dono@meekz.com');
    return c;
  }

  test('lista todos, mais novo primeiro, com a linha do admin marcada', async () => {
    const admin = await entrarComoAdmin();
    await cadastrar(cliente(ctx.porta), 'lista-a@exemplo.com');
    await cadastrar(cliente(ctx.porta), 'lista-b@exemplo.com');
    const r = await admin.pedir('GET', '/admin/usuarios');
    assert.strictEqual(r.status, 200);
    const emails = r.json.usuarios.map(u => u.email);
    assert.ok(emails.indexOf('lista-b@exemplo.com') < emails.indexOf('lista-a@exemplo.com'), 'mais novo primeiro');
    const dono = r.json.usuarios.find(u => u.email === 'dono@meekz.com');
    assert.strictEqual(dono.admin, true);
    assert.strictEqual(r.json.usuarios.find(u => u.email === 'lista-a@exemplo.com').admin, false);
    for (const u of r.json.usuarios) {
      assert.deepStrictEqual(Object.keys(u).sort(), ['admin', 'created_at', 'email', 'id', 'reviewed_at', 'status']);
    }
  });

  test('aprova, bloqueia e volta a pendente, gravando reviewed_at', async () => {
    const admin = await entrarComoAdmin();
    const c = cliente(ctx.porta);
    await cadastrar(c, 'muda@exemplo.com');
    const { id } = (await ctx.repo.listarPerfis()).find(p => p.email === 'muda@exemplo.com');

    let r = await admin.pedir('POST', `/admin/usuarios/${id}/status`, { status: 'approved' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json, { id, status: 'approved' });
    assert.strictEqual((await c.pedir('POST', '/protegida', {})).status, 200, 'aprovação vale na hora');
    assert.ok((await ctx.repo.buscarPerfil(id)).reviewed_at);

    r = await admin.pedir('POST', `/admin/usuarios/${id}/status`, { status: 'blocked' });
    assert.strictEqual(r.json.status, 'blocked');
    assert.strictEqual((await c.pedir('POST', '/protegida', {})).status, 403, 'bloqueio vale na hora');

    r = await admin.pedir('POST', `/admin/usuarios/${id}/status`, { status: 'pending' });
    assert.strictEqual(r.json.status, 'pending');
  });

  test('status inventado responde 400 e não grava', async () => {
    const admin = await entrarComoAdmin();
    await cadastrar(cliente(ctx.porta), 'invalido@exemplo.com');
    const { id } = (await ctx.repo.listarPerfis()).find(p => p.email === 'invalido@exemplo.com');
    for (const ruim of ['admin', 'approved ', 'APPROVED', '', null, 42]) {
      const r = await admin.pedir('POST', `/admin/usuarios/${id}/status`, { status: ruim });
      assert.strictEqual(r.status, 400, `deveria recusar ${JSON.stringify(ruim)}`);
      assert.strictEqual(r.json.error, 'Status inválido.');
    }
    assert.strictEqual((await ctx.repo.buscarPerfil(id)).status, 'pending');
  });

  test('admin não muda o próprio status', async () => {
    const admin = await entrarComoAdmin();
    const { id } = (await ctx.repo.listarPerfis()).find(p => p.email === 'dono@meekz.com');
    const r = await admin.pedir('POST', `/admin/usuarios/${id}/status`, { status: 'blocked' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.error, 'O admin não muda o próprio status.');
  });

  test('id inexistente responde 404', async () => {
    const admin = await entrarComoAdmin();
    const r = await admin.pedir('POST', '/admin/usuarios/00000000-0000-4000-8000-000000000000/status', { status: 'approved' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.json.error, 'Usuário não encontrado.');
  });

  test('aprovado comum e anônimo não acessam o painel', async () => {
    const c = cliente(ctx.porta);
    await cadastrar(c, 'comum@exemplo.com');
    const { id } = (await ctx.repo.listarPerfis()).find(p => p.email === 'comum@exemplo.com');
    await ctx.repo.mudarStatus(id, 'approved');
    assert.strictEqual((await c.pedir('GET', '/admin/usuarios')).status, 403);
    assert.strictEqual((await c.pedir('POST', `/admin/usuarios/${id}/status`, { status: 'blocked' })).status, 403);
    assert.strictEqual((await cliente(ctx.porta).pedir('GET', '/admin/usuarios')).status, 401);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test test/auth.test.js`
Expected: FAIL nos testes do painel com 404.

- [ ] **Step 3: Acrescentar as rotas em `auth/rotas.js`**

Antes de `return router;`:

```js
  // ── painel ──────────────────────────────────────────────────
  router.get('/admin/usuarios', mw.exigirAdminApi, async (req, res) => {
    try {
      const perfis = await repositorio.listarPerfis();
      res.json({
        usuarios: perfis.map(p => ({
          id: p.id, email: p.email, status: p.status,
          created_at: p.created_at, reviewed_at: p.reviewed_at,
          admin: mw.ehAdmin(p.email),
        })),
      });
    } catch (e) { responderErro(res, e); }
  });

  router.post('/admin/usuarios/:id/status', mw.exigirAdminApi, async (req, res) => {
    const status = req.body && req.body.status;
    if (!STATUS.includes(status)) return res.status(400).json({ error: 'Status inválido.' });
    if (req.params.id === req.usuario.id) return res.status(400).json({ error: 'O admin não muda o próprio status.' });
    try {
      const perfil = await repositorio.mudarStatus(req.params.id, status);
      if (!perfil) return res.status(404).json({ error: 'Usuário não encontrado.' });
      res.json({ id: perfil.id, status: perfil.status });
    } catch (e) { responderErro(res, e); }
  });
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npm test`
Expected: PASS em tudo.

- [ ] **Step 5: Commit**

```bash
git add auth/rotas.js test/auth.test.js
git commit -m "Rotas do painel: listar usuários e mudar status"
```

---

### Task 6: Repositório Supabase

**Files:**
- Modify: `package.json`, `package-lock.json` (dependência nova)
- Create: `auth/supabase.js`
- Create: `auth/repositorio.js`

**Interfaces:**
- Consumes: `ErroEmailExistente`, `ErroIndisponivel` (Tarefa 2).
- Produces:
  - `criarClientes({ url, chaveSecreta }) → { admin, loginComSenha(email, senha) → Promise<{ id, email } | null> }`
  - `criarRepositorioSupabase({ admin, loginComSenha }) → repositório` com a interface da Tarefa 3.

- [ ] **Step 1: Instalar o supabase-js com versão fixada**

```bash
npm install --save-exact @supabase/supabase-js@2.117.2
```

(Se `npm view @supabase/supabase-js version` mostrar uma 2.x mais nova, use ela.) Confirme em `package.json` que a entrada não tem `^`.

- [ ] **Step 2: Criar `auth/supabase.js`**

```js
'use strict';

// Clientes do Supabase para o servidor. Só a chave secreta existe aqui; ela
// nunca vai pro frontend.
const { createClient } = require('@supabase/supabase-js');

// Servidor não guarda sessão do SDK: a sessão é o nosso cookie.
const OPCOES = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function criarClientes({ url, chaveSecreta }) {
  const admin = createClient(url, chaveSecreta, OPCOES);

  // Um cliente por login. Depois de signInWithPassword o SDK passa a mandar o
  // token do usuário em vez da chave secreta; isso não pode vazar pro `admin`.
  async function loginComSenha(email, senha) {
    const temporario = createClient(url, chaveSecreta, OPCOES);
    const { data, error } = await temporario.auth.signInWithPassword({ email, password: senha });
    if (error) {
      const credenciais = error.code === 'invalid_credentials' || error.status === 400 || error.status === 401;
      if (credenciais) return null;
      throw error;
    }
    return { id: data.user.id, email: data.user.email };
  }

  return { admin, loginComSenha };
}

module.exports = { criarClientes };
```

- [ ] **Step 3: Criar `auth/repositorio.js`**

```js
'use strict';

// Implementação Supabase da interface do repositório (ver test/apoio/repositorio-memoria.js
// para a versão em memória com a mesma interface).
const { ErroEmailExistente, ErroIndisponivel } = require('./erros');

const TABELA  = 'viddrop_profiles';
const COLUNAS = 'id, email, status, created_at, reviewed_at';

function criarRepositorioSupabase({ admin, loginComSenha }) {
  const falha = e => new ErroIndisponivel(e);

  const repo = {
    async criarUsuario(email, senha) {
      const { data, error } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (error) {
        if (error.code === 'email_exists' || /already/i.test(error.message || '')) throw new ErroEmailExistente();
        throw falha(error);
      }
      return repo.garantirPerfil(data.user.id, email);
    },

    async loginComSenha(email, senha) {
      try { return await loginComSenha(email, senha); }
      catch (e) { throw falha(e); }
    },

    async buscarPerfil(id) {
      const { data, error } = await admin.from(TABELA).select(COLUNAS).eq('id', id).maybeSingle();
      if (error) throw falha(error);
      return data;
    },

    async garantirPerfil(id, email) {
      const { data, error } = await admin.from(TABELA)
        .upsert({ id, email }, { onConflict: 'id', ignoreDuplicates: true })
        .select(COLUNAS).maybeSingle();
      if (error) throw falha(error);
      return data || repo.buscarPerfil(id);   // já existia: o upsert não devolve linha
    },

    async listarPerfis() {
      const { data, error } = await admin.from(TABELA).select(COLUNAS).order('created_at', { ascending: false });
      if (error) throw falha(error);
      return data;
    },

    async mudarStatus(id, status) {
      const { data, error } = await admin.from(TABELA)
        .update({ status, reviewed_at: new Date().toISOString() })
        .eq('id', id).select(COLUNAS).maybeSingle();
      if (error) throw falha(error);
      return data;
    },
  };

  return repo;
}

module.exports = { criarRepositorioSupabase, TABELA };
```

- [ ] **Step 4: Checar sintaxe e que os módulos carregam**

Run:
```bash
node --check auth/supabase.js && node --check auth/repositorio.js && node -e "const {criarClientes}=require('./auth/supabase');const {criarRepositorioSupabase}=require('./auth/repositorio');const r=criarRepositorioSupabase(criarClientes({url:'https://x.supabase.co',chaveSecreta:'fake'}));console.log(Object.keys(r).join(','))"
```
Expected: imprime `criarUsuario,loginComSenha,buscarPerfil,garantirPerfil,listarPerfis,mudarStatus`.

- [ ] **Step 5: Smoke contra o Supabase real (se houver `.env`)**

Se o arquivo `.env` existir na raiz com as quatro variáveis (o dono cria; ver Tarefa 11), rode:

```bash
node --env-file=.env -e "const {criarClientes}=require('./auth/supabase');const {criarRepositorioSupabase}=require('./auth/repositorio');const r=criarRepositorioSupabase(criarClientes({url:process.env.SUPABASE_URL,chaveSecreta:process.env.SUPABASE_SECRET_KEY}));r.listarPerfis().then(l=>console.log('perfis:',l.length)).catch(e=>{console.error('FALHOU:',e.causa||e);process.exit(1)})"
```
Expected: `perfis: 0`. Se não houver `.env`, anote "smoke pulado, sem .env" e siga: o teste manual da Tarefa 12 cobre.

- [ ] **Step 6: Rodar os testes e commitar**

Run: `npm test` — Expected: PASS.

```bash
git add package.json package-lock.json auth/supabase.js auth/repositorio.js
git commit -m "Repositório de usuários no Supabase"
```

---

### Task 7: Ligar tudo no `server.js`, páginas privadas e `/healthz`

**Files:**
- Modify: `server.js` (topo, linhas 1-16; rotas nas linhas 91, 321, 334, 436, 496, 523, 810, 813, 819)
- Move: `public/index.html` → `private/index.html` (`git mv`; o conteúdo muda na Tarefa 8)

**Interfaces:**
- Consumes: `montarAuth` (Tarefa 4), `criarClientes` + `criarRepositorioSupabase` (Tarefa 6).
- Produces: servidor que exige as quatro variáveis, guarda todas as rotas de download, serve `/`, `/admin`, `/login`, `/cadastro`, `/aguardando` e `/healthz`.

- [ ] **Step 1: Mover a página principal para `private/`**

```bash
mkdir -p private && git mv public/index.html private/index.html
```

- [ ] **Step 2: Variáveis obrigatórias e módulo de auth no topo de `server.js`**

Logo depois de `const { segundosParaCortar, cortarInicio } = require('./video/trim');` (linha 7), acrescente:

```js
const { montarAuth }              = require('./auth');
const { criarClientes }           = require('./auth/supabase');
const { criarRepositorioSupabase } = require('./auth/repositorio');

// Sem login não tem site: recusa subir sem as variáveis, com mensagem clara.
const OBRIGATORIAS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'ADMIN_EMAIL'];
const faltando = OBRIGATORIAS.filter(nome => !process.env[nome]);
if (faltando.length) {
  console.error(`Faltam variáveis de ambiente: ${faltando.join(', ')}. Veja a seção "Login e aprovação" do README.`);
  process.exit(1);
}
```

Substitua as linhas 15-16 (`app.use(cors()); app.use(express.json());`) por:

```js
app.set('trust proxy', 1);   // Render: req.secure vem do X-Forwarded-Proto
app.use(cors());
app.use(express.json());

const auth = montarAuth(app, {
  repositorio: criarRepositorioSupabase(criarClientes({
    url: process.env.SUPABASE_URL,
    chaveSecreta: process.env.SUPABASE_SECRET_KEY,
  })),
  adminEmail:    process.env.ADMIN_EMAIL,
  segredoSessao: process.env.SESSION_SECRET,
});

const PUBLIC_DIR  = path.join(__dirname, 'public');
const PRIVATE_DIR = path.join(__dirname, 'private');

// ── PÁGINAS ──────────────────────────────────────────────────
// A raiz passa a redirecionar; o health check do Render usa /healthz.
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get(['/', '/index.html'],   auth.exigirAprovadoPagina, (req, res) => res.sendFile(path.join(PRIVATE_DIR, 'index.html')));
app.get(['/admin', '/admin.html'], auth.exigirAdminPagina, (req, res) => res.sendFile(path.join(PRIVATE_DIR, 'admin.html')));
app.get('/login',      auth.redirecionarLogado, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/cadastro',   auth.redirecionarLogado, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'cadastro.html')));
app.get('/aguardando', auth.exigirAguardando,   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'aguardando.html')));
```

- [ ] **Step 3: Guardar as rotas existentes**

Troque cada abertura de rota por esta forma (só o segundo argumento muda):

| Linha atual | Nova |
|---|---|
| `app.post('/cancel/:jobId', (req, res) => {` | `app.post('/cancel/:jobId', auth.exigirAprovadoApi, (req, res) => {` |
| `app.get('/test', (req, res) => {` | `app.get('/test', auth.exigirAdminApi, (req, res) => {` |
| `app.post('/extract', async (req, res) => {` | `app.post('/extract', auth.exigirAprovadoApi, async (req, res) => {` |
| `app.post('/playlist', (req, res) => {` | `app.post('/playlist', auth.exigirAprovadoApi, (req, res) => {` |
| `app.post('/info', (req, res) => {` | `app.post('/info', auth.exigirAprovadoApi, (req, res) => {` |
| `app.post('/download', (req, res) => {` | `app.post('/download', auth.exigirAprovadoApi, (req, res) => {` |
| `app.use('/api/twitter', require('./twitter/routes'));` | `app.use('/api/twitter', auth.exigirAprovadoApi, require('./twitter/routes'));` |
| `app.use('/files', (req, res, next) => {` | `app.use('/files', auth.exigirAprovadoApi, (req, res, next) => {` |

A linha `app.use(express.static(path.join(__dirname, 'public')));` fica como está (serve CSS, JS, imagens, páginas legais e os HTML públicos).

- [ ] **Step 4: Checar sintaxe e subir com variáveis falsas**

Run: `node --check server.js` — Expected: sem saída.

Run (Git Bash), numa porta livre:
```bash
SUPABASE_URL=https://exemplo.supabase.co SUPABASE_SECRET_KEY=fake SESSION_SECRET=segredo-de-teste-com-bastante-tamanho ADMIN_EMAIL=dono@meekz.com PORT=3141 node server.js &
sleep 2
curl -s -o /dev/null -w "healthz %{http_code}\n" http://localhost:3141/healthz
curl -s -o /dev/null -w "raiz %{http_code} -> %{redirect_url}\n" http://localhost:3141/
curl -s -o /dev/null -w "admin %{http_code} -> %{redirect_url}\n" http://localhost:3141/admin
curl -s -o /dev/null -w "login %{http_code}\n" http://localhost:3141/login
curl -s -w " download %{http_code}\n" -X POST http://localhost:3141/download -H 'Content-Type: application/json' -d '{"url":"x"}'
curl -s -w " twitter %{http_code}\n" -X POST http://localhost:3141/api/twitter/resolve -H 'Content-Type: application/json' -d '{"url":"x"}'
curl -s -o /dev/null -w "files %{http_code}\n" http://localhost:3141/files/x.mp4
curl -s -o /dev/null -w "css %{http_code}\n" http://localhost:3141/style.css
kill %1
```
Expected:
```
healthz 200
raiz 302 -> http://localhost:3141/login
admin 302 -> http://localhost:3141/login
login 404        ← a página só existe na Tarefa 8; aqui basta não ser redirect
{"error":"Faça login para continuar."} download 401
{"error":"Faça login para continuar."} twitter 401
files 401
css 200
```

Sem as variáveis: `node server.js` — Expected: imprime `Faltam variáveis de ambiente: ...` e sai com código 1.

- [ ] **Step 5: Rodar os testes e commitar**

Run: `npm test` — Expected: PASS.

```bash
git add server.js private/index.html
git commit -m "Servidor exige login: guardas nas rotas, páginas privadas e /healthz"
```

---

### Task 8: Páginas de login, cadastro e espera, `auth.js` e `auth.css`

**Files:**
- Create: `public/login.html`, `public/cadastro.html`, `public/aguardando.html`
- Create: `public/auth.js`, `public/auth.css`
- Modify: `private/index.html` (faixa de sessão, includes)

**Interfaces:**
- Consumes: `POST /auth/cadastro`, `POST /auth/login`, `POST /auth/sair`, `GET /auth/eu` (Tarefa 4).
- Produces: `window.redirecionarSeSemAcesso(res) → boolean` (usado por `app.js`, `twitter.js` e `admin.js`); elementos `#sessaoFaixa`, `#sessaoEmail`, `#sessaoAdmin` e botões `[data-sair]`.

- [ ] **Step 1: Criar `public/auth.css`**

```css
/* ─────────────────────────────────────────────────────────────
   Páginas de acesso (login, cadastro, espera) e painel admin.
   Carregado depois de style.css: reaproveita variáveis e .deck.
   ───────────────────────────────────────────────────────────── */

.deck-auth { max-width: 440px; }

.auth-tag {
  font-family: 'Saira Condensed', sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--ink-soft);
}

/* ── formulários ─────────────────────────────────────────────── */
.auth-form { display: flex; flex-direction: column; }
.auth-form .field-label { margin-top: 16px; }
.auth-form .field-label:first-child { margin-top: 0; }

.auth-input {
  width: 100%;
  padding: 13px 15px;
  font-family: 'Azeret Mono', ui-monospace, monospace;
  font-size: 14px;
  color: var(--screen-txt);
  background: var(--recess);
  border: 1px solid var(--recess-edge);
  border-radius: 3px;
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .7);
  outline: none;
}
.auth-input::placeholder { color: var(--screen-dim); }
.auth-input:focus-visible {
  border-color: var(--amber);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, .7), 0 0 0 2px rgba(255, 154, 31, .5);
}

.auth-btn {
  margin-top: 22px;
  padding: 14px 24px;
  font-family: 'Saira Condensed', sans-serif;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink);
  cursor: pointer;
  background: linear-gradient(180deg, var(--btn-top), var(--btn-bot));
  border: 1px solid var(--panel-lo);
  border-top-color: #fff;
  border-radius: 3px;
  box-shadow: 0 2px 0 var(--panel-lo), 0 3px 6px rgba(0, 0, 0, .28);
  transition: transform .08s ease, box-shadow .08s ease;
}
.auth-btn:hover:not(:disabled) { background: linear-gradient(180deg, var(--btn-top-hi), var(--btn-bot-hi)); }
.auth-btn:active { transform: translateY(2px); box-shadow: 0 0 0 var(--panel-lo), 0 1px 3px rgba(0, 0, 0, .3); }
.auth-btn:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.auth-btn:disabled { opacity: .5; cursor: default; transform: none; }
.auth-btn-secundario { background: none; box-shadow: none; border-top-color: var(--panel-lo); }
.auth-btn-secundario:hover:not(:disabled) { background: none; border-color: var(--ink-soft); }

.auth-link { margin: 18px 0 0; font-size: 13.5px; color: var(--ink-soft); text-align: center; }
.auth-link a { color: var(--ink); }

.auth-acoes { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
.auth-acoes .auth-btn { margin-top: 0; flex: 1; }

/* ── tela de espera ──────────────────────────────────────────── */
.espera {
  padding: 18px 16px;
  font-size: 15px;
  line-height: 1.55;
  color: var(--screen-txt);
  background: var(--recess);
  border-radius: 3px;
  border-left: 3px solid var(--amber);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .7);
}
body.is-blocked .espera { border-left-color: var(--rec); }
.espera-email {
  display: block;
  margin-top: 10px;
  font-family: 'Azeret Mono', ui-monospace, monospace;
  font-size: 12.5px;
  color: var(--screen-dim);
}

/* ── faixa de sessão (index e admin) ─────────────────────────── */
.sessao {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-basis: 100%;
  font-size: 12.5px;
  color: var(--ink-soft);
}
.sessao-email {
  flex: 1;
  min-width: 0;
  font-family: 'Azeret Mono', ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── painel admin ────────────────────────────────────────────── */
.abas { display: flex; gap: 6px; margin-bottom: 14px; }
.aba {
  flex: 1;
  padding: 9px 6px;
  font-family: 'Saira Condensed', sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink-soft);
  cursor: pointer;
  background: none;
  border: 1px solid var(--panel-lo);
  border-radius: 3px;
}
.aba.is-active { color: var(--ink); background: linear-gradient(180deg, var(--btn-top), var(--btn-bot)); }
.aba:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }

.usuarios {
  padding: 6px;
  border-radius: 3px;
  background: var(--recess);
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, .7);
}
.usuario {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 8px;
  color: var(--screen-txt);
}
.usuario + .usuario { border-top: 1px solid rgba(255, 255, 255, .07); }
.usuario-email {
  flex: 1;
  min-width: 0;
  font-family: 'Azeret Mono', ui-monospace, monospace;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.usuario-data { font-size: 12px; color: var(--screen-dim); }
.usuario-admin { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--amber); }
.usuario-acoes { display: flex; gap: 6px; }
.usuario-acoes button {
  padding: 6px 10px;
  font-family: 'Saira Condensed', sans-serif;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--screen-txt);
  cursor: pointer;
  background: none;
  border: 1px solid rgba(255, 255, 255, .25);
  border-radius: 3px;
}
.usuario-acoes button:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); }
.usuario-acoes button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.usuario-acoes button:disabled { opacity: .45; cursor: default; }
.usuarios-vazio { margin: 0; padding: 18px; text-align: center; font-size: 13.5px; color: var(--screen-dim); }
```

- [ ] **Step 2: Criar `public/auth.js`**

```js
// Login, cadastro, tela de espera e faixa de sessão. Um arquivo só: cada
// página usa um pedaço, e o que não existe no DOM é ignorado.
(function () {
  const $ = id => document.getElementById(id);

  // Usado por app.js, twitter.js e admin.js depois de um fetch: 401 manda pro
  // login, 403 pra tela de espera. Devolve true se redirecionou.
  window.redirecionarSeSemAcesso = function (res) {
    if (res.status === 401) { location.href = '/login';      return true; }
    if (res.status === 403) { location.href = '/aguardando'; return true; }
    return false;
  };

  async function postar(caminho, corpo) {
    const res = await fetch(caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    let dados = {};
    try { dados = await res.json(); } catch {}
    return { ok: res.ok, dados };
  }

  function mostrarErro(msg) {
    const el = $('erro');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // ── login ────────────────────────────────────────────────────
  const formLogin = $('formLogin');
  if (formLogin) formLogin.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('btnLogin');
    btn.disabled = true;
    let r = null;
    try { r = await postar('/auth/login', { email: $('email').value, senha: $('senha').value }); } catch {}
    btn.disabled = false;
    if (!r)    return mostrarErro('Sem conexão com o servidor.');
    if (!r.ok) return mostrarErro(r.dados.error || 'Não foi possível entrar.');
    location.href = r.dados.aprovado ? '/' : '/aguardando';
  });

  // ── cadastro ─────────────────────────────────────────────────
  const formCadastro = $('formCadastro');
  if (formCadastro) formCadastro.addEventListener('submit', async e => {
    e.preventDefault();
    const senha = $('senha').value;
    if (senha.length < 8)                return mostrarErro('A senha precisa ter pelo menos 8 caracteres.');
    if (senha !== $('confirmaSenha').value) return mostrarErro('As senhas não conferem.');
    const btn = $('btnCadastro');
    btn.disabled = true;
    let r = null;
    try { r = await postar('/auth/cadastro', { email: $('email').value, senha }); } catch {}
    btn.disabled = false;
    if (!r)    return mostrarErro('Sem conexão com o servidor.');
    if (!r.ok) return mostrarErro(r.dados.error || 'Não foi possível criar a conta.');
    location.href = r.dados.aprovado ? '/' : '/aguardando';
  });

  // ── sair (qualquer página com [data-sair]) ───────────────────
  document.querySelectorAll('[data-sair]').forEach(b => b.addEventListener('click', async () => {
    try { await fetch('/auth/sair', { method: 'POST' }); } catch {}
    location.href = '/login';
  }));

  // ── tela de espera ───────────────────────────────────────────
  const esperaTexto = $('esperaTexto');
  if (esperaTexto) {
    fetch('/auth/eu').then(r => (r.ok ? r.json() : null)).then(eu => {
      if (!eu)         return (location.href = '/login');
      if (eu.aprovado) return (location.href = '/');
      $('esperaEmail').textContent = eu.email;
      const bloqueado = eu.status === 'blocked';
      document.body.classList.toggle('is-blocked', bloqueado);
      esperaTexto.textContent = bloqueado
        ? 'Seu acesso foi bloqueado. Se acha que foi engano, fale com o administrador.'
        : 'Sua conta está aguardando aprovação. Assim que o administrador liberar, é só entrar de novo.';
    }).catch(() => mostrarErro('Sem conexão com o servidor.'));
    $('btnVerificar').addEventListener('click', () => location.reload());
  }

  // ── faixa de sessão (index e admin) ──────────────────────────
  const faixa = $('sessaoFaixa');
  if (faixa) {
    fetch('/auth/eu').then(r => (r.ok ? r.json() : null)).then(eu => {
      if (!eu) return;
      $('sessaoEmail').textContent = eu.email;
      if (eu.admin) $('sessaoAdmin').classList.remove('hidden');
      faixa.classList.remove('hidden');
    }).catch(() => {});
  }
})();
```

- [ ] **Step 3: Criar `public/login.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Entrar — Meekz Drop</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Azeret+Mono:wght@400..700&family=Saira+Condensed:wght@500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/style.css?v=5" />
  <link rel="stylesheet" href="/auth.css?v=1" />
  <script>
    (function () {
      var t;
      try { t = localStorage.getItem('meekz-theme'); } catch (e) {}
      if (t !== 'light' && t !== 'dark') {
        t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>
<body>
  <button type="button" id="themeToggle" class="theme-toggle" aria-label="Mudar para acabamento escuro">
    <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
    <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  </button>

  <main class="deck deck-auth">
    <header class="deck-head">
      <h1 class="logo">Meekz Drop</h1>
      <span class="auth-tag">Acesso restrito</span>
    </header>

    <form id="formLogin" class="auth-form" novalidate>
      <label class="field-label" for="email">E-mail</label>
      <input class="auth-input" type="email" id="email" autocomplete="email" required />

      <label class="field-label" for="senha">Senha</label>
      <input class="auth-input" type="password" id="senha" autocomplete="current-password" required />

      <button type="submit" id="btnLogin" class="auth-btn">Entrar</button>
      <p id="erro" class="error hidden"></p>
      <p class="auth-link">Ainda não tem conta? <a href="/cadastro">Criar conta</a></p>
    </form>
  </main>

  <script src="/theme.js"></script>
  <script src="/auth.js?v=1"></script>
</body>
</html>
```

- [ ] **Step 4: Criar `public/cadastro.html`**

Igual ao `login.html` (mesmo `<head>`, mesmo botão de tema, mesmos scripts), com `<title>Criar conta — Meekz Drop</title>` e este `<main>`:

```html
  <main class="deck deck-auth">
    <header class="deck-head">
      <h1 class="logo">Meekz Drop</h1>
      <span class="auth-tag">Criar conta</span>
    </header>

    <form id="formCadastro" class="auth-form" novalidate>
      <label class="field-label" for="email">E-mail</label>
      <input class="auth-input" type="email" id="email" autocomplete="email" required />

      <label class="field-label" for="senha">Senha (mínimo 8 caracteres)</label>
      <input class="auth-input" type="password" id="senha" autocomplete="new-password" minlength="8" required />

      <label class="field-label" for="confirmaSenha">Confirmar senha</label>
      <input class="auth-input" type="password" id="confirmaSenha" autocomplete="new-password" minlength="8" required />

      <button type="submit" id="btnCadastro" class="auth-btn">Criar conta</button>
      <p id="erro" class="error hidden"></p>
      <p class="auth-link">Sua conta fica pendente até o administrador aprovar.</p>
      <p class="auth-link">Já tem conta? <a href="/login">Entrar</a></p>
    </form>
  </main>
```

- [ ] **Step 5: Criar `public/aguardando.html`**

Mesmo `<head>` e botão de tema, `<title>Aguardando aprovação — Meekz Drop</title>`, e este `<main>`:

```html
  <main class="deck deck-auth">
    <header class="deck-head">
      <h1 class="logo">Meekz Drop</h1>
      <span class="auth-tag">Sua conta</span>
    </header>

    <div class="espera">
      <span id="esperaTexto">Verificando sua conta...</span>
      <span id="esperaEmail" class="espera-email"></span>
    </div>
    <p id="erro" class="error hidden"></p>

    <div class="auth-acoes">
      <button type="button" id="btnVerificar" class="auth-btn">Verificar de novo</button>
      <button type="button" class="auth-btn auth-btn-secundario" data-sair>Sair</button>
    </div>
  </main>
```

- [ ] **Step 6: Faixa de sessão em `private/index.html`**

No `<head>`, depois de `<link rel="stylesheet" href="style.css?v=5" />`, troque os caminhos relativos por absolutos e acrescente o CSS de auth:

```html
  <link rel="stylesheet" href="/style.css?v=5" />
  <link rel="stylesheet" href="/auth.css?v=1" />
```

Dentro de `<header class="deck-head">`, depois do `<div class="lamp" ...>...</div>`, acrescente:

```html
      <div id="sessaoFaixa" class="sessao hidden">
        <span id="sessaoEmail" class="sessao-email"></span>
        <a id="sessaoAdmin" class="tw-link hidden" href="/admin">Admin</a>
        <button type="button" class="tw-link" data-sair>Sair</button>
      </div>
```

No fim do `<body>`, troque os três scripts por caminhos absolutos e inclua `auth.js` **antes** de `app.js`:

```html
  <script src="/theme.js"></script>
  <script src="/auth.js?v=1"></script>
  <script src="/app.js?v=12"></script>
  <script src="/twitter.js?v=1"></script>
```

- [ ] **Step 7: Conferir no navegador com o servidor de variáveis falsas**

Suba como no Step 4 da Tarefa 7 (porta 3141) e abra `http://localhost:3141/login`, `/cadastro` e `/aguardando` (esta redireciona para `/login`). Expected: as duas páginas aparecem no visual "deck", sem erro no console; o toggle de tema funciona. Enviar o login com senha qualquer mostra "Serviço de login indisponível. Tente de novo." (Supabase falso). Depois `kill %1`.

- [ ] **Step 8: Rodar os testes e commitar**

Run: `npm test` — Expected: PASS.

```bash
git add public/auth.css public/auth.js public/login.html public/cadastro.html public/aguardando.html private/index.html
git commit -m "Páginas de login, cadastro e espera; faixa de sessão na página principal"
```

---

### Task 9: Painel `/admin`

**Files:**
- Create: `private/admin.html`
- Create: `public/admin.js`

**Interfaces:**
- Consumes: `GET /admin/usuarios`, `POST /admin/usuarios/:id/status` (Tarefa 5), `window.redirecionarSeSemAcesso` e a faixa de sessão (Tarefa 8).

- [ ] **Step 1: Criar `private/admin.html`**

Mesmo `<head>` e botão de tema do `login.html`, `<title>Admin — Meekz Drop</title>`, e este `<main>` e scripts:

```html
  <main class="deck">
    <header class="deck-head">
      <h1 class="logo">Meekz Drop</h1>
      <span class="auth-tag">Painel do admin</span>
      <div id="sessaoFaixa" class="sessao hidden">
        <span id="sessaoEmail" class="sessao-email"></span>
        <a id="sessaoAdmin" class="tw-link hidden" href="/">Downloads</a>
        <button type="button" class="tw-link" data-sair>Sair</button>
      </div>
    </header>

    <div class="abas" role="tablist" aria-label="Status dos usuários">
      <button type="button" class="aba is-active" role="tab" data-status="pending">Pendentes</button>
      <button type="button" class="aba" role="tab" data-status="approved">Aprovados</button>
      <button type="button" class="aba" role="tab" data-status="blocked">Bloqueados</button>
    </div>

    <div id="usuarios" class="usuarios"></div>
    <p id="erro" class="error hidden"></p>
  </main>

  <script src="/theme.js"></script>
  <script src="/auth.js?v=1"></script>
  <script src="/admin.js?v=1"></script>
```

- [ ] **Step 2: Criar `public/admin.js`**

```js
// Painel /admin: lista os usuários por status e aprova, bloqueia ou devolve a pendente.
// DOM manual, no mesmo estilo de twitter.js.
(function () {
  const $ = id => document.getElementById(id);
  const lista = $('usuarios');
  const erro  = $('erro');
  if (!lista) return;

  const ROTULO = { pending: 'Pendentes', approved: 'Aprovados', blocked: 'Bloqueados' };
  // botões por status atual: [status novo, rótulo]
  const ACOES = {
    pending:  [['approved', 'Aprovar'],  ['blocked', 'Bloquear']],
    approved: [['blocked',  'Bloquear'], ['pending', 'Voltar a pendente']],
    blocked:  [['approved', 'Aprovar'],  ['pending', 'Voltar a pendente']],
  };

  let usuarios = [];
  let aba = 'pending';

  function mostrarErro(msg) { erro.textContent = msg; erro.classList.remove('hidden'); }

  async function carregar() {
    let res;
    try { res = await fetch('/admin/usuarios'); }
    catch { return mostrarErro('Sem conexão com o servidor.'); }
    if (redirecionarSeSemAcesso(res)) return;
    if (!res.ok) return mostrarErro('Não foi possível carregar a lista.');
    usuarios = (await res.json()).usuarios;
    erro.classList.add('hidden');
    desenhar();
  }

  function desenhar() {
    document.querySelectorAll('.aba').forEach(b => {
      const n = usuarios.filter(u => u.status === b.dataset.status).length;
      b.textContent = `${ROTULO[b.dataset.status]} (${n})`;
      b.classList.toggle('is-active', b.dataset.status === aba);
      b.setAttribute('aria-selected', String(b.dataset.status === aba));
    });

    lista.innerHTML = '';
    const visiveis = usuarios.filter(u => u.status === aba);
    if (!visiveis.length) {
      const p = document.createElement('p');
      p.className = 'usuarios-vazio';
      p.textContent = 'Ninguém aqui.';
      lista.appendChild(p);
      return;
    }
    visiveis.forEach(u => lista.appendChild(linha(u)));
  }

  function linha(u) {
    const row = document.createElement('div');
    row.className = 'usuario';

    const email = document.createElement('span');
    email.className = 'usuario-email';
    email.textContent = u.email;
    email.title = u.email;

    const data = document.createElement('span');
    data.className = 'usuario-data';
    data.textContent = new Date(u.created_at).toLocaleDateString('pt-BR');

    row.append(email, data);

    if (u.admin) {
      const tag = document.createElement('span');
      tag.className = 'usuario-admin';
      tag.textContent = 'admin';
      row.appendChild(tag);
      return row;
    }

    const acoes = document.createElement('div');
    acoes.className = 'usuario-acoes';
    for (const [status, rotulo] of ACOES[u.status]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = rotulo;
      b.addEventListener('click', () => mudar(u, status, b));
      acoes.appendChild(b);
    }
    row.appendChild(acoes);
    return row;
  }

  async function mudar(u, status, botao) {
    botao.disabled = true;
    let res;
    try {
      res = await fetch(`/admin/usuarios/${encodeURIComponent(u.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      botao.disabled = false;
      return mostrarErro('Sem conexão com o servidor.');
    }
    if (redirecionarSeSemAcesso(res)) return;
    if (!res.ok) {
      botao.disabled = false;
      let d = {};
      try { d = await res.json(); } catch {}
      return mostrarErro(d.error || 'Não foi possível mudar o status.');
    }
    await carregar();
  }

  document.querySelectorAll('.aba').forEach(b => b.addEventListener('click', () => {
    aba = b.dataset.status;
    desenhar();
  }));

  carregar();
})();
```

- [ ] **Step 3: Conferir sintaxe e servir**

Run: `node --check public/admin.js` — Expected: sem saída.

Com o servidor de variáveis falsas (porta 3141): `curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" http://localhost:3141/admin` — Expected: `302 -> http://localhost:3141/login`. A conferência visual do painel fica para a Tarefa 12, que precisa do Supabase real.

- [ ] **Step 4: Commit**

```bash
git add private/admin.html public/admin.js
git commit -m "Painel /admin para aprovar, bloquear e listar usuários"
```

---

### Task 10: `app.js` e `twitter.js` redirecionam em 401/403

**Files:**
- Modify: `public/app.js:95-105` (runDownload), `public/app.js:189-195` (playlist), `public/app.js:454-460` (extract)
- Modify: `public/twitter.js:100-110` (resolver)
- Modify: `test/fila.test.js:62-80` (stub no sandbox)

**Interfaces:**
- Consumes: `window.redirecionarSeSemAcesso(res)` (Tarefa 8).

- [ ] **Step 1: Stub no sandbox do `fila.test.js`**

Em `test/fila.test.js`, dentro de `load()`, logo depois de `ctx.triggerSave = ...` (linha 78), acrescente:

```js
  // auth.js define isto na página; no sandbox nunca há sessão a perder
  ctx.redirecionarSeSemAcesso = () => false;
```

- [ ] **Step 2: Teste de que o redirecionamento é chamado em 401**

No fim de `test/fila.test.js`:

```js
test('resposta 401 no download chama o redirecionamento de acesso', async () => {
  const { ctx, dom, settle } = load(async (url) => {
    if (url.endsWith('/playlist')) return { ok: false, status: 401, json: async () => ({ error: 'Faça login para continuar.' }) };
    return { ok: false, status: 401, json: async () => ({ error: 'Faça login para continuar.' }) };
  });
  const chamadas = [];
  ctx.redirecionarSeSemAcesso = res => { chamadas.push(res.status); return true; };
  dom.byId.urlInput.value = 'https://site.com/a';
  ctx.addToQueue();
  await settle();
  await ctx.startBatch();
  assert.ok(chamadas.includes(401), 'app.js avisou o auth.js do 401');
});
```

Run: `node --test test/fila.test.js` — Expected: o teste novo FALHA (`chamadas` vazio).

- [ ] **Step 3: Chamar o helper em `app.js`**

Em `runDownload` (linha 101), troque:

```js
  if (!res.ok) {
    let err = {};
```
por
```js
  if (!res.ok) {
    if (redirecionarSeSemAcesso(res)) throw new Error('Sessão encerrada.');
    let err = {};
```

Na análise de playlist (linha 189-195), logo depois de `const data = await res.json();`, acrescente antes do `if (res.ok ...)`:

```js
    if (redirecionarSeSemAcesso(res)) return;
```

Em `extractM3u8` (linha 454-460), logo depois de `const data = await res.json();`, acrescente:

```js
    if (redirecionarSeSemAcesso(res)) return null;
```

- [ ] **Step 4: Chamar o helper em `twitter.js`**

Em `resolver(item)`, logo depois de `try { data = await res.json(); } catch {}` (linha 108), acrescente:

```js
      if (redirecionarSeSemAcesso(res)) return;
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npm test` — Expected: PASS, incluindo o teste novo.
Run: `node --check public/app.js && node --check public/twitter.js` — Expected: sem saída.

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/twitter.js test/fila.test.js
git commit -m "Frontend manda para o login ou para a espera quando perde o acesso"
```

---

### Task 11: Configuração, deploy e README

**Files:**
- Modify: `render.yaml`
- Create: `.env.example`
- Modify: `package.json` (`engines`)
- Modify: `README.md`

- [ ] **Step 1: `render.yaml`**

Substitua o arquivo inteiro:

```yaml
# Deploy no Render. O Render não lê o railway.json — sem este arquivo é
# preciso escolher "Docker" na mão ao criar o serviço, e escolher "Node" por
# engano sobe o app sem yt-dlp e sem ffmpeg, com todo download falhando.
services:
  - type: web
    name: viddrop
    runtime: docker
    dockerfilePath: ./Dockerfile
    # O painel do Render nao deixa trocar o plano de um servico gerenciado por
    # blueprint: o valor daqui e que vale. Mudar o plano e mudar esta linha.
    plan: starter
    region: oregon
    autoDeploy: true
    # A raiz redireciona para /login; /healthz responde 200 sem tocar em nada.
    healthCheckPath: /healthz
    # sync: false = o Render pede o valor no painel e nunca grava aqui.
    envVars:
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SECRET_KEY
        sync: false
      - key: SESSION_SECRET
        sync: false
      - key: ADMIN_EMAIL
        sync: false
```

- [ ] **Step 2: `.env.example`**

```
# Copie para .env e preencha. O .env é ignorado pelo git.
# Rode local com: node --env-file=.env server.js

# Projeto spm-homolog no Supabase
SUPABASE_URL=https://ujyaacvsalqzgepczxri.supabase.co
# Chave secreta do projeto (Settings > API Keys > Secret keys). Nunca vai pro frontend.
SUPABASE_SECRET_KEY=
# Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=
# Seu e-mail: é quem entra em /admin e aprova as pessoas
ADMIN_EMAIL=
```

- [ ] **Step 3: `package.json`**

Troque `"node": ">=18.0.0"` por `"node": ">=20.6.0"`.

- [ ] **Step 4: README**

Troque o título e a primeira linha por:

```markdown
# Meekz Drop

Downloader de vídeos com frontend HTML/CSS e backend Node.js usando yt-dlp.
Acesso restrito: quem quer usar cria uma conta e o dono aprova.
```

Em "Requisitos", troque `**Node.js** 18+` por `**Node.js** 20.6+` e acrescente `- Um projeto no **Supabase** (Auth + Postgres) para as contas`.

Substitua a seção "Estrutura" por:

```markdown
## Estrutura

```
2viddrop/
├── public/               ← estático e público: CSS, JS, login/cadastro/espera, páginas legais
├── private/              ← páginas só para logado: index.html (aprovados) e admin.html (admin)
├── auth/                 ← sessão em cookie, repositório Supabase, guardas e rotas /auth e /admin
├── twitter/              ← feature Twitter/X (/api/twitter)
├── video/                ← corte de intro com ffmpeg
├── test/                 ← node --test
├── downloads/            ← arquivos temporários (auto-deletados)
├── server.js             ← Express + yt-dlp
└── render.yaml           ← deploy no Render (Docker)
```
```

Substitua a tabela de "Variáveis de Ambiente" por:

```markdown
| Variável              | Padrão   | Descrição                                                        |
|-----------------------|----------|------------------------------------------------------------------|
| `SUPABASE_URL`        | —        | **Obrigatória.** URL do projeto Supabase                          |
| `SUPABASE_SECRET_KEY` | —        | **Obrigatória.** Chave secreta (`sb_secret_...` ou `service_role`) |
| `SESSION_SECRET`      | —        | **Obrigatória.** Segredo do cookie de sessão (32+ bytes em hex)   |
| `ADMIN_EMAIL`         | —        | **Obrigatória.** E-mail do dono; é quem entra em `/admin`         |
| `PORT`                | `3000`   | Porta do servidor                                                |
| `YTDLP_BIN`           | `yt-dlp` | Caminho customizado do executável                                |
```

Acrescente, depois dessa tabela, a seção nova:

```markdown
## Login e aprovação

O site inteiro fica atrás de login. Fluxo:

1. A pessoa abre `/cadastro`, cria a conta (e-mail e senha) e cai em `/aguardando`.
2. Você entra com o e-mail de `ADMIN_EMAIL` (cadastre-se como qualquer pessoa: esse
   e-mail é sempre tratado como aprovado e admin) e abre `/admin`.
3. Em `/admin`, aba **Pendentes**, clique **Aprovar**. A pessoa recarrega `/aguardando`
   e entra. **Bloquear** tira o acesso na hora.

As contas ficam no Supabase Auth e o status na tabela `viddrop_profiles`
(migração `viddrop_profiles`, projeto `spm-homolog`). Só o servidor acessa a tabela,
com a chave secreta.

Local: copie `.env.example` para `.env`, preencha e rode

```bash
node --env-file=.env server.js
```

Sem as quatro variáveis o servidor não sobe e diz qual falta.
```

Na seção "Deploy no Render", troque os passos 3-5 por:

```markdown
3. O `render.yaml` já fixa o runtime Docker e o health check em `/healthz`
4. No painel do serviço, preencha `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SESSION_SECRET` e `ADMIN_EMAIL`
```

Na lista "Funcionalidades", acrescente no topo: `- ✅ Login com e-mail e senha; só usuário aprovado pelo admin baixa`.

- [ ] **Step 5: Conferir e commitar**

Run: `npm test` — Expected: PASS. Run: `cat .gitignore | grep -x .env` — Expected: `.env` (já está ignorado).

```bash
git add render.yaml .env.example package.json README.md
git commit -m "Variáveis de ambiente do login no Render, .env.example e README"
```

---

### Task 12: Teste manual ponta a ponta com o Supabase real

**Files:**
- Nenhum (só verificação). Precisa do `.env` preenchido pelo dono (Tarefa 11, Step 2).

- [ ] **Step 1: Subir o servidor com o `.env`**

```bash
node --env-file=.env server.js
```
Expected: `🟢 VidDrop rodando em http://localhost:3000` sem erro de variável.

- [ ] **Step 2: Cadastro e espera**

No navegador: `http://localhost:3000/` → redireciona para `/login`. Clique "Criar conta", cadastre `teste1@exemplo.com` com senha de 8+ caracteres. Expected: cai em `/aguardando` com o texto "Sua conta está aguardando aprovação" e o e-mail embaixo. Abrir `/` de novo volta para `/aguardando`.

- [ ] **Step 3: Admin**

Em outra janela anônima: `/cadastro` com o e-mail de `ADMIN_EMAIL`. Expected: cai direto em `/` (admin é aprovado sempre) com a faixa mostrando o e-mail e o link **Admin**. Clique **Admin**. Expected: aba Pendentes (1) com `teste1@exemplo.com`. Clique **Aprovar**. Expected: some de Pendentes e aparece em Aprovados.

- [ ] **Step 4: Download como aprovado**

Na janela do `teste1`: clique **Verificar de novo**. Expected: vai para `/`. Cole um link curto de vídeo (por exemplo `https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4`) e baixe. Expected: download conclui e o arquivo é salvo.

- [ ] **Step 5: Bloqueio e 403**

No admin: aba Aprovados, **Bloquear** o `teste1`. Na janela do `teste1`, cole outro link e clique baixar. Expected: a página vai para `/aguardando` com "Seu acesso foi bloqueado" (o 403 disparou o redirecionamento).

- [ ] **Step 6: Sair e proteção direta**

Clique **Sair** nas duas janelas. Expected: volta para `/login`. Acesse direto `http://localhost:3000/index.html` e `http://localhost:3000/admin.html`. Expected: ambos redirecionam para `/login`. `http://localhost:3000/style.css` → 200.

- [ ] **Step 7: Verificar no Supabase**

Pelo MCP `execute_sql` no `ujyaacvsalqzgepczxri`:
```sql
select email, status, reviewed_at is not null as revisado from public.viddrop_profiles order by created_at;
```
Expected: duas linhas: o admin `pending` (o status gravado dele não importa) e `teste1@exemplo.com` `blocked` com `revisado = true`.

- [ ] **Step 8: Registrar o resultado**

Anote aqui o que passou e o que não passou. Se algo falhou, abra uma correção como tarefa nova antes de dar por concluído.

`Resultado: ____`
