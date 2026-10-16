// Painel /admin: lista os usuários por status e aprova, bloqueia ou devolve a pendente.
// A aba Acessos mostra quem abriu o site (visitas, logado ou não) e os logins.
// DOM manual, no mesmo estilo de twitter.js.
(function () {
  const $ = id => document.getElementById(id);
  const lista = $('usuarios');
  const erro  = $('erro');
  if (!lista) return;

  const ROTULO = { pending: 'Pendentes', approved: 'Aprovados', blocked: 'Bloqueados', acessos: 'Acessos' };
  const filtro = $('filtroAcessos');
  // botões por status atual: [status novo, rótulo]
  const ACOES = {
    pending:  [['approved', 'Aprovar'],  ['blocked', 'Bloquear']],
    approved: [['blocked',  'Bloquear'], ['pending', 'Voltar a pendente']],
    blocked:  [['approved', 'Aprovar'],  ['pending', 'Voltar a pendente']],
  };

  let usuarios = [];
  let acessos = null;     // carregado só quando a aba Acessos abre
  let tipoFiltro = '';    // '', 'visita' ou 'login'
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

  async function carregarAcessos() {
    let res;
    try { res = await fetch('/admin/acessos' + (tipoFiltro ? '?tipo=' + tipoFiltro : '')); }
    catch { return mostrarErro('Sem conexão com o servidor.'); }
    if (redirecionarSeSemAcesso(res)) return;
    if (!res.ok) return mostrarErro('Não foi possível carregar os acessos.');
    acessos = (await res.json()).acessos;
    erro.classList.add('hidden');
    desenhar();
  }

  // "Chrome · Windows" a partir do User-Agent; sem exagero de precisão.
  function resumirNavegador(ua) {
    if (!ua) return '—';
    const tem = marca => ua.includes(marca + '/');
    const nav = tem('Edg') ? 'Edge' : tem('OPR') ? 'Opera' : tem('Firefox') ? 'Firefox'
      : tem('Chrome') ? 'Chrome' : tem('Safari') ? 'Safari' : ua.split(' ')[0];
    const so = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
      : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return so ? `${nav} · ${so}` : nav;
  }

  function linhaAcesso(a) {
    const row = document.createElement('div');
    row.className = 'usuario';
    const tipo = document.createElement('span');
    tipo.className = 'acesso-tipo' + (a.tipo === 'login' ? ' is-login' : '');
    tipo.textContent = a.tipo === 'login' ? 'login' : 'visita';
    const ip = document.createElement('span');
    ip.className = 'login-ip';
    ip.textContent = a.ip || '—';
    const quem = document.createElement('span');
    quem.className = 'usuario-email';
    // visita anônima mostra a página aberta; logado mostra a conta
    quem.textContent = a.email ? a.email + (a.tipo === 'visita' && a.caminho ? ' · ' + a.caminho : '') : (a.caminho || '—');
    quem.title = [a.email, a.caminho].filter(Boolean).join(' · ');
    const nav = document.createElement('span');
    nav.className = 'usuario-data';
    nav.textContent = resumirNavegador(a.user_agent);
    nav.title = a.user_agent || '';
    const quando = document.createElement('span');
    quando.className = 'usuario-data';
    quando.textContent = new Date(a.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    row.append(tipo, ip, quem, nav, quando);
    return row;
  }

  function desenhar() {
    document.querySelectorAll('.aba').forEach(b => {
      const s = b.dataset.status;
      const n = s === 'acessos' ? (acessos ? acessos.length : null) : usuarios.filter(u => u.status === s).length;
      b.textContent = n === null ? ROTULO[s] : `${ROTULO[s]} (${n})`;
      b.classList.toggle('is-active', s === aba);
      b.setAttribute('aria-selected', String(s === aba));
    });

    lista.innerHTML = '';
    filtro.classList.toggle('hidden', aba !== 'acessos');
    if (aba === 'acessos') {
      if (!acessos) return;
      if (!acessos.length) {
        const p = document.createElement('p');
        p.className = 'usuarios-vazio';
        p.textContent = 'Nenhum acesso registrado ainda.';
        lista.appendChild(p);
        return;
      }
      acessos.forEach(a => lista.appendChild(linhaAcesso(a)));
      return;
    }
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
    if (aba === 'acessos') carregarAcessos();
  }));

  filtro.querySelectorAll('.filtro-btn').forEach(b => b.addEventListener('click', () => {
    tipoFiltro = b.dataset.tipo;
    filtro.querySelectorAll('.filtro-btn').forEach(x => x.classList.toggle('is-active', x === b));
    carregarAcessos();
  }));

  carregar();
})();
