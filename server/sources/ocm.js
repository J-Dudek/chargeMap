/**
 * Source Open Charge Map (openchargemap.org), interrogée en direct pour la zone affichée.
 * Il faut une clé API, gratuite : https://openchargemap.org/site/develop/api
 */
import { config } from '../config.js';
import { CONNECTORS, CONNECTOR_TYPES, addConnector, hasAnyType } from '../connectors.js';
import { clean, httpFetch } from '../util.js';

/** Type de prise d'une connexion OCM : d'après le libellé, plus fiable, sinon d'après l'identifiant. */
export function ocmConnectorType(c) {
  const title = c.ConnectionType?.Title || '';
  if (title) {
    const byTitle = CONNECTOR_TYPES.find((t) => CONNECTORS[t].ocmTitle.test(title));
    if (byTitle) return byTitle;
  }
  return CONNECTOR_TYPES.find((t) => CONNECTORS[t].ocmIds?.includes(c.ConnectionTypeID)) || null;
}

export function normalizeOcm(poi) {
  const a = poi.AddressInfo || {};
  if (typeof a.Latitude !== 'number' || typeof a.Longitude !== 'number') return null;
  const connectors = {};
  for (const c of poi.Connections || []) {
    const t = ocmConnectorType(c);
    if (t) addConnector(connectors, t, c.Quantity || 1, c.PowerKW || null);
  }
  if (!Object.keys(connectors).length) return null;
  const usage = poi.UsageType || {};
  const cost = clean(poi.UsageCost);
  const isFree = cost ? /^(free|gratuit|gratis|0([.,]0+)?\s*€?)$/i.test(cost.trim()) : null;
  const status = poi.StatusType;
  return {
    id: `ocm:${poi.ID}`,
    source: 'OCM',
    name: clean(a.Title) || 'Station de recharge',
    lat: a.Latitude,
    lon: a.Longitude,
    address: [clean(a.AddressLine1), clean(a.Postcode), clean(a.Town)].filter(Boolean).join(', ') || null,
    country: a.Country?.ISOCode || null,
    operator: clean(poi.OperatorInfo?.Title),
    network: null,
    connectors,
    tariff: { free: isFree, text: cost, payCard: usage.IsPayAtLocation ?? null, payAdHoc: usage.IsPayAtLocation ?? null },
    access: clean(usage.Title),
    hours: null,
    operational: status ? status.IsOperational : null,
    updatedAt: clean(poi.DateLastStatusUpdate) || clean(poi.DateLastVerified),
    url: `https://openchargemap.org/site/poi/details/${poi.ID}`,
  };
}

export async function queryOcm(bbox, types) {
  if (!config.ocm.apiKey) return [];
  const params = new URLSearchParams({
    output: 'json',
    boundingbox: `(${bbox.north},${bbox.west}),(${bbox.south},${bbox.east})`,
    maxresults: String(config.ocm.maxResults),
    compact: 'false',
    verbose: 'false',
  });
  // OCM ne peut filtrer par identifiant que si tous les types demandés en ont un
  if (types.every((t) => CONNECTORS[t].ocmIds)) params.set('connectiontypeid', types.flatMap((t) => CONNECTORS[t].ocmIds).join(','));
  const res = await httpFetch(`${config.ocm.baseUrl}?${params}`, { headers: { 'X-API-Key': config.ocm.apiKey } });
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(normalizeOcm).filter((s) => s && hasAnyType(s, types));
}
