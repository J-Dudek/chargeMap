/**
 * Gabarits HTML, en simples chaînes. Tout ce qui vient du serveur passe par esc().
 * view regroupe ce qui dépend de l'écran : { types, labels, ref, selectedId, platform, isFavorite }.
 */
import { powerOf, statusOf } from './stations.js';
import { distanceKm, esc, fmtDist, fmtKwhPrice, safeUrl } from './util.js';

const kwLabel = (kw, estimated) => `${estimated ? '≈ ' : ''}${Math.round(kw)} kW`;

/** Infobulle du repère, aussi lue par les lecteurs d'écran : sa couleur seule ne suffit pas. */
export function pinTitle(station, types) {
  const p = powerOf(station, types);
  return [station.name, p ? kwLabel(p.kw, p.estimated) : null, statusOf(station).label].filter(Boolean).join(' · ');
}

export function pinHtml(station, types, selected) {
  const p = powerOf(station, types);
  const classes = ['pin', statusOf(station).cls, selected ? 'sel' : ''].filter(Boolean).join(' ');
  return `<div class="${classes}"><span>${p ? Math.round(p.kw) : '?'}</span></div>`;
}

function tariffHtml(station) {
  const lines = station.tariffs
    .map((t) => {
      const parts = [];
      if (t.text) parts.push(esc(t.text));
      else if (t.free === true) parts.push('Gratuit');
      else if (t.free === false) parts.push('Payant (montant non communiqué)');
      if (t.payCard === true) parts.push(`<span class="muted">${parts.length ? '· ' : ''}CB acceptée</span>`);
      return parts.length ? `<p><span class="src">${esc(t.source)}</span>${parts.join(' ')}</p>` : '';
    })
    .join('');
  return lines || '<p class="muted">Tarif non communiqué</p>';
}

function sourcesHtml(station) {
  return station.sources
    .map((x) => {
      const url = safeUrl(x.url);
      return url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(x.source)}</a>` : esc(x.source);
    })
    .join(', ');
}

/**
 * Liens de navigation. Google Maps et Waze ouvrent leur application quand elle est installée.
 * On ajoute Plans sur iPhone, et sur Android un lien geo: qui laisse choisir l'application.
 */
export function navLinks(station, platform) {
  const dest = `${Number(station.lat)},${Number(station.lon)}`;
  const links = [
    { label: 'Itinéraire', href: `https://www.google.com/maps/dir/?api=1&destination=${dest}`, external: true },
    { label: 'Waze', href: `https://waze.com/ul?ll=${dest}&navigate=yes`, external: true },
  ];
  if (platform === 'ios') links.splice(1, 0, { label: 'Plans', href: `https://maps.apple.com/?daddr=${dest}&dirflg=d`, external: true });
  if (platform === 'android') links.push({ label: 'Autre appli', href: `geo:${dest}?q=${dest}(${encodeURIComponent(station.name || 'Borne')})`, external: false });
  return links;
}

/** Étoile des favoris ; son libellé dit ce que fera le clic. */
export function favButton(fav) {
  const label = fav ? 'Retirer des favoris' : 'Ajouter aux favoris';
  return `<button type="button" class="fav-btn" aria-pressed="${fav}" aria-label="${label}" title="${label}">${fav ? '★' : '☆'}</button>`;
}

export function cardHtml(station, view) {
  const s = station;
  const { types, labels } = view;
  const selected = s.id === view.selectedId;
  const fav = !!view.isFavorite?.(s.id);
  const st = statusOf(s);
  const p = powerOf(s, types);
  const plugTags = types
    .filter((t) => s.connectors[t])
    .map((t) => {
      const c = s.connectors[t];
      return `<span class="tag plug">${c.count} × ${esc(labels[t])}${c.maxKw ? ` · ${kwLabel(c.maxKw, c.estimated)}` : ''}</span>`;
    });
  const tags = [
    p ? `<span class="tag kw">${kwLabel(p.kw, p.estimated)}</span>` : '',
    ...plugTags,
    st.label ? `<span class="tag ${st.cls}">${esc(st.label)}</span>` : '',
    s.free === true ? '<span class="tag free">Gratuit</span>' : '',
    s.price && s.free !== true ? `<span class="tag price" title="Prix lu dans le tarif ${esc(s.price.source)}, à vérifier sur place">${fmtKwhPrice(s.price)}</span>` : '',
  ].join('');
  const others = Object.keys(s.connectors).filter((t) => !types.includes(t) && labels[t]);
  // [libellé, valeur déjà échappée]
  const rows = [
    ['Autres prises', esc(others.map((t) => labels[t]).join(', '))],
    ['Opérateur', esc(s.operator)],
    ['Réseau', s.network !== s.operator ? esc(s.network) : ''],
    ['Accès', esc(s.access)],
    ['Horaires', esc(s.hours)],
    ['Dispo maj', s.status?.updatedAt ? esc(new Date(s.status.updatedAt).toLocaleString('fr-FR')) : ''],
    ['Sources', sourcesHtml(s)],
  ].filter(([, v]) => v);
  const actions = navLinks(s, view.platform)
    .map((l, i) => `<a${i ? ' class="secondary"' : ''} href="${esc(l.href)}"${l.external ? ' target="_blank" rel="noopener"' : ''}>${l.label}</a>`)
    .join('');
  return `
    <li class="card${selected ? ' active' : ''}" data-id="${esc(s.id)}">
      <div class="card-top">
        <h2><button type="button" class="card-title" aria-expanded="${selected}">${esc(s.name)}</button></h2>
        <span class="dist">${fmtDist(distanceKm(view.ref, s))}</span>
        ${favButton(fav)}
      </div>
      <div class="meta">${esc(s.address)}</div>
      <div class="tags">${tags}</div>
      <div class="tariff">${tariffHtml(s)}</div>
      <div class="details">
        <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        <div class="actions">${actions}</div>
      </div>
    </li>`;
}
