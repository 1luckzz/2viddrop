'use strict';

// Router isolado da feature Twitter/X. Montado em /api/twitter no server.js.
// Não toca em nenhuma rota do downloader M3U8.

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');

const { validarUrlTweet, ehHostDeMidiaPermitido } = require('./validation');
const { resolverTweet, ERROS } = require('./resolver');

const router = express.Router();

// ── Rate limit ───────────────────────────────────────────────
// Janela deslizante em memória. Suficiente pra uma instância; sem dependência
// nova e sem estado compartilhado com o resto do servidor.
const JANELA_MS       = 60000;
const MAX_POR_JANELA  = 12;
const acessos         = new Map();   // ip -> number[] (timestamps)

function limitar(req, res, next) {
  const ip    = req.ip || req.socket.remoteAddress || 'desconhecido';
  const agora = Date.now();
  const lista = (acessos.get(ip) || []).filter(t => agora - t < JANELA_MS);

  if (lista.length >= MAX_POR_JANELA) {
    res.set('Retry-After', '60');
    return res.status(429).json({
      success: false,
      error: 'Muitas solicitações. Tente novamente em alguns instantes.',
    });
  }

  lista.push(agora);
  acessos.set(ip, lista);
  if (acessos.size > 5000) acessos.clear();   // teto de memória
  next();
}

// ── Cofre de mídia ───────────────────────────────────────────
// O cliente nunca manda URL pra baixar: ele manda um token que só o servidor
// sabe emitir. É o que impede a rota de virar proxy aberto.
const TOKEN_TTL_MS = 15 * 60 * 1000;
const cofre        = new Map();   // token -> { url, nome, expira }

function guardarMidia(url, nome) {
  const token = crypto.randomBytes(16).toString('hex');
  cofre.set(token, { url, nome, expira: Date.now() + TOKEN_TTL_MS });
  return token;
}

function pegarMidia(token) {
  const item = cofre.get(token);
  if (!item) return null;
  if (Date.now() > item.expira) { cofre.delete(token); return null; }
  return item;
}

setInterval(() => {
  const agora = Date.now();
  for (const [t, v] of cofre) if (agora > v.expira) cofre.delete(t);
}, 5 * 60 * 1000).unref();

function nomeArquivo(autor, tweetId, qualidade) {
  const base = `${autor || 'twitter'}_${tweetId}_${qualidade}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
  return `${base}.mp4`;
}

// ── POST /api/twitter/resolve ────────────────────────────────
router.post('/resolve', limitar, async (req, res) => {
  const validacao = validarUrlTweet(req.body && req.body.url);
  if (!validacao.ok) {
    return res.status(400).json({ success: false, error: validacao.erro });
  }

  let resultado;
  try {
    resultado = await resolverTweet(validacao.url);
  } catch (e) {
    console.error('[twitter] falha inesperada ao resolver:', e && e.message);
    return res.status(502).json({ success: false, error: ERROS.temporario });
  }

  if (!resultado.ok) {
    return res.status(resultado.status).json({ success: false, error: resultado.erro });
  }

  const d = resultado.dados;
  const tweetId = d.tweetId || validacao.tweetId;

  // Troca a URL real por um token antes de responder: o front nunca recebe
  // endereço que ele possa mandar de volta pra rota de download.
  const formats = d.formats.map(f => ({
    id:       f.id,
    ext:      f.ext,
    width:    f.width,
    height:   f.height,
    quality:  f.quality,
    bitrate:  f.bitrate,
    filesize: f.filesize,
    token:    guardarMidia(f.url, nomeArquivo(d.author || validacao.autor, tweetId, f.quality)),
  }));

  res.json({
    success:   true,
    tweetId,
    title:     d.title,
    author:    d.author || validacao.autor,
    thumbnail: d.thumbnail,
    duration:  d.duration,
    formats,
  });
});

// ── GET /api/twitter/download/:token ─────────────────────────
const MAX_BYTES    = 512 * 1024 * 1024;
const MAX_REDIRECT = 2;

router.get('/download/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) {
    return res.status(400).json({ success: false, error: 'Link de download inválido.' });
  }

  const item = pegarMidia(token);
  if (!item) {
    return res.status(404).json({
      success: false,
      error: 'Esse link expirou. Busque o vídeo novamente.',
    });
  }

  let enviados  = 0;
  let respondeu = false;

  function falhar(status, msg) {
    if (respondeu) return res.destroy();
    respondeu = true;
    res.status(status).json({ success: false, error: msg });
  }

  function buscar(url, saltos) {
    // Revalida a cada salto: um redirect não pode nos levar pra fora do X.
    if (!ehHostDeMidiaPermitido(url)) return falhar(400, 'Origem de mídia não permitida.');
    if (saltos > MAX_REDIRECT)        return falhar(502, ERROS.temporario);

    const req2 = https.get(url, { timeout: 20000 }, resp => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        let destino;
        try { destino = new URL(resp.headers.location, url).toString(); }
        catch { return falhar(502, ERROS.temporario); }
        return buscar(destino, saltos + 1);
      }

      if (resp.statusCode !== 200) {
        resp.resume();
        return falhar(502, ERROS.temporario);
      }

      const tamanho = parseInt(resp.headers['content-length'] || '0', 10);
      if (tamanho && tamanho > MAX_BYTES) {
        resp.destroy();
        return falhar(413, 'Esse vídeo é grande demais para o servidor processar.');
      }

      respondeu = true;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${item.nome}"`);
      if (tamanho) res.setHeader('Content-Length', String(tamanho));

      resp.on('data', pedaco => {
        enviados += pedaco.length;
        if (enviados > MAX_BYTES) { resp.destroy(); res.destroy(); }
      });
      resp.pipe(res);
    });

    req2.on('timeout', () => { req2.destroy(); falhar(504, ERROS.temporario); });
    req2.on('error', () => falhar(502, ERROS.temporario));
  }

  buscar(item.url, 0);
});

module.exports = router;
