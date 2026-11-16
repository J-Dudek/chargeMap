import { config } from './config.js';

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Distance en mètres entre deux points (haversine). */
export function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function inBbox(lat, lon, b) {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Booléen écrit en français ou en anglais (true, oui, 1…) ; null si on ne sait pas. */
export function parseBool(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'oui', 'yes', 'vrai', 't'].includes(s)) return true;
  if (['false', '0', 'non', 'no', 'faux', 'f'].includes(s)) return false;
  return null;
}

/** Premier nombre du texte ; accepte la virgule et les unités (« 50 kW »). */
export function parseNumber(v) {
  if (v === undefined || v === null) return null;
  const m = String(v).replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Puissance en kW ; certains producteurs IRVE déclarent en W. */
export function normalizeKw(v) {
  const n = parseNumber(v);
  if (n === null || n <= 0) return null;
  return n > 2000 ? Math.round(n / 1000) : Math.round(n * 10) / 10;
}

export const clean = (s) => {
  if (s === undefined || s === null) return null;
  const t = String(s).trim();
  return t === '' || t.toLowerCase() === 'null' || t.toLowerCase() === 'nan' ? null : t;
};

/** fetch avec un délai maximum et notre User-Agent. */
export async function httpFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? config.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${new URL(url).host}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** Petit cache en mémoire, avec durée de vie. */
export class TtlCache {
  constructor(ttlMs, maxEntries = 200) {
    this.ttlMs = ttlMs;
    this.max = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  delete(key) {
    this.map.delete(key);
  }
  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }
}

/** Arrondit une zone sur une grille, pour que des vues proches tombent sur la même entrée de cache. */
export function snapBbox(b, step = 0.05) {
  const f = (v) => Math.floor(v / step) * step;
  const c = (v) => Math.ceil(v / step) * step;
  return {
    south: +f(b.south).toFixed(4),
    west: +f(b.west).toFixed(4),
    north: +c(b.north).toFixed(4),
    east: +c(b.east).toFixed(4),
  };
}
