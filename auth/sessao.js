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
