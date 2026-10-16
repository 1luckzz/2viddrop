'use strict';

// Localização aproximada de um IP (cidade, estado, país) via ip-api.com:
// gratuito, sem chave, 45 consultas por minuto, só HTTP no plano grátis.
// Cache em memória por IP pra não repetir consulta a cada visita.

const PRIVADOS = [
  /^::1$/, /^::ffff:127\./, /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^f[cd][0-9a-f]{2}:/i, /^fe80:/i, /^::$/,
];

function ehIpLocal(ip) {
  return typeof ip === 'string' && PRIVADOS.some(re => re.test(ip));
}

function criarGeolocalizador({ buscar = (url, opcoes) => fetch(url, opcoes), cacheMax = 5000, timeoutMs = 4000 } = {}) {
  const cache = new Map();   // ip -> string | null

  async function consultar(ip) {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=pt-BR&fields=status,country,regionName,city`;
    const res = await buscar(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res || !res.ok) return null;
    const dados = await res.json();
    if (!dados || dados.status !== 'success') return null;
    const cidadeEstado = [dados.city, dados.regionName].filter(Boolean).join(', ');
    return [cidadeEstado, dados.country].filter(Boolean).join(' · ') || null;
  }

  async function localizar(ip) {
    if (!ip) return null;
    if (ehIpLocal(ip)) return 'local';
    if (cache.has(ip)) return cache.get(ip);
    let resultado = null;
    try { resultado = await consultar(ip); }
    catch (e) { console.error('[geo] consulta falhou:', e && e.message); }
    if (cache.size >= cacheMax) cache.clear();
    cache.set(ip, resultado);
    return resultado;
  }

  return { localizar };
}

module.exports = { criarGeolocalizador, ehIpLocal };
