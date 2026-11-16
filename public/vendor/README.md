# Bibliothèques tierces

Copiées telles quelles depuis npm (via unpkg.com), sans modification.

| Dossier | Bibliothèque | Version | Licence |
|---|---|---|---|
| `leaflet/` | [Leaflet](https://leafletjs.com) | 1.9.4 | BSD-2-Clause (`leaflet/LICENSE`) |
| `maplibre/` | [MapLibre GL JS](https://maplibre.org) (`maplibre-gl.js`, `.css`) | 5.24.1 | BSD-3-Clause (`maplibre/LICENSE.txt`) |
| `maplibre/` | [maplibre-gl-leaflet](https://github.com/maplibre/maplibre-gl-leaflet) (`leaflet-maplibre-gl.js`) | 0.1.4 | ISC (`maplibre/leaflet-maplibre-gl.LICENSE`) |
| `markercluster/` | [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) | 1.5.3 | MIT (`markercluster/MIT-LICENCE.txt`) |

MapLibre reste en version 5 : la version 6 n'est plus distribuée sous la forme d'un script unique.

Mettre à jour : remplacer les fichiers par ceux de `https://unpkg.com/<paquet>@<version>/dist/`, puis changer la version ci-dessus.
