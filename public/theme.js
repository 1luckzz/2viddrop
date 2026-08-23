// Alterna o acabamento do aparelho (alumínio / grafite) e lembra a escolha.
// O <head> já carimba data-theme antes da primeira pintura; aqui só tratamos o clique.
(function () {
  const KEY  = 'meekz-theme';
  const root = document.documentElement;
  const btn  = document.getElementById('themeToggle');
  if (!btn) return;

  function setLabel(theme) {
    btn.setAttribute('aria-label',
      theme === 'dark' ? 'Mudar para acabamento claro' : 'Mudar para acabamento escuro');
  }

  setLabel(root.getAttribute('data-theme'));

  btn.addEventListener('click', function () {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    setLabel(next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
  });
})();
