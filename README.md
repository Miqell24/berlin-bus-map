# Berlin Public Transport — interactive map

Interactive, poster-grade map of the public transport network of **Berlin and
its Umland**: BVG's buses and trams, the ten U-Bahn lines, the sixteen S-Bahn
lines and the Brandenburg operators that reach into the city — Potsdam,
Oranienburg, Bernau, Strausberg, Königs Wusterhausen, Ludwigsfelde — drawn
along the real street and track geometry.

## Live

Local build on port 8162 (`npm run serve`).

Everything comes from ONE feed — the **VBB GTFS** (<https://www.vbb.de/vbbgtfs>),
which covers the entire Verkehrsverbund: Berlin *and* all of Brandenburg, 1254
lines over 30 000 km², from Prenzlau to Cottbus. The map is the metropolitan
region, so its scope is a precomputed allowlist (`pipeline/scope.mjs` →
`data/scope.json`):

| mode | route_type | scope | graph |
|---|---|---|---|
| buses | 700 + 3 | ≥50% of stops within 30 km of Alexanderplatz, no stop past 55 km | OSM roadways |
| trams | 900 | same radius rule — BVG, Potsdam, Woltersdorf, Schöneiche, Strausberg | `railway=tram` |
| U-Bahn | 400 | all ten lines, colours from the feed | `railway=subway` |
| S-Bahn | 109 | the ring and its spokes, colours from the feed | `railway=rail` + `light_rail` |

Thirty kilometres is not a round number: it is the reach of the Berlin C fare
zone. Potsdam (26 km), Oranienburg (30), Bernau (25), Strausberg (30), Königs
Wusterhausen (28) and Ludwigsfelde (27) are in; Fürstenwalde (55), Nauen (40)
and Brandenburg an der Havel (60) are out, and with them Cottbus and Frankfurt
(Oder) — which is also why the tram numbers never collide, since those three
cities number their trams 1–6.

Cut deliberately:

* **regional trains** (route_type 100 and 106) — a single RE to Wittenberge
  would stretch the frame across the whole Land;
* **the BVG ferries** F10–F39 (1000) — the engine has no water graph;
* **the Ersatzverkehr.** BVG runs rail-replacement buses under the *replaced
  line's own name*, so the feed carries buses called U6, S7, M1 and 12. The
  discriminator is exactly that name clash — a real Berlin bus is 100–399,
  M11–M85, X…, N… — and the same rule catches the RB/RE replacement coaches
  DB Regio and ODEG run. Budapest's *pótló* and London's "Replacement Service"
  set the precedent.

Line keys need nothing invented: VBB numbers every line uniquely across the
Verbund, and the five numbers that do repeat in scope (662, 733, 825, 893,
N13) are one line published twice by two co-operating operators, so they merge
on the shared key by themselves.

## Pipeline

`npm run download` fetches the VBB feed, computes the scope, and cuts the OSM
extracts. **The OSM data comes from Geofabrik, not Overpass**: a 95 × 82 km box
over German street density is more than the public mirrors will serve — every
round came back 504 — and the road grid alone runs to 690 000 ways.
`pipeline/pbf-tiles.py` (needs `pip3 install --user osmium`) cuts a 5 × 5 grid
out of `berlin-latest.osm.pbf` **and** `brandenburg-latest.osm.pbf` — two files
are needed because Geofabrik's Berlin extract is the city alone and its
Brandenburg extract has the city cut out — writing exactly the JSON shape
Overpass would have returned, node ids included.

`npm run build` map-matches every line (HMM/Viterbi on the OSM graphs) and
writes GeoJSON to `data/out/`; `npm run lines` adds the line-by-line view.
`npm run serve` hosts the map at <http://localhost:8162>.

Data: VBB (Verkehrsverbund Berlin-Brandenburg) ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
