/**
 * Briques HTTP partagées : en-têtes de sécurité, réponses compressées, limite de débit.
 */
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { config } from './config.js';

const gzip = promisify(zlib.gzip);
const MIN_COMPRESS_BYTES = 1024;

/** Origine d'une URL, pour la CSP. Le {s} des tuiles Leaflet devient un joker ; vide si l'URL est invalide. */
export const origin = (url) => {
  try {
    return new URL(String(url).replace('{s}', '*')).origin;
  } catch {
    return '';
  }
};
const origins = (...urls) => [...new Set(urls.map(origin).filter(Boolean))].join(' ');

// Tout ce que la page exécute vient du site lui-même. Seul le fond de carte est chargé ailleurs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  // Images : le site et le serveur de tuiles, rien d'autre, pour ne rien laisser fuiter vers un tiers
  `img-src 'self' data: blob: ${origins(config.tiles.url)}`.trim(),
  // MapLibre va chercher style, tuiles et polices de carte chez le fournisseur du fond vectoriel
  `connect-src 'self' ${origins(config.tiles.styleUrl, config.tiles.styleUrlDark)}`.trim(),
  "manifest-src 'self'",
  "worker-src 'self' blob:", // notre service worker, et le worker (blob) où MapLibre dessine
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // les tuiles OpenStreetMap refusent les requêtes sans Referer
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // on n'a besoin que de la géolocalisation
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // HSTS seulement si on sait que le site public est en https (SITE_URL), sinon on pourrait le rendre injoignable
  ...(config.siteUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};

const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

/** Envoie la réponse, compressée si le client sait la lire et si le corps en vaut la peine. */
export async function sendBody(req, res, status, headers, body, { compress = true } = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { ...headers, Vary: 'Accept-Encoding' };
  if (compress && buf.length >= MIN_COMPRESS_BYTES && acceptsGzip(req)) {
    buf = await gzip(buf);
    h['Content-Encoding'] = 'gzip';
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

export function sendJson(req, res, status, body, extraHeaders = {}) {
  return sendBody(req, res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders }, JSON.stringify(body));
}

/**
 * IP du visiteur. Derrière notre reverse proxy, c'est la dernière adresse de X-Forwarded-For : c'est
 * le proxy qui l'ajoute, alors que les précédentes viennent du visiteur et peuvent être inventées.
 * Ça ne tient que si l'app n'est joignable que par le proxy.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const last = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
    if (last) return last;
  }
  return req.socket.remoteAddress || 'inconnu';
}

/** En IPv6, chaque abonné dispose de milliards d'adresses : on compte donc par bloc /64. */
export function rateKey(ip) {
  const v = String(ip).slice(0, 64).toLowerCase();
  if (!v.includes(':') || v.startsWith('::ffff:')) return v;
  const [head, tail = ''] = v.split('::');
  const groups = head.split(':').filter(Boolean);
  if (v.includes('::')) groups.push(...Array(Math.max(0, 8 - groups.length - tail.split(':').filter(Boolean).length)).fill('0'));
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/** Adresse publique du site : SITE_URL, ou à défaut l'hôte demandé, s'il a une forme valide. */
export function siteUrl(req) {
  if (config.siteUrl) return config.siteUrl;
  const host = String(req.headers.host || '');
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return '';
  const forwarded = config.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

// Garde-fou mémoire : au-delà, les nouveaux venus sont refusés jusqu'à la fenêtre suivante
const MAX_TRACKED_KEYS = 50_000;

/** Limite de débit toute simple, en mémoire : N requêtes par minute et par clé. */
export class RateLimiter {
  constructor(max, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => this.purge(), windowMs).unref();
  }
  /** 0 si la requête passe, sinon le nombre de secondes à patienter. */
  check(key) {
    if (!this.max) return 0;
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now >= e.reset) {
      if (!e && this.hits.size >= MAX_TRACKED_KEYS) return Math.ceil(this.windowMs / 1000);
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count > this.max ? Math.ceil((e.reset - now) / 1000) : 0;
  }
  purge() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (now >= e.reset) this.hits.delete(k);
  }
}
