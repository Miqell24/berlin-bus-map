#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts the missing OSM extracts out of Geofabrik .pbf files — same JSON shape
as Overpass ('elements': ways with tags, node ids and geometry), so build.mjs
cannot tell the difference. Used when Overpass is too congested to serve the
5×5 road grid, which for a 95 × 82 km box over German street density is most
of the time.

Berlin needs TWO extracts: Geofabrik's berlin is the city alone and its
brandenburg is the Land with the city cut out, so the Speckgürtel lives in the
second file. Way ids are OSM's own, so build.mjs dedupes the overlap and the
node ids stitch the topology across the seam.
"""
import json, os, re, sys
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
PBFS = [os.path.join(ROOT, 'data', 'berlin-latest.osm.pbf'),
        os.path.join(ROOT, 'data', 'brandenburg-latest.osm.pbf')]

# must match pipeline/download.sh
S, N, W, E = 52.03, 52.94, 12.66, 13.98
RAIL_BOX = (52.24, 12.94, 52.81, 13.98)

HW = re.compile(r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')
RAIL = re.compile(r'^(subway|tram|light_rail|rail|construction)$')

road_tiles = {}
for i in range(1, 26):
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    if os.path.exists(f):
        continue
    row, col = (i - 1) // 5, (i - 1) % 5
    road_tiles[i] = (S + (N - S) * row / 5, S + (N - S) * (row + 1) / 5,
                     W + (E - W) * col / 5, W + (E - W) * (col + 1) / 5)
rail_file = os.path.join(ROOT, 'data/osm/berlin-rail.json')
need_rail = not os.path.exists(rail_file)
print('brakujące kafle dróg:', sorted(road_tiles), '| szyny:', need_rail, flush=True)
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

GEN = 'pbf-tiles.py (Geofabrik berlin + brandenburg)'
for i, els in out.items():
    f = os.path.join(ROOT, f'data/osm/tiles/t{i}.json')
    if os.path.exists(f):
        print(f't{i}: już jest (Overpass zdążył)', flush=True); continue
    json.dump({'version': 0.6, 'generator': GEN, 'elements': els}, open(f, 'w'))
    print(f't{i}: {len(els)} dróg', flush=True)
if need_rail and not os.path.exists(rail_file):
    json.dump({'version': 0.6, 'generator': GEN, 'elements': out_rail}, open(rail_file, 'w'))
    print(f'szyny: {len(out_rail)} odcinków', flush=True)
print('gotowe', flush=True)
