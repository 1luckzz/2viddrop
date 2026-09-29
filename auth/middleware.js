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
