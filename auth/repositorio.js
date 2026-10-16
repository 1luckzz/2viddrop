'use strict';

// Implementação Supabase da interface do repositório (ver test/apoio/repositorio-memoria.js
// para a versão em memória com a mesma interface).
const { ErroEmailExistente, ErroIndisponivel } = require('./erros');

const TABELA  = 'viddrop_profiles';
const ACESSOS = 'viddrop_acessos';
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

    async registrarAcesso({ tipo, userId, email, ip, userAgent, caminho, localizacao }) {
      const { error } = await admin.from(ACESSOS)
        .insert({ tipo, user_id: userId || null, email: email || null, ip, user_agent: userAgent, caminho: caminho || null, localizacao: localizacao || null });
      if (error) throw falha(error);
    },

    async listarAcessos(limite, tipo) {
      let consulta = admin.from(ACESSOS)
        .select('id, tipo, user_id, email, ip, localizacao, user_agent, caminho, created_at')
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(limite);
      if (tipo) consulta = consulta.eq('tipo', tipo);
      const { data, error } = await consulta;
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
