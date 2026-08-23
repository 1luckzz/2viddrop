'use strict';

// Resolve metadados de um post do X via yt-dlp (que já tem extractor próprio).
// Nada aqui é compartilhado com o downloader M3U8 — módulo independente.

const { execFile } = require('child_process');
const { ehHostDeMidiaPermitido } = require('./validation');

const TIMEOUT_MS    = 25000;
const MAX_BUFFER    = 12 * 1024 * 1024;   // JSON de metadados não passa disso
const MAX_FORMATOS  = 12;

const ERROS = {
  naoEncontrado: 'Não foi possível encontrar esse post.',
  semVideo:      'Esse post não contém um vídeo.',
  privado:       'Esse vídeo não está disponível publicamente.',
  temporario:    'Não foi possível processar o vídeo agora. Tente novamente.',
};

function binarioYtDlp() {
  return process.env.YTDLP_BIN || 'yt-dlp';
}

// O yt-dlp fala inglês e com detalhes técnicos; traduzimos pra algo que o
// usuário entenda, sem nunca repassar stack trace nem a saída crua.
function traduzirErro(stderr) {
  const t = String(stderr || '').toLowerCase();

  if (/no video could be found|there'?s no video|no media found|unsupported url/.test(t)) {
    return ERROS.semVideo;
  }
  if (/nsfw|age-restricted|protected|private|log ?in|authentication|requested content is not available|not authorized/.test(t)) {
    return ERROS.privado;
  }
  if (/no status found|does not exist|page doesn'?t exist|not found|404|tweet unavailable|account.*suspended/.test(t)) {
    return ERROS.naoEncontrado;
  }
  return ERROS.temporario;
}

function rotuloQualidade(altura, largura) {
  if (!altura) return largura ? `${largura}px` : 'Padrão';
  return `${altura}p`;
}

// filesize quando o yt-dlp sabe; senão estima por bitrate × duração.
function tamanhoEstimado(f, duracao) {
  if (typeof f.filesize === 'number' && f.filesize > 0) return f.filesize;
  if (typeof f.filesize_approx === 'number' && f.filesize_approx > 0) return f.filesize_approx;
  if (typeof f.tbr === 'number' && f.tbr > 0 && typeof duracao === 'number' && duracao > 0) {
    return Math.round((f.tbr * 1000 / 8) * duracao);   // tbr vem em kbit/s
  }
  return null;
}

/**
 * Seleciona os MP4 progressivos do tweet, do maior pro menor.
 * Variantes HLS são identificadas mas ficam de fora: quem baixa HLS aqui é o
 * módulo M3U8, e ele não é alterado por esta feature.
 */
function extrairFormatos(info) {
  const duracao = typeof info.duration === 'number' ? info.duration : null;
  const brutos  = Array.isArray(info.formats) ? info.formats : [];

  const mp4 = brutos.filter(f => {
    if (!f || typeof f.url !== 'string') return false;
    if (!ehHostDeMidiaPermitido(f.url)) return false;          // só mídia do X
    if (f.protocol && !/^https?$/.test(f.protocol)) return false; // exclui m3u8_native/dash
    if (f.vcodec === 'none') return false;                     // faixa só de áudio
    return (f.ext || '').toLowerCase() === 'mp4';
  });

  // Mesma resolução pode vir repetida; fica a de maior bitrate.
  const porResolucao = new Map();
  for (const f of mp4) {
    const chave = `${f.width || 0}x${f.height || 0}`;
    const atual = porResolucao.get(chave);
    if (!atual || (f.tbr || 0) > (atual.tbr || 0)) porResolucao.set(chave, f);
  }

  return [...porResolucao.values()]
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .slice(0, MAX_FORMATOS)
    .map(f => ({
      id:       String(f.format_id || `${f.width}x${f.height}`),
      ext:      'mp4',
      width:    f.width  || null,
      height:   f.height || null,
      quality:  rotuloQualidade(f.height, f.width),
      bitrate:  typeof f.tbr === 'number' ? Math.round(f.tbr) : null,
      filesize: tamanhoEstimado(f, duracao),
      url:      f.url,
    }));
}

function melhorThumbnail(info) {
  if (typeof info.thumbnail === 'string' && ehHostDeMidiaPermitido(info.thumbnail)) {
    return info.thumbnail;
  }
  const lista = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const boa = lista
    .filter(t => t && typeof t.url === 'string' && ehHostDeMidiaPermitido(t.url))
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return boa ? boa.url : null;
}

function resumir(texto, limite = 180) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > limite ? t.slice(0, limite - 1).trimEnd() + '…' : t;
}

/**
 * Chama o yt-dlp só para metadados. A URL já vem validada e remontada pelo
 * servidor, e os argumentos vão separados — nunca concatenados numa string.
 * @param {string} urlValidada
 */
function resolverTweet(urlValidada) {
  return new Promise(resolve => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--socket-timeout', '15',
      '--retries', '2',
      urlValidada,
    ];

    execFile(binarioYtDlp(), args, {
      timeout:   TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && !String(stdout || '').trim()) {
        if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
          return resolve({ ok: false, status: 504, erro: ERROS.temporario });
        }
        const msg = traduzirErro(stderr || err.message);
        const status = msg === ERROS.naoEncontrado ? 404
                     : msg === ERROS.privado       ? 403
                     : msg === ERROS.semVideo      ? 422 : 502;
        return resolve({ ok: false, status, erro: msg });
      }

      let info;
      try {
        info = JSON.parse(String(stdout).trim().split('\n')[0]);
      } catch {
        return resolve({ ok: false, status: 502, erro: ERROS.temporario });
      }

      const formats = extrairFormatos(info);
      if (!formats.length) {
        return resolve({ ok: false, status: 422, erro: ERROS.semVideo });
      }

      resolve({
        ok: true,
        dados: {
          tweetId:   String(info.id || ''),
          title:     resumir(info.title || info.description || ''),
          author:    info.uploader || info.uploader_id || info.channel || '',
          thumbnail: melhorThumbnail(info),
          duration:  typeof info.duration === 'number' ? info.duration : null,
          formats,
        },
      });
    });
  });
}

module.exports = { resolverTweet, extrairFormatos, traduzirErro, ERROS };
