#!/usr/bin/env bash
# Downloads input data: the VBB GTFS, OSM extracts (Geofabrik), MapLibre GL.
# Everything is cached — re-running only fetches what is missing.
#
# Berlin: VBB publishes ONE open GTFS for the whole Verbund — Berlin and all of
# Brandenburg, 1254 lines over 30 000 km² (https://www.vbb.de/vbbgtfs). The map
# is the metropolitan region, so the scope is a precomputed allowlist
# (pipeline/scope.mjs → data/scope.json) and the OSM extracts below cover only
# what that allowlist reaches.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs data/osm/tiles web/vendor

# pyosmium does the cutting; it is the one dependency outside Node here.
need_osmium () {
  python3 -c "import osmium" 2>/dev/null && return 0
  echo "brak pakietu osmium — zainstaluj: pip3 install --user osmium" >&2
  return 1
}

# 1) GTFS — the Verbund bundle (stable URL, refreshed in place by VBB)
if [ ! -f data/gtfs/routes.txt ]; then
  echo "== VBB GTFS (Berlin + Brandenburg) =="
  curl -fL --retry 3 --max-time 1800 -o data/vbb-gtfs.zip "https://www.vbb.de/vbbgtfs"
  unzip -o data/vbb-gtfs.zip -d data/gtfs
fi

# 1b) scope: which of the 1254 Verbund lines belong on a BERLIN map
if [ ! -f data/scope.json ]; then
  node --max-old-space-size=8192 pipeline/scope.mjs
fi

# 2) OSM — from the Geofabrik extracts, not Overpass.
#    A 95 × 82 km box over German street density is more than the public
#    Overpass mirrors will serve — every round came back 504 — and the road
#    grid alone runs to 690 000 ways. Two extracts are needed because
#    Geofabrik's berlin is the city alone and its brandenburg has the city
#    cut out.
#    pipeline/pbf-tiles.py cuts the tiles out of the .pbf and writes exactly the
#    JSON shape Overpass would have returned (ways with tags, NODE IDS and
#    geometry — buildGraph silently drops ways without el.nodes).
if [ ! -f data/osm/tiles/t25.json ] || [ ! -f data/osm/berlin-rail.json ]; then
  need_osmium
  if [ ! -f data/berlin-latest.osm.pbf ]; then
    echo "== Geofabrik berlin-latest.osm.pbf =="
    curl -fL --retry 5 --retry-delay 5 -C - --max-time 3600 -o data/berlin-latest.osm.pbf \
      "https://download.geofabrik.de/europe/germany/berlin-latest.osm.pbf"
  fi
  if [ ! -f data/brandenburg-latest.osm.pbf ]; then
    echo "== Geofabrik brandenburg-latest.osm.pbf =="
    curl -fL --retry 5 --retry-delay 5 -C - --max-time 3600 -o data/brandenburg-latest.osm.pbf \
      "https://download.geofabrik.de/europe/germany/brandenburg-latest.osm.pbf"
  fi
  echo "== cutting OSM tiles out of the extracts =="
  python3 pipeline/pbf-tiles.py
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/gtfs data/osm 2>/dev/null || true
