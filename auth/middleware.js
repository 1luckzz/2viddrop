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

// ErroIndisponivel esconde a causa do cliente; no log ela precisa aparecer.
function descrever(e) {
  const causa = e && e.causa;
  return causa ? `${e.message} (${causa.message || causa})` : (e && e.message) || String(e);
}

function normalizar(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

const JANELA_VISITA_MS = 5 * 60 * 1000;

function criarMiddlewares({ sessao, repositorio, adminEmail, janelaVisitaMs = JANELA_VISITA_MS }) {
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
      catch (e) { console.error('[auth] perfil indisponível:', descrever(e)); return indisponivel(res, api); }

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
    catch (e) { console.error('[auth] perfil indisponível:', descrever(e)); return next(); }   // banco fora: deixa ver a página
    if (!u) return next();
    res.redirect(u.aprovado ? '/' : '/aguardando');
  }

  // /aguardando: só logado não aprovado.
  async function exigirAguardando(req, res, next) {
    let u;
    try { u = await carregarUsuario(req, res); }
    catch (e) { console.error('[auth] perfil indisponível:', descrever(e)); return indisponivel(res, false); }
    if (!u) return res.redirect('/login');
    if (u.aprovado) return res.redirect('/');
    next();
  }

  // Aba Acessos: grava quem abriu uma página, logado ou não. Uma visita por IP
  // por janela, pra recarregar a página não encher a lista. Roda em segundo
  // plano e nunca segura nem derruba a resposta.
  const visitasRecentes = new Map();   // ip -> timestamp da última visita gravada
  function registrarVisita(req, res, next) {
    next();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || null;
    const agora = Date.now();
    const ultima = ip ? visitasRecentes.get(ip) : undefined;
    if (ip && ultima !== undefined && agora - ultima < janelaVisitaMs) return;
    if (ip) visitasRecentes.set(ip, agora);
    if (visitasRecentes.size > 5000) visitasRecentes.clear();   // teto de memória

    Promise.resolve(repositorio.registrarAcesso({
      tipo: 'visita',
      userId: req.sessao ? req.sessao.id : null,
      email: req.sessao ? req.sessao.email : null,
      ip,
      userAgent: req.get('user-agent') || null,
      caminho: req.path,
    })).catch(e => console.error('[auth] registro de visita falhou:', descrever(e)));
  }

  return {
    MSG, ehAdmin, carregarSessao, carregarUsuario, registrarVisita,
    exigirAprovadoPagina: guarda({ api: false, admin: false }),
    exigirAprovadoApi:    guarda({ api: true,  admin: false }),
    exigirAdminPagina:    guarda({ api: false, admin: true }),
    exigirAdminApi:       guarda({ api: true,  admin: true }),
    redirecionarLogado,
    exigirAguardando,
  };
}

module.exports = { criarMiddlewares, normalizar, descrever, MSG };
