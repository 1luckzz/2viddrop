'use strict';

// Ponto de entrada do módulo de auth. server.js e os testes chamam montarAuth
// e usam as guardas devolvidas nas rotas que precisam.
const { criarSessao }      = require('./sessao');
const { criarMiddlewares } = require('./middleware');
const { criarRotas }       = require('./rotas');

function montarAuth(app, { repositorio, adminEmail, segredoSessao, limiteTentativas }) {
  const sessao = criarSessao(segredoSessao);
  const mw     = criarMiddlewares({ sessao, repositorio, adminEmail });

  app.use(mw.carregarSessao);
  app.use(criarRotas({ sessao, repositorio, mw, limiteTentativas }));

  // express.json() responde JSON malformado com 400 mas sem corpo; padroniza.
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Corpo inválido.' });
    next(err);
  });

  return mw;
}

module.exports = { montarAuth };
