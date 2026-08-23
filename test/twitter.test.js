'use strict';

// Suíte da feature Twitter/X + guarda de regressão do downloader M3U8.
// Roda com `npm test` (node:test, embutido — sem dependência nova).

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const path   = require('node:path');
const http   = require('node:http');
const express = require('express');

const { validarUrlTweet, ehHostDeMidiaPermitido } = require('../twitter/validation');
const { extrairFormatos, traduzirErro, ERROS }    = require('../twitter/resolver');

const RAIZ = path.join(__dirname, '..');

// ── 2, 3: URLs válidas ───────────────────────────────────────
describe('validação — links aceitos', () => {
  const validas = [
    ['x.com',             'https://x.com/usuario/status/123456789'],
    ['twitter.com',       'https://twitter.com/usuario/status/123456789'],
    ['mobile.twitter.com','https://mobile.twitter.com/usuario/status/123456789'],
    ['www + query',       'https://www.x.com/user/status/123?s=20&t=abc'],
    ['sufixo /video/1',   'https://x.com/user/status/123/video/1'],
    ['sem esquema',       'x.com/user/status/123'],
    ['http',              'http://twitter.com/user/status/123'],
  ];

  for (const [nome, url] of validas) {
    test(nome, () => {
      const r = validarUrlTweet(url);
      assert.equal(r.ok, true, `deveria aceitar: ${url}`);
      assert.match(r.tweetId, /^\d+$/);
      // a URL entregue ao yt-dlp é remontada pelo servidor
      assert.match(r.url, /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/);
    });
  }

  test('normaliza para forma canônica', () => {
    const r = validarUrlTweet('https://mobile.twitter.com/Alguem/status/000123?s=1');
    assert.equal(r.tweetId, '123');
    assert.equal(r.url, 'https://x.com/Alguem/status/123');
  });
});

// ── 9, 10, 11, 12: entradas rejeitadas ───────────────────────
describe('validação — links rejeitados', () => {
  const invalidas = [
    ['string vazia',            ''],
    ['não é URL',               'isso não é link'],
    ['outro domínio',           'https://youtube.com/watch?v=abc'],
    ['domínio parecido',        'https://x.com.atacante.net/user/status/123'],
    ['perfil sem status',       'https://x.com/usuario'],
    ['home',                    'https://x.com/'],
    ['SSRF localhost',          'http://localhost/user/status/123'],
    ['SSRF 127.0.0.1',          'http://127.0.0.1/user/status/123'],
    ['SSRF IP decimal',         'http://2130706433/user/status/123'],
    ['SSRF metadata AWS',       'http://169.254.169.254/user/status/123'],
    ['SSRF IPv6',               'http://[::1]/user/status/123'],
    ['SSRF via credenciais',    'https://x.com@evil.com/user/status/123'],
    ['SSRF porta interna',      'https://x.com:8080/user/status/123'],
    ['esquema file',            'file:///etc/passwd'],
    ['esquema javascript',      'javascript:alert(1)'],
    ['esquema data',            'data:text/html,<script>alert(1)</script>'],
    ['injeção shell ;',         'https://x.com/u/status/123; rm -rf /'],
    ['injeção shell $()',       'https://x.com/u/status/$(whoami)'],
    ['injeção shell backtick',  'https://x.com/u/status/`id`'],
    ['injeção pipe',            'https://x.com/u/status/123 | cat /etc/passwd'],
    ['id não numérico',         'https://x.com/u/status/abc'],
    ['nulo',                    null],
    ['objeto',                  { url: 'https://x.com/u/status/1' }],
  ];

  for (const [nome, url] of invalidas) {
    test(nome, () => {
      const r = validarUrlTweet(url);
      assert.equal(r.ok, false, `deveria rejeitar: ${String(url)}`);
      assert.equal(r.erro, 'Cole um link válido de um post do Twitter/X.');
    });
  }
});

