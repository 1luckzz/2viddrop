'use strict';

// Cookie de sessão assinado: o servidor confia só no que ele mesmo assinou.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { criarSessao, NOME_COOKIE, VALIDADE_MS } = require('../auth/sessao');

const SEGREDO = 'segredo-de-teste-com-bastante-tamanho';
const DADOS   = { id: '3f2c1a00-0000-4000-8000-000000000001', email: 'ana@exemplo.com' };

describe('assinar e verificar', () => {
  test('o que foi assinado volta igual, com exp 30 dias à frente', () => {
    const s = criarSessao(SEGREDO);
    const agora = 1_700_000_000_000;
    const valor = s.assinar(DADOS, agora);
    const lido  = s.verificar(valor, agora + 1000);
    assert.deepStrictEqual(lido, { ...DADOS, exp: agora + VALIDADE_MS });
  });

  test('valor tem duas partes separadas por ponto, sem caracteres fora de base64url', () => {
    const valor = criarSessao(SEGREDO).assinar(DADOS);
    assert.match(valor, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('vencido devolve null', () => {
    const s = criarSessao(SEGREDO);
    const agora = 1_700_000_000_000;
    const valor = s.assinar(DADOS, agora);
    assert.strictEqual(s.verificar(valor, agora + VALIDADE_MS), null, 'no instante exato já venceu');
    assert.strictEqual(s.verificar(valor, agora + VALIDADE_MS + 1), null);
  });

  test('assinatura adulterada devolve null', () => {
    const s = criarSessao(SEGREDO);
    const valor = s.assinar(DADOS);
    const [payload, assinatura] = valor.split('.');
    const trocada = assinatura[0] === 'A' ? 'B' + assinatura.slice(1) : 'A' + assinatura.slice(1);
    assert.strictEqual(s.verificar(`${payload}.${trocada}`), null);
  });

  test('payload adulterado devolve null', () => {
    const s = criarSessao(SEGREDO);
    const [, assinatura] = s.assinar(DADOS).split('.');
    const outro = Buffer.from(JSON.stringify({ ...DADOS, email: 'x@y.z', exp: Date.now() + 1e9 })).toString('base64url');
    assert.strictEqual(s.verificar(`${outro}.${assinatura}`), null);
  });

  test('segredo diferente devolve null', () => {
    const valor = criarSessao(SEGREDO).assinar(DADOS);
    assert.strictEqual(criarSessao('outro-segredo-igualmente-longo').verificar(valor), null);
  });

  test('lixo devolve null sem lançar', () => {
    const s = criarSessao(SEGREDO);
    for (const lixo of ['', 'sem-ponto', 'a.b', '.', 'YQ==.', undefined, null, 42]) {
      assert.strictEqual(s.verificar(lixo), null, `deveria rejeitar ${JSON.stringify(lixo)}`);
    }
  });

  test('segredo curto é recusado na criação', () => {
    assert.throws(() => criarSessao('curto'), /SESSION_SECRET/);
  });
});

describe('cookie HTTP', () => {
  const s = criarSessao(SEGREDO);

  test('lerCookie acha o nosso cookie no meio de outros', () => {
    const req = { headers: { cookie: `tema=dark; ${NOME_COOKIE}=abc.def; outro=1` } };
    assert.strictEqual(s.lerCookie(req), 'abc.def');
  });

  test('lerCookie devolve null sem header ou sem o cookie', () => {
    assert.strictEqual(s.lerCookie({ headers: {} }), null);
    assert.strictEqual(s.lerCookie({ headers: { cookie: 'tema=dark' } }), null);
  });

  test('gravarCookie manda HttpOnly, SameSite=Lax, Path=/ e Max-Age de 30 dias', () => {
    const headers = [];
    const res = { append: (n, v) => headers.push([n, v]) };
    s.gravarCookie({ secure: false }, res, 'abc.def');
    assert.strictEqual(headers.length, 1);
    const [nome, valor] = headers[0];
    assert.strictEqual(nome, 'Set-Cookie');
    assert.match(valor, new RegExp(`^${NOME_COOKIE}=abc\\.def; `));
    assert.match(valor, /HttpOnly/);
    assert.match(valor, /SameSite=Lax/);
    assert.match(valor, /Path=\//);
    assert.match(valor, /Max-Age=2592000/);
    assert.doesNotMatch(valor, /Secure/);
  });

  test('gravarCookie adiciona Secure quando o pedido é HTTPS', () => {
    const headers = [];
    s.gravarCookie({ secure: true }, { append: (n, v) => headers.push(v) }, 'abc.def');
    assert.match(headers[0], /; Secure$/);
  });

  test('limparCookie zera o valor com Max-Age=0', () => {
    const headers = [];
    s.limparCookie({ secure: false }, { append: (n, v) => headers.push(v) });
    assert.match(headers[0], new RegExp(`^${NOME_COOKIE}=; `));
    assert.match(headers[0], /Max-Age=0/);
  });
});
