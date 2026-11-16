/**
 * Règles d'affichage d'une station : puissance, disponibilité, filtres et tris.
 * Que des fonctions pures, testées sous Node. Les stations ont la forme renvoyée par /api/stations.
 */

/** Puissance max parmi les prises choisies : { kw, estimated }, ou null. */
export function powerOf(station, types) {
  let best = null;
  for (const t of types) {
    const c = station.connectors[t];
    if (c?.maxKw && (!best || c.maxKw > best.kw)) best = { kw: c.maxKw, estimated: c.estimated };
  }
  return best;
}

/** État affiché. cls vaut 'ok', 'busy', 'down', ou '' quand on ne sait pas. */
export function statusOf(station) {
  if (station.operational === false) return { cls: 'down', label: 'Hors service (signalé)' };
  const st = station.status;
  if (!st) return { cls: '', label: null };
  if (st.available > 0) return { cls: 'ok', label: `${st.available} libre${st.available > 1 ? 's' : ''} / ${st.known}` };
  if (st.outOfService === st.known) return { cls: 'down', label: 'Hors service' };
  return { cls: 'busy', label: 'Occupé' };
}

/** Filtres proposés. Une entrée de plus ici, et le bouton apparaît tout seul. */
export const FILTERS = {
  fast: { label: '≥ 50 kW', test: (s, types) => powerOf(s, types)?.kw >= 50 },
  available: { label: 'Disponible', test: (s) => s.status?.available > 0 },
  free: { label: 'Gratuit', test: (s) => s.free === true },
  priced: { label: 'Tarif connu', test: (s) => s.tariffs.some((t) => t.text) },
};

/** La station passe-t-elle tous les filtres actifs ? */
export function passFilters(station, active, types) {
  for (const key of active) if (!FILTERS[key]?.test(station, types)) return false;
  return true;
}

/** Prix pour comparer les stations, en €/kWh : 0 si gratuit, sinon le plus bas connu, ou null. */
export function comparablePrice(station) {
  if (station.free === true) return 0;
  return station.price?.min ?? null;
}

/**
 * Tris proposés, sur le même principe que les filtres. compare(a, b, distance) reçoit de quoi
 * calculer la distance d'une station au point de référence.
 */
export const SORTS = {
  distance: { label: 'Distance', compare: (a, b, distance) => distance(a) - distance(b) },
  price: {
    label: 'Prix au kWh',
    // prix connus d'abord, du moins cher au plus cher ; à égalité, le plus proche
    compare: (a, b, distance) => {
      const pa = comparablePrice(a);
      const pb = comparablePrice(b);
      if (pa !== pb) return pa === null ? 1 : pb === null ? -1 : pa - pb;
      return distance(a) - distance(b);
    },
  },
  power: { label: 'Puissance', compare: (a, b, distance, types) => (powerOf(b, types)?.kw ?? 0) - (powerOf(a, types)?.kw ?? 0) || distance(a) - distance(b) },
};
