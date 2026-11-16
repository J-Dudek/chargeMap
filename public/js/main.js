/**
 * Point d'entrée du front : la carte, le chargement des bornes, la liste, la recherche, la géolocalisation.
 * Les règles d'affichage sont dans stations.js, le HTML dans templates.js.
 */
import { $, detectPlatform, getJson, loadScript, loadStylesheet, store, toast } from './dom.js';
import { FILTERS, passFilters, SORTS } from './stations.js';
import { cardHtml, pinHtml, pinTitle } from './templates.js';
import { distanceKm, esc, formatViewHash, parseViewHash } from './util.js';

const L = window.L; // Leaflet, chargé par index.html
const MIN_ZOOM = 9; // en dessous, la zone est trop grande pour charger les bornes
const DEFAULT_VIEW = { lat: 47.2, lon: 2.5, zoom: 6 }; // vue de départ, avant toute recherche
const MAX_CARDS = 150; // au-delà, la liste s'arrête ; la carte, elle, montre tout
const MOVE_DEBOUNCE_MS = 350;
// Tant qu'on reste dans la zone déjà chargée, inutile de rappeler le serveur, sauf si les données ont vieilli
const FRESH_MS = 3 * 60 * 1000;
// En vue rapprochée, on charge un peu plus large que l'écran pour encaisser les petits déplacements
const PAD_FROM_ZOOM = 12;
const PAD_RATIO = 0.25;
// Quand une source est lente, on redemande un peu plus tard, quelques fois seulement
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 2;
const SEARCH_DEBOUNCE_MS = 280;
// Fond vectoriel pas prêt dans ce délai : on passe aux tuiles image
const VECTOR_TIMEOUT_MS = 8000;
const isMobile = () => window.matchMedia('(max-width: 800px)').matches;
const platform = detectPlatform();

function hasWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Noms de lieux en français quand ils existent (Bruxelles, Londres), sinon dans la langue locale. */
function frenchLabels(gl) {
  for (const layer of gl.getStyle().layers) {
    if (layer.type !== 'symbol' || !JSON.stringify(layer.layout?.['text-field'] ?? '').includes('name')) continue;
    gl.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:fr'], ['get', 'name:latin'], ['get', 'name']]);
  }
}

/**
 * Fond de carte vectoriel (MapLibre, chargé seulement si besoin) quand l'appareil sait l'afficher,
 * sinon, ou en cas de problème, tuiles image classiques.
 */
async function addBaseLayer(map, tiles) {
  const raster = () => L.tileLayer(tiles.url, { maxZoom: tiles.maxZoom, subdomains: tiles.subdomains, attribution: tiles.attribution }).addTo(map);
  if (!tiles.styleUrl || !hasWebGL()) return raster();
  // Suit le thème de la page (js/theme.js), y compris quand on le change en cours de route
  const styleFor = () => (document.documentElement.dataset.theme === 'dark' && tiles.styleUrlDark) || tiles.styleUrl;
  let layer;
  try {
    loadStylesheet('vendor/maplibre/maplibre-gl.css');
    await loadScript('vendor/maplibre/maplibre-gl.js');
    await loadScript('vendor/maplibre/leaflet-maplibre-gl.js');
    let current = styleFor();
    layer = L.maplibreGL({ style: current }).addTo(map);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fond vectoriel trop lent')), VECTOR_TIMEOUT_MS);
      const gl = layer.getMaplibreMap();
      gl.once('load', () => {
        clearTimeout(timer);
        frenchLabels(gl);
        resolve();
      });
    });
    if (tiles.styleUrlDark) {
      const gl = layer.getMaplibreMap();
      const follow = () => {
        if (styleFor() === current) return;
        current = styleFor();
        gl.once('style.load', () => frenchLabels(gl));
        gl.setStyle(current);
      };
      document.addEventListener('themechange', follow);
      follow(); // thème changé pendant que le fond se chargeait
    }
  } catch (e) {
    console.warn('Fond vectoriel indisponible, retour aux tuiles image :', e.message);
    if (layer) map.removeLayer(layer);
    raster();
  }
}

init().catch((e) => {
  console.error(e);
  $('#subtitle').textContent = navigator.onLine ? 'Impossible de démarrer la carte. Rechargez la page.' : 'Hors connexion : la carte a besoin d\'Internet.';
});
setupPwa();

