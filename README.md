# Berlin Public Transport — interactive map

Interactive, poster-grade map of the **whole Verkehrsverbund
Berlin-Brandenburg**: BVG's buses and trams, the nine U-Bahn and sixteen S-Bahn
lines, the county networks of all of Brandenburg — from the Prignitz to the
Lausitz, from the Uckermark to the Elbe-Elster — the tram towns of Potsdam,
Cottbus, Frankfurt (Oder), Brandenburg an der Havel, Woltersdorf, Schöneiche
and Strausberg, and the RB/RE regional trains that tie them together —
**1 123 lines / 23 555 stops / 56 901 km**, drawn along the real street and
track geometry, weighted mean matching error 1.94 m. The largest network in
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
| S-Bahn | 109 | the ring and its spokes, colours from the feed; the two foreign S-Bahn lines in the feed — DB Regio's Mittelelbe S1 (Wittenberge–Stendal–Schönebeck) and Mitteldeutschland S4 (Leipzig–Oschatz) — ship no colour and take the Verbund grey, not tram red | `railway=rail` + `light_rail` |
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
way; the raw stretches of the bus network fell from 76 km to 46 km. What
remains raw is mostly the Tiergartentunnel: M41 and M85 run Potsdamer Platz →
Hauptbahnhof with no stop between, i.e. through the tunnel, and the line
through the Spreebogen park is the tunnel's own alignment; the northbound
bore's connection to Washingtonplatz routes 7.6× the chord and stays a chord.
`npm run serve` hosts the map at <http://localhost:8162>.

Data: VBB — the whole Verkehrsverbund Berlin-Brandenburg ·
base map © OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.
