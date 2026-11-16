// Thème clair ou sombre : celui de l'appareil au chargement, puis celui choisi avec le bouton du bandeau.
// Script classique chargé dans <head>, avant le premier affichage : pas d'éclair blanc en mode sombre.
// La carte écoute l'évènement « themechange » pour changer de fond.
(() => {
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let chosen = false; // une fois le bouton utilisé, on ne suit plus l'appareil

  function apply(theme) {
    root.dataset.theme = theme;
    const btn = document.getElementById('themeBtn');
    if (btn) {
      const label = theme === 'dark' ? 'Passer en mode clair' : 'Passer en mode sombre';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  apply(system.matches ? 'dark' : 'light');
  system.addEventListener('change', (e) => {
    if (!chosen) apply(e.matches ? 'dark' : 'light');
  });

  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme); // met à jour le libellé du bouton, qui n'existait pas encore
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      chosen = true;
      apply(root.dataset.theme === 'dark' ? 'light' : 'dark');
    });
  });
})();
