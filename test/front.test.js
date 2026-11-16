// Fonctions pures du front (public/js) : règles d'affichage et gabarits HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import { comparablePrice, FILTERS, passFilters, powerOf, SORTS, statusOf } from '../public/js/stations.js';
import { cardHtml, navLinks, pinHtml, pinTitle } from '../public/js/templates.js';
import { detectPlatform } from '../public/js/dom.js';
import { distanceKm, esc, fmtDist, fmtKwhPrice, formatViewHash, parseViewHash, safeUrl } from '../public/js/util.js';

const station = (over = {}) => ({
  id: 'irve:1',
  name: 'Station <b>test</b>',
  lat: 45.76,
  lon: 4.84,
  address: '1 rue de la Paix',
  operator: 'Op',
  network: 'Op',
  connectors: { chademo: { count: 1, maxKw: 50, estimated: true }, ccs: { count: 2, maxKw: 150, estimated: false } },
  status: null,
  operational: null,
  tariffs: [],
  sources: [{ source: 'IRVE', id: 'irve:1', url: null }],
  free: null,
  ...over,
});

test('Front : utilitaires', () => {
  assert.equal(esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  assert.equal(esc(null), '');
  assert.equal(safeUrl('https://exemple.fr/a'), 'https://exemple.fr/a');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(fmtDist(0.25), '250 m');
  assert.equal(fmtDist(2.34), '2.3 km');
  assert.equal(fmtDist(42.6), '43 km');
  assert.equal(fmtKwhPrice({ min: 0.4, max: 0.4, extras: false }), '0,40 €/kWh');
  assert.equal(fmtKwhPrice({ min: 0.31, max: 0.49, extras: false }), 'dès 0,31 €/kWh');
  assert.equal(fmtKwhPrice({ min: 0.35, max: 0.35, extras: true }), 'dès 0,35 €/kWh');
  const d = distanceKm({ lat: 48.8566, lon: 2.3522 }, { lat: 45.764, lon: 4.8357 }); // Paris – Lyon
  assert.ok(d > 385 && d < 400, String(d));
});

test('Front : puissance limitée aux prises sélectionnées', () => {
  const s = station();
  assert.deepEqual(powerOf(s, ['chademo']), { kw: 50, estimated: true });
  assert.deepEqual(powerOf(s, ['chademo', 'ccs']), { kw: 150, estimated: false });
  assert.equal(powerOf(s, ['type2']), null);
});

test('Front : disponibilité', () => {
  assert.equal(statusOf(station()).label, null);
  assert.deepEqual(statusOf(station({ status: { known: 2, available: 1, outOfService: 0 } })), { cls: 'ok', label: '1 libre / 2' });
  assert.equal(statusOf(station({ status: { known: 2, available: 0, outOfService: 2 } })).cls, 'down');
  assert.equal(statusOf(station({ status: { known: 2, available: 0, outOfService: 1 } })).cls, 'busy');
  assert.equal(statusOf(station({ operational: false, status: { known: 1, available: 1, outOfService: 0 } })).cls, 'down');
});

test('Front : filtres', () => {
  const s = station({ free: true, tariffs: [{ source: 'OCM', text: '0,45 €/kWh' }] });
  assert.equal(passFilters(s, new Set(), ['chademo']), true);
  assert.equal(passFilters(s, new Set(['fast', 'free', 'priced']), ['chademo']), true);
  assert.equal(passFilters(s, new Set(['available']), ['chademo']), false);
  assert.equal(passFilters(station({ connectors: { chademo: { count: 1, maxKw: 22 } } }), new Set(['fast']), ['chademo']), false);
  for (const f of Object.values(FILTERS)) assert.equal(typeof f.label, 'string');
});

test('Front : gabarits échappés', () => {
  const view = { types: ['chademo'], labels: { chademo: 'CHAdeMO', ccs: 'CCS Combo 2' }, ref: { lat: 45.76, lon: 4.84 }, selectedId: 'irve:1' };
  const s = station({ sources: [{ source: 'OSM', id: 'osm:1', url: 'javascript:alert(1)' }], tariffs: [{ source: 'IRVE', text: '<script>' }] });
  const html = cardHtml(s, view);
  assert.ok(html.includes('Station &lt;b&gt;test&lt;/b&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.includes('1 × CHAdeMO · ≈ 50 kW'));
  assert.ok(html.includes('CCS Combo 2')); // listée dans « Autres prises »
  assert.ok(html.includes('class="card active"'));
  assert.ok(!html.includes('tag price'));
  const priced = cardHtml(station({ price: { min: 0.36, max: 0.59, extras: false, source: 'IRVE' } }), view);
  assert.ok(priced.includes('dès 0,36 €/kWh'));
  assert.match(pinHtml(s, ['chademo'], true), /class="pin sel"><span>50</);
  assert.match(pinTitle(s, ['chademo']), /^.+ · ≈ 50 kW/);
});

test('Front : tris', () => {
  const near = station({ id: 'near', lat: 45.761 });
  const cheap = station({ id: 'cheap', lat: 45.9, price: { min: 0.3, max: 0.3 } });
  const pricey = station({ id: 'pricey', lat: 45.77, price: { min: 0.6, max: 0.6 } });
  const free = station({ id: 'free', lat: 46.2, free: true });
  const slow = station({ id: 'slow', lat: 45.762, connectors: { chademo: { count: 1, maxKw: 22 } } });
  const ref = { lat: 45.76, lon: 4.84 };
  const distance = (s) => distanceKm(ref, s);
  const order = (key, list, types = ['chademo', 'ccs']) => [...list].sort((a, b) => SORTS[key].compare(a, b, distance, types)).map((s) => s.id);
  assert.equal(comparablePrice(free), 0);
  assert.equal(comparablePrice(near), null);
  assert.deepEqual(order('distance', [cheap, pricey, near]), ['near', 'pricey', 'cheap']);
  // gratuit, puis prix croissant, puis sans prix (le plus proche d'abord)
  assert.deepEqual(order('price', [near, pricey, cheap, free, slow]), ['free', 'cheap', 'pricey', 'near', 'slow']);
  assert.deepEqual(order('power', [slow, near]), ['near', 'slow']);
});

test('Front : liens de navigation selon l\'appareil', () => {
  const s = station({ name: 'Borne & Co' });
  const labels = (platform) => navLinks(s, platform).map((l) => l.label);
  assert.deepEqual(labels('other'), ['Itinéraire', 'Waze']);
  assert.deepEqual(labels('ios'), ['Itinéraire', 'Plans', 'Waze']);
  assert.deepEqual(labels('android'), ['Itinéraire', 'Waze', 'Autre appli']);
  assert.equal(navLinks(s, 'ios')[1].href, 'https://maps.apple.com/?daddr=45.76,4.84&dirflg=d');
  assert.equal(navLinks(s, 'android')[2].href, 'geo:45.76,4.84?q=45.76,4.84(Borne%20%26%20Co)');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 }), 'ios');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), 'ios'); // iPad récent
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), 'other');
  assert.equal(detectPlatform({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', maxTouchPoints: 5 }), 'android');
});

test('Front : vue partagée dans l\'adresse', () => {
  const hash = formatViewHash({ lat: 45.764043, lon: 4.835659, zoom: 14 }, ['chademo', 'ccs']);
  assert.equal(hash, '#14/45.7640/4.8357/chademo,ccs');
  assert.deepEqual(parseViewHash(hash), { view: { lat: 45.764, lon: 4.8357, zoom: 14 }, types: ['chademo', 'ccs'] });
  assert.deepEqual(parseViewHash('#6/47.2/-1.5'), { view: { lat: 47.2, lon: -1.5, zoom: 6 }, types: [] });
  for (const bad of ['', '#', '#abc', '#14/95/4', '#14/45/200', '#99/45/4', '#14/45', '#14/45/4/<script>']) assert.equal(parseViewHash(bad), null, bad);
});
