# Recharge Map

Carte des bornes de recharge, filtrées sur **votre type de prise** (CHAdeMO, CCS Combo 2, Type 2, prise domestique E/F — sélection multiple, mémorisée), avec **tarifs** et **disponibilité temps réel** quand elle existe.
Recherche par adresse (autocomplétion) ou par géolocalisation ; liste triée par distance, prix au kWh ou puissance ; filtres (≥ 50 kW, disponible, gratuit, tarif connu) ; liens de navigation (Google Maps, Waze, Plans sur iPhone, appli au choix sur Android). Bornes favorites (étoile ☆ sur chaque fiche, bouton ★ en haut de la liste) : enregistrées sur l'appareil, sans compte, avec leur disponibilité à jour d'un coup d'œil, où qu'on soit sur la carte. L'adresse de la page garde la vue et les prises choisies : elle se partage telle quelle. Mode clair ou sombre (interface et fond de carte) : celui de l'appareil à l'ouverture, puis au choix avec le bouton en haut à droite.

La puissance, la disponibilité et le filtre « ≥ 50 kW » portent uniquement sur les prises sélectionnées.
Quand une prise CHAdeMO partage un point de charge avec une prise CCS plus puissante, sa puissance est affichée « ≈ 50 kW » (estimation), sauf si une autre source donne la valeur réelle.

Aucune dépendance npm pour faire tourner le site : Node ≥ 20 suffit. Seul l'outil de vérification du code (ESLint) s'installe, pour le développement, avec `npm install`.

```bash
cp .env.example .env                    # puis y mettre la clé Open Charge Map
node --env-file=.env server/index.js    # http://localhost:8080 (ou : OCM_API_KEY=xxxx npm start)
npm run dev                             # redémarre le serveur à chaque modification (sans .env)
npm run check                           # ESLint puis tests (unitaires + bout en bout, serveurs amont simulés) : avant chaque mise en ligne
docker compose up -d --build            # NAS / serveur (lit .env)
```

## Application installable (PWA)

Le site s'installe comme une application (bouton « Installer l'appli » en bas de la liste quand le navigateur le permet ; sur iPhone : Partager → « Sur l'écran d'accueil »). L'installation exige HTTPS, ou `localhost`.
Un service worker (`public/sw.js`) garde l'interface en cache : hors connexion, l'application s'ouvre et affiche « Hors connexion » (les bornes et le fond de carte demandent Internet). En ligne, c'est toujours la dernière version du site qui est servie.

## Mise en ligne

Sur un NAS (Synology…) ou un serveur : `docker compose up -d --build`, puis un reverse proxy **HTTPS** devant (sur Synology : Panneau de configuration → Portail de connexion → Avancé → Proxy inversé, vers `http://localhost:8080`, avec HSTS coché).

À faire :
- Renseigner dans `.env` : `OCM_API_KEY`, `SITE_URL=https://…` (adresse publique) et `TRUST_PROXY=true`. `.env` est ignoré par git et n'entre pas dans l'image.
- **N'ouvrir que le port 443 du reverse proxy vers Internet.** Le port 8080 de l'app n'écoute que sur le NAS lui-même (`127.0.0.1`, voir `docker-compose.yml`) : ouvert au réseau, il servirait le site sans HTTPS et la limite de débit deviendrait contournable.
- Si un autre proxy s'ajoute devant (Cloudflare…), la limite de débit verra son adresse et non celle des visiteurs.
- Reconstruire l'image de temps en temps (`docker compose build --pull && docker compose up -d`) pour recevoir les correctifs de Node et d'Alpine.

