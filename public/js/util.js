/** Fonctions pures, sans DOM, pour pouvoir les tester sous Node. */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Échappe une valeur avant de l'insérer dans du HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Ne laisse passer que les liens http(s) : ces URL viennent de sources externes. */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : null);

/** Distance en km entre deux points { lat, lon } (haversine). */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export const fmtDist = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);

/** « 0,42 €/kWh », ou « dès 0,31 €/kWh » s'il y a plusieurs prix ou d'autres frais. */
export function fmtKwhPrice(p) {
  const simple = p.min === p.max && !p.extras;
  return `${simple ? '' : 'dès '}${p.min.toFixed(2).replace('.', ',')} €/kWh`;
}

/** Vue de la carte dans l'adresse, pour pouvoir la partager : #14/45.7640/4.8357/chademo,ccs */
export function formatViewHash({ lat, lon, zoom }, types = []) {
  return `#${Math.round(zoom)}/${lat.toFixed(4)}/${lon.toFixed(4)}${types.length ? `/${types.join(',')}` : ''}`;
}

/** L'inverse : null si l'adresse ne décrit pas une vue valable. */
export function parseViewHash(hash) {
  const m = /^#(\d{1,2})\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)(?:\/([a-z0-9,]*))?$/i.exec(String(hash ?? ''));
  if (!m) return null;
  const [zoom, lat, lon] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (zoom > 22 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { view: { lat, lon, zoom }, types: (m[4] || '').toLowerCase().split(',').filter(Boolean) };
}
