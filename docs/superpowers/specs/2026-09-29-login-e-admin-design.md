# Login, aprovação de usuários e painel /admin — desenho

Data: 2026-09-29
Projeto: Meekz Drop (repositório `2viddrop`), Express + frontend estático, deploy no Render (Docker).

## 1. Objetivo

Hoje o site inteiro é público: qualquer pessoa cola um link e baixa. O objetivo é
trancar o site atrás de um login e deixar **só o dono** (admin) decidir quem pode
usar. Fluxo:

1. A pessoa cria uma conta (e-mail e senha) e fica **pendente**.
2. O admin abre `/admin`, vê a lista e **aprova** ou **bloqueia** cada conta.
3. Só conta **aprovada** vê a página de downloads e consegue baixar.

Sucesso: um usuário novo não consegue baixar nada até o admin aprovar; depois de
aprovado, usa o site exatamente como hoje; bloqueado perde o acesso na hora.

## 2. Decisões tomadas com o dono

| Decisão | Escolha |
|---|---|
| O que fica trancado | O site inteiro. Anônimo cai em `/login`. |
| Onde guardar usuários | Supabase Auth + tabela de perfis (abordagem A). |
| Projeto do Supabase | **Reaproveitar `spm-homolog`** (`ujyaacvsalqzgepczxri`, `https://ujyaacvsalqzgepczxri.supabase.co`). Aceito que o gatilho `on_auth_user_created` desse projeto crie um `profiles`, um `workspaces` e um `workspace_members` para cada cadastro do viddrop. |
| Método de login | E-mail e senha. Sem Google, sem link mágico. |
| Confirmação de e-mail | Desligada: a aprovação manual do admin é o filtro. |
| Quem é admin | O e-mail em `ADMIN_EMAIL`. Sem tabela de papéis. |
| Sessão | Cookie assinado pelo próprio servidor (não o token do Supabase). |

## 3. Fluxo do usuário

| Rota | Quem vê | O que faz |
|---|---|---|
| `/login` | Qualquer um | Formulário e-mail + senha. Link para `/cadastro`. Sucesso: aprovado → `/`, pendente ou bloqueado → `/aguardando`. Se já está logado, redireciona direto conforme o status. |
| `/cadastro` | Qualquer um | Formulário e-mail + senha (mínimo 8 caracteres) + confirmação de senha. Cria a conta pendente, já entra logado e vai para `/aguardando`. |
| `/aguardando` | Logado não aprovado | Texto "Sua conta está aguardando aprovação" ou "Seu acesso foi bloqueado" conforme o status. Botões **Verificar de novo** (recarrega; se aprovou, vai para `/`) e **Sair**. Anônimo → `/login`. Aprovado → `/`. |
| `/` | Aprovado | O app atual, sem mudança interna. Ganha uma faixa no cabeçalho com o e-mail, link **Admin** (só admin) e botão **Sair**. |
| `/admin` | Admin | Lista de usuários em abas **Pendentes**, **Aprovados**, **Bloqueados**. Cada linha: e-mail, data de cadastro, status, botões **Aprovar** / **Bloquear** / **Voltar a pendente** (os que fazem sentido para o status). A linha do admin aparece marcada e sem botões. Não admin logado → `/`. Anônimo → `/login`. |
| `/termos.html`, `/privacidade.html` | Qualquer um | Continuam públicas, sem mudança. |

O admin se cadastra como qualquer pessoa. O servidor trata o e-mail igual a
`ADMIN_EMAIL` (comparação sem diferenciar maiúsculas) como **aprovado e admin
sempre**, independente do status gravado. Não existe passo manual de bootstrap.

## 4. Arquitetura do servidor

Novo diretório `auth/`, um arquivo por responsabilidade. Nada em `server.js`
sobre auth além de montar o módulo e aplicar as guardas.