Ce que l'app fait déjà :
- **En-têtes de sécurité** : CSP stricte (scripts, styles et polices du site uniquement ; images et connexions limitées au fournisseur du fond de carte), `nosniff`, anti-cadre, HSTS quand `SITE_URL` est en https.
- **Aucune entrée n'est écrite ni exécutée** : API en lecture seule (GET/HEAD), paramètres validés, pas de base de données, pas de compte, pas de cookie.
- **Limites de débit** par visiteur (API, et plus strictement la recherche d'adresse) et **budget global d'appels sortants** vers Open Charge Map et Overpass, pour que personne ne puisse épuiser la clé ou faire bannir le serveur.
- **Conteneur cloisonné** : utilisateur non-root, système de fichiers en lecture seule (seul `/data` est inscriptible), aucun privilège noyau, mémoire et nombre de processus plafonnés.
- **Aucune dépendance npm à l'exécution**, bibliothèques et polices hébergées avec le site (rien n'est chargé depuis un CDN, RGPD) : le seul service externe appelé par le navigateur est le fournisseur du fond de carte.
- La clé OCM n'est jamais envoyée au navigateur ni écrite dans les journaux.

Fond de carte : OpenFreeMap par défaut (gratuit, sans clé, sans garantie de service), avec repli automatique sur les tuiles OSM standard (voir « Fonds de carte »).

## Sources agrégées

