// Toute la configuration passe par des variables d'environnement, détaillées dans le README.
const env = process.env;

const num = (v, def) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : def);

const DEFAULT_MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const DEFAULT_MAP_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

// Style vectoriel. Vide si MAP_STYLE_URL=none, ou si seul TILE_URL est fourni : on veut alors ces tuiles-là.
function mapStyleUrl() {
  if (env.MAP_STYLE_URL === 'none') return '';
  return env.MAP_STYLE_URL || (env.TILE_URL ? '' : DEFAULT_MAP_STYLE);
}

// Style du mode sombre. On n'en impose un par défaut que si le style clair est lui aussi celui par défaut.
function mapStyleDarkUrl(light) {
  if (!light || env.MAP_STYLE_DARK_URL === 'none') return '';
  return env.MAP_STYLE_DARK_URL || (light === DEFAULT_MAP_STYLE ? DEFAULT_MAP_STYLE_DARK : '');
}

export const config = {
  port: num(env.PORT, 8080),
  dataDir: env.DATA_DIR || './data',
  userAgent: env.USER_AGENT || 'recharge-map/1.1 (usage personnel)',

  irve: {
    enabled: env.IRVE_ENABLED !== 'false',
    // Base nationale consolidée par transport.data.gouv.fr, republiée chaque nuit
    staticUrl: env.IRVE_STATIC_URL || 'https://transport.data.gouv.fr/resources/84013/download',
    // État et occupation des points de charge, presque en temps réel
    dynamicUrl: env.IRVE_DYNAMIC_URL || 'https://transport.data.gouv.fr/resources/84098/download',
    staticRefreshHours: num(env.IRVE_STATIC_REFRESH_HOURS, 24),
    dynamicRefreshMinutes: num(env.IRVE_DYNAMIC_REFRESH_MINUTES, 10),
    // Fichier tarifs du schéma IRVE v3, pas encore publié au niveau national (vide = ignoré).
    // Relu en même temps que les données dynamiques.
    tariffsUrl: env.IRVE_TARIFFS_URL || '',
  },

  ocm: {
    // Open Charge Map : clé gratuite sur https://openchargemap.org/site/develop/api
    apiKey: env.OCM_API_KEY || '',
    baseUrl: env.OCM_URL || 'https://api.openchargemap.io/v3/poi/',
    maxResults: num(env.OCM_MAX_RESULTS, 1000),
  },

  osm: {
    enabled: env.OSM_ENABLED !== 'false',
    // Les serveurs publics tombent souvent : on les essaie l'un après l'autre
    overpassUrls: (env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean),
    // Temps laissé à chaque serveur avant de passer au suivant
    timeoutMs: num(env.OVERPASS_TIMEOUT_MS, 10000),
    // Quand tous ont échoué, on les laisse tranquilles un moment
    retryPauseMs: num(env.OVERPASS_RETRY_PAUSE_S, 120) * 1000,
  },

  geocode: {
    geoplateformeUrl: env.GEOPF_URL || 'https://data.geopf.fr/geocodage/search',
    photonUrl: env.PHOTON_URL || 'https://photon.komoot.io/api/',
  },

  // Fond de carte : vectoriel OpenFreeMap par défaut (gratuit, sans clé). Les tuiles image servent
  // de secours, ou de fond principal si TILE_URL est donné seul.
  tiles: {
    styleUrl: mapStyleUrl(),
    styleUrlDark: mapStyleDarkUrl(mapStyleUrl()),
    url: env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: env.TILE_ATTRIBUTION || '© <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
    maxZoom: num(env.TILE_MAX_ZOOM, 19),
    subdomains: env.TILE_SUBDOMAINS || 'abc',
  },

  // Durée de cache des réponses OCM et Overpass, par zone
  liveCacheMinutes: num(env.LIVE_CACHE_MINUTES, 15),
  // Au-delà, on répond sans la source en retard ; sa réponse servira au chargement suivant
  liveWaitMs: num(env.LIVE_WAIT_MS, 3000),
  // Plus grande zone qu'on accepte de charger, en degrés de latitude
  maxBboxSpanDeg: num(env.MAX_BBOX_SPAN_DEG, 2.5),
  // Deux stations de sources différentes plus proches que ça sont considérées comme la même
  mergeDistanceMeters: num(env.MERGE_DISTANCE_M, 60),
  requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 20000),

  // Requêtes API par minute et par IP (0 = illimité)
  rateLimitPerMinute: num(env.RATE_LIMIT_PER_MIN, 300),
  // La recherche d'adresse appelle deux services à chaque fois, d'où une limite à part
  geocodeLimitPerMinute: num(env.GEOCODE_LIMIT_PER_MIN, 60),
  // Plafond d'appels vers chaque source live, tous visiteurs confondus. Sans lui, quelqu'un qui balaie
  // des zones au hasard pourrait épuiser la clé OCM ou faire bannir l'IP du serveur.
  liveMaxPerMinute: num(env.LIVE_MAX_PER_MIN, 60),
  // Adresse publique du site, sans / final (ex. https://recharge.exemple.fr). Elle sert pour l'URL canonique,
  // le sitemap et les aperçus de partage ; à défaut, on reprend l'adresse demandée par le visiteur.
  siteUrl: (env.SITE_URL || '').replace(/\/+$/, ''),
  // Derrière un reverse proxy : l'IP du visiteur est alors lue dans X-Forwarded-For
  trustProxy: env.TRUST_PROXY === 'true',
};
