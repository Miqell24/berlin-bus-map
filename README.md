# Berlin Public Transport — interactive map

Interactive, poster-grade map of the **whole Verkehrsverbund
Berlin-Brandenburg**: BVG's buses and trams, the nine U-Bahn and sixteen S-Bahn
lines, the county networks of all of Brandenburg — from the Prignitz to the
Lausitz, from the Uckermark to the Elbe-Elster — the tram towns of Potsdam,
Cottbus, Frankfurt (Oder), Brandenburg an der Havel, Woltersdorf, Schöneiche
and Strausberg, and the RB/RE regional trains that tie them together —
**1 123 lines / 23 555 stops / 56 901 km**, drawn along the real street and
track geometry, weighted mean matching error 1.94 m — and, since 14.09.2026,
the seven ferries on the water they cross. The largest network in this family
of maps.

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
| S-Bahn | 109 | the ring and its spokes, colours from the feed; the two foreign S-Bahn lines in the feed — DB Regio's Mittelelbe S1 (Wittenberge–Stendal–Schönebeck) and Mitteldeutschland S4 (Leipzig–Oschatz) — ship no colour and take the Verbund grey, not tram red | `railway=rail` + `light_rail` |
| regional trains | 100 + 106 | every RB/RE and the FEX, colours from the feed, Verbund grey where it ships none | `railway=rail` |
| ferries | 1000 | BVG's F10, F11, F12, F21, F23, F24 and Strausberg's F39, dashed purple | water courses from `pipeline/ferries.mjs` |

Cut deliberately:

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

Everything that reads a line *as text* has to look through that code, not at
it — and until 10.09.2026 three things did not. The colour palette was keyed
by the bare number, so Berlin's own S1 (keyed `sbahn:S1`, because DB Regio's
S-Bahn Mittelelbe S1 Wittenberge–Magdeburg is in the feed too) missed its pink
and fell to the mode colour: the whole Nordbahn, S1+S2+S25+S26, drew in tram
red. The rail test (`isRailTrunk`, which decides the trunk treatment and the
panel's "Trains" heading) missed the same keys, and `meta.json` carried no
`metro` flag at all — every train sat under "Trams" in the panel. And the sort
compared raw keys, so Frankfurt (Oder)'s trams read "5, 2" (only 1–4 collide
Verbund-wide; `5` sorted before `ffo:2`). All three now sort, colour and
classify on the printed label, the key only as a tie-break.

Four buses keep a rail name and are drawn as buses: RB34, RB66, RE30 and RE50
are lines the feed itself publishes as road services — long-term replacements
for track closures whose rail counterpart is not in the feed at all — so what
is on the map is what actually runs.

## The ferries (14.09.2026)

Seven ferry lines cross the Verbund's water — F10 Wannsee–Kladow over the Havel,
F11 Baumschulenweg–Wilhelmstrand over the Spree, F12 over the Langer See, F21
to Krampenburg in the Große Krampe, F23 along the Müggelspree to the Müggelsee,
the rowing ferry F24 at Rahnsdorf and the Straussee ferry F39 — and nothing in the inputs draws
them: the road graph ends at the landing stages, and VBB's shapes are chords
straight over the land. `pipeline/ferries.mjs` makes the water itself the
network, with the method Copenhagen's harbour buses use:

1. **Water.** `pipeline/water-cut.py` cuts the rivers, lakes (`natural=water`,
   `waterway=riverbank`) and piers around every ferry line out of the
   `berlin` and `brandenburg` extracts — a water relation whole, every member,
   so its rings close. Overpass answered 504 on every mirror.
2. **Areas.** The lines lie up to 50 km apart, so the stops are grouped by the
   lines joining them and every group gets a 4 m occupancy grid of its own
   (its stops plus 1.5 km): six grids, F23 and F24 sharing Kruggasse. Water
   polygons are scan-filled, piers cut back out as land — a pier outline
   whole, a landing stage drawn as a line one cell wide.
3. **Berths.** A stop stands on land, never out on the water: its berth is the
   pier cell nearest to the feed's coordinate, or the bank two cells (≈ 6 m)
   behind the water's edge, on a water body of 2 ha or more (never a garden
   pond). Ten of the fifteen stops land on their pier within 3 m.
