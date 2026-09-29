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
    if (senha.length < 8)                   return mostrarErro('A senha precisa ter pelo menos 8 caracteres.');
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
