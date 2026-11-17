/**
 * Source IRVE : la base nationale française, publiée par transport.data.gouv.fr.
 * Le fichier statique (environ 180 000 points de charge) est lu en flux, regroupé par station et gardé
 * en mémoire, avec une copie sur disque pour redémarrer vite. Le fichier dynamique donne l'état de
 * chaque point de charge et de chaque prise.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { CONNECTORS, CONNECTOR_TYPES, addConnector, hasAnyType } from '../connectors.js';
import { parseCsv, streamToText } from '../csv.js';
import { buildTariffs, currentTariff, parseTariffIds, summarizeTariff } from '../tariffs.js';
import { clean, httpFetch, inBbox, normalizeKw, parseBool, parseNumber } from '../util.js';

// Une prise CHAdeMO qui partage son point de charge avec une CCS dépasse rarement 50 kW :
// on plafonne sa puissance affichée, en la marquant comme estimée.
const CHADEMO_SHARED_CAP_KW = 50;

const state = {
  stations: [],
  byId: new Map(), // pour retrouver vite les bornes favorites
  pdcIds: new Set(),
  dynamic: new Map(), // par id_pdc_itinerance : { etat, occupation, prises, at }
  tariffs: new Map(), // par tarif_id (schéma v3)
  tariffsAt: null,
  tariffsError: null,
  loadedAt: null,
  dynamicAt: null,
  loading: false,
  error: null,
  dynamicError: null,
};

// Valeurs du champ tarification qui ne disent rien du prix
const EMPTY_TARIFF = /^(true|false|vrai|faux|oui|non|nc|n\/?a|inconnu|non communiqué|[-.?0 ]*)$/i;
// Texte passe-partout copié sur des milliers de stations, sans le moindre prix
const BOILERPLATE_TARIFF = /^les tarifs de recharge peuvent varier en fonction/i;

/** Texte de tarif s'il apporte quelque chose, sinon null. */
export function cleanTariff(v) {
  const t = clean(v);
  return t && !EMPTY_TARIFF.test(t) && !BOILERPLATE_TARIFF.test(t) ? t : null;
}

// On lit le schéma IRVE v2.3 de la base actuelle, mais les noms de colonnes de la v3 (encore en alpha,
// https://github.com/etalab/schema-irve) sont déjà acceptés : c'est le « v2 ?? v3 » qu'on voit plus bas.

/** Paiement sans abonnement : un booléen en v2 (paiement_acte), une liste JSON en v3 (paiement_ad_hoc). */
export function parseAdHoc(r) {
  const v2 = parseBool(r.paiement_acte);
  if (v2 !== null) return v2;
  const list = clean(r.paiement_ad_hoc);
  if (!list) return null;
  try {
    const arr = JSON.parse(list);
    return Array.isArray(arr) ? arr.length > 0 : null;
  } catch {
    return null;
  }
}