| Source | Couverture | Ce qu'elle apporte | Mode |
|---|---|---|---|
| **IRVE – Base nationale consolidée** (PAN, transport.data.gouv.fr) | France | Référentiel officiel : types de prise (`prise_type_*`), puissance, champ `tarification`, gratuit, paiement CB, horaires, accès | CSV statique (~180 000 PDC) téléchargé chaque nuit, regroupé par station, gardé en mémoire + cache disque |
| **IRVE – données dynamiques** (PAN) | France (opérateurs qui publient) | État et occupation de chaque point de charge et de chaque prise → « 1 libre / 2 », « Hors service » | CSV rafraîchi toutes les 10 min |
| **Open Charge Map** ([openchargemap.org](https://openchargemap.org)) | Monde | `UsageCost` (tarif saisi par la communauté/opérateurs), opérateur, statut | API live par zone (1000 bornes max par requête), clé gratuite |
| **Overpass** (bornes issues d'OpenStreetMap) | Monde | `socket:chademo`, `socket:type2_combo`, `socket:type2(_cable)`, `socket:typee/schuko`, `charge`, `fee` | API live par zone |
| **Géoplateforme IGN** | France | Géocodage d'adresses (remplace api-adresse.data.gouv.fr) | API live |
| **Photon (komoot, données OSM)** | Monde | Géocodage d'adresses, en favorisant les lieux proches du centre de la carte | API live |

Dans le code, Open Charge Map s'appelle `OCM` et la source Overpass `OSM`. Les stations des différentes sources situées à moins de 60 m sont fusionnées (priorité IRVE > OCM > OSM pour les champs descriptifs) ; **les tarifs de chaque source sont tous affichés**, avec leur provenance, car ils se complètent souvent.

### Pourquoi un backend ?
- le CSV IRVE fait ~150 Mo : il faut le filtrer côté serveur ;
- la clé OCM ne doit pas être exposée dans le navigateur ;
- cache par zone pour ménager Overpass et OCM (15 min par défaut).

## Limites à connaître
- **Tarifs** : il n'existe pas d'API ouverte et exhaustive des prix réels. Quand un texte de tarif (IRVE ou OCM) contient un prix explicite au kWh, il est extrait (`server/price.js`) et affiché en étiquette sur la fiche (« 0,42 €/kWh », ou « dès … » s'il y a plusieurs prix ou d'autres frais) : environ 14 % des stations rapides. Le champ IRVE `tarification` est du texte libre souvent vide ; OCM/OSM dépendent des contributeurs. Le [schéma IRVE v3](https://github.com/etalab/schema-irve/releases) (en alpha depuis octobre 2026, sans date de mise en service ; la base nationale est encore en v2.3.1) remplace ce texte libre par un fichier tarifs structuré (modèle OCPI : prix TTC au kWh, à l'heure, forfait). Le site est prêt : `server/sources/irve.js` accepte les colonnes renommées de la v3 et `server/tariffs.js` lit le fichier tarifs ; il suffira de renseigner `IRVE_TARIFFS_URL` quand le PAN publiera sa consolidation (et de vérifier l'URL du fichier statique).
- **Hors de France** : pas de base officielle branchée, la carte repose sur Open Charge Map et Overpass, deux bases contributives, donc incomplètes (sans clé OCM et avec Overpass en panne, il n'y a rien). Les pays européens publient leurs flux officiels au format AFIR, chacun sur son portail et souvent avec une inscription : en Belgique par exemple sur [transportdata.be](https://transportdata.be/dataset/ae5bd9d5-cb5b-4a15-80af-f10e7a17ffd8), avec un jeton à demander à Eco-Movement. Aucun n'est branché pour l'instant.
- **Overpass** : les serveurs publics sont souvent saturés ou en panne. Le site répond alors sans eux (voir `LIVE_WAIT_MS`, `OVERPASS_RETRY_PAUSE_S`) et le signale sous la liste.
- L'ancienne base IRVE data.gouv.fr disparaît le 31/12/2026 ; l'app utilise déjà la nouvelle base du PAN.

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | 8080 | Port HTTP |
| `OCM_API_KEY` | — | Clé Open Charge Map (source ignorée si absente) |
| `OCM_MAX_RESULTS` | 1000 | Bornes Open Charge Map max par requête (au-delà, zoomer pour voir les autres) |
| `DATA_DIR` | ./data | Cache disque IRVE |
| `IRVE_STATIC_URL` | `https://transport.data.gouv.fr/resources/84013/download` | CSV statique |
| `IRVE_DYNAMIC_URL` | `https://transport.data.gouv.fr/resources/84098/download` | CSV dynamique |
| `IRVE_STATIC_REFRESH_HOURS` | 24 | Rafraîchissement statique |
| `IRVE_DYNAMIC_REFRESH_MINUTES` | 10 | Rafraîchissement disponibilité |
| `IRVE_TARIFFS_URL` | — | Fichier tarifs du schéma IRVE v3 (pas encore publié au niveau national) : prix structurés, relus avec la disponibilité. Sans effet tant que la base statique est en v2 |
| `OVERPASS_URL` | overpass-api.de, overpass.kumi.systems, overpass.private.coffee | Serveurs Overpass séparés par des virgules, essayés dans l'ordre (repli sur le suivant en cas d'échec ; le dernier qui a répondu est réessayé en premier) |
| `OVERPASS_TIMEOUT_MS` | 10000 | Délai max par serveur Overpass avant de passer au suivant |
| `OVERPASS_RETRY_PAUSE_S` | 120 | Si tous les serveurs Overpass échouent, OSM est ignoré pendant ce délai (réponses rapides avec IRVE / OCM) |
| `OSM_ENABLED` / `IRVE_ENABLED` | true | Désactiver une source |
| `MAP_STYLE_URL` | style « liberty » d'OpenFreeMap | Fond de carte vectoriel (style MapLibre). `none` pour s'en passer |
| `MAP_STYLE_DARK_URL` | style « dark » d'OpenFreeMap | Fond vectoriel des appareils en mode sombre (par défaut seulement avec le style OpenFreeMap par défaut). `none` pour garder le même fond |
| `TILE_URL` | tuiles OSM standard | Fond de carte en tuiles image : repli du fond vectoriel, ou fond principal s'il est défini sans `MAP_STYLE_URL` |
| `TILE_ATTRIBUTION` | © OpenStreetMap | Mention obligatoire du fournisseur de tuiles |
| `TILE_SUBDOMAINS` / `TILE_MAX_ZOOM` | abc / 19 | Options Leaflet |
| `LIVE_CACHE_MINUTES` | 15 | Cache des requêtes OCM / OSM |
| `LIVE_WAIT_MS` | 3000 | Attente max d'une source live (OCM, Overpass) avant de répondre sans elle ; elle se termine en arrière-plan et sert le chargement suivant |
| `MERGE_DISTANCE_M` | 60 | Distance de fusion entre sources |
| `MAX_BBOX_SPAN_DEG` | 2.5 | Taille max de zone interrogeable |
| `RATE_LIMIT_PER_MIN` | 300 | Requêtes API max par minute et par adresse IP (0 = pas de limite) |
| `GEOCODE_LIMIT_PER_MIN` | 60 | Recherches d'adresse max par minute et par adresse IP |
| `LIVE_MAX_PER_MIN` | 60 | Appels max par minute vers chaque source live (OCM, Overpass), tous visiteurs confondus |
| `SITE_URL` | adresse demandée par le visiteur | Adresse publique du site, sans `/` final (ex. `https://recharge.byj6n.fr`) : URL canonique, `sitemap.xml`, aperçus de partage. En https, active l'en-tête HSTS. À renseigner en production |
| `TRUST_PROXY` | false | `true` derrière un reverse proxy : l'IP du visiteur est lue dans `X-Forwarded-For` |
| `REQUEST_TIMEOUT_MS` | 20000 | Délai max des appels aux services amont (hors Overpass) |
| `OCM_URL`, `GEOPF_URL`, `PHOTON_URL`, `USER_AGENT` | services publics | Adresses des services amont et identifiant envoyé ; rarement utiles à changer |

### Fond de carte par défaut : OpenFreeMap

Le fond est un style vectoriel [OpenFreeMap](https://openfreemap.org) (gratuit, sans clé ni inscription, sans cookies), dessiné dans le navigateur par MapLibre GL, branché sur Leaflet. MapLibre (1 Mo) n'est téléchargé que si ce fond est utilisé.
Autres styles OpenFreeMap : remplacer `liberty` par `bright` ou `positron` dans `MAP_STYLE_URL`.

Le site bascule tout seul sur les tuiles image (`TILE_URL`) si l'appareil n'a pas WebGL, ou si le fond vectoriel ne s'est pas chargé au bout de 8 s. OpenFreeMap vit de dons et n'offre pas de garantie de service : pour s'en passer, `MAP_STYLE_URL=none`.

### Fonds de carte en tuiles image, sans clé

| Choix | `TILE_URL` | `TILE_ATTRIBUTION` |
|---|---|---|
| OSM standard (défaut) | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | `© contributeurs OpenStreetMap` |
| OSM France (style français) | `https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png` (+ `TILE_MAX_ZOOM=20`) | `© contributeurs OpenStreetMap, tuiles OSM France` |
| Plan IGN (France uniquement) | `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}` (+ `TILE_MAX_ZOOM=18`) | `© IGN` |

Les tuiles OSM sont fournies bénévolement, sans garantie : elles conviennent à un usage personnel ou à un petit site, pas à un site à fort trafic ([règles d'usage](https://operations.osmfoundation.org/policies/tiles/)).

### Fonds de carte pour un site public

Pour un site fréquenté, prendre un fournisseur qui s'y engage (offre gratuite limitée, puis payante), par exemple [Jawg](https://www.jawg.io) (français), [MapTiler](https://www.maptiler.com), [Stadia Maps](https://stadiamaps.com) ou [Thunderforest](https://www.thunderforest.com). Après inscription, il suffit de renseigner dans `.env` l'URL fournie (clé comprise) et la mention demandée :

```
TILE_URL=https://…/{z}/{x}/{y}.png?access-token=VOTRE_CLE
TILE_ATTRIBUTION=© Fournisseur, © contributeurs OpenStreetMap
```

La clé d'un fond de carte est visible dans le navigateur : la restreindre à votre nom de domaine dans l'espace client du fournisseur.

## API

- `GET /api/stations?south=&west=&north=&east=&types=chademo,ccs` → `{ types, stations[], counts: {IRVE, OCM, OSM}, warnings[], pending[] }` (types : `chademo`, `ccs`, `type2`, `ef` ; défaut `chademo` ; `pending` : sources trop lentes cette fois, que le front redemande quelques secondes plus tard)
- `GET /api/config` → ce dont le front a besoin au démarrage : `{ tiles, connectors: [{ id, label }], defaultTypes, maxSpan }`
- `GET /api/connectors` → libellés des types gérés
- `GET /api/favorites?types=…&id=irve:…&id=irve:…` → `{ types, stations[] }` : état à jour de bornes précises, où qu'elles soient (50 au plus). Seule la base IRVE donne une disponibilité en temps réel, les autres identifiants sont ignorés. `id` est répété car un identifiant IRVE peut contenir une virgule
- `GET /api/geocode?q=&lat=&lon=` → `{ results: [{ label, lat, lon, country }] }` (lat / lon facultatifs : centre de la carte, pour départager les homonymes)
- `GET /api/status` → état des sources (chargement IRVE, dernières erreurs)

## Structure

```
server/
  index.js        routes de l'API, démarrage, arrêt propre
  http.js         en-têtes de sécurité, réponses JSON compressées, limite de débit
  static.js       fichiers du front (ETag, compression)
  stations.js     agrégation des sources pour une zone + cache des sources live
  connectors.js   types de prise et correspondance IRVE / OCM / OSM
  config.js       variables d'environnement
  csv.js          parseur CSV en flux (gère ; , guillemets, sauts de ligne)
  merge.js        fusion / dédoublonnage multi-sources
  price.js        lecture du prix au kWh dans les textes de tarif
  geocode.js      IGN + Photon
  sources/        irve.js  ocm.js (Open Charge Map)  osm.js (bornes OpenStreetMap via Overpass)
public/
  index.html, style.css
  manifest.webmanifest, sw.js, icon.svg, icons/   application installable : manifeste, service worker, icônes
  fonts/          polices hébergées avec le site
  vendor/         Leaflet, Leaflet.markercluster, MapLibre GL (copies non modifiées)
  js/main.js      carte, chargement, liste, recherche, géolocalisation, panneau mobile
  js/theme.js     thème clair / sombre, appliqué avant le premier affichage
  js/favorites.js bornes favorites, gardées sur l'appareil
  js/stations.js  règles d'affichage : puissance, disponibilité, filtres, tris
  js/templates.js HTML des fiches et des marqueurs
  js/util.js      fonctions pures (échappement, distances)
  js/dom.js       stockage local, message éphémère, appels à l'API
tools/            make-icons.mjs : génère les icônes à partir du logo J6N (tools/j6n-logo.svg)
test/             tests unitaires (serveur et front) + bout en bout avec faux serveurs amont
```

## Modifier l'application

| Je veux… | Où |
|---|---|
| Ajouter un type de prise | une entrée dans `CONNECTORS` (`server/connectors.js`) : le bouton apparaît tout seul |
| Ajouter un filtre | une entrée dans `FILTERS` (`public/js/stations.js`) : le bouton apparaît tout seul |
| Ajouter un tri | une entrée dans `SORTS` (`public/js/stations.js`) : l'option apparaît toute seule |
| Ajouter une source de données | un module dans `server/sources/` + une entrée dans `LIVE_SOURCES` (`server/stations.js`) |
| Changer le contenu d'une fiche | `public/js/templates.js` |
| Changer les boutons de navigation (Itinéraire, Waze, Plans…) | `navLinks` dans `public/js/templates.js` |
| Changer couleurs, tailles, mise en page | variables en tête de `public/style.css` (le mode sombre a les siennes, juste en dessous ; le choix du thème est dans `public/js/theme.js`) ; le mobile est dans le bloc `@media (max-width: 800px)` |
| Ajouter un fichier au front | l'ajouter aussi à la liste `SHELL` de `public/sw.js` pour qu'il soit disponible hors connexion |
| Changer de version de Leaflet ou MapLibre | remplacer les fichiers de `public/vendor/` (voir `public/vendor/README.md`) |
| Changer le logo ou les icônes de l'appli | `node tools/make-icons.mjs` (mode d'emploi en tête du fichier) ; le logo du bandeau est un SVG directement dans `public/index.html` |
| Charger un script ou un style depuis un autre site | à éviter (préférer `public/vendor/`) ; sinon l'autoriser dans la CSP (`server/http.js`) |
