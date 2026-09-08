#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts the OSM extracts out of Geofabrik .pbf files — same JSON shape as
Overpass ('elements': ways with tags, node ids and geometry), so build.mjs
cannot tell the difference. Used because no public Overpass mirror will serve
a box this size (every round came back 504 already for the old 95 x 82 km
Berlin frame).

The map is the WHOLE Verbund since 8.09.2026, so the cut spans Berlin, all of
Brandenburg and the strips of the neighbouring Laender and of Poland the VBB
lines reach into:

  roads (51.28-54.05 N, 10.68-14.87 E): the bus network — Berlin, Brandenburg,
  the Uckermark border, the X2 run to Wolfsburg in Lower Saxony and the
  long-term replacement services that reach Zuessow and Schwerin;
  rails (50.75-54.40 N, 10.95-17.15 E): trams, U-Bahn, S-Bahn AND the 67 RB/RE
  regional lines, which leave the Verbund for Stralsund, Schwerin, Magdeburg,
  Leipzig, Dresden, Goerlitz, Szczecin, Zielona Gora and Wroclaw.

Geofabrik's berlin is the city alone and its brandenburg has the city cut out,
so both are always needed; the others carry the parts outside. Way ids are
OSM's own, so build.mjs dedupes the overlap and the node ids stitch the
topology across every seam.
"""
import json, os, re, sys
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
NAMES = ['berlin', 'brandenburg', 'mecklenburg-vorpommern', 'sachsen',
         'sachsen-anhalt', 'niedersachsen',
         'dolnoslaskie', 'lubuskie', 'zachodniopomorskie']
PBFS = [os.path.join(ROOT, 'data', f'{n}-latest.osm.pbf') for n in NAMES]

# must match pipeline/download.sh; the numbers come from scope.mjs, which
# prints the stop extent of the two graphs
S, N, W, E = 51.28, 54.05, 10.68, 14.87
GRID = 8
RAIL_BOX = (50.75, 10.95, 54.40, 17.15)   # S, W, N, E

HW = re.compile(r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')
RAIL = re.compile(r'^(subway|tram|light_rail|rail|construction)$')

road_tiles = {}
for i in range(1, GRID * GRID + 1):
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    if os.path.exists(f):
        continue
    row, col = (i - 1) // GRID, (i - 1) % GRID
    road_tiles[i] = (S + (N - S) * row / GRID, S + (N - S) * (row + 1) / GRID,
                     W + (E - W) * col / GRID, W + (E - W) * (col + 1) / GRID)
rail_file = os.path.join(ROOT, 'data/osm/berlin-rail.json')
need_rail = not os.path.exists(rail_file)
print('brakujące kafle dróg:', len(road_tiles), '| szyny:', need_rail, flush=True)
if not road_tiles and not need_rail:
    sys.exit(0)
os.makedirs(os.path.join(ROOT, 'data/osm/tiles'), exist_ok=True)

out = {i: [] for i in road_tiles}
out_rail = []


class H(osmium.SimpleHandler):
    def way(self, w):
        tags = w.tags
        hw = tags.get('highway')
        rw = tags.get('railway')
        is_road = bool(road_tiles) and hw is not None and HW.match(hw)
        is_rail = need_rail and rw is not None and RAIL.match(rw)
        if not is_road and not is_rail:
            return
        geom, ids = [], []
        la0, la1, lo0, lo1 = 90.0, -90.0, 180.0, -180.0
        for n in w.nodes:
            try:
                lo, la = n.lon, n.lat
            except osmium.InvalidLocationError:
                continue
            # node ids ride along: buildGraph() builds topology from el.nodes
            # and SILENTLY skips ways without them (the London t13 hole)
            ids.append(n.ref)
            geom.append({'lat': la, 'lon': lo})
            if la < la0: la0 = la
            if la > la1: la1 = la
            if lo < lo0: lo0 = lo
            if lo > lo1: lo1 = lo
        if len(geom) < 2:
            return
        el = None

        def make():
            nonlocal el
            if el is None:
                el = {'type': 'way', 'id': w.id, 'nodes': ids,
                      'tags': {t.k: t.v for t in tags}, 'geometry': geom}
            return el

        if is_road:
            for i, (s, n_, w_, e) in road_tiles.items():
                if la1 >= s and la0 <= n_ and lo1 >= w_ and lo0 <= e:
                    out[i].append(make())
        if is_rail:
            s, w_, n_, e = RAIL_BOX
            if la1 >= s and la0 <= n_ and lo1 >= w_ and lo0 <= e:
                out_rail.append(make())


for pbf in PBFS:
    if not os.path.exists(pbf):
        sys.exit(f'brak {pbf} — pobierz go (pipeline/download.sh)')
    print('czytam', os.path.basename(pbf), flush=True)
    H().apply_file(pbf, locations=True, idx='flex_mem')

GEN = 'pbf-tiles.py (Geofabrik: ' + ', '.join(NAMES) + ')'
for i, els in out.items():
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    json.dump({'version': 0.6, 'generator': GEN, 'elements': els}, open(f, 'w'))
    print(f't{i}: {len(els)} dróg', flush=True)
if need_rail:
    json.dump({'version': 0.6, 'generator': GEN, 'elements': out_rail}, open(rail_file, 'w'))
    print(f'szyny: {len(out_rail)} odcinków', flush=True)
print('gotowe', flush=True)