/** Coordonnées de la station : colonnes consolidées (v2), station_latitude/longitude (v3), ou coordonneesXY en dernier recours. */
export function extractCoords(r) {
  let lat = parseNumber(r.consolidated_latitude ?? r.station_latitude);
  let lon = parseNumber(r.consolidated_longitude ?? r.station_longitude);
  if (lat === null || lon === null) {
    const xy = clean(r.coordonneesXY);
    if (!xy) return null;
    const nums = xy.replace(/[[\]\s]/g, '').split(',').map(Number);
    if (nums.length !== 2 || nums.some(Number.isNaN)) return null;
    [lon, lat] = nums;
  }
  if (Math.abs(lat) < Math.abs(lon) && Math.abs(lon) > 30 && Math.abs(lat) < 20) [lat, lon] = [lon, lat];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Regroupe les points de charge en stations au fil de la lecture, sans garder les lignes. */
export class StationBuilder {
  constructor() {
    this.byStation = new Map();
    this.rows = 0;
  }

  add(r) {
    const types = CONNECTOR_TYPES.filter((t) => parseBool(r[CONNECTORS[t].irve]) === true);
    if (!types.length) return;
    const coords = extractCoords(r);
    if (!coords) return;
    this.rows++;
    const key = clean(r.id_station_itinerance) || `${coords.lat.toFixed(5)},${coords.lon.toFixed(5)}`;
    let s = this.byStation.get(key);
    if (!s) {
      const addr = [clean(r.adresse_station), clean(r.consolidated_code_postal ?? r.code_postal), clean(r.consolidated_commune)].filter(Boolean);
      s = {
        id: `irve:${key}`,
        source: 'IRVE',
        name: clean(r.nom_station) || clean(r.nom_enseigne) || 'Station de recharge',
        lat: coords.lat,
        lon: coords.lon,
        address: addr.filter((v, i) => i === 0 || !addr[0].includes(v)).join(', ') || null,
        country: 'FR',
        operator: clean(r.nom_operateur) || clean(r.nom_amenageur),
        network: clean(r.nom_enseigne),
        connectors: {},
        tariff: { free: parseBool(r.gratuit), text: null, payCard: parseBool(r.paiement_cb), payAdHoc: parseAdHoc(r) },
        access: clean(r.condition_acces),
        hours: clean(r.horaires),
        pdcs: [],
        updatedAt: clean(r.date_maj ?? r.horodatage_maj),
      };
      this.byStation.set(key, s);
    }
    const kw = normalizeKw(r.puissance_nominale ?? r.puissance_nominale_kw);
    for (const t of types) {
      const capped = t === 'chademo' && types.includes('ccs') && kw > CHADEMO_SHARED_CAP_KW;
      addConnector(s.connectors, t, 1, capped ? CHADEMO_SHARED_CAP_KW : kw, capped);
    }
    // En v3, le texte libre disparaît au profit d'un fichier tarifs, que l'on retrouve par tarif_ids
    for (const id of parseTariffIds(r.tarif_ids)) {
      s.tariffIds ??= []; // créé seulement si besoin, pour ne pas alourdir le cache tant que la base est en v2
      if (!s.tariffIds.includes(id)) s.tariffIds.push(id);
    }
    const tarif = cleanTariff(r.tarification);
    if (tarif && !(s.tariff.text || '').includes(tarif)) s.tariff.text = s.tariff.text ? `${s.tariff.text} | ${tarif}` : tarif;
    if (s.tariff.free === null) s.tariff.free = parseBool(r.gratuit);
    s.pdcs.push({ id: clean(r.id_pdc_itinerance), types });
  }

  result() {
    return [...this.byStation.values()];
  }
}

export function buildStations(rows) {
  const b = new StationBuilder();
  for (const r of rows) b.add(r);
  return b.result();
}

export function buildDynamic(rows) {
  const map = new Map();
  for (const r of rows) {
    const id = clean(r.id_pdc_itinerance);
    if (!id) continue;
    const prises = {};
    for (const t of CONNECTOR_TYPES) {
      const v = clean(r[CONNECTORS[t].irveDynamic]);
      if (v) prises[t] = v;
    }
    map.set(id, { etat: clean(r.etat_pdc), occupation: clean(r.occupation_pdc), prises, at: clean(r.horodatage) });
  }
  return map;
}

/** Disponibilité de la station, en ne comptant que les points de charge qui ont une des prises choisies. */
export function stationStatus(station, dynamic, types) {
  let known = 0;
  let available = 0;
  let outOfService = 0;
  let total = 0;
  let last = null;
  for (const pdc of station.pdcs) {
    const wanted = pdc.types.filter((t) => types.includes(t));
    if (!wanted.length) continue;
    total++;
    const d = pdc.id && dynamic.get(pdc.id);
    if (!d) continue;
    known++;
    if (d.at && (!last || d.at > last)) last = d.at;
    const prisesHs = wanted.every((t) => d.prises[t] === 'hors_service');
    if (d.etat === 'hors_service' || prisesHs) outOfService++;
    else if (d.occupation === 'libre') available++;
  }
  if (!known) return null;
  return { known, available, outOfService, total, updatedAt: last };
}

// À augmenter quand le format des stations change : l'ancien cache est alors ignoré et reconstruit
const CACHE_VERSION = 3;
const cacheFile = () => path.join(config.dataDir, `irve-stations-${CACHE_VERSION}.json`);

async function* rowsFromUrl(url) {
  const res = await httpFetch(url, { timeoutMs: 10 * 60 * 1000, headers: { Accept: 'text/csv,*/*' } });
  yield* parseCsv(streamToText(res.body));
}

function setStations(stations, loadedAt) {
  state.stations = stations;
  state.loadedAt = loadedAt;
  state.byId = new Map(stations.map((s) => [s.id, s]));
  state.pdcIds = new Set(stations.flatMap((s) => s.pdcs.map((p) => p.id).filter(Boolean)));
}

/** Efface les caches des versions précédentes. */
async function removeOldCaches() {
  const current = path.basename(cacheFile());
  for (const f of await fs.readdir(config.dataDir)) {
    if (/^irve-stations-.+\.json$/.test(f) && f !== current) await fs.rm(path.join(config.dataDir, f), { force: true });
  }
}

async function loadStatic() {
  const t0 = Date.now();
  const builder = new StationBuilder();
  for await (const r of rowsFromUrl(config.irve.staticUrl)) builder.add(r);
  const stations = builder.result();
  if (!stations.length) throw new Error('IRVE : aucune station trouvée (format du fichier changé ?)');
  setStations(stations, new Date().toISOString());
  await fs.mkdir(config.dataDir, { recursive: true });
  // on écrit à côté puis on renomme : un arrêt brutal ne laisse jamais un cache à moitié écrit
  const tmp = `${cacheFile()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ loadedAt: state.loadedAt, stations }));
  await fs.rename(tmp, cacheFile());
  await removeOldCaches();
  console.log(`[IRVE] ${stations.length} stations (${builder.rows} PDC) chargées en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

async function loadDynamic() {
  const rows = [];
  for await (const r of rowsFromUrl(config.irve.dynamicUrl)) if (state.pdcIds.has(r.id_pdc_itinerance)) rows.push(r);
  state.dynamic = buildDynamic(rows);
  state.dynamicAt = new Date().toISOString();
  state.dynamicError = null;
  console.log(`[IRVE] statut dynamique : ${state.dynamic.size} PDC`);
}

async function loadTariffs() {
  const used = new Set(state.stations.flatMap((s) => s.tariffIds || []));
  if (!used.size) return; // tant que la base est en v2, aucune borne ne renvoie vers un tarif
  const rows = [];
  for await (const r of rowsFromUrl(config.irve.tariffsUrl)) rows.push(r);
  state.tariffs = buildTariffs(rows, used);
  state.tariffsAt = new Date().toISOString();
  state.tariffsError = null;
  console.log(`[IRVE] tarifs : ${state.tariffs.size} / ${used.size} référencés`);
}

async function refreshStatic() {
  if (state.loading) return;
  state.loading = true;
  try {
    await loadStatic();
    state.error = null;
  } catch (e) {
    state.error = e.message;
    console.error('[IRVE] échec du chargement statique :', e.message);
  } finally {
    state.loading = false;
  }
}

async function refreshDynamic() {
  if (!state.stations.length) return;
  try {
    await loadDynamic();
  } catch (e) {
    state.dynamicError = e.message;
    console.error('[IRVE] échec du chargement dynamique :', e.message);
  }
  if (!config.irve.tariffsUrl) return;
  try {
    await loadTariffs();
  } catch (e) {
    state.tariffsError = e.message;
    console.error('[IRVE] échec du chargement des tarifs :', e.message);
  }
}

export async function startIrve() {
  if (!config.irve.enabled) return;
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile(), 'utf8'));
    setStations(cached.stations, cached.loadedAt);
    console.log(`[IRVE] ${cached.stations.length} stations depuis le cache disque (${cached.loadedAt})`);
  } catch {
    /* pas encore de cache : premier démarrage */
  }
  const staleMs = config.irve.staticRefreshHours * 3600 * 1000;
  const isStale = !state.loadedAt || Date.now() - Date.parse(state.loadedAt) > staleMs;
  const first = isStale ? refreshStatic() : Promise.resolve();
  first.then(refreshDynamic);
  setInterval(() => refreshStatic().then(refreshDynamic), staleMs).unref();
  setInterval(refreshDynamic, config.irve.dynamicRefreshMinutes * 60 * 1000).unref();
}

