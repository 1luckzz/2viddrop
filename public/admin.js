// Painel /admin: lista os usuários por status e aprova, bloqueia ou devolve a pendente.
// DOM manual, no mesmo estilo de twitter.js.
(function () {
  const $ = id => document.getElementById(id);
  const lista = $('usuarios');
  const erro  = $('erro');
  if (!lista) return;

  const ROTULO = { pending: 'Pendentes', approved: 'Aprovados', blocked: 'Bloqueados' };
  // botões por status atual: [status novo, rótulo]
  const ACOES = {
    pending:  [['approved', 'Aprovar'],  ['blocked', 'Bloquear']],
    approved: [['blocked',  'Bloquear'], ['pending', 'Voltar a pendente']],
    blocked:  [['approved', 'Aprovar'],  ['pending', 'Voltar a pendente']],
  };

  let usuarios = [];
  let aba = 'pending';

  function mostrarErro(msg) { erro.textContent = msg; erro.classList.remove('hidden'); }

  async function carregar() {
    let res;
    try { res = await fetch('/admin/usuarios'); }
    catch { return mostrarErro('Sem conexão com o servidor.'); }
    if (redirecionarSeSemAcesso(res)) return;
    if (!res.ok) return mostrarErro('Não foi possível carregar a lista.');
    usuarios = (await res.json()).usuarios;
    erro.classList.add('hidden');
    desenhar();
  }

  function desenhar() {
    document.querySelectorAll('.aba').forEach(b => {
      const n = usuarios.filter(u => u.status === b.dataset.status).length;
      b.textContent = `${ROTULO[b.dataset.status]} (${n})`;
      b.classList.toggle('is-active', b.dataset.status === aba);
      b.setAttribute('aria-selected', String(b.dataset.status === aba));
    });

    lista.innerHTML = '';
    const visiveis = usuarios.filter(u => u.status === aba);
    if (!visiveis.length) {
      const p = document.createElement('p');
      p.className = 'usuarios-vazio';
      p.textContent = 'Ninguém aqui.';
      lista.appendChild(p);
      return;
    }
    visiveis.forEach(u => lista.appendChild(linha(u)));
  }

  function linha(u) {
    const row = document.createElement('div');
    row.className = 'usuario';

    const email = document.createElement('span');
    email.className = 'usuario-email';
    email.textContent = u.email;
    email.title = u.email;

    const data = document.createElement('span');
    data.className = 'usuario-data';
    data.textContent = new Date(u.created_at).toLocaleDateString('pt-BR');

    row.append(email, data);

    if (u.admin) {
      const tag = document.createElement('span');
      tag.className = 'usuario-admin';
      tag.textContent = 'admin';
      row.appendChild(tag);
      return row;
    }

    const acoes = document.createElement('div');
    acoes.className = 'usuario-acoes';
    for (const [status, rotulo] of ACOES[u.status]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = rotulo;
      b.addEventListener('click', () => mudar(u, status, b));
      acoes.appendChild(b);
    }
    row.appendChild(acoes);
    return row;
  }

  async function mudar(u, status, botao) {
    botao.disabled = true;
    let res;
    try {
      res = await fetch(`/admin/usuarios/${encodeURIComponent(u.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      botao.disabled = false;
      return mostrarErro('Sem conexão com o servidor.');
    }
    if (redirecionarSeSemAcesso(res)) return;
    if (!res.ok) {
      botao.disabled = false;
      let d = {};
      try { d = await res.json(); } catch {}
      return mostrarErro(d.error || 'Não foi possível mudar o status.');
    }
    await carregar();
  }

  document.querySelectorAll('.aba').forEach(b => b.addEventListener('click', () => {
    aba = b.dataset.status;
    desenhar();
  }));

  carregar();
})();
