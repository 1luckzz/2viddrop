'use strict';

// Repositório em memória com a mesma interface de auth/repositorio.js.
// `fora = true` simula o Supabase indisponível: toda operação lança ErroIndisponivel.
const crypto = require('crypto');
const { ErroEmailExistente, ErroIndisponivel } = require('../../auth/erros');

function criarRepositorioMemoria() {
  const contas  = new Map();   // email -> { id, senha }
  const perfis  = new Map();   // id -> perfil
  let relogio = 0;             // created_at crescente e determinístico

  const repo = {
    fora: false,

    async criarUsuario(email, senha) {
      checar();
      if (contas.has(email)) throw new ErroEmailExistente();
      const id = crypto.randomUUID();
      contas.set(email, { id, senha });
      return repo.garantirPerfil(id, email);
    },

    async loginComSenha(email, senha) {
      checar();
      const conta = contas.get(email);
      return conta && conta.senha === senha ? { id: conta.id, email } : null;
    },

    async buscarPerfil(id) {
      checar();
      return perfis.get(id) || null;
    },

    async garantirPerfil(id, email) {
      checar();
      if (!perfis.has(id)) {
        perfis.set(id, {
          id, email, status: 'pending',
          created_at: new Date(1_700_000_000_000 + (relogio++) * 1000).toISOString(),
          reviewed_at: null,
        });
      }
      return perfis.get(id);
    },

    async listarPerfis() {
      checar();
      return [...perfis.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },

    async mudarStatus(id, status) {
      checar();
      const perfil = perfis.get(id);
      if (!perfil) return null;
      perfil.status = status;
      perfil.reviewed_at = new Date().toISOString();
      return perfil;
    },

    // só para os testes: simula usuário apagado no Supabase
    apagar(id) {
      perfis.delete(id);
      for (const [email, conta] of contas) if (conta.id === id) contas.delete(email);
    },

    // só para os testes: conta existe no Auth mas sem linha de perfil
    apagarSoPerfil(id) { perfis.delete(id); },
  };

  function checar() { if (repo.fora) throw new ErroIndisponivel(new Error('simulado')); }

  return repo;
}

module.exports = { criarRepositorioMemoria };
