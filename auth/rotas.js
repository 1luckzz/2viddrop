'use strict';

// Rotas de conta (/auth/*) e do painel (/admin/usuarios*).
// Toda resposta de erro é JSON com a chave `error`, como o resto do servidor.
const express = require('express');
const { ErroEmailExistente } = require('./erros');
const { normalizar, descrever } = require('./middleware');
const { criarLimitador } = require('./limite');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS   = ['pending', 'approved', 'blocked'];

function criarRotas({ sessao, repositorio, mw, limiteTentativas }) {
  const router  = express.Router();
  const limitar = criarLimitador(limiteTentativas);

  function responderErro(res, e) {
    if (e instanceof ErroEmailExistente) return res.status(409).json({ error: e.message });
    console.error('[auth]', descrever(e));
    return res.status(503).json({ error: mw.MSG.indisponivel });
  }

  function entrar(req, res, perfil) {
    sessao.gravarCookie(req, res, sessao.assinar({ id: perfil.id, email: perfil.email }));
    return { status: perfil.status, aprovado: mw.ehAdmin(perfil.email) || perfil.status === 'approved' };
  }

  router.post('/auth/cadastro', limitar, async (req, res) => {
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

  router.post('/auth/login', limitar, async (req, res) => {
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

  return router;
}

module.exports = { criarRotas, STATUS };
