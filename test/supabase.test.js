'use strict';

// Adaptador do Supabase Auth com o SDK substituído por um dublê: o que se testa
// é o mapeamento de erros e o cliente descartável por login.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { criarClientes } = require('../auth/supabase');

// Os erros do SDK real são instâncias de Error (AuthApiError) com code e status.
function erroSdk({ code, status, message }) {
  return Object.assign(new Error(message), { code, status });
}

function dublê(resposta) {
  if (resposta.error) resposta = { ...resposta, error: erroSdk(resposta.error) };
  const criados = [];
  const criarCliente = (url, chave, opcoes) => {
    const c = { url, chave, opcoes, auth: { signInWithPassword: async () => resposta } };
    criados.push(c);
    return c;
  };
  return { criarCliente, criados };
}

describe('loginComSenha', () => {
  test('senha errada (invalid_credentials) devolve null', async () => {
    const { criarCliente } = dublê({ data: { user: null }, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } });
    const { loginComSenha } = criarClientes({ url: 'https://x.supabase.co', chaveSecreta: 'sb_secret_x', criarCliente });
    assert.strictEqual(await loginComSenha('a@b.c', 'errada'), null);
  });

  test('chave secreta errada (invalid_api_key, 401) lança, em vez de fingir senha errada', async () => {
    const { criarCliente } = dublê({ data: { user: null }, error: { code: 'invalid_api_key', status: 401, message: 'Invalid API key' } });
    const { loginComSenha } = criarClientes({ url: 'https://x.supabase.co', chaveSecreta: 'sb_secret_x', criarCliente });
    await assert.rejects(() => loginComSenha('a@b.c', 'certa'), /Invalid API key/);
  });

  test('erro 400 de validação sem código de credencial também lança', async () => {
    const { criarCliente } = dublê({ data: { user: null }, error: { code: 'validation_failed', status: 400, message: 'validation' } });
    const { loginComSenha } = criarClientes({ url: 'https://x.supabase.co', chaveSecreta: 'sb_secret_x', criarCliente });
    await assert.rejects(() => loginComSenha('a@b.c', 'certa'), /validation/);
  });

  test('sucesso devolve id e e-mail, com um cliente novo por login e sem sessão persistida', async () => {
    const { criarCliente, criados } = dublê({ data: { user: { id: 'u1', email: 'a@b.c' } }, error: null });
    const { admin, loginComSenha } = criarClientes({ url: 'https://x.supabase.co', chaveSecreta: 'sb_secret_x', criarCliente });
    assert.deepStrictEqual(await loginComSenha('a@b.c', 'certa'), { id: 'u1', email: 'a@b.c' });
    await loginComSenha('a@b.c', 'certa');
    assert.strictEqual(criados.length, 3, 'admin + um cliente por login');
    assert.strictEqual(criados[0], admin);
    for (const c of criados) assert.deepStrictEqual(c.opcoes.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  });
});
