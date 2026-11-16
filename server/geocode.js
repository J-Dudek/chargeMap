/**
 * Recherche d'adresse : Photon (données OpenStreetMap) partout, et l'IGN, plus précis, pour les adresses françaises.
 */
import { config } from './config.js';
import { httpFetch } from './util.js';

// En autocomplétion, mieux vaut un résultat incomplet qu'une longue attente
const GEOCODE_TIMEOUT_MS = 4000;
const PHOTON_GRACE_MS = 800;
// Ce qu'on considère comme une ville ou une région, par opposition à une rue, un lieu-dit ou un monument
const PLACE_TYPES = new Set(['municipality', 'city', 'town', 'village', 'district', 'county', 'state', 'country']);


export function normalizeGeopf(f) {
  const [lon, lat] = f.geometry?.coordinates || [];
  if (typeof lat !== 'number') return null;
  return { label: f.properties?.label, lat, lon, country: 'FR', type: f.properties?.type, source: 'IGN' };
}

export function normalizePhoton(f) {
  const [lon, lat] = f.geometry?.coordinates || [];
  const p = f.properties || {};
  if (typeof lat !== 'number') return null;
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [p.name !== p.street ? p.name : null, street, [p.postcode, p.city].filter(Boolean).join(' '), p.country];
  const label = parts.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return { label, lat, lon, country: p.countrycode || null, type: p.type || p.osm_value, source: 'Photon' };
}

const fetchFeatures = (url, normalize) =>
  httpFetch(url, { timeoutMs: GEOCODE_TIMEOUT_MS })
    .then((r) => r.json())
    .then((d) => (d.features || []).map(normalize).filter(Boolean));

/**
 * Assemble les deux listes. L'IGN passe devant pour la France, sauf quand Photon a trouvé une vraie ville
 * et l'IGN seulement des rues ou des lieux-dits : en tapant « Berlin », on veut la capitale allemande,
 * pas le lieu-dit de l'Ariège.
 */
export function mergeResults(ign, others, limit) {
  const photonFirst = PLACE_TYPES.has(others[0]?.type) && ign[0]?.type !== 'municipality';
  return (photonFirst ? [...others.slice(0, 3), ...ign] : [...ign.slice(0, 4), ...others]).slice(0, limit);
}

const settle = (promise) => promise.then((value) => ({ ok: true, value }), () => ({ ok: false, value: [] }));

/**
 * Renvoie { results, complete }. complete est faux quand on n'a pas attendu Photon jusqu'au bout :
 * il manque peut-être des résultats, donc on ne met pas ce résultat en cache.
 * near ({ lat, lon }, facultatif) favorise les lieux proches de la carte, pour tomber sur le bon Saint-Denis.
 * Photon le prend au sens large (zoom 6, une région) : plus serré, il préfère un restaurant « Berlin »
 * du coin à la ville de Berlin.
 */
export async function geocode(q, { near = null, limit = 6 } = {}) {
  const ignParams = new URLSearchParams({ q, limit: String(limit), autocomplete: '1' });
  const photonParams = new URLSearchParams({ q, limit: String(limit), lang: 'fr' });
  if (near) {
    for (const params of [ignParams, photonParams]) {
      params.set('lat', String(near.lat));
      params.set('lon', String(near.lon));
    }
    photonParams.set('zoom', '6');
  }
  const ignReq = settle(fetchFeatures(`${config.geocode.geoplateformeUrl}?${ignParams}`, normalizeGeopf));
  const photonReq = settle(fetchFeatures(`${config.geocode.photonUrl}?${photonParams}`, normalizePhoton));
  const ign = await ignReq;
  // L'IGN a répondu : on n'accorde plus à Photon qu'un petit délai
  const photon = ign.value.length ? await Promise.race([photonReq, new Promise((r) => setTimeout(r, PHOTON_GRACE_MS, null))]) : await photonReq;
  // Pour la France on garde l'IGN ; Photon apporte le reste du monde, ou remplace l'IGN s'il est en panne
  const others = (photon?.value || []).filter((r) => (ign.value.length ? r.country !== 'FR' : true));
  const results = mergeResults(ign.value, others, limit);
  if (!results.length && !ign.ok && photon && !photon.ok) throw new Error('Services de géocodage indisponibles');
  return { results, complete: photon !== null };
}
