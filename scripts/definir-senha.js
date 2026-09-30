#!/usr/bin/env node
'use strict';

// Define a senha de um usuário pelo e-mail, direto na API admin do Supabase.
// Serve para o dono recuperar o acesso sem depender do e-mail de recuperação
// (o Site URL do projeto compartilhado aponta para outro app).
//
// Uso (precisa do .env preenchido):
//   node --env-file=.env scripts/definir-senha.js email@exemplo.com "senha nova"

const { normalizar } = require('../auth/middleware');

async function definirSenha(admin, email, senha) {
  const alvo = normalizar(email);
  if (!alvo) throw new Error('Informe o e-mail.');
  if (typeof senha !== 'string' || senha.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');

  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const usuario = (data.users || []).find(u => normalizar(u.email) === alvo);
  if (!usuario) throw new Error(`Usuário não encontrado: ${alvo}`);

  const atualizado = await admin.auth.admin.updateUserById(usuario.id, { password: senha });
  if (atualizado.error) throw atualizado.error;
  return { id: usuario.id, email: alvo };
}

async function main() {
  const [email, senha] = process.argv.slice(2);
  if (!email || !senha) {
    console.error('Uso: node --env-file=.env scripts/definir-senha.js <email> <senha>');
    process.exit(2);
  }
  for (const nome of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    if (!process.env[nome]) { console.error(`Falta ${nome} no ambiente (.env).`); process.exit(2); }
  }
  const { criarClientes } = require('../auth/supabase');
  const { admin } = criarClientes({ url: process.env.SUPABASE_URL, chaveSecreta: process.env.SUPABASE_SECRET_KEY });
  const r = await definirSenha(admin, email, senha);
  console.log(`Senha definida para ${r.email}.`);
}

if (require.main === module) {
  main().catch(e => { console.error('Falhou:', e.message || e); process.exit(1); });
}

module.exports = { definirSenha };
