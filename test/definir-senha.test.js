'use strict';

// Script de manutenção: definir a senha de um usuário pelo e-mail, via API admin.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { definirSenha } = require('../scripts/definir-senha');

function dublê(usuarios) {
  const chamadas = [];
  const admin = {
    auth: { admin: {
      listUsers: async () => ({ data: { users: usuarios }, error: null }),
      updateUserById: async (id, attrs) => { chamadas.push({ id, attrs }); return { data: { user: { id } }, error: null }; },
    } },
  };
  return { admin, chamadas };
}

describe('definirSenha', () => {
  test('acha o usuário pelo e-mail (sem diferenciar caixa) e troca a senha', async () => {
    const { admin, chamadas } = dublê([{ id: 'u1', email: 'dono@meekz.com' }, { id: 'u2', email: 'outra@x.com' }]);
    const r = await definirSenha(admin, '  Dono@Meekz.com ', 'nova-senha-123');
    assert.deepStrictEqual(r, { id: 'u1', email: 'dono@meekz.com' });
    assert.deepStrictEqual(chamadas, [{ id: 'u1', attrs: { password: 'nova-senha-123' } }]);
  });

  test('e-mail inexistente lança sem chamar a atualização', async () => {
    const { admin, chamadas } = dublê([{ id: 'u1', email: 'dono@meekz.com' }]);
    await assert.rejects(() => definirSenha(admin, 'ninguem@x.com', 'nova-senha-123'), /não encontrado/);
    assert.strictEqual(chamadas.length, 0);
  });

  test('senha curta é recusada antes de tocar no Supabase', async () => {
    const { admin, chamadas } = dublê([{ id: 'u1', email: 'dono@meekz.com' }]);
    await assert.rejects(() => definirSenha(admin, 'dono@meekz.com', '1234567'), /8 caracteres/);
    assert.strictEqual(chamadas.length, 0);
  });
});
