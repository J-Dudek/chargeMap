// Test de bout en bout : de faux serveurs amont (IRVE, OCM, Overpass, IGN, Photon)
// puis l'app réelle, interrogée en HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { GEOPF_RESPONSE, IRVE_DYNAMIC_CSV, IRVE_STATIC_CSV, OCM_RESPONSE, OVERPASS_RESPONSE, PHOTON_RESPONSE } from './fixtures.js';

const calls = [];
const upstream = http.createServer((req, res) => {
  calls.push(req.url);
  const send = (type, body) => {
    res.writeHead(200, { 'Content-Type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (req.url.startsWith('/irve-static')) return send('text/csv', IRVE_STATIC_CSV);
  if (req.url.startsWith('/irve-dynamic')) return send('text/csv', IRVE_DYNAMIC_CSV);
  if (req.url.startsWith('/ocm')) {
    assert.equal(req.headers['x-api-key'], 'test-key');
    return send('application/json', OCM_RESPONSE);
  }
  if (req.url.startsWith('/overpass-down')) {
    res.writeHead(502).end('at capacity');
    return;
  }
  if (req.url.startsWith('/overpass')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      send('application/json', OVERPASS_RESPONSE);
    });
    return;
  }
  if (req.url.startsWith('/geopf')) return send('application/json', GEOPF_RESPONSE);
  if (req.url.startsWith('/photon')) return send('application/json', PHOTON_RESPONSE);
  res.writeHead(404).end();
});

test('API de bout en bout', async (t) => {
  await new Promise((r) => upstream.listen(0, r));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'recharge-map-')),
    IRVE_STATIC_URL: `${base}/irve-static`,
    IRVE_DYNAMIC_URL: `${base}/irve-dynamic`,
    OCM_URL: `${base}/ocm`,
    OCM_API_KEY: 'test-key',
    OVERPASS_URL: `${base}/overpass-down,${base}/overpass`,
    GEOPF_URL: `${base}/geopf`,
    PHOTON_URL: `${base}/photon`,
  });
  const { server } = await import('../server/index.js');
  const irve = await import('../server/sources/irve.js');
  await irve.startIrve();
  // attendre le chargement statique + dynamique
  for (let i = 0; i < 50 && !irve.irveStatus().dynamicAt; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => server.listen(0, r));
  const app = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    upstream.close();
  });

  const st = await (await fetch(`${app}/api/status`)).json();
  assert.equal(st.irve.stations, 3);
  assert.equal(st.irve.dynamicPdc, 3);

  // Zone Lyon
  const lyon = await (await fetch(`${app}/api/stations?south=45.70&west=4.75&north=45.80&east=4.95`)).json();
  assert.deepEqual(lyon.warnings, []);
  assert.deepEqual(lyon.pending, []);
  assert.equal(lyon.stations.length, 2);
  const conf = lyon.stations.find((s) => s.id === 'irve:FRION1');
  assert.equal(conf.sources.length, 3);
  assert.equal(conf.status.available, 1);
  assert.ok(conf.tariffs.some((x) => x.source === 'OCM' && x.text.includes('0,45')));

  // Favoris : retrouvés par identifiant, où qu'ils soient, avec leur disponibilité ; le reste est ignoré
  const favParams = new URLSearchParams({ types: 'chademo,ccs' });
  for (const id of ['irve:FRION1', 'irve:45.00000,4.00000', 'ocm:1', 'irve:inconnu']) favParams.append('id', id);
  const fav = await (await fetch(`${app}/api/favorites?${favParams}`)).json();
  assert.deepEqual(fav.stations.map((s) => s.id), ['irve:FRION1']);
  assert.equal(fav.stations[0].status.available, 1);
  assert.deepEqual((await (await fetch(`${app}/api/favorites`)).json()).stations, []);
  // Overpass : le 1er serveur (502) est sauté, le 2e répond
  const downCalls = () => calls.filter((c) => c.startsWith('/overpass-down')).length;
  assert.equal(downCalls(), 1);

  // Même zone, prise Type 2 seule : le parking Type 2 apparaît, Villeurbanne (CHAdeMO seul) disparaît
  const t2 = await (await fetch(`${app}/api/stations?south=45.70&west=4.75&north=45.80&east=4.95&types=type2`)).json();
  assert.deepEqual(t2.types, ['type2']);
  assert.deepEqual(t2.stations.map((s) => s.name).sort(), ['Borne Type 2', 'Lyon Confluence', 'Parking']);

  // Plusieurs types
  const multi = await (await fetch(`${app}/api/stations?south=45.70&west=4.75&north=45.80&east=4.95&types=chademo,type2`)).json();
  assert.equal(multi.stations.length, 4);

  const labels = await (await fetch(`${app}/api/connectors`)).json();
  assert.equal(labels.ccs, 'CCS Combo 2');

  // Hors de France, pas d'IRVE : seulement OCM et Overpass
  const be = await (await fetch(`${app}/api/stations?south=50.5&west=4.2&north=50.9&east=5.7`)).json();
  assert.deepEqual(be.stations.map((s) => s.name).sort(), ['Allego Liège', 'Bruxelles Gare']);
  // Le serveur Overpass qui a répondu est réutilisé en premier : plus d'appel au serveur en panne
  assert.equal(downCalls(), 1);

  // Cache : une 2e requête identique ne rappelle pas OCM
  const before = calls.filter((c) => c.startsWith('/ocm')).length;
  await fetch(`${app}/api/stations?south=45.70&west=4.75&north=45.80&east=4.95`);
  assert.equal(calls.filter((c) => c.startsWith('/ocm')).length, before);

  // Zone trop grande
  const big = await fetch(`${app}/api/stations?south=42&west=-4&north=51&east=8`);
  assert.equal(big.status, 400);
  assert.equal((await big.json()).tooLarge, true);

  // Géocodage : IGN pour la France, Photon pour le reste, sans doublon Lyon
  const geo = await (await fetch(`${app}/api/geocode?q=li%C3%A8ge`)).json();
  // le centre de la carte est transmis aux deux services, arrondi au degré ; plus aucune limite de zone
  await fetch(`${app}/api/geocode?q=berlin&lat=52.52&lon=13.41`);
  const photonCall = calls.filter((c) => c.startsWith('/photon')).pop();
  assert.match(photonCall, /lat=53&lon=13&zoom=6/);
  assert.match(calls.filter((c) => c.startsWith('/geopf')).pop(), /lat=53&lon=13/);
  assert.doesNotMatch(photonCall, /bbox=/);
  assert.deepEqual(geo.results.map((r) => r.country), ['FR', 'BE']);

  // Fond de carte sans clé par défaut
  const cfg = await (await fetch(`${app}/api/config`)).json();
  assert.match(cfg.tiles.url, /tile\.openstreetmap\.org/);
  // Fond vectoriel OpenFreeMap par défaut, autorisé par la politique de sécurité
  assert.equal(cfg.tiles.styleUrl, 'https://tiles.openfreemap.org/styles/liberty');
  assert.equal(cfg.tiles.styleUrlDark, 'https://tiles.openfreemap.org/styles/dark');
  assert.match((await fetch(`${app}/`)).headers.get('content-security-policy'), /connect-src 'self' https:\/\/tiles\.openfreemap\.org;/);
  assert.match((await fetch(`${app}/`)).headers.get('content-security-policy'), /img-src 'self' data: blob: https:\/\/tile\.openstreetmap\.org;/);
  assert.equal((await fetch(`${app}/api/stations?south=45.7&west=4.8&north=45.8&east=4.9&types=constructor`)).status, 200);
  assert.equal((await fetch(`${app}/vendor/maplibre/maplibre-gl.js`)).status, 200);

  // Le front construit ses boutons à partir de la configuration
  assert.deepEqual(cfg.connectors.map((c) => c.id), ['chademo', 'ccs', 'type2', 'ef']);
  assert.deepEqual(cfg.defaultTypes, ['chademo']);
  assert.deepEqual(cfg.maxSpan, { lat: 2.5, lon: 4 });

  // Statique : en-têtes de sécurité, compression, revalidation par ETag
  const home = await fetch(`${app}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(await (await fetch(`${app}/`)).text(), /https?:\/\/(unpkg|fonts\.g)/); // aucune bibliothèque chargée d'un autre site
  assert.equal((await fetch(`${app}/vendor/leaflet/leaflet.js`)).status, 200);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('content-encoding'), 'gzip');
  assert.match(await home.text(), /CHAdeMO/);
  const again = await fetch(`${app}/`, { headers: { 'If-None-Match': home.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await fetch(`${app}/js/main.js`)).status, 200);
  assert.equal((await fetch(`${app}/js/main.js`)).headers.get('cache-control'), 'no-cache');
  assert.match((await fetch(`${app}/fonts/inter-latin.woff2`)).headers.get('cache-control'), /max-age=604800/);
  assert.equal((await fetch(`${app}/../package.json`)).status, 404);
  assert.equal((await fetch(`${app}/api/inconnu`)).status, 404);

  // Référencement : fichiers pour les moteurs, adresse du site injectée dans la page, texte lisible sans JavaScript
  const robots = await (await fetch(`${app}/robots.txt`)).text();
  assert.match(robots, new RegExp(`Sitemap: ${app}/sitemap.xml`));
  assert.doesNotMatch(robots, /Disallow/);
  const sitemap = await fetch(`${app}/sitemap.xml`);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  assert.match(await sitemap.text(), new RegExp(`<loc>${app}/</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
  const page = await (await fetch(`${app}/`)).text();
  assert.ok(!page.includes('%SITE_URL%'));
  assert.ok(page.includes(`<link rel="canonical" href="${app}/" />`));
  assert.ok(page.includes(`<meta property="og:image" content="${app}/icons/og-image.png" />`));
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'WebApplication');
  assert.equal(ld.url, `${app}/`);
  assert.match(page, /<h2 id="aboutTitle">/);
  for (const file of ['icons/og-image.png', 'favicon.ico']) assert.equal((await fetch(`${app}/${file}`)).status, 200, file);

  // PWA : manifeste avec icônes PNG servies, service worker, crédit de l'auteur
  const manifest = await (await fetch(`${app}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.equal((await fetch(`${app}/${icon.src}`)).status, 200, icon.src);
  const sw = await fetch(`${app}/sw.js`);
  assert.match(sw.headers.get('content-type'), /javascript/);
  for (const file of (await sw.text()).match(/^ {2}'[^']+',$/gm).map((l) => l.trim().slice(1, -2))) assert.equal((await fetch(`${app}/${file}`)).status, 200, file);
  assert.match(await (await fetch(`${app}/`)).text(), /href="https:\/\/me\.byj6n\.fr"/);

  // Méthodes autres que GET / HEAD refusées
  assert.equal((await fetch(`${app}/api/stations`, { method: 'POST' })).status, 405);

  // Une URL mal formée renvoie 400 au lieu de faire tomber le serveur
  const raw = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '//' }, (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
  assert.equal(raw, 400);
  assert.equal((await fetch(`${app}/api/status`)).status, 200);
});
