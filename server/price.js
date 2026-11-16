/**
 * Lit un prix au kWh dans les textes libres de tarif (IRVE et Open Charge Map).
 * On ne garde que les prix écrits explicitement au kWh : mieux vaut pas d'étiquette qu'une étiquette fausse.
 */

// « 0,45 €/kWh », « 0.4167€ par kwh », « 49cts/Kwh », « 0,39E/kWh », « 0,35 / Kwh », « 0,54 TTC / kWh »
const AMOUNT_THEN_KWH = /(\d+(?:[.,]\d+)?)\s*(€|euros?|eur|e|cts?|c€|centimes?|cents?)?\s*(ttc|ht)?\s*(?:\/|par|per|le|du)?\s*(?:au\s+)?kwh(?!\s*ht\b)/gi; // « kWh HT » (hors taxes) est écarté
// « €0.59/kWh »
const CURRENCY_THEN_KWH = /€\s*(\d+(?:[.,]\d+)?)\s*(?:\/|par|per)?\s*kwh/gi;
// Autres frais possibles : à la minute, à l'heure, à la session…
const EXTRA_FEES = /\/\s*(min|mn|h)\b|\b(minutes?|heures?|session|forfait|frais|connexion|lancement|abonnement)\b/i;

// Fourchette plausible pour un prix public au kWh, en euros
const MIN_KWH = 0.05;
const MAX_KWH = 1.5;

const toNumber = (s) => Number(s.replace(',', '.'));

/**
 * Prix au kWh TTC trouvés dans le texte : { min, max, extras }, ou null.
 * min et max diffèrent s'il y a plusieurs prix (heures creuses, AC/DC…) ; extras signale d'autres frais.
 */
export function parseKwhPrice(text) {
  if (!text) return null;
  const values = [];
  for (const [, amount, unit, tax] of text.matchAll(AMOUNT_THEN_KWH)) {
    if (/^ht$/i.test(tax || '')) continue; // hors taxes : ce n'est pas ce que paie le client
    let v = toNumber(amount);
    if (/^(cts?|c€|centimes?|cents?)$/i.test(unit || '')) v /= 100;
    else if (!unit && !/[.,]/.test(amount)) continue; // « 22 kWh » est une quantité d'énergie, pas un prix
    values.push(v);
  }
  for (const [, amount] of text.matchAll(CURRENCY_THEN_KWH)) values.push(toNumber(amount));
  const valid = values.filter((v) => v >= MIN_KWH && v <= MAX_KWH).map((v) => Math.round(v * 100) / 100);
  if (!valid.length) return null;
  return { min: Math.min(...valid), max: Math.max(...valid), extras: EXTRA_FEES.test(text) };
}
