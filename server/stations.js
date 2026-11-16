/**
 * Rassemble les bornes d'une zone : IRVE depuis la mémoire, Open Charge Map et Overpass en direct.
 * Pour ajouter une source : un module dans sources/ qui rend le format commun, et une ligne dans LIVE_SOURCES.
 */
import { config } from './config.js';
import { mergeStations } from './merge.js';
import { irveStatus, queryIrve } from './sources/irve.js';
import { queryOcm } from './sources/ocm.js';
import { queryOsm } from './sources/osm.js';
import { RateLimiter } from './http.js';
import { inBbox, snapBbox, TtlCache } from './util.js';

const LIVE_SOURCES = [
  { name: 'OCM', label: 'Open Charge Map' },
  { name: 'OSM', label: "Overpass (bornes issues d'OpenStreetMap)" },
];

const QUERIES = { OCM: queryOcm, OSM: queryOsm };

const liveCache = new TtlCache(config.liveCacheMinutes * 60 * 1000);
const lastErrors = Object.fromEntries(LIVE_SOURCES.map((s) => [s.name, null]));
// Une source lente ou en erreur n'est presque plus attendue, jusqu'à ce qu'elle réponde de nouveau.
const degraded = new Set();
const DEGRADED_WAIT_MS = 200;
// Plafond d'appels sortants par source (voir LIVE_MAX_PER_MIN)
const budget = new RateLimiter(config.liveMaxPerMinute);

/** Dernière erreur de chaque source live, pour /api/status. */
export const liveErrors = () => ({ ...lastErrors });

/** Interroge une source live. La zone est arrondie pour que des vues voisines partagent le cache. */
async function cachedLive({ name }, bbox, types) {
  const query = QUERIES[name];
  const snapped = snapBbox(bbox);
  const key = `${name}:${types.join('+')}:${snapped.south},${snapped.west},${snapped.north},${snapped.east}`;
  let pending = liveCache.get(key);
  if (!pending) {
    const wait = budget.check(name);
    if (wait) throw new Error(`trop de demandes en ce moment, nouvel essai dans ${wait} s`);
    pending = query(snapped, types).then(
      (r) => {
        lastErrors[name] = null;
        degraded.delete(name);
        return r;
      },
      (e) => {
        lastErrors[name] = `${e.message} (${new Date().toISOString()})`;
        degraded.add(name);
        liveCache.delete(key); // un échec ne doit pas rester en cache
        throw e;
      },
    );
    liveCache.set(key, pending);
  }
  return (await pending).filter((s) => inBbox(s.lat, s.lon, bbox));
}

class SlowSourceError extends Error {}

/**
 * N'attend une source que ms millisecondes. Si elle tarde, on répond sans elle ; sa requête continue
 * quand même et remplira le cache pour le prochain chargement.
 */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SlowSourceError('réponse lente, bornes ajoutées dès leur arrivée')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export async function getStations(bbox, types) {
  const live = await Promise.allSettled(
    LIVE_SOURCES.map((src) =>
      withDeadline(cachedLive(src, bbox, types), degraded.has(src.name) ? DEGRADED_WAIT_MS : config.liveWaitMs).catch((e) => {
        if (e instanceof SlowSourceError) degraded.add(src.name);
        throw e;
      }),
    ),
  );
  const lists = { IRVE: queryIrve(bbox, types) };
  const warnings = [];
  const pending = []; // sources en retard, que le front redemandera dans quelques secondes
  live.forEach((r, i) => {
    const src = LIVE_SOURCES[i];
    lists[src.name] = r.status === 'fulfilled' ? r.value : [];
    if (r.status === 'rejected' && r.reason instanceof SlowSourceError) pending.push(src.name);
    if (r.status === 'rejected') warnings.push(`${src.label} ${r.reason instanceof SlowSourceError ? ':' : 'indisponible :'} ${r.reason.message}`);
  });
  const st = irveStatus();
  if (st.enabled && !st.stations) warnings.push(st.loading ? 'Base IRVE en cours de chargement (premier démarrage, ~1 min)' : `Base IRVE indisponible${st.error ? ` : ${st.error}` : ''}`);
  return {
    types,
    stations: mergeStations(Object.values(lists), config.mergeDistanceMeters),
    counts: Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, list.length])),
    warnings,
    pending,
  };
}
