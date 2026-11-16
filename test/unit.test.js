import test from 'node:test';
import { parseKwhPrice } from '../server/price.js';
import { origin, rateKey, RateLimiter } from '../server/http.js';
import assert from 'node:assert/strict';
import { parseCsv } from '../server/csv.js';
import { cleanTariff, buildDynamic, buildStations, stationStatus } from '../server/sources/irve.js';
import { normalizeOcm, ocmConnectorType } from '../server/sources/ocm.js';
import { buildOverpassQuery, normalizeOsm } from '../server/sources/osm.js';
import { parseTypes } from '../server/connectors.js';
import { mergeStations } from '../server/merge.js';
import { mergeResults, normalizePhoton } from '../server/geocode.js';
import { IRVE_DYNAMIC_CSV, IRVE_STATIC_CSV, OCM_RESPONSE, OVERPASS_RESPONSE } from './fixtures.js';

async function collect(gen) {
  const out = [];
  for await (const r of gen) out.push(r);
  return out;
}

/** Découpe un texte en morceaux de taille n pour éprouver le parseur en flux. */
function* chunked(text, n) {
  for (let i = 0; i < text.length; i += n) yield text.slice(i, i + n);
}

test('CSV : guillemets, "" échappés, virgules et découpage arbitraire des chunks', async () => {
  for (const n of [1, 2, 3, 7, 64, 100000]) {
    const rows = await collect(parseCsv(chunked(IRVE_STATIC_CSV, n)));
    assert.equal(rows.length, 5, `chunk=${n}`);
    assert.equal(rows[0].tarification, '0,59 €/kWh, "tarif ad hoc"', `chunk=${n}`);
    assert.equal(rows[0].adresse_station, '12 cours Charlemagne, Lyon');
    assert.equal(rows[3].consolidated_latitude, '');
  }
});

test('CSV : séparateur ; détecté, CRLF et retour à la ligne dans un champ', async () => {
  const rows = await collect(parseCsv(['a;b\r\n1;"x\ny"\r\n2;z']));
  assert.deepEqual(rows, [{ a: '1', b: 'x\ny' }, { a: '2', b: 'z' }]);
});

test('IRVE : regroupement par station, tous types, puissance CHAdeMO plafonnée si PDC partagé avec CCS', async () => {
  const rows = await collect(parseCsv([IRVE_STATIC_CSV]));
  const st = buildStations(rows);
  assert.equal(st.length, 3); // Lyon, Villeurbanne, Parking (Type 2 seul)
  const lyon = st.find((s) => s.id === 'irve:FRION1');
  assert.deepEqual(lyon.connectors.chademo, { count: 2, maxKw: 50, estimated: false }); // E1 mesuré à 50 kW
  const capped = buildStations([{ id_station_itinerance: 'X', coordonneesXY: '[4,45]', puissance_nominale: '150', prise_type_chademo: 'true', prise_type_combo_ccs: 'true' }]);
  assert.deepEqual(capped[0].connectors.chademo, { count: 1, maxKw: 50, estimated: true });
  assert.deepEqual(lyon.connectors.ccs, { count: 2, maxKw: 100, estimated: false }); // 100000 W -> 100 kW
  assert.equal(lyon.connectors.type2.count, 1);
  assert.equal(lyon.tariff.text, '0,59 €/kWh, "tarif ad hoc"');
  assert.equal(lyon.tariff.payCard, true);
  assert.equal(lyon.pdcs.length, 3);
  const vil = st.find((s) => s.id === 'irve:FRFR1');
  assert.equal(vil.lat, 45.766);
  assert.equal(vil.lon, 4.88);
  assert.equal(vil.tariff.free, true);
  assert.equal(st.find((s) => s.id === 'irve:FRNO1').connectors.chademo, undefined);
});

test('IRVE : statut dynamique limité aux types demandés', async () => {
  const st = buildStations(await collect(parseCsv([IRVE_STATIC_CSV])));
  const dyn = buildDynamic(await collect(parseCsv([IRVE_DYNAMIC_CSV])));
  const lyonSt = st.find((s) => s.id === 'irve:FRION1');
  const lyon = stationStatus(lyonSt, dyn, ['chademo']);
  assert.equal(lyon.available, 1);
  assert.equal(lyon.known, 2);
  assert.equal(lyon.total, 2);
  assert.equal(lyon.updatedAt, '2026-11-16T12:05:00+01:00');
  assert.equal(stationStatus(lyonSt, dyn, ['type2']), null); // E3 sans donnée dynamique
  const vil = stationStatus(st.find((s) => s.id === 'irve:FRFR1'), dyn, ['chademo']);
  assert.equal(vil.outOfService, 1);
  assert.equal(vil.available, 0);
});

