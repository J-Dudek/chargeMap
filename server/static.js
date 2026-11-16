/**
 * Sert les fichiers de public/ : cache par ETag, compression, et rien en dehors de ce dossier.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendBody, sendJson, siteUrl } from './http.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// Seules ces extensions sont servies. Le booléen dit si la compression vaut le coup.
const TYPES = {
  '.html': ['text/html; charset=utf-8', true],
  '.js': ['text/javascript; charset=utf-8', true],
  '.css': ['text/css; charset=utf-8', true],
  '.svg': ['image/svg+xml', true],
  '.json': ['application/json', true],
  '.webmanifest': ['application/manifest+json', true],
  '.png': ['image/png', false],
  '.ico': ['image/x-icon', false],
  '.woff2': ['font/woff2', false],
};

/** Date de modification de la page d'accueil, pour le sitemap. */
export async function homeLastModified() {
  return (await fs.stat(path.join(PUBLIC_DIR, 'index.html'))).mtime.toISOString().slice(0, 10);
}

export async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(req, res, 400, { error: 'Requête invalide' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC_DIR, rel);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (rel.includes('\0') || !file.startsWith(PUBLIC_DIR + path.sep) || !type) return sendJson(req, res, 404, { error: 'Introuvable' });
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('pas un fichier');
    // Les pages HTML contiennent %SITE_URL%, remplacé par l'adresse du site
    const site = path.extname(file) === '.html' ? siteUrl(req) : null;
    const etag = `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}${site === null ? '' : `-${site.length.toString(36)}${site.slice(-12).replace(/[^a-z0-9]/gi, '')}`}"`;
    // Polices, bibliothèques et icônes bougent rarement : on les garde une semaine. Le reste est revalidé à chaque visite.
    const longLived = /^\/(fonts|vendor|icons)\//.test(rel);
    const headers = { 'Content-Type': type[0], 'Cache-Control': longLived ? 'public, max-age=604800' : 'no-cache', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    let body = await fs.readFile(file);
    if (site !== null) body = body.toString('utf8').replaceAll('%SITE_URL%', site);
    await sendBody(req, res, 200, headers, body, { compress: type[1] });
  } catch {
    sendJson(req, res, 404, { error: 'Introuvable' });
  }
}
