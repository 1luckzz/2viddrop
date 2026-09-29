'use strict';

// Clientes do Supabase para o servidor. Só a chave secreta existe aqui; ela
// nunca vai pro frontend.
const { createClient } = require('@supabase/supabase-js');

// Servidor não guarda sessão do SDK: a sessão é o nosso cookie.
const OPCOES = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

function criarClientes({ url, chaveSecreta }) {
  const admin = createClient(url, chaveSecreta, OPCOES);

  // Um cliente por login. Depois de signInWithPassword o SDK passa a mandar o
  // token do usuário em vez da chave secreta; isso não pode vazar pro `admin`.
  async function loginComSenha(email, senha) {
    const temporario = createClient(url, chaveSecreta, OPCOES);
    const { data, error } = await temporario.auth.signInWithPassword({ email, password: senha });
    if (error) {
      const credenciais = error.code === 'invalid_credentials' || error.status === 400 || error.status === 401;
      if (credenciais) return null;
      throw error;
    }
    return { id: data.user.id, email: data.user.email };
  }

  return { admin, loginComSenha };
}

module.exports = { criarClientes };
