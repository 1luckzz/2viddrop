'use strict';

// Clientes do Supabase para o servidor. Só a chave secreta existe aqui; ela
// nunca vai pro frontend.
const { createClient } = require('@supabase/supabase-js');

// Servidor não guarda sessão do SDK: a sessão é o nosso cookie.
const OPCOES = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// `criarCliente` é injetável só para os testes trocarem o SDK por um dublê.
function criarClientes({ url, chaveSecreta, criarCliente = createClient }) {
  const admin = criarCliente(url, chaveSecreta, OPCOES);

  // Um cliente por login. Depois de signInWithPassword o SDK passa a mandar o
  // token do usuário em vez da chave secreta; isso não pode vazar pro `admin`.
  async function loginComSenha(email, senha) {
    const temporario = criarCliente(url, chaveSecreta, OPCOES);
    const { data, error } = await temporario.auth.signInWithPassword({ email, password: senha });
    if (error) {
      // Só senha/e-mail errados viram "credenciais inválidas". Chave secreta
      // errada, provedor desligado etc. sobem como indisponível, com log.
      if (error.code === 'invalid_credentials') return null;
      throw error;
    }
    return { id: data.user.id, email: data.user.email };
  }

  return { admin, loginComSenha };
}

module.exports = { criarClientes };
