'use strict';

// Limite de tentativas por IP em janela deslizante, em memória (mesmo padrão
// de twitter/routes.js). Protege /auth/login e /auth/cadastro de força bruta:
// como quem fala com o Supabase é o servidor, o limite do Supabase veria só o
// IP do Render e valeria pro site inteiro, não por atacante.

function criarLimitador({ max = 10, janelaMs = 15 * 60 * 1000 } = {}) {
  const acessos = new Map();   // ip -> number[] (timestamps)

  return function limitar(req, res, next) {
    const ip    = req.ip || (req.socket && req.socket.remoteAddress) || 'desconhecido';
    const agora = Date.now();
    const lista = (acessos.get(ip) || []).filter(t => agora - t < janelaMs);

    if (lista.length >= max) {
      res.set('Retry-After', String(Math.ceil(janelaMs / 1000)));
      return res.status(429).json({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' });
    }

    lista.push(agora);
    acessos.set(ip, lista);
    if (acessos.size > 5000) acessos.clear();   // teto de memória
    next();
  };
}

module.exports = { criarLimitador };