/** Rend le site installable : service worker pour démarrer hors connexion, bouton « Installer » quand le navigateur le permet. */
function setupPwa() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker non installé :', e.message)));
  }
  const btn = $('#installBtn');
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // l'installation passe par notre bouton, pas par la bannière du navigateur
    installPrompt = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => (btn.hidden = true));
}

async function init() {
  if (!L) throw new Error('Leaflet non chargé');
  const cfg = await getJson('/api/config');
  const labels = Object.fromEntries(cfg.connectors.map((c) => [c.id, c.label]));

  // Un lien partagé (#zoom/lat/lon/prises) l'emporte sur la dernière vue mémorisée
  const shared = parseViewHash(location.hash);
  const sharedTypes = shared?.types.filter((t) => labels[t]) ?? [];

  const state = {
    types: sharedTypes.length ? sharedTypes : store.get('types', cfg.defaultTypes).filter((t) => labels[t]),
    filters: new Set(store.get('filters', []).filter((k) => FILTERS[k])),
    sort: SORTS[store.get('sort')] ? store.get('sort') : 'distance',
    stations: [], // toutes les stations de la zone chargée
    shown: [], // celles qui passent les filtres, donc les repères
    loaded: null, // zone chargée : { bounds, typesKey, at }
    ref: null, // point d'où on mesure les distances : { lat, lon, label }
    selectedId: null,
    markers: new Map(),
    abort: null,
    flying: false, // la carte se déplace d'elle-même vers une borne : pas de rechargement
  };
  if (!state.types.length) state.types = [...cfg.defaultTypes];
  const typesLabel = () => state.types.map((t) => labels[t]).join(' + ');

  /* ---------------- carte ---------------- */
  const saved = store.get('view', DEFAULT_VIEW);
  const start = shared?.view ?? ([saved.lat, saved.lon, saved.zoom].every(Number.isFinite) ? saved : DEFAULT_VIEW);
  // markercluster plante si maxZoom n'est pas fixé dès la création
  const map = L.map('map', { zoomControl: false, maxZoom: cfg.tiles.maxZoom }).setView([start.lat, start.lon], start.zoom);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  addBaseLayer(map, cfg.tiles); // sans attendre : les bornes s'affichent pendant que le fond arrive
  const cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 45, disableClusteringAtZoom: 15 });
  map.addLayer(cluster);
  let refMarker = null;
  const zoomHint = $('#zoomHint');

  const refPoint = () => state.ref || { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const pinIcon = (s) => L.divIcon({ className: '', html: pinHtml(s, state.types, s.id === state.selectedId), iconSize: [34, 34], iconAnchor: [17, 41] });

  /* ---------------- chargement ---------------- */
  /** Zone à demander : l'écran, un peu élargi en vue rapprochée si le serveur l'accepte. */
  function boundsToLoad() {
    const view = map.getBounds();
    if (map.getZoom() < PAD_FROM_ZOOM || !cfg.maxSpan) return view;
    const padded = view.pad(PAD_RATIO);
    const tooBig = padded.getNorth() - padded.getSouth() > cfg.maxSpan.lat || padded.getEast() - padded.getWest() > cfg.maxSpan.lon;
    return tooBig ? view : padded;
  }

  function isLoaded() {
    const l = state.loaded;
    return !!l && l.typesKey === state.types.join(',') && Date.now() - l.at < FRESH_MS && l.bounds.contains(map.getBounds());
  }

  /** Charge les bornes de la zone visible. force rappelle le serveur même si c'est déjà chargé. */
  async function loadStations({ force = false } = {}) {
    const zoom = map.getZoom();
    const c = map.getCenter();
    store.set('view', { lat: c.lat, lon: c.lng, zoom });
    history.replaceState(null, '', formatViewHash({ lat: c.lat, lon: c.lng, zoom }, state.types)); // l'adresse suit la vue, on peut la partager
    zoomHint.hidden = zoom >= MIN_ZOOM;
    if (zoom >= MIN_ZOOM && !force && isLoaded()) return renderList(); // seuls le tri et les distances ont changé
    state.abort?.abort();
    clearTimeout(retryTimer);
    if (zoom < MIN_ZOOM) {
      $('#panel').removeAttribute('aria-busy');
      state.stations = [];
      state.loaded = null;
      showWarnings([]);
      return render();
    }
    const b = boundsToLoad();
    const typesKey = state.types.join(',');
    const params = new URLSearchParams({ types: typesKey, south: b.getSouth().toFixed(5), west: b.getWest().toFixed(5), north: b.getNorth().toFixed(5), east: b.getEast().toFixed(5) });
    state.abort = new AbortController();
    $('#subtitle').textContent = 'Chargement…';
    $('#panel').setAttribute('aria-busy', 'true');
    try {
      const data = await getJson(`/api/stations?${params}`, { signal: state.abort.signal });
      state.stations = data.stations;
      // une source a manqué : on retentera au prochain déplacement
      state.loaded = data.warnings.length ? null : { bounds: b, typesKey, at: Date.now() };
      showWarnings(data.warnings);
      render();
      scheduleRetry(data.pending);
    } catch (e) {
      if (e.name === 'AbortError') return; // une requête plus récente a pris le relais
      $('#subtitle').textContent = navigator.onLine ? e.message : 'Hors connexion';
    }
    $('#panel').removeAttribute('aria-busy');
  }

  /** Une source a répondu trop tard : le serveur la laisse finir, on repasse la chercher un peu après. */
  let retryTimer;
  let retries = 0;
  function scheduleRetry(pending = []) {
    clearTimeout(retryTimer);
    if (!pending.length) return void (retries = 0);
    if (retries >= MAX_RETRIES) return;
    retries++;
    retryTimer = setTimeout(() => loadStations({ force: true }), RETRY_DELAY_MS);
  }

  function showWarnings(list = []) {
    const w = $('#warnings');
    w.hidden = !list.length;
    w.innerHTML = list.map((x) => `<div>⚠ ${esc(x)}</div>`).join('');
  }

  /* ---------------- rendu ---------------- */
  /** Reconstruit les repères (bornes qui passent les filtres), puis la liste. */
  function render() {
    state.shown = state.stations.filter((s) => passFilters(s, state.filters, state.types));
    cluster.clearLayers();
    state.markers.clear();
    const markers = state.shown.map((s) => {
      const m = L.marker([s.lat, s.lon], { icon: pinIcon(s), title: pinTitle(s, state.types) });
      m.on('click', () => select(s.id, false));
      state.markers.set(s.id, m);
      return m;
    });
    cluster.addLayers(markers);
    renderList();
  }

  /** Met à jour la liste et le titre pour les bornes visibles, sans toucher aux repères. */
  function renderList() {
    const ref = refPoint();
    const view = map.getBounds();
    const inView = (s) => view.contains([s.lat, s.lon]);
    const distances = new Map();
    const distance = (s) => distances.get(s) ?? distances.set(s, distanceKm(ref, s)).get(s);
    const visible = state.shown.filter(inView).sort((a, b) => SORTS[state.sort].compare(a, b, distance, state.types));

    const zoomedOut = map.getZoom() < MIN_ZOOM;
    $('#sortBox').hidden = visible.length < 2; // rien à trier
    const hidden = state.stations.filter(inView).length - visible.length;
    $('#countTitle').textContent = zoomedOut ? 'Bornes de recharge' : `${visible.length} borne${visible.length > 1 ? 's' : ''} ${typesLabel()}`;
    if (zoomedOut) $('#subtitle').textContent = 'Zoomez sur la carte ou cherchez une adresse';
    else {
      const parts = [];
      if (hidden) parts.push(`${hidden} masquée${hidden > 1 ? 's' : ''} par les filtres`);
      if (state.sort === 'distance') parts.push(state.ref ? `Distances depuis ${state.ref.label}` : 'Distances depuis le centre de la carte');
      // combien de bornes affichées vient de chaque source (une borne peut en avoir plusieurs)
      const bySource = {};
      for (const s of visible) for (const x of s.sources) bySource[x.source] = (bySource[x.source] || 0) + 1;
      const counts = Object.entries(bySource).map(([name, n]) => `${name} ${n}`);
      if (counts.length) parts.push(counts.join(' · '));
      $('#subtitle').textContent = parts.join(' · ');
    }

    const cardView = { types: state.types, labels, ref, selectedId: state.selectedId, platform };
    let html = visible.slice(0, MAX_CARDS).map((s) => cardHtml(s, cardView)).join('');
    if (visible.length > MAX_CARDS) html += `<li class="empty">… et ${visible.length - MAX_CARDS} autres : zoomez pour affiner.</li>`;
    if (!visible.length) html = `<li class="empty">${zoomedOut ? 'Cherchez une adresse ou zoomez sur la carte.' : `Aucune borne ${esc(typesLabel())} dans cette zone avec ces filtres.`}</li>`;
    $('#list').innerHTML = html;
  }

  /** Sélectionne une borne, ou la désélectionne si elle l'était déjà. fly centre la carte dessus. */
  function select(id, fly) {
    const prev = state.selectedId;
    state.selectedId = prev === id ? null : id;
    for (const sid of new Set([prev, id])) {
      const s = state.stations.find((x) => x.id === sid);
      if (s) state.markers.get(sid)?.setIcon(pinIcon(s));
    }
    for (const card of document.querySelectorAll('.card')) {
      const active = card.dataset.id === state.selectedId;
      card.classList.toggle('active', active);
      card.querySelector('.card-title').setAttribute('aria-expanded', active);
    }
    if (!state.selectedId) return;
    document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const marker = state.markers.get(id);
    if (fly && marker) {
      state.flying = true;
      cluster.zoomToShowLayer(marker, () => {
        map.once('moveend', () => (state.flying = false));
        map.panTo(marker.getLatLng());
      });
    }
    if (isMobile()) setPanel('expanded');
  }

  $('#list').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const card = e.target.closest('.card');
    if (card) select(card.dataset.id, true);
  });

  /* ---------------- boutons de prise et de filtre ---------------- */
  function addChip(container, label, pressed, extraClass, onClick) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip ${extraClass}`;
    chip.textContent = label;
    chip.setAttribute('aria-pressed', pressed);
    chip.addEventListener('click', () => chip.setAttribute('aria-pressed', onClick()));
    container.appendChild(chip);
  }

  for (const { id, label } of cfg.connectors) {
    addChip($('#plugChips'), label, state.types.includes(id), 'plug', () => {
      if (!state.types.includes(id)) state.types.push(id);
      else if (state.types.length === 1) toast('Gardez au moins un type de prise');
      else state.types = state.types.filter((t) => t !== id);
      store.set('types', state.types);
      state.selectedId = null;
      loadStations();
      return state.types.includes(id);
    });
  }

  for (const [key, { label }] of Object.entries(FILTERS)) {
    addChip($('#filterChips'), label, state.filters.has(key), '', () => {
      if (!state.filters.delete(key)) state.filters.add(key);
      store.set('filters', [...state.filters]);
      render();
      return state.filters.has(key);
    });
  }

  /* ---------------- tri de la liste ---------------- */
  const sortSelect = $('#sortSelect');
  for (const [key, { label }] of Object.entries(SORTS)) sortSelect.add(new Option(label, key, false, key === state.sort));
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    store.set('sort', state.sort);
    renderList();
    $('.panel-scroll').scrollTop = 0;
  });

  /* ---------------- déplacement de la carte ---------------- */
  let moveTimer;
  map.on('moveend', () => {
    if (state.flying) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(loadStations, MOVE_DEBOUNCE_MS);
  });
  $('#refreshBtn').addEventListener('click', () => loadStations({ force: true }));

  function setRef(lat, lon, label, kind) {
    state.ref = { lat, lon, label };
    if (refMarker) map.removeLayer(refMarker);
    const icon = L.divIcon({ className: '', html: `<div class="${kind === 'me' ? 'me-dot' : 'search-pin'}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    refMarker = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    map.setView([lat, lon], Math.max(map.getZoom(), 12));
    renderList(); // les distances changent même si la carte ne bouge pas
  }

  /* ---------------- recherche d'adresse ---------------- */
  const input = $('#searchInput');
  const sugg = $('#suggestions');
  let suggItems = [];
  let active = -1;
  let searchTimer;

  // le centre de la carte aide à départager les villes homonymes (arrondi au degré côté serveur)
  const geocode = (q) => {
    const c = map.getCenter();
    return getJson(`/api/geocode?q=${encodeURIComponent(q)}&lat=${c.lat.toFixed(1)}&lon=${c.lng.toFixed(1)}`).then((d) => d.results || []);
  };

  function drawSugg() {
    if (!suggItems.length) return hideSugg();
    sugg.innerHTML = suggItems
      .map((r, i) => `<li role="option" id="sugg-${i}" data-i="${i}" aria-selected="${i === active}"><span class="flag">${esc(r.country || '')}</span>${esc(r.label)}</li>`)
      .join('');
    sugg.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `sugg-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function hideSugg() {
    sugg.hidden = true;
    suggItems = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function pick(result) {
    input.value = result.label;
    hideSugg();
    input.blur();
    setRef(result.lat, result.lon, result.label.split(',')[0], 'search');
  }

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) return hideSugg();
    searchTimer = setTimeout(async () => {
      const results = await geocode(q).catch(() => []);
      if (input.value.trim() !== q) return; // la saisie a changé entre-temps
      suggItems = results;
      active = -1;
      drawSugg();
    }, SEARCH_DEBOUNCE_MS);
  });

  // mousedown plutôt que click : il arrive avant le blur du champ, qui fermerait la liste
  sugg.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) pick(suggItems[Number(li.dataset.i)]);
  });

  input.addEventListener('keydown', (e) => {
    if (sugg.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + suggItems.length) % suggItems.length;
      drawSugg();
    } else if (e.key === 'Escape') hideSugg();
  });
  input.addEventListener('blur', () => setTimeout(hideSugg, 150));

  $('#searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (suggItems.length) return pick(suggItems[Math.max(active, 0)]);
    const q = input.value.trim();
    if (q.length < 3) return;
    const results = await geocode(q).catch(() => []);
    if (results.length) pick(results[0]);
    else toast('Adresse introuvable');
  });

  /* ---------------- géolocalisation ---------------- */
  $('#locateBtn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return toast('Géolocalisation non disponible sur cet appareil');
    if (!window.isSecureContext) return toast('La géolocalisation nécessite HTTPS (ou localhost)');
    const btn = $('#locateBtn');
    btn.classList.add('busy');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        btn.classList.remove('busy');
        input.value = '';
        setRef(p.coords.latitude, p.coords.longitude, 'votre position', 'me');
      },
      (err) => {
        btn.classList.remove('busy');
        toast(err.code === err.PERMISSION_DENIED ? 'Autorisez la localisation dans votre navigateur' : 'Position introuvable');
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });

  /* ---------------- panneau mobile (3 hauteurs : réduit, normal, étendu) ---------------- */
  const PANEL_MODES = ['collapsed', null, 'expanded'];
  const panel = $('#panel');
  const handle = $('#panelHandle');
  const panelMode = () => PANEL_MODES.find((m) => m && panel.classList.contains(m)) ?? null;

  function setPanel(mode) {
    panel.classList.remove('collapsed', 'expanded');
    if (mode) panel.classList.add(mode);
    handle.setAttribute('aria-expanded', mode !== 'collapsed');
  }
  /** +1 agrandit d'un cran, -1 réduit d'un cran. */
  function stepPanel(delta) {
    const i = PANEL_MODES.indexOf(panelMode()) + delta;
    setPanel(PANEL_MODES[Math.max(0, Math.min(PANEL_MODES.length - 1, i))]);
  }

  handle.addEventListener('click', () => setPanel(panelMode() === 'expanded' ? 'collapsed' : panelMode() === 'collapsed' ? null : 'expanded'));

  // glisser l'en-tête du panneau vers le haut ou le bas
  let touchStartY = null;
  const head = $('#panelDrag');
  head.addEventListener('touchstart', (e) => (touchStartY = e.touches[0].clientY), { passive: true });
  head.addEventListener(
    'touchend',
    (e) => {
      if (touchStartY === null) return;
      const dy = e.changedTouches[0].clientY - touchStartY;
      touchStartY = null;
      if (Math.abs(dy) > 30) stepPanel(dy < 0 ? 1 : -1);
    },
    { passive: true },
  );

  // l'adresse a changé (saisie à la main, lien vers une autre vue) : on y va
  window.addEventListener('hashchange', () => location.reload());

  loadStations();
}
