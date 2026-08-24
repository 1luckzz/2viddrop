'use strict';

// Resolve metadados de um post do X via yt-dlp (que já tem extractor próprio).
// Nada aqui é compartilhado com o downloader M3U8 — módulo independente.

const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const { ehHostDeMidiaPermitido } = require('./validation');
const { resolverPorSyndication } = require('./syndication');

const TIMEOUT_MS    = 25000;
const MAX_BUFFER    = 12 * 1024 * 1024;   // JSON de metadados não passa disso
const MAX_FORMATOS  = 12;

const ERROS = {
  naoEncontrado: 'Não foi possível encontrar esse post.',
  semVideo:      'Esse post não contém um vídeo.',
  privado:       'Esse vídeo não está disponível publicamente.',
  temporario:    'Não foi possível processar o vídeo agora. Tente novamente.',
};

// Mesma detecção do server.js: em desenvolvimento no Windows o binário é o
// yt-dlp.exe da raiz do projeto, e não existe um "yt-dlp" no PATH. Sem isto o
// execFile falha com ENOENT e todo post vira "falha temporária".
function binarioYtDlp() {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  const local = path.join(__dirname, '..', 'yt-dlp.exe');
  if (fs.existsSync(local)) return local;
  return 'yt-dlp';
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
  if (!info || typeof info !== 'object') return [];
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

// O timeout do execFile manda SIGTERM e confia que o processo morre. Não morre:
// no Windows o sinal não derruba o yt-dlp, e o binário ainda gera um subprocesso.
// Sem matar a árvore, o stdio nunca fecha, o callback nunca vem e a requisição
// fica pendurada — foi o que deixou a fila presa em "Buscando..." pra sempre.
function matarArvore(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => {});
  } else {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

/**
 * Chama o yt-dlp só para metadados. A URL já vem validada e remontada pelo
 * servidor, e os argumentos vão separados — nunca concatenados numa string.
 * @param {string} urlValidada
 */
function resolverPorYtDlp(urlValidada) {
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

    let respondeu = false;
    let alarme    = null;

    // Uma resposta, e só uma, sempre — aconteça o que acontecer com o processo.
    function responder(r) {
      if (respondeu) return;
      respondeu = true;
      clearTimeout(alarme);
      resolve(r);
    }

    const filho = execFile(binarioYtDlp(), args, {
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err && !String(stdout || '').trim()) {
        if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
          return responder({ ok: false, status: 504, erro: ERROS.temporario });
        }
        const msg = traduzirErro(stderr || err.message);
        const status = msg === ERROS.naoEncontrado ? 404
                     : msg === ERROS.privado       ? 403
                     : msg === ERROS.semVideo      ? 422 : 502;
        return responder({ ok: false, status, erro: msg });
      }

      try {
        let info;
        try {
          info = JSON.parse(String(stdout).trim().split('\n')[0]);
        } catch {
          return responder({ ok: false, status: 502, erro: ERROS.temporario });
        }

        // Quando não consegue extrair, o yt-dlp escreve "null" no stdout — que é
        // JSON válido e vira null. Sem esta guarda o código seguia adiante e
        // estourava, deixando a requisição pendurada sem nunca responder.
        if (!info || typeof info !== 'object') {
          const msg = traduzirErro(stderr || '');
          const status = msg === ERROS.naoEncontrado ? 404
                       : msg === ERROS.privado       ? 403
                       : msg === ERROS.semVideo      ? 422 : 502;
          return responder({ ok: false, status, erro: msg });
        }

        const formats = extrairFormatos(info);
        if (!formats.length) {
          return responder({ ok: false, status: 422, erro: ERROS.semVideo });
        }

        responder({
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
      } catch (e) {
        // Rede de segurança: qualquer falha inesperada vira resposta, nunca
        // uma promise pendurada.
        console.error('[twitter] erro ao montar resposta:', e && e.message);
        responder({ ok: false, status: 502, erro: ERROS.temporario });
      }
    });

    alarme = setTimeout(() => {
      matarArvore(filho);
      responder({ ok: false, status: 504, erro: ERROS.temporario });
    }, TIMEOUT_MS);
  });
}

/**
 * Tenta a API de syndication primeiro — é um GET só, responde em milissegundos
 * e cobre a maioria dos posts públicos. Qualquer falha dela cai no yt-dlp, que
 * continua sendo o caminho definitivo e não foi alterado por esta adição.
 *
 * @param {string} urlValidada  URL remontada pelo servidor
 * @param {string} [tweetId]    id já validado; sem ele, vai direto ao yt-dlp
 */
async function resolverTweet(urlValidada, tweetId) {
  if (tweetId) {
    try {
      const via = await resolverPorSyndication(tweetId);
      if (via.ok && via.dados && via.dados.formats.length) {
        return { ok: true, dados: via.dados };
      }
    } catch {
      // nunca deixa a syndication derrubar a resolução: segue pro yt-dlp
    }
  }
  return resolverPorYtDlp(urlValidada);
}

module.exports = {
  resolverTweet,
  resolverPorYtDlp,
  extrairFormatos,
  traduzirErro,
  ERROS,
};
