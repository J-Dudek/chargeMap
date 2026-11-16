/**
 * Bornes issues d'OpenStreetMap, interrogées en direct via l'API Overpass. C'est un service à part,
 * sans lien avec les tuiles ni avec le site openstreetmap.org.
 * Tags lus : socket:<type>, socket:<type>:output, charge, fee, operator, network…
 */
import { config } from '../config.js';
import { CONNECTORS, CONNECTOR_TYPES, addConnector, hasAnyType } from '../connectors.js';
import { clean, httpFetch, normalizeKw, parseBool } from '../util.js';

export function buildOverpassQuery(b, types) {
  const bbox = `(${b.south},${b.west},${b.north},${b.east})`;
  const tags = [...new Set(types.flatMap((t) => CONNECTORS[t].osm))];
  return `[out:json][timeout:25];
(
${tags.map((tag) => `  nwr["amenity"="charging_station"]["socket:${tag}"]${bbox};`).join('\n')}
);
out center tags;`;
}

export function normalizeOsm(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const connectors = {};
  for (const type of CONNECTOR_TYPES) {
    for (const tag of CONNECTORS[type].osm) {
      const v = t[`socket:${tag}`];
      if (!v || ['no', '0'].includes(String(v).toLowerCase())) continue;
      const n = Number.parseInt(v, 10);
      addConnector(connectors, type, Number.isFinite(n) && n > 0 ? n : 1, normalizeKw(t[`socket:${tag}:output`]));
    }
  }
  if (!Object.keys(connectors).length) return null;
  const fee = parseBool(t.fee);
  const addr = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:postcode'], t['addr:city']].filter(Boolean);
  return {
    id: `osm:${el.type}/${el.id}`,
    source: 'OSM',
    name: clean(t.name) || clean(t.brand) || clean(t.operator) || 'Station de recharge',
    lat,
    lon,
    address: addr.length ? addr.join(', ') : null,
    country: clean(t['addr:country']),
    operator: clean(t.operator),
    network: clean(t.network) || clean(t.brand),
    connectors,
    tariff: {
      free: fee === null ? null : !fee,
      text: clean(t.charge),
      payCard: t['payment:credit_cards'] ? parseBool(t['payment:credit_cards']) : null,
      payAdHoc: null,
    },
    access: clean(t.access),
    hours: clean(t.opening_hours),
    updatedAt: null,
    url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

// On recommence par le dernier serveur qui a répondu.
let preferred = 0;
// Après un échec général, on attend avant de réessayer, plutôt que de subir tous les délais à chaque requête.
let pausedUntil = 0;
let lastFailure = null;

/** Envoie la requête aux serveurs Overpass l'un après l'autre, jusqu'à ce que l'un réponde. */
export async function fetchOverpass(query) {
  if (Date.now() < pausedUntil) throw new Error(`${lastFailure} (nouvel essai dans ${Math.ceil((pausedUntil - Date.now()) / 1000)} s)`);
  const urls = config.osm.overpassUrls;
  const errors = [];
  for (let i = 0; i < urls.length; i++) {
    const idx = (preferred + i) % urls.length;
    try {
      const res = await httpFetch(urls[idx], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query }),
        timeoutMs: config.osm.timeoutMs,
      });
      const data = await res.json();
      preferred = idx;
      return data;
    } catch (e) {
      const host = (() => { try { return new URL(urls[idx]).host; } catch { return urls[idx]; } })();
      errors.push(e.name === 'AbortError' ? `délai dépassé sur ${host}` : e.message);
    }
  }
  lastFailure = errors.join(' ; ') || 'aucun serveur Overpass configuré';
  pausedUntil = Date.now() + config.osm.retryPauseMs;
  throw new Error(lastFailure);
}

export async function queryOsm(bbox, types) {
  if (!config.osm.enabled) return [];
  const data = await fetchOverpass(buildOverpassQuery(bbox, types));
  return (data.elements || []).map(normalizeOsm).filter((s) => s && hasAnyType(s, types));
}
