'use strict';

// Caminho alternativo de resolução: a API pública de syndication do X — a mesma
// que alimenta posts embutidos em sites de terceiros. É um GET só, sem processo
// externo, então responde bem mais rápido que o yt-dlp.
//
// Não substitui o yt-dlp: é tentada antes, e qualquer falha cai nele.
// Não serve posts com mídia sensível/restrita — esses continuam exigindo login,
// que esta feature deliberadamente não faz.

const https = require('https');
const { ehHostDeMidiaPermitido } = require('./validation');

const HOST        = 'cdn.syndication.twimg.com';
const TIMEOUT_MS  = 8000;
const MAX_BYTES   = 2 * 1024 * 1024;

// O widget de embed do X deriva este token do próprio id do post.
function tokenDoId(tweetId) {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function buscarJson(tweetId) {
  return new Promise((resolve, reject) => {
    const caminho = `/tweet-result?id=${encodeURIComponent(tweetId)}`
                  + `&token=${encodeURIComponent(tokenDoId(tweetId))}&lang=pt`;

    const req = https.get({
      hostname: HOST,                 // host fixo: nada aqui vem do usuário
      path: caminho,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                    + '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: TIMEOUT_MS,
    }, resp => {
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error('http ' + resp.statusCode));
      }

      let corpo = '';
      let bytes = 0;
      resp.on('data', p => {
        bytes += p.length;
        if (bytes > MAX_BYTES) { resp.destroy(); return reject(new Error('resposta grande demais')); }
        corpo += p;
      });
      resp.on('end', () => {
        try { resolve(JSON.parse(corpo.replace(/^﻿/, ''))); }
        catch (e) { reject(e); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// As URLs de mp4 do X trazem a resolução no caminho: .../vid/720x1280/arquivo.mp4
function resolucaoDaUrl(url) {
  const m = /\/(\d{2,4})x(\d{2,4})\//.exec(String(url || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

function rotuloQualidade(altura, largura) {
  if (altura) return `${altura}p`;
  return largura ? `${largura}px` : 'Padrão';
}

/**
 * Converte a resposta da syndication no mesmo formato que o resolver do yt-dlp
 * devolve, para o resto da aplicação não precisar saber de onde veio.
 */
function extrairDeSyndication(j) {
  if (!j || typeof j !== 'object') return null;

  const midias = Array.isArray(j.mediaDetails) ? j.mediaDetails : [];
  const comVideo = midias.filter(m => m && m.video_info
    && Array.isArray(m.video_info.variants)
    && (m.type === 'video' || m.type === 'animated_gif'));

  if (!comVideo.length) return null;

  const midia   = comVideo[0];
  const duracao = typeof midia.video_info.duration_millis === 'number'
    ? Math.round(midia.video_info.duration_millis / 1000)
    : null;

  // Só mp4 progressivo, e só de host de mídia do X. Variantes HLS ficam de fora:
  // quem baixa HLS é o módulo M3U8, que esta feature não altera.
  const porResolucao = new Map();
  for (const v of midia.video_info.variants) {
    if (!v || typeof v.url !== 'string') continue;
    if (v.content_type !== 'video/mp4') continue;
    if (!ehHostDeMidiaPermitido(v.url)) continue;

    const { width, height } = resolucaoDaUrl(v.url);
    const chave = `${width || 0}x${height || 0}`;
    const atual = porResolucao.get(chave);
    if (!atual || (v.bitrate || 0) > (atual.bitrate || 0)) {
      porResolucao.set(chave, { ...v, width, height });
    }
  }

  const formats = [...porResolucao.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
    .map(v => ({
      id:       String(v.bitrate || v.height || 'mp4'),
      ext:      'mp4',
      width:    v.width,
      height:   v.height,
      quality:  rotuloQualidade(v.height, v.width),
      bitrate:  typeof v.bitrate === 'number' ? Math.round(v.bitrate / 1000) : null,
      filesize: typeof v.bitrate === 'number' && duracao
        ? Math.round((v.bitrate / 8) * duracao)
        : null,
      url:      v.url,
    }));

  if (!formats.length) return null;

  const thumb = typeof midia.media_url_https === 'string'
             && ehHostDeMidiaPermitido(midia.media_url_https)
    ? midia.media_url_https
    : null;

  const texto = String(j.text || '').replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim();

  return {
    tweetId:   String(j.id_str || ''),
    title:     texto.length > 180 ? texto.slice(0, 179).trimEnd() + '…' : texto,
    author:    (j.user && (j.user.screen_name || j.user.name)) || '',
    thumbnail: thumb,
    duration:  duracao,
    formats,
  };
}

/**
 * @param {string} tweetId  já validado como sequência de dígitos
 * @returns {Promise<{ok:true, dados:object}|{ok:false}>}
 */
async function resolverPorSyndication(tweetId) {
  if (!/^\d{1,25}$/.test(String(tweetId || ''))) return { ok: false };
  try {
    const dados = extrairDeSyndication(await buscarJson(tweetId));
    return dados ? { ok: true, dados } : { ok: false };
  } catch {
    return { ok: false };   // silencioso de propósito: o yt-dlp assume daqui
  }
}

module.exports = { resolverPorSyndication, extrairDeSyndication, tokenDoId };