test('Types : parsing et valeur par défaut', () => {
  assert.deepEqual(parseTypes('ccs,chademo,foo'), ['ccs', 'chademo']);
  assert.deepEqual(parseTypes(''), ['chademo']);
  assert.deepEqual(parseTypes('xx'), ['chademo']);
});

test('OCM : connecteurs classés par libellé puis identifiant', () => {
  const out = OCM_RESPONSE.map(normalizeOcm).filter(Boolean);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].connectors.chademo, { count: 2, maxKw: 50, estimated: false });
  assert.deepEqual(out[0].connectors.ccs, { count: 4, maxKw: 350, estimated: false });
  assert.equal(out[0].tariff.text, '0,45 €/kWh + 0,10 €/min');
  assert.equal(out[1].tariff.free, true);
  assert.equal(out[1].country, 'BE');
  assert.deepEqual(Object.keys(out[2].connectors), ['type2']);
  assert.equal(ocmConnectorType({ ConnectionTypeID: 999, ConnectionType: { Title: 'CCS (Type 2)' } }), 'ccs');
  assert.equal(ocmConnectorType({ ConnectionTypeID: 999, ConnectionType: { Title: 'CEE 7/4 - Schuko - Type F' } }), 'ef');
  assert.equal(ocmConnectorType({ ConnectionTypeID: 1036 }), 'type2');
  assert.equal(ocmConnectorType({ ConnectionTypeID: 1, ConnectionType: { Title: 'Type 1 (J1772)' } }), null);
});

test('OSM : normalisation multi-prises, way avec center, socket:x=no ignoré, requête Overpass', () => {
  const out = OVERPASS_RESPONSE.elements.map(normalizeOsm).filter(Boolean);
  assert.equal(out.length, 2);
  assert.equal(out[0].connectors.chademo.maxKw, 50);
  assert.equal(out[0].connectors.ccs.count, 2);
  assert.equal(out[0].tariff.free, false);
  assert.equal(out[1].lat, 50.85);
  assert.equal(out[1].tariff.free, true);
  const q = buildOverpassQuery({ south: 1, west: 2, north: 3, east: 4 }, ['ccs', 'type2']);
  assert.match(q, /socket:type2_combo/);
  assert.match(q, /socket:type2_cable/);
  assert.doesNotMatch(q, /chademo/);
});

test('Fusion : même station des 3 sources -> 1 station, tarifs conservés, puissance mesurée > estimée', async () => {
  const irve = buildStations(await collect(parseCsv([IRVE_STATIC_CSV])));
  const ocm = OCM_RESPONSE.map(normalizeOcm).filter(Boolean);
  const osm = OVERPASS_RESPONSE.elements.map(normalizeOsm).filter(Boolean);
  const merged = mergeStations([irve, ocm, osm], 60);
  assert.equal(merged.length, 6); // Lyon (fusionnée), Villeurbanne, Parking, Liège, Bruxelles, OCM Type 2
  const lyon = merged.find((m) => m.id === 'irve:FRION1');
  assert.deepEqual(lyon.sources.map((s) => s.source), ['IRVE', 'OCM', 'OSM']);
  assert.equal(lyon.tariffs.length, 3);
  assert.equal(lyon.name, 'Lyon Confluence');
  assert.deepEqual(lyon.connectors.chademo, { count: 2, maxKw: 50, estimated: false });
  assert.equal(lyon.connectors.ccs.maxKw, 350);
  assert.equal(lyon.free, false);
  assert.deepEqual(lyon.price, { min: 0.59, max: 0.59, extras: false, source: 'IRVE' }); // premier prix par ordre de priorité des sources
});

test('Fusion : deux stations proches d\'une même source restent séparées', () => {
  const a = { id: 'osm:1', source: 'OSM', lat: 45, lon: 4, connectors: { chademo: { count: 1 } }, tariff: {} };
  const b = { id: 'osm:2', source: 'OSM', lat: 45.0001, lon: 4, connectors: { chademo: { count: 1 } }, tariff: {} };
  assert.equal(mergeStations([[a, b]]).length, 2);
});

test('Géocodage Photon : libellé lisible', () => {
  const r = normalizePhoton({ geometry: { coordinates: [5.57, 50.63] }, properties: { name: 'Rue Léopold', street: 'Rue Léopold', housenumber: '3', postcode: '4000', city: 'Liège', country: 'Belgique', countrycode: 'BE' } });
  assert.equal(r.label, '3 Rue Léopold, 4000 Liège, Belgique');
  assert.equal(r.country, 'BE');
});

test('IRVE : tarification sans information ignorée', () => {
  for (const v of ['TRUE', 'false', 'NC', ' - ', '', '0', 'Non communiqué', 'Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs, y compris le fournisseur…']) assert.equal(cleanTariff(v), null, v);
  assert.equal(cleanTariff('0,45 €/kWh'), '0,45 €/kWh');
  assert.equal(cleanTariff('Gratuit'), 'Gratuit');
});

