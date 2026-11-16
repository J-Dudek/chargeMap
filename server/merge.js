/**
 * Fusion des sources : deux stations à moins de N mètres sont la même.
 * Pour les champs descriptifs, IRVE l'emporte sur OCM, puis sur Overpass. Les tarifs, eux, sont
 * tous gardés : chaque source en connaît souvent une partie.
 */
import { parseKwhPrice } from './price.js';
import { distanceMeters } from './util.js';

const PRIORITY = { IRVE: 0, OCM: 1, OSM: 2 };
const FILL_FIELDS = ['name', 'address', 'country', 'operator', 'network', 'access', 'hours', 'updatedAt'];

function toMerged(s) {
  return {
    id: s.id,
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    address: s.address,
    country: s.country,
    operator: s.operator,
    network: s.network,
    connectors: structuredClone(s.connectors || {}),
    access: s.access,
    hours: s.hours,
    updatedAt: s.updatedAt,
    status: s.status ?? null,
    operational: s.operational ?? null,
    tariffs: [],
    price: null, // { min, max, extras, source } : tarif structuré IRVE v3, ou prix lu dans un texte
    sources: [],
  };
}

function addSource(m, s) {
  m.sources.push({ source: s.source, id: s.id, url: s.url || null });
  const t = s.tariff || {};
  if (t.text || t.free !== null || t.payCard !== null) {
    m.tariffs.push({ source: s.source, free: t.free ?? null, text: t.text ?? null, payCard: t.payCard ?? null, payAdHoc: t.payAdHoc ?? null });
    // les sources arrivent par ordre de priorité, le premier prix trouvé gagne
    const price = m.price ? null : (t.kwh ?? parseKwhPrice(t.text));
    if (price) m.price = { ...price, source: s.source };
  }
  for (const f of FILL_FIELDS) if (!m[f] && s[f]) m[f] = s[f];
  if (m.sources.length > 1) {
    // une autre source décrit la même station : on garde le maximum par type, sans additionner
    for (const [type, c] of Object.entries(s.connectors || {})) {
      const cur = m.connectors[type];
      if (!cur) m.connectors[type] = { ...c };
      else {
        cur.count = Math.max(cur.count, c.count);
        // une puissance réelle passe devant une estimation
        if (c.maxKw && (!cur.maxKw || (cur.estimated && !c.estimated) || (!c.estimated && c.maxKw > cur.maxKw))) {
          cur.maxKw = c.maxKw;
          cur.estimated = c.estimated;
        }
      }
    }
  }
  if (!m.status && s.status) m.status = s.status;
  if (m.operational === null && s.operational !== undefined && s.operational !== null) m.operational = s.operational;
}

/** Gratuit si une source le dit et qu'aucune ne dit le contraire. */
function summarizeFree(tariffs) {
  const vals = tariffs.map((t) => t.free).filter((v) => v !== null);
  if (!vals.length) return null;
  if (vals.every(Boolean)) return true;
  if (vals.every((v) => !v)) return false;
  return null; // les sources se contredisent
}

export function mergeStations(lists, mergeDistance = 60) {
  const all = lists.flat().sort((a, b) => (PRIORITY[a.source] ?? 9) - (PRIORITY[b.source] ?? 9));
  const merged = [];
  // grille d'environ 0,01° : on ne compare que des voisines
  const grid = new Map();
  const cell = (lat, lon) => `${Math.floor(lat * 100)}:${Math.floor(lon * 100)}`;

  for (const s of all) {
    const ci = Math.floor(s.lat * 100);
    const cj = Math.floor(s.lon * 100);
    let target = null;
    let best = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const m of grid.get(`${ci + di}:${cj + dj}`) || []) {
          if (m.sources.some((x) => x.source === s.source)) continue; // deux stations d'une même source restent distinctes
          const d = distanceMeters(s.lat, s.lon, m.lat, m.lon);
          if (d <= mergeDistance && d < best) {
            best = d;
            target = m;
          }
        }
      }
    }
    if (!target) {
      target = toMerged(s);
      merged.push(target);
      const k = cell(s.lat, s.lon);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(target);
    }
    addSource(target, s);
  }
  for (const m of merged) m.free = summarizeFree(m.tariffs);
  return merged;
}
