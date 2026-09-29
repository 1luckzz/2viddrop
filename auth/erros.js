'use strict';

// Erros que o repositório lança e as rotas traduzem em status HTTP.
// Qualquer outro erro vindo do Supabase vira ErroIndisponivel (503).

class ErroEmailExistente extends Error {
  constructor() {
    super('E-mail já cadastrado.');
    this.codigo = 'email_existente';
  }
}

class ErroIndisponivel extends Error {
  constructor(causa) {
    super('Serviço de login indisponível. Tente de novo.');
    this.codigo = 'indisponivel';
    this.causa = causa;
  }
}

module.exports = { ErroEmailExistente, ErroIndisponivel };
