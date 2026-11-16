/**
 * Fichier tarifs du schéma IRVE v3 (https://github.com/etalab/schema-irve, encore en alpha).
 * Une ligne par élément de tarif, sur le modèle OCPI : prix TTC en euros, sans abonnement.
 * Quatre types de prix : ENERGY au kWh, TIME par heure de charge, PARKING_TIME par heure branché
 * sans charger, FLAT au forfait. Chaque élément peut être limité à des horaires, des jours, une durée…
 * On en tire de quoi remplir la fiche : prix au kWh mini et maxi, autres frais, texte lisible.
 */
import { clean, parseNumber } from './util.js';

const DAYS = { MONDAY: 'lun', TUESDAY: 'mar', WEDNESDAY: 'mer', THURSDAY: 'jeu', FRIDAY: 'ven', SATURDAY: 'sam', SUNDAY: 'dim' };
const UNITS = { ENERGY: '€/kWh', TIME: '€/h de charge', PARKING_TIME: '€/h branché sans charger', FLAT: '€ par session' };
// dans l'ordre où on les affiche
const COMPONENT_TYPES = ['ENERGY', 'FLAT', 'TIME', 'PARKING_TIME'];

function parseJson(text, fallback) {
  const t = clean(text);
  if (!t) return fallback;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Lit la colonne tarif_ids d'un point de charge (une liste JSON). */
export function parseTariffIds(text) {
  const ids = parseJson(text, []);
  return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
}

/**
 * Regroupe les lignes du fichier par tarif, éléments triés. keep limite aux tarifs utilisés ;
 * une ligne illisible est simplement ignorée.
 */
export function buildTariffs(rows, keep = null) {
  const map = new Map();
  for (const r of rows) {
    const id = clean(r.tarif_id);
    if (!id || (keep && !keep.has(id))) continue;
    if (r.devise && r.devise !== 'EUR') continue;
    const restrictions = parseJson(r.restrictions, {});
    const components = parseJson(r.price_components, []);
    if (!restrictions || typeof restrictions !== 'object' || !Array.isArray(components)) continue;
    let t = map.get(id);
    if (!t) {
      t = {
        start: clean(r.start_date_time),
        end: clean(r.end_date_time),
        minPrice: parseNumber(r.min_price),
        maxPrice: parseNumber(r.max_price),
        elements: [],
      };
      map.set(id, t);
    }
    t.elements.push({ index: parseNumber(r.element_index) ?? t.elements.length, restrictions, components });
  }
  for (const t of map.values()) t.elements.sort((a, b) => a.index - b.index);
  return map;
}

/** Parmi les tarifs d'une station, celui qui s'applique à la date donnée, ou null. */
export function currentTariff(ids, tariffs, now = new Date().toISOString()) {
  for (const id of ids) {
    const t = tariffs.get(id);
    if (t && (!t.start || t.start <= now) && (!t.end || now < t.end)) return t;
  }
  return null;
}

// 0,33 / 0,50 / 4 : au centime, sans décimales quand elles ne servent à rien
const euros = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));
const hour = (hhmm) => `${Number(hhmm.slice(0, 2))} h${hhmm.slice(3) === '00' ? '' : hhmm.slice(3)}`;
const duration = (s) => (s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);

/** Conditions d'un élément, en clair. La durée de session n'a pas de sens pour le prix au kWh. */
function conditions(r, withDuration) {
  const parts = [];
  if (r.start_time && r.end_time) parts.push(`${hour(r.start_time)}–${hour(r.end_time)}`);
  else if (r.start_time) parts.push(`dès ${hour(r.start_time)}`);
  else if (r.end_time) parts.push(`avant ${hour(r.end_time)}`);
  if (Array.isArray(r.day_of_week) && r.day_of_week.length && r.day_of_week.length < 7) {
    parts.push(r.day_of_week.map((d) => DAYS[d] || d).join(', '));
  }
  if (typeof r.min_power === 'number') parts.push(`≥ ${r.min_power} kW`);
  if (typeof r.max_power === 'number') parts.push(`< ${r.max_power} kW`);
  if (typeof r.min_kwh === 'number') parts.push(`au-delà de ${r.min_kwh} kWh`);
  if (typeof r.max_kwh === 'number') parts.push(`jusqu'à ${r.max_kwh} kWh`);
  if (withDuration) {
    if (r.min_duration && r.max_duration) parts.push(`entre ${duration(r.min_duration)} et ${duration(r.max_duration)}`);
    else if (r.min_duration) parts.push(`après ${duration(r.min_duration)}`);
    else if (r.max_duration) parts.push(`pendant ${duration(r.max_duration)}`);
  }
  return parts.join(', ');
}

/**
 * Résumé d'un tarif : prix au kWh mini et maxi (pour le tri et l'étiquette), autres frais éventuels,
 * et le texte de la fiche, par exemple « 0,33 €/kWh (6 h–0 h) · 4 €/h de charge (après 2 h) ».
 */
export function summarizeTariff(t) {
  const lines = new Map(COMPONENT_TYPES.map((type) => [type, []]));
  for (const { restrictions, components } of t.elements) {
    for (const c of components) {
      const price = Number(c?.price);
      const list = lines.get(c?.type);
      if (!list || !Number.isFinite(price) || price < 0) continue;
      if (c.type !== 'ENERGY' && price === 0) continue;
      const cond = conditions(restrictions, c.type !== 'ENERGY');
      // prix déjà annoncé (élément par défaut, palier de durée…) : inutile de le répéter
      if (list.some((l) => l.price === price && (l.cond === cond || !cond))) continue;
      list.push({ price, cond });
    }
  }
  const energy = lines.get('ENERGY').map((l) => l.price);
  const extras = ['FLAT', 'TIME', 'PARKING_TIME'].some((type) => lines.get(type).length) || t.minPrice > 0;
  const text = [...lines]
    .flatMap(([type, list]) => list.map((l) => `${euros(l.price)} ${UNITS[type]}${l.cond ? ` (${l.cond})` : ''}`))
    .concat(t.minPrice > 0 ? [`minimum ${euros(t.minPrice)} €`] : [], t.maxPrice > 0 ? [`maximum ${euros(t.maxPrice)} €`] : [])
    .join(' · ');
  return {
    min: energy.length ? Math.min(...energy) : null,
    max: energy.length ? Math.max(...energy) : null,
    extras,
    text: text || null,
  };
}
