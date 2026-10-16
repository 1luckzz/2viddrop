'use strict';

// Implementação Supabase da interface do repositório (ver test/apoio/repositorio-memoria.js
// para a versão em memória com a mesma interface).
const { ErroEmailExistente, ErroIndisponivel } = require('./erros');

const TABELA  = 'viddrop_profiles';
const LOGINS  = 'viddrop_logins';
const COLUNAS = 'id, email, status, created_at, reviewed_at';

function criarRepositorioSupabase({ admin, loginComSenha }) {
  const falha = e => new ErroIndisponivel(e);

  const repo = {
    async criarUsuario(email, senha) {
      const { data, error } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
      if (error) {
        if (error.code === 'email_exists' || /already/i.test(error.message || '')) throw new ErroEmailExistente();
        throw falha(error);
      }
      return repo.garantirPerfil(data.user.id, email);
    },

    async loginComSenha(email, senha) {
      try { return await loginComSenha(email, senha); }
      catch (e) { throw falha(e); }
    },

    async buscarPerfil(id) {
      const { data, error } = await admin.from(TABELA).select(COLUNAS).eq('id', id).maybeSingle();
      if (error) throw falha(error);
      return data;
    },

    async garantirPerfil(id, email) {
      const { data, error } = await admin.from(TABELA)
        .upsert({ id, email }, { onConflict: 'id', ignoreDuplicates: true })
        .select(COLUNAS).maybeSingle();
      if (error) throw falha(error);
      return data || repo.buscarPerfil(id);   // já existia: o upsert não devolve linha
    },

    async listarPerfis() {
      const { data, error } = await admin.from(TABELA).select(COLUNAS).order('created_at', { ascending: false });
      if (error) throw falha(error);
      return data;
    },

    async registrarLogin({ userId, email, ip, userAgent }) {
      const { error } = await admin.from(LOGINS).insert({ user_id: userId, email, ip, user_agent: userAgent });
      if (error) throw falha(error);
    },

    async listarLogins(limite) {
      const { data, error } = await admin.from(LOGINS)
        .select('id, user_id, email, ip, user_agent, created_at')
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(limite);
      if (error) throw falha(error);
      return data;
    },

    async mudarStatus(id, status) {
      const { data, error } = await admin.from(TABELA)
        .update({ status, reviewed_at: new Date().toISOString() })
        .eq('id', id).select(COLUNAS).maybeSingle();
      if (error) throw falha(error);
      return data;
    },
  };

  return repo;
}

module.exports = { criarRepositorioSupabase, TABELA };
