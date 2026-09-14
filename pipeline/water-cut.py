#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts the WATER the ferries ride out of the Geofabrik extracts (14.09.2026):
rivers and lakes (natural=water, waterway=riverbank), the coastline where
there is one, and the piers (man_made=pier) — around every ferry line in
data/scope.json (ferryBox, grown by MARGIN). Same JSON shape as Overpass
('elements': ways and relations with tags and geometry), written to
data/osm/berlin-water.json for pipeline/ferries.mjs.

Overpass would do the same query, and every mirror answered 504: the Havel and
Spree are multipolygons of thousands of members, and a relation is returned
whole or not at all. Here a relation is kept whole too — every member way's
geometry — whenever one of its members touches a box, so the rings close.
"""
import json, os, sys
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
NAMES = ['berlin', 'brandenburg']
PBFS = [os.path.join(ROOT, 'data', f'{n}-latest.osm.pbf') for n in NAMES]
OUT = os.path.join(ROOT, 'data/osm/berlin-water.json')
MARGIN_LAT, MARGIN_LON = 0.02, 0.03   # ~2.2 km: pipeline/ferries.mjs grids 1.5 km around the stops

scope = json.load(open(os.path.join(ROOT, 'data/scope.json'), encoding='utf-8'))
BOXES = [(b[0] - MARGIN_LAT, b[1] + MARGIN_LAT, b[2] - MARGIN_LON, b[3] + MARGIN_LON)
         for b in (scope.get('ferryBox') or {}).values()]
if not BOXES:
    sys.exit('data/scope.json has no ferryBox — run pipeline/scope.mjs')


def is_water(tags):
    return (tags.get('natural') in ('water', 'bay', 'coastline')
            or tags.get('waterway') in ('riverbank', 'dock')
            or tags.get('man_made') == 'pier')


def touches(la0, la1, lo0, lo1):
    return any(la1 >= s and la0 <= n and lo1 >= w and lo0 <= e for s, n, w, e in BOXES)


# pass 1: the member ways of every water relation
class Rels(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.rels = {}      # id -> {tags, members: [(ref, role)]}
        self.wanted = set()

    def relation(self, r):
        tags = {t.k: t.v for t in r.tags}
        if tags.get('type') not in ('multipolygon', None) or not is_water(tags):
            return
        mem = [(m.ref, m.role) for m in r.members if m.type == 'w']
        if not mem:
            return
        self.rels[r.id] = {'tags': tags, 'members': mem}
        self.wanted.update(ref for ref, _ in mem)


# pass 2: geometry of the tagged water ways and of the relation members
class Ways(osmium.SimpleHandler):
    def __init__(self, wanted):
        super().__init__()
        self.wanted = wanted
        self.geom = {}      # member way id -> (geometry, bbox)
        self.ways = {}      # tagged water way id -> element

    def way(self, w):
        tagged = is_water(w.tags)
        member = w.id in self.wanted
        if not tagged and not member:
            return
        geom = []
        la0, la1, lo0, lo1 = 90.0, -90.0, 180.0, -180.0
        for n in w.nodes:
            try:
                lo, la = n.lon, n.lat
            except osmium.InvalidLocationError:
                continue
            geom.append({'lat': la, 'lon': lo})
            la0, la1, lo0, lo1 = min(la0, la), max(la1, la), min(lo0, lo), max(lo1, lo)
        if len(geom) < 2:
            return
        if member:
            self.geom[w.id] = (geom, (la0, la1, lo0, lo1))
        if tagged and touches(la0, la1, lo0, lo1):
            self.ways[w.id] = {'type': 'way', 'id': w.id, 'tags': {t.k: t.v for t in w.tags}, 'geometry': geom}


rels = Rels()
for pbf in PBFS:
    if not os.path.exists(pbf):
        sys.exit(f'brak {pbf} — pobierz go (pipeline/download.sh)')
    print('relacje:', os.path.basename(pbf), flush=True)
    rels.apply_file(pbf)
ways = Ways(rels.wanted)
for pbf in PBFS:
    print('drogi wodne:', os.path.basename(pbf), flush=True)
    ways.apply_file(pbf, locations=True, idx='flex_mem')

elements = list(ways.ways.values())
nrel = 0
for rid, r in rels.rels.items():
    got = [(ref, role) for ref, role in r['members'] if ref in ways.geom]
    if not any(touches(*ways.geom[ref][1]) for ref, _ in got):
        continue
    nrel += 1
    elements.append({'type': 'relation', 'id': rid, 'tags': r['tags'],
                     'members': [{'type': 'way', 'ref': ref, 'role': role, 'geometry': ways.geom[ref][0]} for ref, role in got]})
json.dump({'version': 0.6, 'generator': 'water-cut.py (Geofabrik: ' + ', '.join(NAMES) + ')', 'elements': elements},
          open(OUT, 'w', encoding='utf-8'))
print(f'woda: {len(ways.ways)} dróg, {nrel} relacji w {len(BOXES)} boksach -> {OUT}', flush=True)
