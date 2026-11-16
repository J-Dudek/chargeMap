/**
 * Types de prise gérés, et la façon dont chaque source les nomme.
 * Pour en ajouter un, une entrée ici suffit : le front construit ses boutons à partir de /api/config.
 */
export const CONNECTORS = {
  chademo: {
    label: 'CHAdeMO',
    irve: 'prise_type_chademo',
    irveDynamic: 'etat_prise_type_chademo',
    osm: ['chademo'],
    ocmIds: [2],
    ocmTitle: /chademo/i,
  },
  ccs: {
    label: 'CCS Combo 2',
    irve: 'prise_type_combo_ccs',
    irveDynamic: 'etat_prise_type_combo_ccs',
    osm: ['type2_combo'],
    ocmIds: [33],
    ocmTitle: /ccs|combo/i,
  },
  type2: {
    label: 'Type 2',
    irve: 'prise_type_2',
    irveDynamic: 'etat_prise_type_2',
    osm: ['type2', 'type2_cable'],
    ocmIds: [25, 1036],
    ocmTitle: /type ?2|mennekes/i, // doit passer après ccs : OCM écrit « CCS (Type 2) »
  },
  ef: {
    label: 'Prise E/F',
    irve: 'prise_type_ef',
    irveDynamic: 'etat_prise_type_ef',
    osm: ['typee', 'schuko'],
    ocmIds: null, // pas d'identifiant OCM fiable, on se fie au libellé
    ocmTitle: /type ?e\b|type ?f\b|schuko|cee ?7/i,
  },
};

export const CONNECTOR_TYPES = Object.keys(CONNECTORS);
export const DEFAULT_TYPES = ['chademo'];

/** Lit le paramètre types, par exemple "chademo,ccs". Les valeurs inconnues sont ignorées. */
export function parseTypes(v) {
  if (!v) return DEFAULT_TYPES;
  const out = [...new Set(String(v).split(',').map((s) => s.trim().toLowerCase()))].filter((t) => Object.hasOwn(CONNECTORS, t));
  return out.length ? out.sort() : DEFAULT_TYPES;
}

/** Ajoute des prises au résumé d'une station, en gardant la puissance la plus haute. */
export function addConnector(connectors, type, count = 1, kw = null, estimated = false) {
  const c = (connectors[type] ||= { count: 0, maxKw: null, estimated: false });
  c.count += count;
  if (kw && (!c.maxKw || kw > c.maxKw)) {
    c.maxKw = kw;
    c.estimated = estimated;
  }
}

export const hasAnyType = (station, types) => types.some((t) => station.connectors[t]?.count > 0);
