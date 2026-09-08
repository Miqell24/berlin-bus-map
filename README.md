# Berlin Public Transport — interactive map

Interactive, poster-grade map of the **whole Verkehrsverbund
Berlin-Brandenburg**: BVG's buses and trams, the nine U-Bahn and sixteen S-Bahn
lines, the county networks of all of Brandenburg — from the Prignitz to the
Lausitz, from the Uckermark to the Elbe-Elster — the tram towns of Potsdam,
Cottbus, Frankfurt (Oder), Brandenburg an der Havel, Woltersdorf, Schöneiche
and Strausberg, and the RB/RE regional trains that tie them together —
**1 123 lines / 23 610 stops / 58 184 km**, drawn along the real street and
track geometry, weighted mean matching error 1.96 m. The largest network in
this family of maps.

## Live

**https://miqell24.github.io/berlin-bus-map/** — GitHub Pages from `main:/docs`. Local build on port 8162 (`npm run serve`).

Everything comes from ONE feed — the **VBB GTFS** (<https://www.vbb.de/vbbgtfs>),
which covers the entire Verkehrsverbund: Berlin *and* all of Brandenburg, 1255
lines and 35 operators over 30 000 km². Until 8.09.2026 this map was the
metropolitan region — a 30 km radius around Alexanderplatz. It is now the
Verbund itself, and `pipeline/scope.mjs` → `data/scope.json` no longer cuts by
distance; it decides the modes, the Ersatzverkehr and the line keys:

| mode | route_type | on the map | graph |
|---|---|---|---|
| buses | 700 + 3 | every line of the Verbund | OSM roadways |
| trams | 900 | BVG, Potsdam, Cottbus, Frankfurt (Oder), Brandenburg a. d. H., Woltersdorf, Schöneiche, Strausberg | `railway=tram` |
| U-Bahn | 400 | U1–U9, colours from the feed | `railway=subway` |
| S-Bahn | 109 | the ring and its spokes, colours from the feed | `railway=rail` + `light_rail` |
| regional trains | 100 + 106 | every RB/RE and the FEX, colours from the feed, Verbund grey where it ships none | `railway=rail` |

Cut deliberately:

* **the ferries** (1000) — BVG's F10–F39 and Strausberg's F39; the engine has
  no water graph;
* **the Ersatzverkehr.** An operator numbers its rail-replacement buses after
  the line they replace, so the feed carries "buses" called U6, S7, M1 and
  RE2. The discriminator is per OPERATOR, not per name: a bus is a replacement
  when the *same agency* also runs a rail line of that name. That distinction
  matters now that the whole Verbund is on the map — Cottbusverkehr's buses
  12, 16, 18, 21, 27 and 37 are real buses, because Cottbus trams are 1–4, and
  a Verbund-wide name list would have swallowed all six. Budapest's *pótló* and
  London's "Replacement Service" set the precedent.

**Line keys.** Verbund-wide the numbers are not unique: 197 of them belong to
two operators or more — 401 is an Oder-Spree line *and* an Uckermark line, and
trams 1–4 run in Cottbus, Frankfurt (Oder) and Brandenburg an der Havel at
once. A shared number carries its operator's code in the key (`los:401`,
`uvg:401`, `cb:1`) and prints bare on the street; the panel groups its chips by
that operator, so the three trams that all print "1" sit under three headings.
The Randstad rule.

Four buses keep a rail name and are drawn as buses: RB34, RB66, RE30 and RE50
are lines the feed itself publishes as road services — long-term replacements
for track closures whose rail counterpart is not in the feed at all — so what
is on the map is what actually runs.

## Pipeline

`npm run download` fetches the VBB feed, computes the scope, and cuts the OSM
extracts. **The OSM data comes from Geofabrik, not Overpass**: a 307 × 288 km
box over German street density is far past what the public mirrors will serve
— they returned 504 already for the old 95 × 82 km frame — and the road grid
runs to 1.05 million ways. `pipeline/pbf-tiles.py` (needs
`pip3 install --user osmium`) cuts an 8 × 8 road grid, and the rail box the
trains need, out of **nine** extracts: `berlin` and `brandenburg` (Geofabrik's
Berlin file is the city alone and its Brandenburg file has the city cut out),
`mecklenburg-vorpommern`, `sachsen`, `sachsen-anhalt` and `niedersachsen` for
the lines that leave the Land, and the Polish `dolnoslaskie`, `lubuskie` and
`zachodniopomorskie` for RB91 to Rzepin, RB92 to Zielona Góra and RB93 to
Wrocław. It writes exactly the JSON shape Overpass would have returned, node
ids included.

`npm run build` map-matches every line (HMM/Viterbi on the OSM graphs) and
writes GeoJSON to `data/out/`; `npm run lines` adds the line-by-line view.
`npm run serve` hosts the map at <http://localhost:8162>.

Data: VBB — the whole Verkehrsverbund Berlin-Brandenburg ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
