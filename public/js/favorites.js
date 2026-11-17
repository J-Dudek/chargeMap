/**
 * Bornes favorites, gardées sur l'appareil (pas de compte) : une copie de chaque fiche, pour pouvoir
 * les afficher même loin de la zone chargée. La disponibilité n'est jamais enregistrée : elle vieillit
 * trop vite, on la redemande au serveur à chaque ouverture de la liste.
 */
import { store } from './dom.js';

const KEY = 'favorites';
export const MAX_FAVORITES = 50; // même limite que le serveur

let list = store.get(KEY, []).filter((s) => s && typeof s.id === 'string' && Number.isFinite(s.lat) && Number.isFinite(s.lon));
const fresh = new Map(); // id → fiche à jour reçue du serveur pendant cette visite

const save = () => store.set(KEY, list);

export const favoriteCount = () => list.length;
export const isFavorite = (id) => list.some((s) => s.id === id);

/** Les favoris, avec les données les plus récentes connues. */
export const favorites = () => list.map((s) => fresh.get(s.id) ?? s);

/** Ajoute ou retire une borne ; renvoie vrai si elle est désormais en favori. */
export function toggleFavorite(station) {
  if (isFavorite(station.id)) {
    list = list.filter((s) => s.id !== station.id);
    fresh.delete(station.id);
    save();
    return false;
  }
  if (list.length >= MAX_FAVORITES) throw new Error(`${MAX_FAVORITES} favoris au maximum`);
  list.push({ ...station, status: null });
  save();
  return true;
}

/** Identifiants dont le serveur peut donner la disponibilité (base IRVE). */
export const liveIds = () => list.map((s) => s.id).filter((id) => id.startsWith('irve:'));

/** Range les fiches à jour reçues du serveur ; la copie enregistrée est rafraîchie au passage, sans la disponibilité. */
export function updateFavorites(stations) {
  for (const s of stations) {
    const i = list.findIndex((f) => f.id === s.id);
    if (i < 0) continue;
    fresh.set(s.id, s);
    list[i] = { ...s, status: null };
  }
  save();
}