test('Limite de débit : refuse au-delà du quota, par clé', () => {
  const rl = new RateLimiter(2);
  assert.equal(rl.check('a'), 0);
  assert.equal(rl.check('a'), 0);
  assert.ok(rl.check('a') > 0);
  assert.equal(rl.check('b'), 0);
  assert.equal(new RateLimiter(0).check('a'), 0); // 0 = désactivée
});

test('Prix au kWh : lu dans les textes de tarif', () => {
  const p = (t) => parseKwhPrice(t);
  assert.deepEqual(p('0.69€ / kwh'), { min: 0.69, max: 0.69, extras: false });
  assert.deepEqual(p('0,45 €/kWh'), { min: 0.45, max: 0.45, extras: false });
  assert.deepEqual(p('€0.59/kWh'), { min: 0.59, max: 0.59, extras: false });
  assert.deepEqual(p('0,399 e/ kwh'), { min: 0.4, max: 0.4, extras: false });
  assert.deepEqual(p('0,54  TTC / kWh'), { min: 0.54, max: 0.54, extras: false });
  // centimes, plusieurs prix
  assert.deepEqual(p('HPC 59cts/Kwh | HPC 49cts/Kwh | AC 36cts/KWh'), { min: 0.36, max: 0.59, extras: false });
  // autres frais mentionnés
  assert.deepEqual(p('0,35€/kWh + 0,03€/min entre 6h et 18h, 15€ la session entre 18h et 6h'), { min: 0.35, max: 0.35, extras: true });
  assert.deepEqual(p("par défaut : 0.4167€ par kwh de charge, par défaut : 6.0€ par heure d'occupation hors charge"), { min: 0.42, max: 0.42, extras: true });
  assert.deepEqual(p('entre 08:00 et 20:00 : 0.30916667€ par kwh de charge, entre 20:00 et 08:00 : 0.25€ par kwh de charge'), { min: 0.25, max: 0.31, extras: false });
  assert.deepEqual(p('0.25€+0.35/kWh'), { min: 0.35, max: 0.35, extras: false });
  // pas de prix fiable
  for (const t of ['0,42 € HT / kWh', '1,25€/KWH HT', 'Grille tarifaire en ligne', '0.4916', 'Borne 22 kWh', '050 kWh', '2 AC- DC €/kWh', '0,025€ / min', null]) assert.equal(p(t), null, String(t));
});

test('IRVE : lignes au schéma v3 (alpha) lues comme la v2', () => {
  const [s] = buildStations([{
    id_station_itinerance: 'FRABCP001', id_pdc_itinerance: 'FRABCE001', nom_station: 'Gare',
    station_latitude: '48.85', station_longitude: '2.35', code_postal: '75001',
    puissance_nominale_kw: '150', prise_type_combo_ccs: 'true', paiement_ad_hoc: '["cb_sans_contact"]',
  }]);
  assert.equal(s.lat, 48.85);
  assert.equal(s.lon, 2.35);
  assert.equal(s.connectors.ccs.maxKw, 150);
  assert.equal(s.tariff.payAdHoc, true);
});

// Exemple officiel du schéma IRVE v3.0.0-alpha.1 (tarifs/exemple-valide-tarifs.csv)
const TARIFS_V3_CSV = `tarif_id,element_index,devise,horodatage_maj_tarif,start_date_time,end_date_time,type,tax_included,min_price,max_price,restrictions,price_components
FRELCT5,0,EUR,2024-12-17T13:13:31Z,2024-12-01T00:00:00Z,,AD_HOC_PAYMENT,YES,0.50,,"{""start_time"":""06:00"",""end_time"":""00:00"",""min_duration"":0,""max_duration"":7200}","[{""type"":""ENERGY"",""price"":0.33334,""step_size"":1000}]"
FRELCT5,1,EUR,2024-12-17T13:13:31Z,2024-12-01T00:00:00Z,,AD_HOC_PAYMENT,YES,0.50,,"{""start_time"":""06:00"",""end_time"":""00:00"",""min_duration"":7200,""max_duration"":10800}","[{""type"":""PARKING_TIME"",""price"":4,""step_size"":60},{""type"":""ENERGY"",""price"":0.33334,""step_size"":1000},{""type"":""TIME"",""price"":4,""step_size"":60}]"
FRELCT5,2,EUR,2024-12-17T13:13:31Z,2024-12-01T00:00:00Z,,AD_HOC_PAYMENT,YES,0.50,,"{""start_time"":""06:00"",""end_time"":""00:00"",""min_duration"":10800}","[{""type"":""PARKING_TIME"",""price"":8,""step_size"":60},{""type"":""TIME"",""price"":8,""step_size"":60},{""type"":""ENERGY"",""price"":0.33334,""step_size"":1000}]"
FRELCT5,3,EUR,2024-12-17T13:13:31Z,2024-12-01T00:00:00Z,,AD_HOC_PAYMENT,YES,0.50,,"{""start_time"":""00:00"",""end_time"":""06:00""}","[{""type"":""ENERGY"",""price"":0.20834,""step_size"":1000}]"
FRELCT5,4,EUR,2024-12-17T13:13:31Z,2024-12-01T00:00:00Z,,AD_HOC_PAYMENT,YES,0.50,,{},"[{""type"":""ENERGY"",""price"":0.20834,""step_size"":1000}]"
`;

