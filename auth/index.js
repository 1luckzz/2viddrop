'use strict';

// Ponto de entrada do módulo de auth. server.js e os testes chamam montarAuth
// e usam as guardas devolvidas nas rotas que precisam.
const { criarSessao }      = require('./sessao');
const { criarMiddlewares } = require('./middleware');

function montarAuth(app, { repositorio, adminEmail, segredoSessao }) {
  const sessao = criarSessao(segredoSessao);
  const mw     = criarMiddlewares({ sessao, repositorio, adminEmail });
  app.use(mw.carregarSessao);
  return mw;
}

module.exports = { montarAuth };
