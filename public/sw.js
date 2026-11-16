/**
 * Service worker : rend le site installable et lui permet de s'ouvrir hors connexion.
 * Réseau d'abord : en ligne on sert toujours la dernière version, le cache n'est qu'un secours.
 * Les bornes, les recherches et le fond de carte ne sont jamais mis en cache.
 */
const CACHE = 'recharge-map-v1';

// L'essentiel de l'interface, mis en cache dès l'installation
const SHELL = [
  './',
  'style.css',
  'manifest.webmanifest',
  'icon.svg',
  'icons/icon-192.png',
  'js/main.js',
  'js/theme.js',
  'js/dom.js',
  'js/stations.js',
  'js/templates.js',
  'js/util.js',
  'fonts/inter-latin.woff2',
  'fonts/space-grotesk-latin.woff2',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/leaflet.markercluster.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  // on supprime les caches des anciennes versions (changer CACHE pour tout repartir de zéro)
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = (await cache.match(request)) || (request.mode === 'navigate' && (await cache.match('./')));
    if (cached) return cached;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return; // tuiles et autres sites : on laisse faire le navigateur
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/config') return; // les données doivent rester fraîches
  event.respondWith(networkFirst(request));
});