| Arquivo | Responsabilidade | Depende de |
|---|---|---|
| `auth/sessao.js` | `assinar({ id, email })` → string do cookie; `verificar(str)` → payload ou `null`. HMAC-SHA256 com `crypto` nativo. Validade 30 dias. Helpers `lerCookie(req)` / `gravarCookie(res, valor)` / `limparCookie(res)`. | `crypto`, `SESSION_SECRET` |
| `auth/supabase.js` | Cria o cliente admin (chave secreta, `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false`) e a função `loginComSenha(email, senha)`, que cria um cliente **descartável** por chamada e devolve `{ id, email }` ou lança. Cliente descartável porque, depois de `signInWithPassword`, o SDK passa a usar o token do usuário no lugar da chave secreta. | `@supabase/supabase-js`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` |
| `auth/repositorio.js` | Implementação Supabase das cinco operações: `criarUsuario(email, senha)`, `loginComSenha(email, senha)`, `buscarPerfil(id)`, `listarPerfis()`, `mudarStatus(id, status)`. É a única fronteira com o Supabase; os testes trocam por uma versão em memória com a mesma interface. | `auth/supabase.js` |
| `auth/middleware.js` | `carregarSessao` (só valida o cookie e preenche `req.sessao = { id, email }` ou `null`; **não** consulta o banco, porque roda em todo pedido, inclusive assets); `carregarUsuario` (busca o perfil e preenche `req.usuario = { id, email, status, admin, aprovado }` ou `null`; usado pelas guardas e por `/auth/eu`); `exigirAprovadoPagina`, `exigirAprovadoApi`, `exigirAdminPagina`, `exigirAdminApi`. | `auth/sessao.js`, repositório, `ADMIN_EMAIL` |
| `auth/rotas.js` | Router com `/auth/*` e `/admin/usuarios*`. | middleware, repositório |
| `auth/index.js` | `montarAuth(app, { repositorio, adminEmail, segredoSessao })`: registra `carregarSessao`, o router e devolve as guardas. Usado por `server.js` e pelos testes. | tudo acima |

`server.js` muda em pontos localizados:

- `app.set('trust proxy', 1)` para o Render (cookie `Secure` via `req.secure`).
- Chama `montarAuth` logo depois de `express.json()`.
- Falha ao subir (mensagem clara e `process.exit(1)`) se faltar qualquer uma das
  quatro variáveis de ambiente.
- Páginas privadas saem de `public/` e vão para `private/` (`private/index.html`,
  `private/admin.html`), servidas por rotas explícitas com guarda. Assim nenhum
  caminho direto (`/index.html`, `/admin.html`) vaza a página. Os assets que elas
  usam (`style.css`, `app.js`, `twitter.js`, `theme.js`, `background.png`) continuam
  em `public/` e são públicos: são só código de interface.
- Rotas `GET /login`, `GET /cadastro`, `GET /aguardando` servem os HTML de `public/`
  pelo caminho limpo (o arquivo `.html` direto também funciona, é público).
- Guardas aplicadas às rotas existentes (ver seção 6).
- `GET /healthz` → `200 ok` (a raiz passa a redirecionar, e o health check do Render
  não pode depender disso).

Dependência nova: `@supabase/supabase-js` com versão fixada (`2.117.2` no momento
da escrita; instalar a mais recente 2.x e fixar). `package-lock.json` commitado.
Nada de biblioteca de cookie nem de JWT: o `crypto` nativo resolve.

## 5. Sessão (cookie)

- Nome: `meekz_sessao`.
- Valor: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET))`.
- Payload: `{ "id": "<uuid>", "email": "<email>", "exp": <epoch ms> }`. `exp` = agora + 30 dias.
- Atributos: `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`; `Secure` quando
  `req.secure` for verdadeiro (produção atrás do proxy do Render; em `localhost` HTTP
  fica sem `Secure`).
- `verificar` rejeita: formato errado, assinatura diferente (comparação em tempo
  constante com `crypto.timingSafeEqual`), `exp` vencido, JSON inválido. Em qualquer
  falha, o pedido segue como anônimo (não é erro).
- O cookie não carrega status: o status é lido do banco a cada pedido guardado, para
  que bloquear tenha efeito imediato. Sem cache nesta versão.
- CSRF: `SameSite=Lax` impede que outro site dispare `POST` com o cookie. O `cors()`
  aberto de hoje fica como está: sem `Access-Control-Allow-Credentials`, navegador
  nenhum manda o cookie em pedido de outra origem.

## 6. Guarda de rotas

`req.sessao` é preenchido por `carregarSessao` em todo pedido (só o cookie, sem
banco). Cada guarda chama `carregarUsuario`, que faz **uma** consulta ao perfil, e
então decide:

| Rota | Anônimo | Pendente / bloqueado | Aprovado | Admin |
|---|---|---|---|---|
| `GET /`, `GET /index.html` | 302 `/login` | 302 `/aguardando` | página | página |
| `GET /admin`, `GET /admin.html` | 302 `/login` | 302 `/aguardando` | 302 `/` | página |
| `GET /login`, `GET /cadastro` | página | 302 `/aguardando` | 302 `/` | 302 `/` |
| `GET /aguardando` | 302 `/login` | página | 302 `/` | 302 `/` |
| `POST /extract`, `/playlist`, `/info`, `/download`, `/cancel/:id` | 401 JSON | 403 JSON | passa | passa |
| `GET /files/*` | 401 JSON | 403 JSON | passa | passa |
| `/api/twitter/*` | 401 JSON | 403 JSON | passa | passa |
| `GET /auth/eu` | 401 JSON | `{ email, status, admin }` | idem | idem |
| `GET /admin/usuarios`, `POST /admin/usuarios/:id/status` | 401 JSON | 403 JSON | 403 JSON | passa |
| `GET /healthz`, `/termos.html`, `/privacidade.html`, assets | passa | passa | passa | passa |

Corpo dos erros de API: `{ "error": "Faça login para continuar." }` (401) e
`{ "error": "Sua conta ainda não foi aprovada." }` ou `"Seu acesso foi bloqueado."` (403).
A chave é `error` porque é a que `app.js` e `twitter.js` já leem.

Se a busca do perfil no Supabase falhar (rede, serviço fora): API responde
`503 { "error": "Serviço de login indisponível. Tente de novo." }`; página responde
`503` com esse mesmo texto em HTML simples (não redireciona, para não entrar em loop).

`GET /test` (diagnóstico do yt-dlp) passa a exigir admin, por revelar detalhes do servidor.

## 7. Rotas novas

| Método e rota | Corpo | Sucesso | Erros |
|---|---|---|---|
| `POST /auth/cadastro` | `{ email, senha }` | `201 { status: "pending" }` + cookie | `400` e-mail inválido ou senha < 8; `409` e-mail já cadastrado; `503` Supabase fora |
| `POST /auth/login` | `{ email, senha }` | `200 { status }` + cookie (`status` é `pending`, `approved` ou `blocked`) | `400` campos faltando; `401` "E-mail ou senha incorretos." (mensagem única, sem revelar se o e-mail existe); `503` |
| `POST /auth/sair` | — | `204` + cookie limpo | — |
| `GET /auth/eu` | — | `200 { email, status, admin }` | `401` |
| `GET /admin/usuarios` | — | `200 { usuarios: [{ id, email, status, created_at, reviewed_at, admin }] }`, ordenado por `created_at` desc | `401`, `403` |
| `POST /admin/usuarios/:id/status` | `{ status }` com `approved`, `blocked` ou `pending` | `200 { id, status }` | `400` status inválido ou tentativa de mudar o próprio admin; `404` id inexistente; `401`, `403` |

Detalhes:

- **Cadastro**: `auth.admin.createUser({ email, password, email_confirm: true })`,
  depois `insert` em `viddrop_profiles` com `status = 'pending'`. E-mail é
  normalizado (`trim`, minúsculas) antes de tudo. Erro do Supabase com código
  `email_exists` (ou mensagem contendo "already") vira `409`.
- **Login**: `loginComSenha` → `buscarPerfil(id)`. Se o perfil não existir (usuário
  criado fora do app), cria pendente na hora. Grava o cookie e responde o status.
  Bloqueado **pode** logar: vê a tela de bloqueio em `/aguardando`.
- **Mudar status**: grava `status` e `reviewed_at = now()`. Se o `:id` for o do
  admin logado, `400`.
- **Listar**: marca `admin: true` na linha cujo e-mail é o `ADMIN_EMAIL`.

## 8. Banco (projeto `spm-homolog`)

Uma migração via MCP `apply_migration`, nome `viddrop_profiles`:

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

- Sem policies de propósito: `anon` e `authenticated` não enxergam nada pela Data
  API; a chave secreta (service role) ignora RLS. Mesmo padrão da tabela
  `x_credentials` do projeto `postgrape`.
- Sem índice extra: a tabela tem dezenas de linhas, e a PK cobre a busca por id.
- Depois de aplicar, rodar `get_advisors` (security) e confirmar que a tabela não
  aparece como exposta.
- O gatilho existente `on_auth_user_created` do spm-homolog continua rodando a cada
  cadastro (cria `profiles`, `workspaces`, `workspace_members`). É efeito colateral
  aceito, não é tocado.

## 9. Frontend

Arquivos novos em `public/`:

| Arquivo | Conteúdo |
|---|---|
| `login.html` | Cabeçalho "Meekz Drop", painel com dois campos e botão **Entrar**, link "Criar conta". Mensagem de erro no mesmo estilo de `#error`. |
| `cadastro.html` | Três campos (e-mail, senha, confirmar senha), botão **Criar conta**, link "Já tenho conta". |
| `aguardando.html` | Cartão com o texto do status (preenchido por `/auth/eu`), botões **Verificar de novo** e **Sair**. |
| `auth.js` | Um arquivo para as três páginas acima e para a faixa de sessão. Detecta pela presença dos elementos. Faz os `fetch` de `/auth/*`, mostra erros, redireciona conforme a resposta. Expõe `montarFaixaSessao()` usado por `index.html` e `admin.html`. |
| `admin.js` | Carrega `/admin/usuarios`, desenha as abas e as linhas, dispara `POST .../status` e recarrega a lista. Sem framework, mesmo estilo de DOM manual de `twitter.js`. |
| `auth.css` | Regras só das páginas de auth e do painel (formulários, abas, tabela, faixa de sessão). Carregado depois de `style.css`. Reaproveita as variáveis de cor e as classes `deck`, `panel`, `box`, `field-label`, `error`. |

Páginas privadas em `private/`:

- `private/index.html`: o `public/index.html` atual movido (`git mv`), com a faixa
  de sessão adicionada no `header.deck-head` e `auth.css` + `auth.js` incluídos.
- `private/admin.html`: cabeçalho igual, painel com abas e lista.

Mudanças em arquivos existentes:

- `app.js` e `twitter.js`: nos pontos onde já leem `res.ok`, tratar `401` →
  `location.href = '/login'` e `403` → `location.href = '/aguardando'`, via um helper
  `redirecionarSeSemAcesso(res)` definido em `auth.js` (carregado antes deles).
- `theme.js` é incluído em todas as páginas novas, para manter o tema.
- Todas as páginas novas usam `lang="pt-BR"`, as mesmas fontes do Google e o toggle
  de tema.

## 10. Configuração e deploy

Variáveis de ambiente (todas obrigatórias):

| Variável | Valor |
|---|---|
| `SUPABASE_URL` | `https://ujyaacvsalqzgepczxri.supabase.co` |
| `SUPABASE_SECRET_KEY` | Chave secreta do projeto (`sb_secret_...`; a `service_role` legada também funciona). Nunca vai para o frontend. |
| `SESSION_SECRET` | String aleatória longa (32+ bytes em hex). Trocar invalida todas as sessões. |
| `ADMIN_EMAIL` | E-mail do dono. |

- `render.yaml`: adiciona as quatro em `envVars` com `sync: false` (o Render pede o
  valor no painel e nunca grava no repositório) e troca `healthCheckPath` para `/healthz`.
- Local: arquivo `.env` (já ignorado pelo git) e `node --env-file=.env server.js`.
  `engines.node` sobe para `>=20.6.0` (o Dockerfile já usa Node 20; `--env-file`
  existe desde 20.6).
- README: seção nova "Login e aprovação" com as variáveis, como criar o `.env`, como
  gerar o `SESSION_SECRET` e como funciona a aprovação. Remover a afirmação de que
  não há usuários.
- `.env.example` com as quatro chaves vazias, commitado.

## 11. Erros e casos de borda

| Situação | Comportamento |
|---|---|
| Cookie inválido, adulterado ou vencido | Pedido segue como anônimo. |
| Usuário apagado no Supabase mas com cookie válido | `buscarPerfil` não acha → tratado como anônimo, cookie limpo. |
| Admin muda o próprio status | `400`, nada gravado. |
| Admin bloqueado no banco (alguém editou a tabela) | Continua admin: o e-mail manda. |
| Supabase fora do ar | `503` em API e páginas guardadas; login e cadastro respondem `503` com mensagem. |
| Senha < 8 no cadastro | `400` antes de chamar o Supabase. |
| Duas abas: bloqueado no meio de um download | O download em curso termina (o processo já está rodando); o próximo pedido recebe `403`. |
| `/files/<nome>` de um download antigo | Exige aprovado; anônimo recebe `401`. |

## 12. Testes

Mantém `node --test test/*.test.js`, sem Supabase nos testes.

- `test/sessao.test.js`: assina e verifica; payload volta igual; `exp` vencido →
  `null`; assinatura alterada → `null`; string sem ponto → `null`; segredo diferente
  → `null`.
- `test/auth.test.js`: sobe um `express()` de teste, chama `montarAuth` com um
  repositório em memória (`Map` de perfis e `Map` de senhas) e registra uma rota
  `POST /protegida` com `exigirAprovadoApi` e um `GET /pagina` com
  `exigirAprovadoPagina`. Usa `http` nativo em porta aleatória. Casos:
  - anônimo: `GET /pagina` → 302 `/login`; `POST /protegida` → 401.
  - cadastro → 201, cookie presente, `GET /auth/eu` → `pending`.
  - pendente: `GET /pagina` → 302 `/aguardando`; `POST /protegida` → 403.
  - admin muda status para `approved` → `POST /protegida` → 200.
  - `blocked` → 403 com a mensagem de bloqueio.
  - login com senha errada → 401 com a mensagem única; e-mail inexistente → mesma mensagem.
  - cadastro repetido → 409.
  - e-mail igual a `ADMIN_EMAIL` pendente → `GET /admin/usuarios` → 200; outro usuário aprovado → 403.
  - admin tenta mudar o próprio status → 400.
  - `POST /auth/sair` → 204 e o pedido seguinte é anônimo.
  - repositório em memória lançando erro → 503.
- `test/fila.test.js` e `test/twitter.test.js` continuam passando (o helper
  `redirecionarSeSemAcesso` precisa existir no sandbox do `fila.test.js`: o teste
  ganha um stub).
- Teste manual final, com o servidor real e o Supabase: cadastro, tela de espera,
  aprovação pelo `/admin`, download de um link, bloqueio e `403`.

## 13. Fora desta versão

- Recuperação de senha por e-mail (o Supabase Auth já suporta; precisa de página
  de redefinição e de configurar o Site URL no projeto).
- Excluir usuário pelo painel: bloquear cobre o caso; excluir esbarra nas chaves
  estrangeiras que o gatilho do spm-homolog cria.
- Atualizar `termos.html` / `privacidade.html` (seis idiomas) que dizem que não há
  cadastro nem banco de usuários. Fica como pendência para o dono.
- Cache do status do perfil, limite de tentativas de login próprio (o Supabase Auth
  já limita por IP no endpoint de token).

## 14. Ordem sugerida de implementação

1. Migração no Supabase + advisors.
2. `auth/sessao.js` com testes.
3. Repositório em memória + `auth/middleware.js` + `auth/rotas.js` + `auth/index.js` com `test/auth.test.js`.
4. `auth/supabase.js` + `auth/repositorio.js` (Supabase real).
5. `server.js`: variáveis, `montarAuth`, guardas, páginas privadas, `/healthz`.
6. Frontend: páginas, `auth.js`, `admin.js`, `auth.css`, ajustes em `app.js`/`twitter.js`.
7. `render.yaml`, `.env.example`, README, `package.json`.
8. Teste manual ponta a ponta.