/**
 * Applique le tarif v3 en vigueur : il remplace le texte libre et fournit le prix au kWh.
 * Les tarifs sont déclarés par point de charge ; on retient le premier qui s'applique.
 */
export function withTariff(tariff, ids, tariffs, now) {
  const t = ids?.length ? currentTariff(ids, tariffs, now) : null;
  if (!t) return tariff;
  const { text, ...kwh } = summarizeTariff(t);
  return { ...tariff, text: text || tariff.text, kwh: kwh.min === null ? null : kwh };
}

/** Ce qu'on renvoie au front : la station, son tarif en vigueur et sa disponibilité pour les prises choisies. */
function forClient({ pdcs, tariffIds, ...s }, types, now) {
  return { ...s, tariff: withTariff(s.tariff, tariffIds, state.tariffs, now), status: stationStatus({ pdcs }, state.dynamic, types) };
}

export function queryIrve(bbox, types) {
  const now = new Date().toISOString();
  return state.stations.filter((s) => inBbox(s.lat, s.lon, bbox) && hasAnyType(s, types)).map((s) => forClient(s, types, now));
}

/** Bornes précises, où qu'elles soient : sert à rafraîchir les favoris. Les identifiants inconnus sont ignorés. */
export function irveStationsById(ids, types) {
  const now = new Date().toISOString();
  return ids.map((id) => state.byId.get(id)).filter(Boolean).map((s) => forClient(s, types, now));
}

export function irveStatus() {
  return {
    enabled: config.irve.enabled,
    stations: state.stations.length,
    loadedAt: state.loadedAt,
    loading: state.loading,
    error: state.error,
    dynamicAt: state.dynamicAt,
    dynamicPdc: state.dynamic.size,
    dynamicError: state.dynamicError,
    tariffsUrl: Boolean(config.irve.tariffsUrl),
    tariffsAt: state.tariffsAt,
    tariffs: state.tariffs.size,
    tariffsError: state.tariffsError,
  };
}