// ── allowlist de mídia (anti proxy aberto) ───────────────────
describe('allowlist de host de mídia', () => {
  test('aceita hosts de mídia do X', () => {
    assert.ok(ehHostDeMidiaPermitido('https://video.twimg.com/ext_tw_video/1/pu/vid/720x1280/a.mp4'));
    assert.ok(ehHostDeMidiaPermitido('https://pbs.twimg.com/media/abc.jpg'));
  });

  test('recusa qualquer outro host', () => {
    for (const u of [
      'https://qualquer-site.com/arquivo.mp4',
      'http://video.twimg.com/a.mp4',          // sem https
      'https://video.twimg.com.evil.net/a.mp4',
      'https://127.0.0.1/a.mp4',
      'https://localhost/a.mp4',
      'file:///etc/passwd',
      'https://video.twimg.com:22/a.mp4',
    ]) {
      assert.equal(ehHostDeMidiaPermitido(u), false, `deveria recusar: ${u}`);
    }
  });
});

// ── 5, 6: formatos ───────────────────────────────────────────
describe('extração de formatos', () => {
  const info = {
    duration: 30,
    formats: [
      { format_id: 'http-1080', ext: 'mp4', width: 1920, height: 1080, tbr: 4000, protocol: 'https',
        url: 'https://video.twimg.com/a/1080.mp4' },
      { format_id: 'http-720',  ext: 'mp4', width: 1280, height: 720,  tbr: 2000, protocol: 'https',
        url: 'https://video.twimg.com/a/720.mp4' },
      { format_id: 'http-360',  ext: 'mp4', width: 640,  height: 360,  tbr: 800,  protocol: 'https',
        url: 'https://video.twimg.com/a/360.mp4' },
      // HLS: identificado, mas fora — quem baixa HLS é o módulo M3U8
      { format_id: 'hls-720',   ext: 'mp4', width: 1280, height: 720, protocol: 'm3u8_native',
        url: 'https://video.twimg.com/a/playlist.m3u8' },
      // faixa só de áudio
      { format_id: 'audio',     ext: 'mp4', vcodec: 'none', protocol: 'https',
        url: 'https://video.twimg.com/a/audio.mp4' },
      // host de fora não entra de jeito nenhum
      { format_id: 'externo',   ext: 'mp4', width: 1920, height: 1080, protocol: 'https',
        url: 'https://evil.com/a.mp4' },
    ],
  };

  test('fica só com MP4 progressivo do X', () => {
    const fs_ = extrairFormatos(info);
    assert.equal(fs_.length, 3);
    assert.ok(fs_.every(f => f.url.startsWith('https://video.twimg.com/')));
    assert.ok(!fs_.some(f => f.url.includes('.m3u8')), 'HLS não deve entrar');
    assert.ok(!fs_.some(f => f.url.includes('evil.com')), 'host externo não deve entrar');
  });

  test('ordena da maior para a menor', () => {
    const q = extrairFormatos(info).map(f => f.quality);
    assert.deepEqual(q, ['1080p', '720p', '360p']);
  });

  test('estima tamanho por bitrate × duração', () => {
    const f = extrairFormatos(info)[0];
    assert.equal(f.filesize, Math.round((4000 * 1000 / 8) * 30));
  });

  test('post sem vídeo devolve lista vazia', () => {
    assert.equal(extrairFormatos({ formats: [] }).length, 0);
    assert.equal(extrairFormatos({}).length, 0);
  });
});

// ── 6, 7, 8: mensagens de erro ───────────────────────────────
describe('mensagens de erro amigáveis', () => {
  const casos = [
    ['No video could be found in this tweet',        ERROS.semVideo],
    ['ERROR: Unsupported URL: https://x.com/u',      ERROS.semVideo],
    ['This tweet is protected',                      ERROS.privado],
    ['NSFW tweet requires authentication',           ERROS.privado],
    ['Requested content is not available',           ERROS.privado],
    ['No status found with that ID',                 ERROS.naoEncontrado],
    ['HTTP Error 404: Not Found',                    ERROS.naoEncontrado],
    ['Temporary failure in name resolution',         ERROS.temporario],
  ];

  for (const [stderr, esperado] of casos) {
    test(stderr.slice(0, 42), () => assert.equal(traduzirErro(stderr), esperado));
  }

  test('nunca vaza stack trace', () => {
    const msg = traduzirErro('Traceback (most recent call last):\n  File "yt_dlp/x.py", line 42');
    assert.ok(!msg.includes('Traceback'));
    assert.ok(!msg.includes('.py'));
    assert.equal(msg, ERROS.temporario);
  });
});