4. **Straight crossings.** Most of these ferries go from one bank to the other.
   Where the straight line between two berths stays on the water, clear of the
   banks by 0.3 m per metre out of each berth (up to 15 m), that line is the
   crossing: F11, F12, F24, F39.
5. **Routed courses.** A leg that would cross land (F10 through the Großer
   Wannsee, F21 round Krampenburg, F23 along the Müggelspree) is routed: A*
   through water at least 6 m from the banks, pulled to mid-channel, simplified,
   relaxed by a bending (bi-Laplacian) flow, then docked — each call vertex
   carried onto its berth, the course following over up to 90 m either side —
   and bent smooth again with the calls pinned.
6. **Proof.** Every course is sampled every metre against the mask; only the
   14 m out of each berth may be land. A land sample anywhere else stops the
   script before anything is written.
7. **Output.** One synthetic `route=ferry` way per stretch of named water goes
   to `data/osm/berlin-ferry.json`, with the berth of every stop. The build's
   `ferry` mode puts each stop at its berth and matches the stop sequences on
   that graph; a match that would leave the water (a raw stretch or a Viterbi
   break) is dropped rather than drawn.

The frontend draws the courses dashed purple on a white casing, under the street
casing so the bridges pass over them; the landing stages are full discs, and
the mode has its own toggle and its own "Ferries" heading in the line list.

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

`npm run download` also cuts the ferries' water and runs `pipeline/ferries.mjs`
(see above). `npm run build` map-matches every line (HMM/Viterbi on the OSM
graphs) and writes GeoJSON to `data/out/`; `npm run lines` adds the
line-by-line view.

**Two repairs after matching (10.09.2026, user report: stubs and lines through
buildings).** *Out-and-back stubs* — `trimSpurs`, the family's trim (Belgrade,
Naples, Timișoara…): a path that leaves the corridor, touches a point and
comes straight back along the same segments is the matcher reaching for an
observation that sits off the carriageway, and VBB's bus shapes invite it —
outside the city they are stop-to-stop sketches, 247's whole Gartenplatz block
is five shape points, so every pole on the far side of a junction pulled a comb
of stubs out of the route. An excursion up to 300 m out is cut unless a stop is
served only by it. The first full run cut 12 716 of them from 1 832 runs, and
1 284 km came off the network — almost all of it phantom mileage: on a rural
corridor the matcher had been doubling back over the road it was already on
(789 through Kallinchen, 726 through Neuendorf), so the line's length fell while
the drawn street did not change; where a stop sits only on the excursion (789
at Zossen, Straße der Befreiung) the excursion stays. *Chords through
buildings* — a shape-gap leg whose routed bridge comes out more than 2.2× the
straight line is refused and drawn as the raw chord, which is right where the
chord IS a road OSM lacks and wrong where it crosses a mall or a park: Potsdam's
694 left its terminus with a 543 m line straight through the Stern-Center, the
1 269 m bus loop around it refused at 2.34×. The chord itself now decides,
walked every 25 m: three consecutive samples with no road but a driveway, a
fire lane or a mall lane within 40 m (`svc` on the graph segment) mean the
detour is the truth, and it is taken up to 4× the chord. 40 legs turned that
way; the raw stretches of the bus network fell from 76 km to 46 km. *The
Tiergartentunnel* — M41 and M85 run Potsdamer Platz → Hauptbahnhof with no stop
between, i.e. through the tunnel, but VBB digitised it on the surface, 30–100 m
east of the bores, so the matcher snapped their points to the Kanzleramt's
service roads and Straße des 17. Juni and the line broke at every junction
along it. That is a feed error, repaired in the data (`shapeFix` on the bus
mode, user rule): every shape point of the two lines inside the tunnel box is
projected onto the nearest OSM way named "Tunnel Tiergarten Spreebogen" — the
bores and the Bellevuestraße and Hauptbahnhof ramps alike — that runs WITH the
point's direction of travel: the two bores are oneway and 12–20 m apart, and
a point dropped on the wrong one broke the line and zigzagged it under Straße
des 17. Juni. 130 points moved (Bellevuestraße ramp to the top of the
Hauptbahnhof ramps); both lines now match with no break and no raw trace in
either direction, and the Hauptbahnhof gap that used to be drawn as a chord
across the Spree is the ramp onto Invalidenstraße.
`npm run serve` hosts the map at <http://localhost:8162>.

Data: VBB — the whole Verkehrsverbund Berlin-Brandenburg ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
