/**
 * Serveur HTTP : l'API, les fichiers du site, le démarrage et l'arrêt.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { CONNECTORS, DEFAULT_TYPES, parseTypes } from './connectors.js';
import { geocode } from './geocode.js';
import { clientIp, rateKey, RateLimiter, SECURITY_HEADERS, sendBody, sendJson, siteUrl } from './http.js';
import { irveStatus, startIrve } from './sources/irve.js';
import { homeLastModified, serveStatic } from './static.js';
import { getStations, liveErrors } from './stations.js';
import { TtlCache } from './util.js';

const MAX_QUERY_LENGTH = 200;
const LON_SPAN_FACTOR = 1.6; // un écran est plus large que haut
const geoCache = new TtlCache(24 * 3600 * 1000, 500);
const limiter = new RateLimiter(config.rateLimitPerMinute);
const geocodeLimiter = new RateLimiter(config.geocodeLimitPerMinute);

function parseBbox(sp) {
  const b = Object.fromEntries(['south', 'west', 'north', 'east'].map((k) => [k, Number(sp.get(k) ?? NaN)]));
  if (Object.values(b).some((v) => !Number.isFinite(v))) return { error: 'Paramètres south, west, north, east requis' };
  if (b.south > b.north || b.west > b.east) return { error: 'Emprise invalide' };
  if (b.north - b.south > config.maxBboxSpanDeg || b.east - b.west > config.maxBboxSpanDeg * LON_SPAN_FACTOR) return { error: 'Zone trop grande : zoomez davantage', tooLarge: true };
  return { bbox: b };
}

/** Routes de l'API. Chacune renvoie [statut, corps JSON]. */
const API = {
  '/api/stations': async (sp) => {
    const { bbox, error, tooLarge } = parseBbox(sp);
    if (error) return [400, { error, tooLarge: !!tooLarge }];
    return [200, await getStations(bbox, parseTypes(sp.get('types')))];
  },

  '/api/geocode': async (sp) => {
    const q = (sp.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH);
    if (q.length < 3) return [200, { results: [] }];
    // centre de la carte, arrondi au degré : assez pour départager les homonymes, et le cache reste efficace
    const lat = Math.round(Number(sp.get('lat')));
    const lon = Math.round(Number(sp.get('lon')));
    const near = Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && sp.has('lat') && sp.has('lon') ? { lat, lon } : null;
    const key = `${q.toLowerCase()}|${near ? `${lat},${lon}` : ''}`;
    let results = geoCache.get(key);
    if (!results) {
      let complete;
      try {
        ({ results, complete } = await geocode(q, { near }));
      } catch (e) {
        return [502, { error: e.message }];
      }
      if (complete) geoCache.set(key, results);
    }
    return [200, { results }];
  },

  // Ce que le front lit au démarrage : fond de carte et types de prise
  '/api/config': () => [
    200,
    {
      tiles: config.tiles,
      connectors: Object.entries(CONNECTORS).map(([id, c]) => ({ id, label: c.label })),
      defaultTypes: DEFAULT_TYPES,
      // le front s'en sert pour ne pas demander une zone que l'API refuserait
      maxSpan: { lat: config.maxBboxSpanDeg, lon: config.maxBboxSpanDeg * LON_SPAN_FACTOR },
    },
  ],

  '/api/connectors': () => [200, Object.fromEntries(Object.entries(CONNECTORS).map(([k, v]) => [k, v.label]))],

  '/api/status': () => {
    const errors = liveErrors();
    return [
      200,
      {
        irve: irveStatus(),
        ocm: { enabled: !!config.ocm.apiKey, lastError: errors.OCM },
        osm: { enabled: config.osm.enabled, lastError: errors.OSM },
      },
    ];
  },
};

/** robots.txt et sitemap.xml contiennent l'adresse du site, on les génère donc à la volée. */
const SEO_FILES = {
  // on laisse /api ouvert : sans lui, les moteurs verraient une carte vide
  '/robots.txt': (site) => ['text/plain; charset=utf-8', `User-agent: *\nAllow: /\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ''}`],
  '/sitemap.xml': async (site) => [
    'application/xml; charset=utf-8',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}/</loc><lastmod>${await homeLastModified()}</lastmod></url>\n</urlset>\n`,
  ],
};

async function handle(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'Méthode non autorisée' }, { Allow: 'GET, HEAD' });

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(req, res, 400, { error: 'Requête invalide' });
  }

  const seoFile = SEO_FILES[url.pathname];
  if (seoFile) {
    const [type, body] = await seoFile(siteUrl(req));
    // Sans SITE_URL, l'adresse vient de l'en-tête Host : on interdit le cache pour qu'aucun cache partagé ne la garde
    return sendBody(req, res, 200, { 'Content-Type': type, 'Cache-Control': config.siteUrl ? 'public, max-age=3600' : 'no-store' }, body);
  }

  const route = API[url.pathname];
  if (!route) {
    if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Introuvable' });
    return serveStatic(req, res, url.pathname);
  }
  // /api/status sert au healthcheck Docker, on ne le limite pas
  const ip = rateKey(clientIp(req));
  const wait = url.pathname === '/api/status' ? 0 : limiter.check(ip) || (url.pathname === '/api/geocode' ? geocodeLimiter.check(ip) : 0);
  if (wait) return sendJson(req, res, 429, { error: 'Trop de requêtes, réessayez dans un instant' }, { 'Retry-After': String(wait) });
  const [status, body] = await route(url.searchParams);
  return sendJson(req, res, status, body);
}

export const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`[HTTP] ${req.method} ${req.url} :`, e);
    if (res.headersSent) return res.destroy();
    sendJson(req, res, 500, { error: 'Erreur interne' }).catch(() => res.destroy());
  });
});

// On coupe vite les connexions lentes ou abandonnées. Le reverse proxy filtre déjà, c'est une sécurité de plus.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 10_000;
server.maxRequestsPerSocket = 1000;

function shutdown(signal) {
  console.log(`${signal} reçu : arrêt du serveur`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startIrve();
  server.listen(config.port, () => {
    console.log(`Recharge Map sur http://localhost:${config.port}`);
    if (!config.ocm.apiKey) console.log('ℹ OCM_API_KEY non définie : source Open Charge Map désactivée');
  });
  if (config.trustProxy && !config.siteUrl) console.log('⚠ SITE_URL non définie : à renseigner en production (adresse canonique fiable, HSTS)');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown(signal));
  // Une promesse rejetée qu'on aurait oubliée ne doit pas faire tomber le service
  process.on('unhandledRejection', (e) => console.error('[Erreur non gérée]', e));
}