test('Tarifs IRVE v3 : exemple officiel résumé en prix au kWh + texte', async () => {
  const { buildTariffs, currentTariff, summarizeTariff } = await import('../server/tariffs.js');
  const tariffs = buildTariffs(await collect(parseCsv([TARIFS_V3_CSV])));
  assert.equal(tariffs.get('FRELCT5').elements.length, 5);
  assert.equal(currentTariff(['FRELCT5'], tariffs, '2024-11-01T00:00:00Z'), null, 'pas encore en vigueur');
  const sum = summarizeTariff(currentTariff(['INCONNU', 'FRELCT5'], tariffs, '2026-01-01T00:00:00Z'));
  assert.equal(sum.min, 0.20834);
  assert.equal(sum.max, 0.33334);
  assert.equal(sum.extras, true);
  assert.equal(sum.text, '0,33 €/kWh (6 h–0 h) · 0,21 €/kWh (0 h–6 h) · 4 €/h de charge (6 h–0 h, entre 2 h et 3 h) · 8 €/h de charge (6 h–0 h, après 3 h) · 4 €/h branché sans charger (6 h–0 h, entre 2 h et 3 h) · 8 €/h branché sans charger (6 h–0 h, après 3 h) · minimum 0,50 €');
});

test('Tarifs IRVE v3 : la station v3 prend le prix structuré, avant le texte libre', async () => {
  const { buildTariffs } = await import('../server/tariffs.js');
  const { withTariff } = await import('../server/sources/irve.js');
  const [s] = buildStations([{ id_station_itinerance: 'FRELCP1', id_pdc_itinerance: 'FRELCE1', station_latitude: '47.6', station_longitude: '7.5', prise_type_2: 'true', tarif_ids: '["FRELCT5"]' }]);
  assert.deepEqual(s.tariffIds, ['FRELCT5']);
  const tariff = withTariff(s.tariff, s.tariffIds, buildTariffs(await collect(parseCsv([TARIFS_V3_CSV]))), '2026-01-01T00:00:00Z');
  assert.equal(tariff.kwh.min, 0.20834);
  const [m] = mergeStations([[{ ...s, tariff }]]);
  assert.equal(m.price.source, 'IRVE');
  assert.equal(m.price.max, 0.33334);
  assert.match(m.tariffs[0].text, /^0,33 €\/kWh/);
});

test('Sécurité : types hérités d\'Object refusés', () => {
  assert.deepEqual(parseTypes('constructor,__proto__,toString,ccs'), ['ccs']);
  assert.deepEqual(parseTypes('hasOwnProperty'), parseTypes(''));
});

test('Sécurité : clé de limite de débit (IPv6 ramenée au /64)', () => {
  assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
  assert.equal(rateKey('::ffff:203.0.113.7'), '::ffff:203.0.113.7');
  assert.equal(rateKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), rateKey('2001:DB8:1:2::1'));
  assert.notEqual(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:3::1'));
  assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
});

test('Sécurité : origine CSP des tuiles', () => {
  assert.equal(origin('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png'), 'https://*.tile.openstreetmap.fr');
  assert.equal(origin('https://tile.openstreetmap.org/{z}/{x}/{y}.png'), 'https://tile.openstreetmap.org');
  assert.equal(origin('n importe quoi'), '');
});

test('Géocodage : une vraie ville trouvée par Photon passe devant les lieux-dits de l\'IGN', () => {
  const r = (label, type) => ({ label, type });
  const berlin = mergeResults([r('Berlin 09210 Saint-Ybars', 'locality'), r('Berling', 'municipality')], [r('Berlin', 'city')], 6);
  assert.equal(berlin[0].label, 'Berlin');
  // une commune française gagne : l'IGN reste devant
  const lyon = mergeResults([r('Lyon', 'municipality'), r('Lyonne', 'street')], [r('Lyonstraße', 'street')], 6);
  assert.deepEqual(lyon.map((x) => x.label), ['Lyon', 'Lyonne', 'Lyonstraße']);
  // une adresse : l'IGN reste devant
  const rue = mergeResults([r('10 Rue de la Paix 75002 Paris', 'housenumber')], [r('Via della Pace', 'street')], 6);
  assert.equal(rue[0].type, 'housenumber');
});
