'use strict';

// IP real do visitante. O site passa pela Cloudflare, que manda o IP original
// em CF-Connecting-IP; sem ela (local, Render direto) vale o req.ip, que já
// respeita o X-Forwarded-For do Render por causa do trust proxy.
function ipDoPedido(req) {
  const cf = req.get && req.get('cf-connecting-ip');
  if (cf) return cf.trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || null;
}

module.exports = { ipDoPedido };
