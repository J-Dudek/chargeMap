/** Petits outils côté navigateur : sélection, stockage local, messages, appels à l'API. */

export const $ = (selector) => document.querySelector(selector);

/** localStorage qui ne plante pas (navigation privée, stockage plein, JSON abîmé). */
export const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible */
    }
  },
};

/** Charge un script du site ; la promesse échoue s'il n'arrive pas. */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Script non chargé : ${src}`));
    document.head.appendChild(el);
  });
}

export function loadStylesheet(href) {
  const el = document.createElement('link');
  el.rel = 'stylesheet';
  el.href = href;
  document.head.appendChild(el);
}

/** 'ios', 'android' ou 'other', pour proposer les bonnes applis de navigation. */
export function detectPlatform(nav = navigator) {
  if (/iPad|iPhone|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1)) return 'ios';
  return /Android/.test(nav.userAgent) ? 'android' : 'other';
}

let toastTimer;
export function toast(message, ms = 3500) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/** GET qui renvoie le JSON, ou lève une erreur avec le message du serveur. */
export async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