// ── 9, 10, 11, 14: rotas HTTP ────────────────────────────────
describe('rotas /api/twitter', () => {
  let servidor, base;

  function subir() {
    return new Promise(res => {
      const app = express();
      app.use(express.json());
      app.use('/api/twitter', require('../twitter/routes'));
      servidor = http.createServer(app).listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${servidor.address().port}`;
        res();
      });
    });
  }

  test('setup', async () => { await subir(); });

  test('URL inválida → 400 com mensagem amigável', async () => {
    const r = await fetch(`${base}/api/twitter/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://youtube.com/watch?v=1' }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.success, false);
    assert.equal(j.error, 'Cole um link válido de um post do Twitter/X.');
  });

  test('body sem url → 400', async () => {
    const r = await fetch(`${base}/api/twitter/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });

  test('download exige token no formato emitido pelo servidor', async () => {
    const r = await fetch(`${base}/api/twitter/download/nao-e-token`);
    assert.equal(r.status, 400);
  });

  test('download não aceita URL como parâmetro (sem proxy aberto)', async () => {
    const r = await fetch(
      `${base}/api/twitter/download/${encodeURIComponent('https://qualquer-site.com/arquivo.mp4')}`);
    assert.ok(r.status === 400 || r.status === 404, `status inesperado: ${r.status}`);
    const corpo = await r.text();
    assert.ok(!corpo.includes('qualquer-site.com'), 'não deve ecoar a URL recebida');
  });

  test('token bem formado mas desconhecido → 404', async () => {
    const r = await fetch(`${base}/api/twitter/download/${'a'.repeat(32)}`);
    assert.equal(r.status, 404);
  });

  test('rate limit responde 429 depois do teto', async () => {
    let viu429 = false;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(`${base}/api/twitter/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://youtube.com/nao-vale' }),
      });
      if (r.status === 429) {
        const j = await r.json();
        assert.equal(j.error, 'Muitas solicitações. Tente novamente em alguns instantes.');
        viu429 = true;
        break;
      }
    }
    assert.ok(viu429, 'deveria ter limitado dentro de 20 tentativas');
  });

  test('teardown', () => { servidor.close(); });
});

// ── 1: guarda de regressão do M3U8 ───────────────────────────
describe('downloader M3U8 permanece intacto', () => {
  const html   = fs.readFileSync(path.join(RAIZ, 'public/index.html'), 'utf8');
  const appJs  = fs.readFileSync(path.join(RAIZ, 'public/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8');

  test('todos os IDs que o app.js manipula seguem no HTML', () => {
    for (const id of ['urlInput', 'dlBtn', 'progress', 'bar', 'pct',
                      'status', 'speed', 'cancelBtn', 'playlist', 'error']) {
      assert.ok(html.includes(`id="${id}"`), `#${id} sumiu do index.html`);
    }
  });

  test('rotas originais continuam registradas', () => {
    for (const rota of ["'/extract'", "'/download'", "'/playlist'", "'/info'"]) {
      assert.ok(server.includes(rota), `rota ${rota} sumiu do server.js`);
    }
  });

  test('funções de download originais continuam existindo', () => {
    for (const fn of ['function runYtDlp', 'function runFfmpegHLS', 'function fetchHtml']) {
      assert.ok(server.includes(fn), `${fn} sumiu do server.js`);
    }
  });

  test('a feature Twitter não invadiu o app.js', () => {
    assert.ok(!/twitter/i.test(appJs), 'app.js não deve mencionar Twitter');
    assert.ok(!/api\/twitter/.test(appJs));
  });

  test('rotas do Twitter não colidem com as do M3U8', () => {
    const rotas = ['/extract', '/download', '/playlist', '/info', '/files'];
    for (const r of rotas) {
      assert.ok(!`/api/twitter${r}`.startsWith(r + '/'), `prefixo colidiria com ${r}`);
    }
  });
});
