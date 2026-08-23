'use strict';

// Validação e normalização de links de post do Twitter/X.
// Isolado de propósito: nada aqui é usado pelo downloader M3U8.

// Hosts aceitos na entrada. Subdomínios só os conhecidos — nada de curinga,
// senão "x.com.atacante.net" passaria.
const HOSTS_ENTRADA = new Set([
  'x.com', 'www.x.com', 'mobile.x.com', 'm.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com',
]);

// Hosts de onde a mídia pode ser servida. Usado na hora de baixar, pra a rota
// não virar proxy aberto.
const HOSTS_MIDIA = new Set([
  'video.twimg.com',
  'pbs.twimg.com',
  'video-cf.twimg.com',
]);

// /usuario/status/123 — com ou sem barra, sufixo (/photo/1, /video/1) e query
const CAMINHO_STATUS = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/;

// Um host que seja IP (v4, v6 ou decimal) nunca é um post do X; barrar aqui
// fecha a porta de SSRF por IP literal.
function pareceIP(hostname) {
  if (!hostname) return true;
  if (hostname.startsWith('[')) return true;                 // IPv6 entre colchetes
  if (/^\d+$/.test(hostname)) return true;                   // decimal (2130706433)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return true; // IPv4
  if (/^0x[0-9a-f]+$/i.test(hostname)) return true;          // hexadecimal
  return false;
}

/**
 * Valida e normaliza a URL de um post.
 * @returns {{ok: true, tweetId: string, url: string, autor: string}
 *          |{ok: false, erro: string}}
 */
function validarUrlTweet(entrada) {
  const ERRO_URL = 'Cole um link válido de um post do Twitter/X.';

  if (typeof entrada !== 'string') return { ok: false, erro: ERRO_URL };

  const bruta = entrada.trim();
  if (!bruta || bruta.length > 2048) return { ok: false, erro: ERRO_URL };

  // Sem esquema explícito assumimos https, mas nunca aceitamos outros
  // (javascript:, data:, file:, ftp:).
  const comEsquema = /^[a-z][a-z0-9+.-]*:/i.test(bruta) ? bruta : 'https://' + bruta;

  let u;
  try { u = new URL(comEsquema); } catch { return { ok: false, erro: ERRO_URL }; }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, erro: ERRO_URL };
  if (u.username || u.password) return { ok: false, erro: ERRO_URL };  // user:senha@host
  if (u.port) return { ok: false, erro: ERRO_URL };

  const host = u.hostname.toLowerCase();
  if (pareceIP(host)) return { ok: false, erro: ERRO_URL };
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, erro: ERRO_URL };
  if (!HOSTS_ENTRADA.has(host)) return { ok: false, erro: ERRO_URL };

  const m = CAMINHO_STATUS.exec(u.pathname);
  if (!m) return { ok: false, erro: ERRO_URL };

  const autor   = m[1];
  const tweetId = m[2].replace(/^0+(?=\d)/, '');
  if (!/^\d{1,25}$/.test(tweetId)) return { ok: false, erro: ERRO_URL };

  // A URL que vai pro yt-dlp é remontada por nós a partir do id validado —
  // nada do texto original do usuário chega à linha de comando.
  return {
    ok: true,
    tweetId,
    autor,
    url: `https://x.com/${autor}/status/${tweetId}`,
  };
}

/** A URL de mídia resolvida aponta pra um host de mídia esperado do X? */
function ehHostDeMidiaPermitido(valor) {
  let u;
  try { u = new URL(String(valor)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (pareceIP(host)) return false;
  return HOSTS_MIDIA.has(host);
}

module.exports = {
  validarUrlTweet,
  ehHostDeMidiaPermitido,
  HOSTS_ENTRADA,
  HOSTS_MIDIA,
};
