// GTFS → OSM graph → map matching (HMM) → GeoJSON files for the frontend.
// Berlin: ONE feed for the entire VBB — Berlin plus all of Brandenburg — cut
// down to the metropolitan region by a precomputed allowlist (scope.mjs →
// data/scope.json). Four modes out of the one bundle: BVG and the Umland
// operators' buses navy, the trams family red, and on the fixed-track side
// the U-Bahn and the S-Bahn in the colours the feed itself ships (VBB is one
// of the few here that fills route_color), both drawn with the trunk
// treatment — wide ribbon, station discs, always-on names.
// Usage: node pipeline/build.mjs [--all | lines...] [--tram all|M4,U6,S41]
// Results land in shared files with properties.color/mode, so the frontend styles
// them data-driven.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';
import { makeProj, resample, nearestOnPolyline, polylineLength } from './lib/geo.mjs';
import { buildGraph, railKind } from './lib/graph.mjs';
import { matchShape, extendToStops } from './lib/hmm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Exact-match repairs for poles a feed names badly. VBB needs none: 42 104
// stop names, not one of them shouted — the family caps audit found the feed
// clean, and the "(Berlin)" tag every city pole carries is handled per feed
// by deBerlin, not here.
const NAME_FIX = {};
// m — longer jumps between shape points are GTFS data gaps. Inside a real gap
// the HMM bridges by routing instead of interpolating observations, which would
// fabricate straight-line detours through side streets.
const GAP_MIN = 300;
const VERBOSE_SPURS = process.env.BUILD_SPUR_LOG === '1';
// m — a pole closer than this to the matched axis is inside the track corridor:
// its coordinate carries no usable side signal and the half-disc falls back to
// the right-hand rule (see the stop pass). Named after the case that set it:
// both direction poles of Dąb Silesia City Center share one point.
const SIDE_CORRIDOR = 6;

const TROLLEY_GREEN = '#149a3f';
const TROLLEY_DARK = '#0a5121';
// the Metrobús BRT corridors — amber, apart from the navy street buses; they
// ride the props the GZM metrolines used (mline/mstop/mall/msome), as Rio's BRT
// and Cairo's paratransit do
const MLINE_YELLOW = '#e8a000';
const MLINE_DARK = '#7d5600';

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
// Natural line order everywhere lists are composed (street number rows,
// badge grids, meta): keys split into alpha prefix, numeric core and suffix,
// so 9 < 10 holds inside every family (7 before 7N, M2 before M10) and the
// letter families stay grouped after the bare numbers. The old Number()-based
// compare left anything non-pure-numeric to lexicographic order.
const keyParts = (s) => {
  const m = /^(\D*)(\d*)(.*)$/.exec(s);
  return [m[1], m[2] ? Number(m[2]) : Infinity, m[3]];
};
const cmpParts = (a, b) => {
  const A = keyParts(a), B = keyParts(b);
  return A[0].localeCompare(B[0]) || (A[1] - B[1]) || A[2].localeCompare(B[2]);
};
// …on the PRINTED number, with the key only as a tie-break. Sorting the raw
// keys let the operator code decide the order: Frankfurt (Oder) numbers its
// trams 1-5 but only 1-4 collide Verbund-wide, so the keys read `5`, `ffo:1`,
// `ffo:2`… and every row there came out "5, 2" or "5, 1, 3, 4". Same for the
// S-Bahn — `sbahn:S1` sorted behind S2 — and for `hanse:RB33` behind RB34.
const numSort = (a, b) => cmpParts(bare(a), bare(b)) || cmpParts(a, b);
function round6(v) { return Math.round(v * 1e6) / 1e6; }
// dark variant for feed-supplied line colors (badge rims / terminus fills)
function darken(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v * (1 - f)).toString(16).padStart(2, '0');
  return '#' + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255);
}

// Weld dangling subway endpoints (nodes used by ONE way only) to the nearest
// vertex of another subway way within 60 m, as synthetic two-node ways.
// Service tracks stay excluded — this only reconnects the mainline tunnels
// that OSM left as islands (see the call site for the Bucharest specifics).
function weldRailGaps(elements) {
  const SERVICE_X = new Set(['yard', 'siding', 'spur', 'crossover']);
  const ways = elements.filter((e) => e.type === 'way' && e.tags?.railway === 'subway'
    && !SERVICE_X.has(e.tags?.service) && e.nodes && e.geometry);
  const nodeUse = new Map();
  for (const w of ways) for (const n of w.nodes) nodeUse.set(n, (nodeUse.get(n) || 0) + 1);
  let synId = -1e9, added = 0;
  for (const w of ways) {
    for (const end of [0, w.nodes.length - 1]) {
      const nid = w.nodes[end];
      if (nodeUse.get(nid) > 1) continue;
      const p = w.geometry[end];
      const kx = 111320 * Math.cos(p.lat * Math.PI / 180);
      let best = null;
      for (const o of ways) {
        if (o === w) continue;
        for (let i = 0; i < o.nodes.length; i++) {
          const g = o.geometry[i];
          const d = Math.hypot((g.lat - p.lat) * 111320, (g.lon - p.lon) * kx);
          if (d < 60 && (!best || d < best.d)) best = { d, nid: o.nodes[i], g };
        }
      }
      if (best) {
        elements.push({
          type: 'way', id: synId--, nodes: [nid, best.nid],
          geometry: [p, best.g], tags: { railway: 'subway' },
        });
        nodeUse.set(nid, 2);
        nodeUse.set(best.nid, (nodeUse.get(best.nid) || 0) + 1);
        added++;
      }
    }
  }
  return added;
}

// ---------- CLI ----------
const ARGS = process.argv.slice(2);
let tramLines = [];
const ti = ARGS.indexOf('--tram');
const busArgs = [...ARGS];
if (ti >= 0) {
  tramLines = (ARGS[ti + 1] || '').split(',').filter(Boolean);
  busArgs.splice(ti, 2);
}
const busAll = busArgs.includes('--all');
const busList = busArgs.filter((a) => a !== '--all');
// --tram feeds four rail cfgs here, told apart by the name itself: U… is the
// U-Bahn, S… the S-Bahn, RB/RE/FEX the regional trains, everything else
// (M1–M17, 12–99, and the 1–6 of the three Brandenburg town networks) a tram
const uSel = tramLines.filter((l) => /^U\d/.test(l));
const sSel = tramLines.filter((l) => /^S\d/.test(l));
const rSel = tramLines.filter((l) => /^(RB|RE|FEX)/.test(l));
const tramSel = tramLines.filter((l) => l !== 'all' && !/^[US]\d/.test(l) && !/^(RB|RE|FEX)/.test(l));

// ONE feed for the whole Verbund, FIVE cfgs.
//
// VBB publishes a single GTFS for Berlin AND all of Brandenburg — 1255 lines
// over 30 000 km². Until 8.09.2026 this map was the metropolitan region
// (30 km around Alexanderplatz); it is now the Verbund itself, so
// pipeline/scope.mjs no longer cuts by distance. What it still decides is in
// data/scope.json: the route lists per mode, the Ersatzverkehr (buses an
// operator numbers after its own rail line — BVG's bus "M2", DB Regio's bus
// "RE2"; the discriminator is the agency, because Cottbus really does run
// buses 12–37 next to its trams 1–4) and the LINE KEYS.
//
// Route types are the extended German set — 700 and 3 both mean "bus" here,
// 900 tram, 400 U-Bahn, 109 S-Bahn, 100 and 106 the RB/RE regional trains.
//
// Cut deliberately: the ferries (1000 — BVG's F10–F39 and Strausberg's F39;
// the engine has no water graph).
//
// LINE KEYS: Verbund-wide the numbers are NOT unique — 197 of them are used
// by two operators or more (Oder-Spree and the Uckermark both number their
// county lines 4xx; trams 1–4 run in Cottbus, Frankfurt (Oder) AND Brandenburg
// an der Havel). A shared number carries its operator's code in the KEY
// (los:401, uvg:401, cb:1) and prints bare on the street through LBL; the
// panel groups its chips by the same code. The Randstad rule.
const LBL = new Map();
const LINE_OP = new Map();   // line key → operator code (panel grouping)

// the allowlist that IS the map's scope — build refuses to guess without it
const SCOPE_FILE = join(ROOT, 'data/scope.json');
if (!existsSync(SCOPE_FILE)) {
  console.error('data/scope.json missing — run `node pipeline/scope.mjs` (npm run download does it)');
  process.exit(1);
}
const SCOPE = JSON.parse(readFileSync(SCOPE_FILE, 'utf8'));
const S_BUS = new Set(SCOPE.bus), S_TRAM = new Set(SCOPE.tram),
  S_UBAHN = new Set(SCOPE.ubahn), S_SBAHN = new Set(SCOPE.sbahn),
  S_RAIL = new Set(SCOPE.rail);
const KEY = SCOPE.key || {}, OP = SCOPE.op || {};

// The U-Bahn, S-Bahn and regional colours come from the feed itself (VBB is
// one of the few in this family that ships route_color), harvested below per
// line: several route rows exist per line and only some carry the colour —
// S1, S8 and S85 are blank on the row the reader happens to hit first.
// Trams and buses stay family navy/red: colour means the MODE there.
//
// Harvested under the LINE KEY, not the bare number. Two of the Verbund's
// S-lines are somebody else's S-Bahn — DB Regio's S1 Wittenberge–Stendal–
// Schönebeck (S-Bahn Mittelelbe) and its S4 Leipzig–Oschatz — so "S1" belongs
// to two operators and scope.mjs keys them apart (sbahn:S1, db:S1). Keying the
// palette by the bare number instead cost Berlin's own S1 its pink: the lookup
// missed, the line fell through to the mode colour, and every corridor it
// shares went TRAM RED with it — the whole Nordbahn, S1+S2+S25+S26.
const ALL_ROUTES = await readCsv(join(ROOT, 'data/gtfs/routes.txt'));
const BER_COLORS = {};
for (const r of ALL_ROUTES) {
  if (!['400', '109', '100', '106'].includes(r.route_type)) continue;
  const sn = (r.route_short_name || '').trim();
  if (!sn) continue;
  const k = KEY[r.route_id] || sn;
  if (k !== sn) LBL.set(k, sn);
  if (BER_COLORS[k]) continue;
  if (/^[0-9A-F]{6}$/i.test(r.route_color || '')) BER_COLORS[k] = '#' + r.route_color.toUpperCase();
}
// U12 is the weekend U1×U2 through service and the feed leaves it blank —
// BVG's own map draws it as U1 green over U2 red, and a single ribbon has to
// pick one: it keeps U1's green, the corridor it shares for most of its run.
BER_COLORS.U12 ||= '#7DAD4C';
// 16 of the 53 regional lines ship no colour: VBB's own network map paints
// the RB lines that carry no house colour in the Verbund grey. The two
// foreign S-Bahn lines take it too — they are outside Berlin's livery, and
// the family rule is that an operator's colours are worn only where that
// operator publishes a COMPLETE set.
const RAIL_GREY = '#5E5E5D';

// The number as the street sees it: a key carries an operator code wherever
// the Verbund reuses a number (los:401, ffo:2, sbahn:S1), the printed label
// never does. Everything that reads a line AS TEXT — the colour table, the
// rail test, the sort — has to look through the code, not at it.
const bare = (k) => LBL.get(k) || k;

// Metro treatment (wide ribbon, station discs, always-on names): the U-Bahn,
// the S-Bahn and the regional trains — everything that is a train here.
// Colour alone cannot decide it: the two foreign S-Bahn lines and 16 of the
// RB lines ship none, and an S-Bahn drawn as a tram is exactly what the
// reader must not see.
const isRailTrunk = (l) => l in BER_COLORS || /^(U\d|S\d|RB|RE|FEX)/.test(bare(l));

// The key a route draws under: its number, or `<operator>:<number>` where the
// number belongs to several operators (scope.mjs decides which). The operator
// code never reaches the street — LBL prints the bare number.
const lineKey = (sn, r) => {
  const k = KEY[r.route_id] || sn;
  if (!k) return null;
  if (k !== sn) LBL.set(k, sn);
  if (OP[r.route_id]) LINE_OP.set(k, OP[r.route_id]);
  return k;
};

// Stop names as the city signs them: VBB tags every Berlin pole "(Berlin)"
// and writes the Brandenburg ones "Potsdam, Weinmeisterweg". On a Berlin map
// the first is noise on every second label; the town prefix outside the city
// is the opposite — it is the only thing telling Bahnhof from Bahnhof.
// The square brackets go too: forty-odd poles carry a dispatcher's note in
// them ("[Pos 7 Endstelle]", "[Busbahnhof]", "[Bus Réaumurstr.]") that is on
// nobody's stop flag, and "U Alexanderplatz (Berlin) [Tram]" hid the tag from
// the (Berlin) rule by not ending on it.
const deBerlin = (n) => n
  .replace(/\s*\[[^\]]*\]/g, '')
  .replace(/\s*\(Berlin\)$/, '')
  .replace(/^Berlin,\s*/, '')
  .replace(/\s+/g, ' ')
  .trim();

const MODES = [{
  mode: 'bus', label: 'buses', graphMode: 'road',
  // The whole Verbund — 8 × 8 tiles over 307 × 288 km cut out of nine
  // Geofabrik extracts (see pipeline/pbf-tiles.py); merged at load, ways
  // deduped by id
  osmFiles: Array.from({ length: 64 }, (_, i) => `data/osm/tiles/t${i + 1}.json`),
  color: '#0059a9', colorDark: '#00294f',
  all: busAll, lines: busList.length ? busList : (busAll ? [] : ['100']),
  feeds: [
    { tag: 'vbb', dir: 'data/gtfs', routeTypes: ['700', '3'],
      skipRoute: (r) => !S_BUS.has(r.route_id), mapKey: lineKey, nameFix: deBerlin },
  ],
}];
const tramAll = tramLines.length === 1 && tramLines[0] === 'all';
if (tramAll || tramSel.length) MODES.push({
  // Seven networks: BVG's M1–M17 and 12–68, Potsdam's 91–99, the three
  // village lines the S-Bahn ends at — Woltersdorf (87), Schöneiche–
  // Rüdersdorf (88), Strausberg (89) — and, since the map became the whole
  // Verbund, Cottbus, Frankfurt (Oder) and Brandenburg an der Havel, which
  // all number from 1 (hence the operator codes in the keys)
  mode: 'tram', label: 'trams', osmFile: 'data/osm/berlin-rail.json',
  graphMode: 'tram', railKeep: new Set(['tram']),
  color: '#d6212b', colorDark: '#7c1116',
  all: tramAll, lines: tramAll ? [] : tramSel,
  feeds: [
    { tag: 'vbb', dir: 'data/gtfs', routeTypes: ['900'],
      skipRoute: (r) => !S_TRAM.has(r.route_id), mapKey: lineKey,
      nameFix: deBerlin },
  ],
});
if (tramAll || uSel.length) MODES.push({
  mode: 'tram', label: 'U-Bahn', osmFile: 'data/osm/berlin-rail.json',
  graphMode: 'tram', railKeep: new Set(['subway']),
  color: '#d6212b', colorDark: '#7c1116',
  all: tramAll, lines: tramAll ? [] : uSel,
  feeds: [
    // no allVariants: Berlin's U-Bahn has no branches — every line is one
    // corridor end to end, so the 245 stop-patterns the feed ships are pure
    // short-turns and the representative-variant rule draws each line whole
    { tag: 'vbb', dir: 'data/gtfs', routeTypes: ['400'],
      skipRoute: (r) => !S_UBAHN.has(r.route_id), mapKey: lineKey,
      lineColor: (k) => BER_COLORS[k], nameFix: deBerlin },
  ],
});
if (tramAll || sSel.length) MODES.push({
  // The S-Bahn rides mainline rail, so its slice of the graph is railway=rail
  // (plus the light_rail the Ringbahn is tagged with in places); allMetro
  // gives every line the trunk treatment without an M-prefix to key off.
  // No allVariants either: every Berlin S-line is one corridor end to end —
  // where a branch exists it carries its own number (S25/S26, S46/S47,
  // S8/S85, S41/S42) — so the 1482 stop-patterns the feed ships were pure
  // short-turns, and drawing them all put 50 000 km on a 25 000 km network.
  mode: 'tram', label: 'S-Bahn', osmFile: 'data/osm/berlin-rail.json',
  graphMode: 'tram', railKeep: new Set(['rail']),
  railExtra: (e) => e.tags?.railway === 'light_rail',
  allMetro: true,
  color: '#d6212b', colorDark: '#7c1116',
  all: tramAll, lines: tramAll ? [] : sSel,
  feeds: [
    { tag: 'vbb', dir: 'data/gtfs', routeTypes: ['109'],
      skipRoute: (r) => !S_SBAHN.has(r.route_id), mapKey: lineKey,
      lineColor: (k) => BER_COLORS[k] || RAIL_GREY, nameFix: deBerlin },
  ],
});
if (tramAll || rSel.length) MODES.push({
  // The regional trains — 67 RB/RE lines plus the FEX airport express — are
  // what makes the Verbund one network rather than a scatter of town systems,
  // and they are the reason this map covers 30 000 km². They ride mainline
  // rail, get the trunk treatment (allMetro) like the S-Bahn, and wear the
  // colours VBB's own network map gives them; the 16 lines the feed leaves
  // blank take the Verbund grey.
  //
  // They leave the Verbund too — the frame ends where they do: Stralsund and
  // Schwerin in the north, Magdeburg and Leipzig in the west, Dresden and
  // Görlitz in the south, Szczecin, Zielona Góra and Wrocław in the east —
  // which is why pbf-tiles.py cuts rails from nine Geofabrik extracts, three
  // of them Polish.
  mode: 'tram', label: 'regional rail', osmFile: 'data/osm/berlin-rail.json',
  graphMode: 'tram', railKeep: new Set(['rail']),
  allMetro: true,
  color: '#d6212b', colorDark: '#7c1116',
  all: tramAll, lines: tramAll ? [] : rSel,
  feeds: [
    { tag: 'vbb', dir: 'data/gtfs', routeTypes: ['100', '106'],
      skipRoute: (r) => !S_RAIL.has(r.route_id), mapKey: lineKey,
      lineColor: (k) => BER_COLORS[k] || RAIL_GREY, nameFix: deBerlin },
  ],
});

// Feed coordinate fixes: poles the GTFS places on the wrong street, keyed by
// `<feed tag>:<stop_id>` with the coordinates of that stop's node in OSM. A
// misplaced pole is not only a dot in the wrong place: where a feed ships no
// shapes, the stop sequence IS the matching observation, so the whole line gets
// dragged into a detour. Empty until a pole is found to be wrong.
const STOP_FIX = {};

function mergeRuns(all) {
  const merged = [];
  const byKey = new Map();
  for (const r of all) {
    if (r.roundabout) { merged.push(r); continue; }
    const k = r.linesKey + '\u0000' + (r.name || '');
    let arr = byKey.get(k);
    if (!arr) byKey.set(k, (arr = []));
    arr.push(r);
  }
  const pk = (c) => c[0] + ',' + c[1];
  for (const arr of byKey.values()) {
    const ends = new Map();
    arr.forEach((r, i) => {
      for (const [k, end] of [[pk(r.coords[0]), 0], [pk(r.coords[r.coords.length - 1]), 1]]) {
        let l = ends.get(k);
        if (!l) ends.set(k, (l = []));
        l.push({ i, end });
      }
    });
    const used = new Array(arr.length).fill(false);
    const free = (k) => (ends.get(k) || []).filter((e) => !used[e.i]);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < arr.length; i++) {
        if (used[i]) continue;
        const r = arr[i];
        const k0 = pk(r.coords[0]), k1 = pk(r.coords[r.coords.length - 1]);
        let coords;
        if (pass === 0) {
          if (free(k0).length === 1) coords = [...r.coords];
          else if (free(k1).length === 1) coords = [...r.coords].reverse();
          else continue;
        } else coords = [...r.coords];
        used[i] = true;
        const names = new Set(r.name ? [r.name] : []);
        for (;;) {
          const cands = free(pk(coords[coords.length - 1]));
          if (cands.length !== 1) break; // fork/end — we do not guess
          const { i: ni, end } = cands[0];
          const nr = arr[ni];
          used[ni] = true;
          const add = end === 0 ? nr.coords : [...nr.coords].reverse();
          for (let p = 1; p < add.length; p++) coords.push(add[p]);
          if (nr.name) names.add(nr.name);
        }
        merged.push({ coords, name: [...names][0] || '', linesKey: r.linesKey, roundabout: 0 });
      }
    }
  }
  return merged;
}

// Segment index for a matched path: the graph segment each consecutive pair of
// path vertices IS, looked up on rounded coordinates (the path is built out of
// graph nodes, so the pairs match exactly).
function pairIndex(graph) {
  if (graph._pairIdx) return graph._pairIdx;
  const m = new Map();
  const k = (x1, y1, x2, y2) => `${x1.toFixed(1)}|${y1.toFixed(1)}|${x2.toFixed(1)}|${y2.toFixed(1)}`;
  graph.segs.forEach((g, i) => {
    m.set(k(g.ax, g.ay, g.bx, g.by), i);
    m.set(k(g.bx, g.by, g.ax, g.ay), i);
  });
  graph._pairIdx = m;
  return m;
}
function segsOfPath(graph, coords) {
  const idx = pairIndex(graph);
  const k = (x1, y1, x2, y2) => `${x1.toFixed(1)}|${y1.toFixed(1)}|${x2.toFixed(1)}|${y2.toFixed(1)}`;
  const out = new Set();
  for (let i = 0; i + 1 < coords.length; i++) {
    const si = idx.get(k(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
    if (si !== undefined) out.add(si);
  }
  return out;
}

// Out-and-back stubs — the "ogonki". A matched path that leaves the corridor,
// touches a point and comes straight back along the same segments is almost
// never a service pattern: it is the matcher reaching for an observation that
// sits off the carriageway. VBB's bus shapes invite it, because outside the
// city they are stop-to-stop sketches — 247's whole Gartenplatz block is five
// shape points — so the drawing between poles is routing, and every pole the
// route passes on the far side of a junction pulls a stub out of it.
//
// m of detour; a longer one is a service pattern. Naples caps this at 120,
// Belgrade needs 300 and so does the Verbund: its county lines detour deep
// into villages, and those excursions all serve a stop, which protects them.
const SPUR_MAX = 300;
const SPUR_STOP = 30;    // m — how close a stop must be to count as served
const SPUR_WIN = 40;     // points to look ahead for the return to a visited point
function trimSpurs(coords, stopsXY, removed) {
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  const pathDist = (p, line) => (line.length > 1 ? nearestOnPolyline(p[0], p[1], line).d : Infinity);
  let out = coords.slice();
  for (let i = 0; i + 2 < out.length; i++) {
    let j = -1;
    for (let k = Math.min(i + SPUR_WIN, out.length - 1); k > i + 1; k--) {
      if (same(out[i], out[k])) { j = k; break; }
    }
    if (j < 0) continue;
    let len = 0;
    for (let t = i; t < j; t++) len += Math.hypot(out[t + 1][0] - out[t][0], out[t + 1][1] - out[t][1]);
    if (len > 2 * SPUR_MAX) continue;                      // out and back = twice the detour
    const spur = out.slice(i, j + 1);
    const rest = [...out.slice(0, i + 1), ...out.slice(j)];
    const serves = stopsXY.some((st) => {
      const ds = pathDist(st, spur.slice(1, -1).length ? spur : []);
      return ds < SPUR_STOP && ds < pathDist(st, rest) - 10;
    });
    if (serves) continue;
    removed.push(spur);
    out = rest;
    i = Math.max(-1, i - 1);
  }
  return out;
}

async function processMode(cfg) {
  log(`== ${cfg.label} ==`);
  // per-line colors (metro/tram/trolleybus): a run keeps a line color only when
  // EVERY line of the set shares it (an all-trolleybus street is green); any mix
  // falls back to the mode color (a bus+trolleybus street stays navy — the green
  // is added there as a dashed overlay by the frontend)
  // an all-metro mixed set (the shared M1+M3 tunnel, Eroilor–Dristor) must
  // NOT fall back to the mode color — that is the tram red, and a metro
  // ribbon in tram red reads as a tram line. Purple = "several metro lines".
  const METRO_MIX = '#7d2b8b', METRO_MIX_DARK = '#45164e';
  const isMetroMix = (lines) => cfg.mode === 'tram' && lines.length > 1 && lines.every(isRailTrunk);
  const colorOf = (lines) => {
    if (!cfg.lineColors) return cfg.color;
    const c = cfg.lineColors[lines[0]] || cfg.color;
    for (const l of lines) if ((cfg.lineColors[l] || cfg.color) !== c) return isMetroMix(lines) ? METRO_MIX : cfg.color;
    return c;
  };
  const colorDarkOf = (lines) => {
    if (!cfg.lineColorsDark) return cfg.colorDark;
    const c = cfg.lineColorsDark[lines[0]] || cfg.colorDark;
    for (const l of lines) if ((cfg.lineColorsDark[l] || cfg.colorDark) !== c) return isMetroMix(lines) ? METRO_MIX_DARK : cfg.colorDark;
    return c;
  };
  cfg.trolleySet = new Set(); // route_type 11 — green per-line color on the bus mode
  cfg.mlineSet = new Set(); // the Metrobús corridors — filled from feed.mline below
  cfg.lineColors = {};
  cfg.lineColorsDark = {};

  // ---------- 1–5) four feeds, one network ----------
  // Every feed loads under its tag: stop ids are namespaced (`ryb:1234`) so the
  // per-pole aggregation never welds different operators' ids, and the line key
  // comes from the feed's mapKey (null = skip the route). Reps of all feeds
  // merge into ONE list — matching, streets, labels and badges downstream see a
  // single network.
  const stopsById = new Map();
  let reps = [];
  const keyFeeds = new Map(); // line key → Set of feed tags (collision check)
  for (const feed of cfg.feeds) {
    const fdir = join(ROOT, feed.dir);
    const shapesFile = join(fdir, 'shapes.txt');
    // guard inherited from sibling cities: a header-only shapes.txt counts as absent
    const hasShapes = existsSync(shapesFile) && statSync(shapesFile).size > 200;
    // more trips sampled when stop sequences ARE the geometry: the longest run
    // must win over short-turn variants
    const tripCap = hasShapes ? 40 : 200;

    const routeToLine = new Map();
    for (const r of await readCsv(join(fdir, 'routes.txt'))) {
      if (feed.routeTypes && !feed.routeTypes.includes((r.route_type || '').trim())) continue;
      if (feed.skipRoute && feed.skipRoute(r)) continue;
      // feed quirk: some short names carry stray whitespace ("14 " vs "14")
      const key = feed.mapKey((r.route_short_name || '').trim(), r);
      if (!key) continue;
      routeToLine.set(r.route_id, key);
      if ((feed.trolley && feed.trolley(r)) || r.route_type === '11') {
        cfg.trolleySet.add(key);
        cfg.lineColors[key] = TROLLEY_GREEN;
        cfg.lineColorsDark[key] = TROLLEY_DARK;
      } else if (feed.mline && feed.mline(r)) {
        cfg.mlineSet.add(key);
        cfg.lineColors[key] = MLINE_YELLOW;
        cfg.lineColorsDark[key] = MLINE_DARK;
      } else if (['0', '1', '2', '6'].includes(r.route_type) && /^[0-9A-F]{6}$/i.test(r.route_color || '')) {
        // the feed ships the official line colours — metro M1 blue, M2 red,
        // SKM S1 coral, S2 blue, S3 amber, S4 green, S40 light green
        cfg.lineColors[key] = '#' + r.route_color.toUpperCase();
        cfg.lineColorsDark[key] = darken('#' + r.route_color, 0.45);
      }
      if (feed.lineColor) {
        const c = feed.lineColor(key);
        if (c) { cfg.lineColors[key] = c; cfg.lineColorsDark[key] = darken(c, 0.45); }
      }
      let s = keyFeeds.get(key);
      if (!s) keyFeeds.set(key, (s = new Set()));
      s.add(feed.tag);
    }
    if (cfg.trolleySet.size || cfg.mlineSet.size) {
      log(`${feed.tag}: ${cfg.trolleySet.size} trolleybus lines (green), ` +
          `${cfg.mlineSet.size} Metrobús corridors (amber), ` +
          `${routeToLine.size - cfg.trolleySet.size - cfg.mlineSet.size} other bus lines`);
    }

    // direction_id alone can lie (the Athens/OSY defect; GPA ships no direction_id at all): a
    // line can carry one constant value on ALL its trips while the return
    // direction exists as separate trips with a mirrored headsign — grouped by
    // direction_id alone both directions collapse into one bucket and only the
    // busier one gets drawn. Pre-scan direction diversity per line; where
    // direction_id cannot tell directions apart, the headsign is the key.
    const dirSeen = new Map();
    for await (const t of iterCsv(join(fdir, 'trips.txt'))) {
      const L = routeToLine.get(t.route_id);
      if (!L) continue;
      let ds = dirSeen.get(L);
      if (!ds) dirSeen.set(L, (ds = new Set()));
      ds.add(t.direction_id || '');
    }
    // headsigns get the feed's own name repair too: VBB tags them "(Berlin)"
    // exactly as it tags the stops, and the panel prints them as directions
    const hsFix = feed.nameFix || ((x) => x);
    const hsKey = (t) => hsFix((t.trip_headsign || '').replace(/\s+/g, ' ').trim()) || '0';

    const byLineDir = new Map();
    for await (const t of iterCsv(join(fdir, 'trips.txt'))) {
      const L = routeToLine.get(t.route_id);
      if (!L) continue;
      let dirs = byLineDir.get(L);
      if (!dirs) byLineDir.set(L, (dirs = new Map()));
      const dir = (dirSeen.get(L)?.size ?? 0) > 1 ? (t.direction_id || '0') : hsKey(t);
      let m = dirs.get(dir);
      if (!m) dirs.set(dir, (m = new Map()));
      let e = m.get(t.shape_id);
      if (!e) m.set(t.shape_id, (e = { count: 0, trips: [] }));
      e.count++;
      // allVariants: every trip is kept — the branch split below needs the
      // full stop_times picture, not a 40-trip sample
      if (e.trips.length < (feed.allVariants ? 1e9 : tripCap)) e.trips.push({ trip_id: t.trip_id, headsign: hsFix((t.trip_headsign || '').trim()) });
    }

    // Length per variant, for the pick below — one streaming pass keeping only
    // a running total and the previous point per shape. Both used by the rule
    // that the busiest shape of a line+direction is very often a peak-hour
    // short-turn: the representative is the LONGEST pattern still worked by at
    // least REP_MIN_SHARE of the busiest pattern's trips (and never a lone
    // trip). The busiest shape always clears its own bar, so this can only
    // lengthen a drawn line, never shorten it.
    const shapeM = new Map();
    if (hasShapes) {
      const needed = new Set();
      for (const dirs of byLineDir.values()) for (const m of dirs.values()) for (const sh of m.keys()) needed.add(sh);
      const prev = new Map();
      let unsorted = 0;
      for await (const sh of iterCsv(shapesFile)) {
        if (!needed.has(sh.shape_id)) continue;
        const lat = Number(sh.shape_pt_lat), lon = Number(sh.shape_pt_lon), seq = Number(sh.shape_pt_sequence);
        const q = prev.get(sh.shape_id);
        if (q) {
          if (seq <= q[2]) unsorted++;
          const k = Math.PI / 180 * 6371008.8;
          shapeM.set(sh.shape_id, (shapeM.get(sh.shape_id) || 0) +
            Math.hypot((lon - q[1]) * k * Math.cos(lat * Math.PI / 180), (lat - q[0]) * k));
        }
        prev.set(sh.shape_id, [lat, lon, seq]);
      }
      if (unsorted) log(`WARNING: shapes.txt not sorted by shape_pt_sequence (${unsorted} rows) — variant lengths approximate`);
    }
    const REP_MIN_SHARE = 0.15;
    let longerReps = 0, longerM = 0;

    const feedReps = [];
    if (feed.allVariants) {
      // EVERY pattern is drawn, not just a representative per direction — the
      // Buenos Aires ramales rule. Here it is the railways that need it: the
      // Underground's branches ARE the network (the Central line alone has
      // four ends), and the longest-regular-pattern rule below would amputate
      // Epping, Hainault, Chesham and half of the Northern line.
      for (const L of [...byLineDir.keys()].sort(numSort)) {
        const dirs = byLineDir.get(L);
        for (const dir of [...dirs.keys()].sort()) {
          const m = dirs.get(dir);
          const byCount = [...m].sort((a, b) => b[1].count - a[1].count);
          for (const [shapeId, e] of byCount) {
            feedReps.push({
              line: L, dir, shapeId, feedTag: feed.tag,
              headsign: e.trips[0]?.headsign || '',
              candTrips: new Set(e.trips.map((x) => x.trip_id)),
              variants: m.size, tripCount: e.count,
            });
          }
        }
      }
      log(`feed ${feed.tag}: ${feedReps.length} patterns from ${byLineDir.size} lines (all branches, not just the busiest)`);
    } else
    for (const L of [...byLineDir.keys()].sort(numSort)) {
      const dirs = byLineDir.get(L);
      for (const dir of [...dirs.keys()].sort()) {
        const m = dirs.get(dir);
        let best = null;
        for (const [shapeId, e] of m) if (!best || e.count > best.e.count) best = { shapeId, e };
        if (hasShapes && m.size > 1) {
          const floor = Math.max(2, best.e.count * REP_MIN_SHARE);
          const lenOf = (id) => shapeM.get(id) || 0;
          let pick = best;
          for (const [shapeId, e] of m) {
            if (e.count >= floor && lenOf(shapeId) > lenOf(pick.shapeId)) pick = { shapeId, e };
          }
          if (pick.shapeId !== best.shapeId) {
            longerReps++;
            longerM += lenOf(pick.shapeId) - lenOf(best.shapeId);
            best = pick;
          }
        }
        feedReps.push({
          line: L, dir, shapeId: best.shapeId, feedTag: feed.tag,
          headsign: best.e.trips[0]?.headsign || '',
          candTrips: new Set(best.e.trips.map((x) => x.trip_id)),
          variants: m.size, tripCount: best.e.count,
        });
      }
    }
    if (longerReps) log(`Representative variant: ${longerReps} line-directions moved off the busiest short-turn onto the longest regular pattern (+${(longerM / 1000).toFixed(0)} km drawn)`);

    const allTripIds = new Set();
    for (const r of feedReps) for (const id of r.candTrips) allTripIds.add(id);
    const tripStops = new Map();
    for await (const st of iterCsv(join(fdir, 'stop_times.txt'))) {
      if (!allTripIds.has(st.trip_id)) continue;
      let arr = tripStops.get(st.trip_id);
      if (!arr) tripStops.set(st.trip_id, (arr = []));
      arr.push({ seq: Number(st.stop_sequence), stopId: feed.tag + ':' + st.stop_id });
    }
    for (const r of feedReps) {
      let bestTrip = null, bestLen = -1;
      for (const id of r.candTrips) {
        const n = tripStops.get(id)?.length ?? 0;
        if (n > bestLen) { bestLen = n; bestTrip = id; }
      }
      r.stopSeq = (tripStops.get(bestTrip) || []).sort((a, b) => a.seq - b.seq);
    }
    if (feed.allVariants) {
      // The Underground's trips carry no shape_id and no headsign — the branch
      // lives ONLY in the stop sequence. So the Buenos Aires all-ramales rule
      // applies one level deeper: trips group by their stop-id fingerprint and
      // every MAXIMAL pattern becomes its own rep. Sub-patterns contained in a
      // longer one (turn-backs, short workings) are not drawn separately —
      // they are the same track; different tails survive because neither
      // contains the other, which is exactly Epping vs Hainault.
      const exploded = [];
      for (const r of feedReps) {
        const pat = new Map();
        for (const id of r.candTrips) {
          const seq = tripStops.get(id);
          if (!seq || seq.length < 2) continue;
          seq.sort((a, b) => a.seq - b.seq);
          const fp = seq.map((s) => s.stopId).join('>');
          let e = pat.get(fp);
          if (!e) pat.set(fp, (e = { count: 0, seq, trips: [] }));
          e.count++;
          if (e.trips.length < 40) e.trips.push(id);
        }
        const byLen = [...pat.entries()].sort((a, b) => b[1].seq.length - a[1].seq.length);
        const kept = [];
        for (const [fp, e] of byLen) {
          if (kept.some((k) => k.fp.includes(fp))) continue;
          kept.push({ fp, ...e });
        }
        kept.sort((a, b) => b.count - a.count);
        for (const e of kept) {
          exploded.push({ ...r, candTrips: new Set(e.trips), stopSeq: e.seq,
            tripCount: e.count, variants: kept.length });
        }
      }
      log(`feed ${feed.tag}: ${feedReps.length} reps → ${exploded.length} maximal stop patterns (branches recovered from stop_times)`);
      feedReps.length = 0;
      feedReps.push(...exploded);
    }

    // ALL-CAPS feeds get title case; short uppercase tokens survive as
    // acronyms (PKP, KWK)
    const titleCase = (s) => s.replace(/[^\s\-,.\/()]+/g, (w) =>
      (w.length > 3 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w));
    for (const s of await readCsv(join(fdir, 'stops.txt'))) {
      // feed names carry double spaces here and there — collapse for clean labels
      let name = (s.stop_name || '').replace(/\s+/g, ' ').trim();
      if (feed.titleCase) name = titleCase(name);
      // a feed's own naming habit, normalised so the same pole gets the same
      // name across feeds (one label, not two): Radzymin writes "Radzymin,
      // Głowackiego" where ZTM writes "Radzymin Głowackiego"
      if (feed.nameFix) name = feed.nameFix(name);
      name = NAME_FIX[name] || name;
      const fix = STOP_FIX[feed.tag + ':' + s.stop_id];
      stopsById.set(feed.tag + ':' + s.stop_id, {
        name,
        lat: fix ? fix[0] : Number(s.stop_lat),
        lon: fix ? fix[1] : Number(s.stop_lon),
      });
    }

    if (hasShapes) {
      const shapeIds = new Set(feedReps.map((r) => r.shapeId));
      const shapePts = new Map();
      for await (const s of iterCsv(shapesFile)) {
        if (!shapeIds.has(s.shape_id)) continue;
        let arr = shapePts.get(s.shape_id);
        if (!arr) shapePts.set(s.shape_id, (arr = []));
        arr.push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
      }
      for (const r of feedReps) {
        const pts = (shapePts.get(r.shapeId) || []).sort((a, b) => a[0] - b[0]);
        r.shapeLatLon = pts.map((p) => [p[1], p[2]]);
      }
    }
    // per-rep fallback: an empty shape (or a shapeless feed) → the stop
    // sequence itself becomes the HMM observation chain
    for (const r of feedReps) {
      if (r.shapeLatLon && r.shapeLatLon.length >= 2) continue;
      r.pseudo = true;
      r.shapeLatLon = r.stopSeq
        .map((s) => stopsById.get(s.stopId))
        .filter(Boolean)
        .map((st) => [st.lat, st.lon]);
      if (r.shapeLatLon.length < 2) log(`SKIPPED ${r.line}/${r.dir}: not enough stops for a pseudo-shape`);
    }
    // trim the shape to the passenger stretch: depot-happy shapes overshoot the
    // termini into depot access tracks (M2's tail runs 3 km past Tudor
    // Arghezi towards the Berceni depot — outside OSM passenger rails, so it
    // matched as breaks and raw chords)
    for (const r of feedReps) {
      if (r.pseudo || r.stopSeq.length < 2) continue;
      const near = (st) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < r.shapeLatLon.length; i++) {
          const [la, lo] = r.shapeLatLon[i];
          const d = Math.hypot((la - st.lat) * 111320, (lo - st.lon) * 111320 * Math.cos(st.lat * Math.PI / 180));
          if (d < bd) { bd = d; bi = i; }
        }
        return bi;
      };
      const s0 = stopsById.get(r.stopSeq[0].stopId);
      const s1 = stopsById.get(r.stopSeq[r.stopSeq.length - 1].stopId);
      if (!s0 || !s1) continue;
      // A CIRCULAR line ends where it began, so near(lastStop) lands on the
      // shape point beside the FIRST one and the slice below throws the whole
      // run away — Novi Sad's 11B, 23 poles and 91 trips a day, came out 50 m
      // long. Where the terminal poles are the same place there is no tail to
      // trim, so there is nothing to do.
      const loopM = Math.hypot((s0.lat - s1.lat) * 111320,
        (s0.lon - s1.lon) * 111320 * Math.cos(s0.lat * Math.PI / 180));
      if (loopM < 300) continue;
      const i0 = near(s0), i1 = near(s1);
      if (i1 - i0 >= 2 && (i0 > 0 || i1 < r.shapeLatLon.length - 1)) {
        // and a second guard for the near-loops the first one misses: a depot
        // overshoot is a small overhang at an end, never the body of the line,
        // so a trim that would drop more than a third of the run is refused.
        const segLen = (a, b) => {
          let m = 0;
          for (let i = a + 1; i <= b; i++) {
            m += Math.hypot((r.shapeLatLon[i][0] - r.shapeLatLon[i - 1][0]) * 111320,
              (r.shapeLatLon[i][1] - r.shapeLatLon[i - 1][1]) * 111320 * Math.cos(r.shapeLatLon[i][0] * Math.PI / 180));
          }
          return m;
        };
        const full = segLen(0, r.shapeLatLon.length - 1);
        if (full > 0 && segLen(i0, i1) < full * 0.66) {
          log(`  shape trim ${r.line}/${r.dir}: REFUSED — ${i0}..${i1} would keep only ${Math.round(100 * segLen(i0, i1) / full)}% of the run`);
          continue;
        }
        if (i0 > 5 || i1 < r.shapeLatLon.length - 6) log(`  shape trim ${r.line}/${r.dir}: kept ${i0}..${i1} of ${r.shapeLatLon.length} points (depot tails dropped)`);
        r.shapeLatLon = r.shapeLatLon.slice(i0, i1 + 1);
      }
    }
    log(`feed ${feed.tag}: ${new Set(feedReps.map((r) => r.line)).size} lines, ${feedReps.length} reps` +
        (hasShapes ? '' : ' (no shapes — stop-sequence pseudo)'));
    reps.push(...feedReps);
  }
  for (const [key, tags] of keyFeeds) {
    if (tags.size > 1) log(`WARNING: line key "${key}" comes from several feeds (${[...tags].join(', ')}) — they will merge into one line`);
  }
  reps = reps.filter((r) => r.shapeLatLon.length >= 2);
  if (!cfg.all) reps = reps.filter((r) => cfg.lines.includes(r.line));
  const LINES = [...new Set(reps.map((r) => r.line))].sort(numSort);
  log(`Lines (${LINES.length}): ${LINES.join(', ')}`);

  // ---------- 6) local projection + graph ----------
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const r of reps) for (const [lat, lon] of r.shapeLatLon) {
    if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat;
    if (lon < lonMin) lonMin = lon; if (lon > lonMax) lonMax = lon;
  }
  const proj = makeProj((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  // one extract, or several merged (a region grown after the first download):
  // later files only ADD ways the earlier ones do not have
  const osm = { elements: [] };
  {
    const seen = new Set();
    for (const file of cfg.osmFiles || [cfg.osmFile]) {
      const part = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
      let added = 0;
      for (const e of part.elements) {
        const k = e.type + e.id;
        if (seen.has(k)) continue;
        seen.add(k); osm.elements.push(e); added++;
      }
      log(`OSM ${file}: ${part.elements.length} elements (${added} new)`);
    }
  }
  // railKeep: this cfg sees only its own kind of rails (see MODES above);
  // railExtra admits single oddballs from other layers (the rack railway)
  if (cfg.railKeep) osm.elements = osm.elements.filter((e) => cfg.railKeep.has(railKind(e.tags)) || (cfg.railExtra && cfg.railExtra(e)));
  // Guard inherited from Bucharest, where OSM mapped the metro as
  // per-direction tunnels that meet nowhere: every dangling subway endpoint
  // gets welded to the nearest other-way vertex within 60 m so Viterbi can
  // route through. A no-op wherever the tunnels are drawn connected.
  if (cfg.railKeep?.has('subway')) {
    const n = weldRailGaps(osm.elements);
    if (n) log(`welded ${n} dangling subway endpoints to nearby tracks`);
  }
  const graph = buildGraph(osm.elements, proj, cfg.graphMode);
  log(`Graph (${cfg.graphMode}): ${graph.nodes.size} nodes, ${graph.segs.length} segments, ${graph.ways.size} ways`);

  // ---------- 7) map matching per line+direction ----------
  const segLines = new Map();
  // traveled t-envelope per segment across ALL lines — the street stroke of a
  // long straight segment is later clipped to it at run ends (dangling stubs
  // past U-turn tips / route ends)
  const segIv = new Map();
  const rawRunsAll = [];
  // 2280 runs in the Verbund — one line per trim would drown the log, so the
  // per-run detail is opt-in (BUILD_SPUR_LOG=1) and the mode reports a total
  let spurTrims = 0, spurStubs = 0, chordRescued = 0;
  for (const r of reps) {
    const xy = r.shapeLatLon.map(([lat, lon]) => proj.toXY(lat, lon));
    let sampled, opts;
    if (r.pseudo) {
      // stops as sparse observations (fallback for trips without a shape):
      // poles sit roadside, sometimes in bays — wider net and softer emission
      // than shape matching, soft beta because consecutive stops are 300–600 m
      // apart and the routing between them IS the geometry. gapMin stays OFF
      // (Infinity): with routing doing the drawing, the oneway penalties are
      // exactly what keeps dual carriageways directional.
      sampled = xy;
      opts = { sigma: 15, beta: 64, radii: [60, 90], maxCand: 16 };
    } else {
      let gaps = 0, maxGap = 0;
      for (let i = 1; i < xy.length; i++) {
        const L = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
        if (L > GAP_MIN) { gaps++; if (L > maxGap) maxGap = L; }
      }
      if (gaps) log(`  shape gap ${r.line}/${r.dir}: ${gaps} × >${GAP_MIN} m (max ${Math.round(maxGap)} m) — bridged by routing`);
      sampled = resample(xy, 20, GAP_MIN);
      // gapMin: gap legs bridge on raw meters (soft oneway penalties off) — a
      // 2.5× contraflow surcharge otherwise out-costs real distance and the
      // bridge circles the block (X499 rectangle at El Kafr, user report:
      // Nahia Axis' eastbound carriageway is unmapped in OSM there)
      opts = { gapMin: GAP_MIN };
      // metro shapes are tunnel approximations — often 40–70 m off the OSM
      // subway axis (street-grid drawn), so the snap net widens and the
      // emission softens; surface trams keep the tight default
      if (cfg.mode === 'tram' && isRailTrunk(r.line)) {
        opts = { sigma: 15, radii: [60, 120], maxCand: 16, gapMin: GAP_MIN };
      }
    }
    const res = matchShape(graph, sampled, opts);
    if (!res) { log(`SKIPPED ${r.line}/${r.dir}: matching failed`); continue; }
    // the drawn line must reach the stops it serves: truncated source shapes and
    // dropped pseudo observations otherwise leave the terminus disc, its name and
    // the line badges hanging off the end of the route
    const stopsXY = r.stopSeq
      .map((s) => stopsById.get(s.stopId))
      .filter(Boolean)
      .map((st) => proj.toXY(st.lat, st.lon));
    const ext = extendToStops(graph, res, stopsXY);
    if (ext) log(`  terminal repair ${r.line}/${r.dir}: ` +
      `${ext.head ? `${ext.head} stop(s) before the shape (+${ext.startM} m) ` : ''}` +
      `${ext.tail ? `${ext.tail} stop(s) past the shape (+${ext.endM} m)` : ''}`);
    // cut the out-and-back stubs before anything downstream sees them: the
    // stroke layer, the number rows and the length all come off these
    const spurs = [];
    const trimmed = trimSpurs(res.coords, stopsXY, spurs);
    if (spurs.length) {
      res.coords = trimmed;
      // a segment travelled ONLY inside a cut excursion leaves the streets layer
      // too — otherwise the tail stays drawn although the line no longer runs
      // there. Segments the trimmed path still uses are never touched, so a
      // corridor can never be broken open by this.
      const kept = segsOfPath(graph, trimmed);
      let dropped = 0;
      for (const sp of spurs) {
        for (const si of segsOfPath(graph, sp)) {
          if (!kept.has(si) && res.usedSegs.delete(si)) { res.usedIv.delete(si); dropped++; }
        }
      }
      // …and a geometric sweep behind it. The index lookup above only finds a
      // segment when the excursion's vertices ARE graph nodes, which silently
      // fails for a spur that runs inside one segment or over vertices the
      // terminal repair inserted. So every segment still marked used is
      // re-checked against the FINAL path: its ridden interval (usedIv — a
      // partly ridden segment is a run end or a bridge entry) must lie ON the
      // trimmed path, both ends and the middle within 5 m. A segment the line
      // still travels sits at 0 m from it (the path is built of graph nodes),
      // so a corridor can never be broken open by this; a stub's far end is
      // metres away and goes. The family's earlier rule — midpoint within
      // 40 m — let every stub under ~80 m survive in the streets layer: the
      // Stern-Center frame kept seven of them with no line path near any
      // (user report, 10.09.2026).
      const COVER = 5;
      const covered = (si) => {
        const g = graph.segs[si];
        const iv = res.usedIv.get(si) || [0, 1];
        for (const t of [iv[0], (iv[0] + iv[1]) / 2, iv[1]]) {
          const x = g.ax + (g.bx - g.ax) * t, y = g.ay + (g.by - g.ay) * t;
          if (nearestOnPolyline(x, y, trimmed).d > COVER) return false;
        }
        return true;
      };
      let swept = 0;
      for (const si of [...res.usedSegs]) {
        if (!covered(si)) { res.usedSegs.delete(si); res.usedIv.delete(si); swept++; }
      }
      spurTrims++; spurStubs += spurs.length;
      if (VERBOSE_SPURS) {
        log(`  spur trim ${r.line}/${r.dir}: ${spurs.length} dead-end stub(s), ` +
          `${dropped} segment(s) dropped${swept ? `, ${swept} swept by distance` : ''}`);
        for (const sp of spurs) {
          const tip = sp[Math.floor(sp.length / 2)];
          const [lon, lat] = proj.toLonLat(tip[0], tip[1]);
          log(`    stub ${Math.round(polylineLength(sp))} m @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
        }
      }
    }
    r.matchedXY = res.coords;
    r.usedSegs = res.usedSegs;
    r.stats = res.stats;
    chordRescued += res.stats.chordRescues || 0;
    r.lengthKm = polylineLength(res.coords) / 1000;
    for (const si of res.usedSegs) {
      let set = segLines.get(si);
      if (!set) segLines.set(si, (set = new Set()));
      set.add(r.line);
      const iv = res.usedIv.get(si);
      if (iv) {
        let g = segIv.get(si);
        if (!g) segIv.set(si, iv.slice());
        else {
          if (iv[0] < g[0]) g[0] = iv[0];
          if (iv[1] > g[1]) g[1] = iv[1];
        }
      }
    }
    for (const raw of res.rawStretches) {
      if (raw.length < 2) continue;
      let len = 0;
      for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      const mid = raw[Math.floor(raw.length / 2)];
      let g = rawRunsAll.find((g) => Math.hypot(g.x - mid[0], g.y - mid[1]) < 60 && Math.abs(g.len - len) < Math.max(60, len * 0.3));
      if (g) g.lines.add(r.line);
      else rawRunsAll.push({
        x: mid[0], y: mid[1], len,
        lines: new Set([r.line]),
        coords: raw.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; }),
      });
    }
    log(`line ${r.line} dir ${r.dir}: ${r.lengthKm.toFixed(2)} km, mean error ${res.stats.meanError.toFixed(1)} m, ` +
        `breaks=${res.stats.viterbiBreaks} (bridged=${res.stats.bridged}, raw=${res.stats.rawStretchCount}/${res.stats.rawMeters} m), ` +
        `roundabouts=${res.stats.roundaboutSegs}, no candidates=${res.stats.noCandidates}`);
    for (const [bx, by] of res.breakPts) {
      const [lon, lat] = proj.toLonLat(bx, by);
      log(`  BREAK ${r.line}/${r.dir} @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
    }
  }
  if (spurTrims) log(`spur trim: ${spurStubs} dead-end stub(s) cut from ${spurTrims} run(s)` +
    `${VERBOSE_SPURS ? '' : ' — BUILD_SPUR_LOG=1 for the per-run detail'}`);
  if (chordRescued) log(`gap legs: ${chordRescued} refused bridge(s) taken after all — the chord had left the road network`);
  reps = reps.filter((r) => r.matchedXY);

  // Trams take the IDENTICAL path as buses: we draw every traversed segment of
  // every direction. The two directional tracks (~3 m apart) are the analog of the
  // two carriageways of a dual carriageway for buses — both strokes, zero selection.
  // The earlier per-line "base track" selection + seam welding produced stubs at
  // every base handoff between lines (reported by the user at 23 lines).

  // ---------- 8) stops: merge by stop_id, line list, snap to routes ----------
  const stopAgg = new Map();
  // A stop is a LOOP when the formal network ends there — or when enough
  // paratransit routes end together to make a real depot/hub. A single survey
  // endpoint of an informal route is not a loop: counting those made a
  // terminus out of 37% of Cairo's stops (user report: every other stop
  // rendered as a pętla).
  const PARA_TERM_MIN = 3;
  for (const r of reps) {
    r.stopSeq.forEach((s, i) => {
      const st = stopsById.get(s.stopId);
      if (!st) return;
      let e = stopAgg.get(s.stopId);
      if (!e) stopAgg.set(s.stopId, (e = { name: st.name, lat: st.lat, lon: st.lon, lines: new Set(), runs: new Set(), term: new Set() }));
      e.lines.add(r.line);
      e.runs.add(r);
      if (i === 0 || i === r.stopSeq.length - 1) e.term.add(r.line);
    });
  }
  // A metro STATION is one place: merge the per-direction (and per-line, at
  // interchanges) platform records into a single entry keyed by name — one disc,
  // one label (user report: Irini drawn twice, once off the tracks).
  if (cfg.mode === 'tram') {
    const isMetroEntry = (e) => [...e.lines].every(isRailTrunk);
    const byStation = new Map();
    for (const [id, e] of stopAgg) {
      if (!isMetroEntry(e)) continue;
      let g = byStation.get(e.name);
      if (!g) byStation.set(e.name, (g = []));
      g.push([id, e]);
    }
    for (const g of byStation.values()) {
      if (g.length < 2) continue;
      const base = g[0][1];
      let latS = base.lat, lonS = base.lon;
      for (let i = 1; i < g.length; i++) {
        const [id, e] = g[i];
        for (const L of e.lines) base.lines.add(L);
        for (const R of e.runs) base.runs.add(R);
        for (const L of e.term) base.term.add(L);
        latS += e.lat; lonS += e.lon;
        stopAgg.delete(id);
      }
      base.lat = latS / g.length;
      base.lon = lonS / g.length;
    }
  }
  const stopFeatures = [];
  let stopsFar = 0;
  const farNames = [];
  for (const e of stopAgg.values()) {
    const [sx, sy] = proj.toXY(e.lat, e.lon);
    const isMetroStop = cfg.mode === 'tram' && [...e.lines].every(isRailTrunk);
    let best = null, bestRun = null;
    // candidates are ONLY the runs that actually call at this pole: on a
    // double-track street the pole of one direction can lie nearer the
    // OPPOSITE track — snapping to it drew the half-disc on the wrong side
    // of the street (user report, Dąb Silesia City Center)
    for (const r of e.runs) {
      const near = nearestOnPolyline(sx, sy, r.matchedXY);
      if (near && (!best || near.d < best.d)) { best = near; bestRun = r; }
    }
    // metro gets a wide snap net: station coords in STASY are entrance-based and
    // can sit well off the track axis (Irini: >80 m) — the disc belongs ON the line
    // A stop drawn beside its own line reads as a bug, so the disc goes ON the
    // line even when the pole coordinate is poor — 200 m of rescue covers the
    // sloppy ones (Lyski Rondo stands 115 m off the roadway in the source data).
    // Metro gets a wider net still: station coords in STASY are entrance-based
    // and can sit well off the track axis (Irini: >80 m).
    const useSnap = best && best.d <= (isMetroStop ? 250 : 200);
    // Beyond that the pole cannot be placed honestly: its own line is drawn
    // somewhere else entirely (tram 44 keeps four stops on the central tracks
    // that neither the TPBI shape nor OSM knows anymore). A disc stranded in
    // open country is worse than a missing stop, so it is left out and logged.
    if (!useSnap) { stopsFar++; farNames.push(`${e.name} (${Math.round(best ? best.d : -1)} m)`); continue; }
    const [lon, lat] = proj.toLonLat(best.x, best.y);
    // half-disc orientation: flat edge along the street, bulge toward the pole's
    // side of the roadway (side = sign of the cross product between the street
    // direction and the snap→pole vector; the GTFS pole stands beside the road)
    let angle = 0;
    let sideInfo = null;
    if (!isMetroStop && best && bestRun && bestRun.matchedXY[best.segIdx + 1]) {
      const A = bestRun.matchedXY[best.segIdx], B = bestRun.matchedXY[best.segIdx + 1];
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const phi = Math.atan2(-dy, dx) * 180 / Math.PI;
      const cross = dx * (sy - best.y) - dy * (sx - best.x);
      // GTFS pole coordinates are frequently sloppy on double-track streets
      // (both direction poles of Dąb Silesia City Center share one point, so
      // both discs flipped the same way) — when the pole sits inside the
      // track corridor (<6 m off the axis) the coordinate carries no side
      // signal; use the right-hand rule instead: doors open to the RIGHT of
      // the direction of travel. Clearly offset poles keep the data's side.
      const offM = Math.abs(cross) / Math.hypot(dx, dy);
      const side = offM < SIDE_CORRIDOR ? -1 : Math.sign(cross);
      angle = Math.round((phi + (side < 0 ? 180 : 0)) * 10) / 10;
      // kept for the tie-break pass below, stripped before the file is written
      sideInfo = { phi, dataSide: Math.sign(cross), offM };
    }
    const arr = [...e.lines].sort(numSort);
    // metroline membership for the independent metrolines toggle
    let mstop = null;
    if (cfg.mlineSet && cfg.mlineSet.size) {
      const n = arr.filter((l) => cfg.mlineSet.has(l)).length;
      mstop = n === arr.length ? 'all' : (n ? 'mix' : null);
    }
    const termArr = [...e.term].sort(numSort);
    const paraEnd = cfg.mlineSet ? termArr.filter((l) => cfg.mlineSet.has(l)).length : 0;
    const formalEnd = termArr.length > paraEnd;
    const terminus = formalEnd || paraEnd >= PARA_TERM_MIN ? 1 : 0;
    stopFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
      properties: {
        name: e.name,
        lines: arr.join(', '),
        arr,
        terminus,
        // terminating lines only — consumed by the badge-anchor pass below and
        // stripped before the geojson is written
        termArr,
        mode: cfg.mode,
        color: colorOf(arr),
        colorDark: colorDarkOf(arr),
        angle,
        ...(sideInfo ? { sideInfo } : {}),
        // metro stations render as full discs (no roadside pole side to show)
        ...(isMetroStop ? { metro: 1 } : {}),
        ...(mstop ? { mstop } : {}),
        snapDist: best ? Math.round(best.d) : null,
      },
    });
  }
  if (stopsFar) log(`WARNING: ${stopsFar} stops dropped — farther than 200 m from every line calling there: ${farNames.slice(0, 8).join(', ')}${stopsFar > 8 ? ', …' : ''}`);


  // Tie-break for the right-hand rule, which has one blind spot: it needs the
  // direction of travel, and `bestRun` is picked by distance. Where both
  // directions of a street ride ONE OSM centerline — or one run passes the same
  // street twice, as a loop line does — the two poles of a stop can snap to the
  // same travelling direction and both discs then bulge the same way.
  // Only pairs that visibly failed are touched, and only when the pole
  // coordinates disagree about the side and both carry more offset than the
  // axis is uncertain — so a pair the rule got right is never second-guessed,
  // and a feed with poles digitised onto the centerline never gets to vote.
  // The blunt alternative (dropping SIDE_CORRIDOR so the coordinates always
  // win) was measured on 8.08.2026 and rejected: it fixed Grodzisk Mazowiecki
  // but drove Rybnik from 96 bad pairs to 154, because the right-hand rule is
  // right far more often than these pole coordinates are.
  const AXIS_NOISE = 1.5; // m — below this a pole coordinate says nothing
  let splitFixed = 0;
  {
    const groups = new Map();
    for (const f of stopFeatures) {
      if (!f.properties.sideInfo) continue;
      let g = groups.get(f.properties.name);
      if (!g) groups.set(f.properties.name, (g = []));
      g.push(f);
    }
    for (const g of groups.values()) {
      if (g.length !== 2) continue; // interchanges are not a two-sided street
      const [a, b] = g;
      const [alon, alat] = a.geometry.coordinates;
      const [blon, blat] = b.geometry.coordinates;
      const [ax, ay] = proj.toXY(alat, alon), [bx, by] = proj.toXY(blat, blon);
      if (Math.hypot(ax - bx, ay - by) > 120) continue; // same name, two places
      const apart = Math.abs(((a.properties.angle - b.properties.angle + 180) % 360) - 180);
      if (apart >= 60) continue; // the discs already point apart: nothing to fix
      const sa = a.properties.sideInfo, sb = b.properties.sideInfo;
      if (sa.offM < AXIS_NOISE || sb.offM < AXIS_NOISE) continue;
      if (sa.dataSide === 0 || sa.dataSide === sb.dataSide) continue; // data agrees they share a side
      for (const f of g) {
        const s = f.properties.sideInfo;
        f.properties.angle = Math.round((s.phi + (s.dataSide < 0 ? 180 : 0)) * 10) / 10;
      }
      splitFixed++;
    }
  }
  for (const f of stopFeatures) delete f.properties.sideInfo;
  if (splitFixed) log(`Stop sides: ${splitFixed} two-pole stops split by pole coordinates (right-hand rule had both discs on one side)`);

  // One label per pole group: clustering by name within a 220 m radius.
  const byName = new Map();
  for (const f of stopFeatures) {
    let g = byName.get(f.properties.name);
    if (!g) byName.set(f.properties.name, (g = []));
    g.push(f);
  }
  let labelCount = 0;
  for (const g of byName.values()) {
    const clusters = [];
    for (const f of g) {
      const [lon, lat] = f.geometry.coordinates;
      const [x, y] = proj.toXY(lat, lon);
      let c = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < 220);
      if (!c) clusters.push((c = { x, y, best: f, term: new Set() }));
      else if (f.properties.terminus > c.best.properties.terminus) c.best = f;
      // terminating lines of the whole pole group: a line can end at the pole
      // of one direction while the label rides the other — badges must not
      // lose it to the label lottery
      for (const l of f.properties.termArr) c.term.add(l);
      f.properties.label = 0;
    }
    for (const c of clusters) {
      c.best.properties.label = 1; labelCount++;
      if (c.best.properties.terminus) c.best.properties.badgeLines = [...c.term].sort(numSort);
    }
  }
  log(`Stops: ${stopFeatures.length} poles, ${labelCount} labels`);

  // Terminus badge ANCHORS: every labeled terminus with the lines that END there
  // (not every line that calls — a Cairo corridor stop where one microbus route
  // ends sees dozens of through lines, and listing those built 150-box walls)
  // and their colors. The grid layout — and the fusing of grids that would collide
  // on screen — happens in a shared pass after all modes, so neighbouring loops of
  // ANY mode merge into one box complex.
  const badgeAnchors = [];
  for (const f of stopFeatures) {
    const p = f.properties;
    if (p.terminus && p.label && p.badgeLines && p.badgeLines.length) {
      badgeAnchors.push({
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        name: p.name,
        lines: p.badgeLines.map((line) => ({
          line, mode: p.mode, color: colorOf([line]), colorDark: colorDarkOf([line]),
          // metro rides the tram slot but answers to its own frontend toggle
          ...(p.mode === 'tram' && isRailTrunk(line) ? { metro: 1 } : {}),
        })),
      });
    }
    delete p.termArr;
    delete p.badgeLines;
  }
  log(`Termini: ${badgeAnchors.length} loops with line badges`);

  // ---------- 9) streets/tracks: runs merged per line set ----------
  const byWay = new Map();
  const posSeg = new Map();
  for (const [si, lines] of segLines) {
    const s = graph.segs[si];
    let m = byWay.get(s.wayId);
    if (!m) byWay.set(s.wayId, (m = new Map()));
    m.set(s.wayPos, lines);
    let pm = posSeg.get(s.wayId);
    if (!pm) posSeg.set(s.wayId, (pm = new Map()));
    pm.set(s.wayPos, si);
  }
  const runs = [];
  for (const [wayId, posMap] of byWay) {
    const way = graph.ways.get(wayId);
    const positions = [...posMap.keys()].sort((a, b) => a - b);
    const keyOf = (pos) => [...posMap.get(pos)].sort(numSort).join(', ');
    const flush = (start, end, linesKey) => {
      const ids = way.nodeIds.slice(start, end + 2);
      const coords = ids.map((id) => {
        const n = graph.nodes.get(id);
        return [round6(n.lon), round6(n.lat)];
      });
      if (coords.length < 2) return;
      // Clip the run's outer ends to the traveled t-envelope of the first and
      // last segment: a long straight segment ridden for only its first meters
      // otherwise draws in full and leaves a dangling stub past the real
      // turnaround (Al Wafaa spur tips, mid-block route ends).
      const pm = posSeg.get(wayId);
      const lerp = (A, B, t) => [round6(A[0] + (B[0] - A[0]) * t), round6(A[1] + (B[1] - A[1]) * t)];
      const iv0 = segIv.get(pm.get(start));
      if (iv0 && iv0[0] > 0.03) coords[0] = lerp(coords[0], coords[1], iv0[0]);
      const iv1 = segIv.get(pm.get(end));
      if (iv1 && iv1[1] < 0.97) coords[coords.length - 1] = lerp(coords[coords.length - 2], coords[coords.length - 1], iv1[1]);
      runs.push({ coords, name: way.name, linesKey, roundabout: way.roundabout ? 1 : 0 });
    };
    let runStart = positions[0], prevPos = positions[0], runKey = keyOf(positions[0]);
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i], key = keyOf(pos);
      if (pos !== prevPos + 1 || key !== runKey) {
        flush(runStart, prevPos, runKey);
        runStart = pos;
        runKey = key;
      }
      prevPos = pos;
    }
    flush(runStart, prevPos, runKey);
  }
  // extra per-run flags: trolley 'all'/'mix' (green stroke / dashed green overlay)
  // and metro (wide translucent ribbon) — the frontend styles on these
  const runFlags = (arr) => {
    const flags = {};
    if (cfg.trolleySet && cfg.trolleySet.size) {
      const n = arr.filter((l) => cfg.trolleySet.has(l)).length;
      if (n === arr.length) flags.trolley = 'all';
      else if (n > 0) flags.trolley = 'mix';
    }
    if (cfg.mode === 'tram' && arr.every(isRailTrunk)) flags.metro = 1;
    if (cfg.mlineSet && cfg.mlineSet.size) {
      const n = arr.filter((l) => cfg.mlineSet.has(l)).length;
      if (n === arr.length) flags.mline = 'all';
      else if (n > 0) flags.mline = 'mix';
    }
    return flags;
  };
  const mergedRuns = mergeRuns(runs);
  const streetFeatures = mergedRuns.map((r) => {
    const arr = r.linesKey.split(', ');
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords },
      properties: { name: r.name, lines: r.linesKey, arr, roundabout: r.roundabout, mode: cfg.mode, color: colorOf(arr), ...runFlags(arr) },
    };
  });
  // A raw stretch is what the matcher leaves behind when it cannot route between
  // two consecutive fixes: the shape's own points, drawn as-is. It enters the
  // streets layer here — but its ends are the MATCHED POSITIONS, while the runs
  // on either side are built from whole intervals of road segments, so the two
  // rarely meet at the same coordinate. The result is a stub hanging in mid-air
  // with the line apparently torn in two (Tricity user report, 19.08.2026;
  // ported here 21.08.2026). So each end is pulled onto the nearest point of a
  // run that carries one of the same lines. The reach is deliberately short:
  // this closes a seam, it does not invent a route.
  const RAW_JOIN = 120;
  const joinRawEnd = (pt, lines) => {
    let best = null, bd = RAW_JOIN;
    for (const r of mergedRuns) {
      const rl = r.linesKey.split(', ');
      if (!rl.some((l) => lines.has(l))) continue;
      for (let i = 1; i < r.coords.length; i++) {
        // proj.toXY takes (lat, lon); these coords are [lon, lat]
        const a = proj.toXY(r.coords[i - 1][1], r.coords[i - 1][0]);
        const b = proj.toXY(r.coords[i][1], r.coords[i][0]);
        const vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * vx + (pt[1] - a[1]) * vy) / L2)) : 0;
        const q = [a[0] + vx * t, a[1] + vy * t];
        const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
        if (d < bd) { bd = d; best = q; }
      }
    }
    return best;
  };
  let rawJoined = 0;
  for (const g of rawRunsAll) {
    const arr = [...g.lines].sort(numSort);
    const xy = g.coords.map(([lon, lat]) => proj.toXY(lat, lon));
    for (const end of [0, 1]) {
      const pt = end ? xy[xy.length - 1] : xy[0];
      const j = joinRawEnd(pt, g.lines);
      if (!j || Math.hypot(j[0] - pt[0], j[1] - pt[1]) < 0.5) continue;
      const [lon, lat] = proj.toLonLat(j[0], j[1]);
      if (end) g.coords.push([round6(lon), round6(lat)]);
      else g.coords.unshift([round6(lon), round6(lat)]);
      rawJoined++;
    }
    streetFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: g.coords },
      properties: { name: '', lines: arr.join(', '), arr, roundabout: 0, mode: cfg.mode, color: colorOf(arr), unmapped: 1, ...runFlags(arr) },
    });
  }
  if (rawJoined) log(`  ${rawJoined} ends of unrouted stretches pulled onto the runs beside them`);
  log(`Runs: ${runs.length} → ${mergedRuns.length} after merging` +
      (rawRunsAll.length ? ` (+${rawRunsAll.length} outside OSM)` : ''));

  // HOLES IN THE STREETS LAYER. That layer is built from the road SEGMENTS a
  // route travelled, and a segment only enters it once at least 25 m or half of
  // it was used — a sensible rule that keeps glancing touches out, and one that
  // leaves a hole whenever a route clips a long segment briefly. route.geojson
  // runs through unbroken; the drawn network does not, and the line appears torn.
  // So: find every line whose runs fall into more than one connected piece, and
  // close the gap with a straight seam — only across a SEAM (≤ 60 m); anything
  // wider is left alone and reported rather than invented.
  {
    const key = (c) => c[0].toFixed(6) + ',' + c[1].toFixed(6);
    const dist = (a, b) => { const [ax, ay] = proj.toXY(a[1], a[0]), [bx, by] = proj.toXY(b[1], b[0]); return Math.hypot(ax - bx, ay - by); };
    const byLine = new Map();
    for (const f of streetFeatures) for (const l of f.properties.arr) {
      if (!byLine.has(l)) byLine.set(l, []);
      byLine.get(l).push(f);
    }
    const MAX_SEAM = 60;
    let patched = 0, patchedM = 0;
    for (const [line, lruns] of byLine) {
      if (lruns.length < 2) continue;
      const at = new Map();
      lruns.forEach((f, i) => { for (const c of f.geometry.coordinates) {
        const k = key(c); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
      const seen = new Array(lruns.length).fill(false);
      const comps = [];
      for (let i = 0; i < lruns.length; i++) {
        if (seen[i]) continue;
        const mem = [], q = [i]; seen[i] = true;
        while (q.length) { const j = q.pop(); mem.push(j);
          for (const c of lruns[j].geometry.coordinates) for (const n of (at.get(key(c)) || [])) if (!seen[n]) { seen[n] = true; q.push(n); } }
        comps.push(mem);
      }
      if (comps.length < 2) continue;
      const ptsOf = (m) => m.flatMap((j) => lruns[j].geometry.coordinates);
      comps.sort((x, y) => ptsOf(y).length - ptsOf(x).length);
      for (let ci = 1; ci < comps.length; ci++) {
        const A = ptsOf(comps[0]), B = ptsOf(comps[ci]);
        let bd = Infinity, pa = null, pb = null;
        for (const x of A) for (const y of B) { const d = dist(x, y); if (d < bd) { bd = d; pa = x; pb = y; } }
        if (!pa || bd > MAX_SEAM) continue;
        streetFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [pa, pb] },
          properties: { name: '', lines: line, arr: [line], roundabout: 0, mode: cfg.mode, color: colorOf([line]), nolabel: 1, ...runFlags([line]) },
        });
        patched++; patchedM += bd;
      }
    }
    if (patched) log(`  ${patched} seams closed in the drawn network (${Math.round(patchedM)} m total)`);
  }

  const toLonLat = (xy) => xy.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; });
  const routeFeatures = reps.map((r) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: toLonLat(r.matchedXY) },
    properties: { line: r.line, dir: r.dir, headsign: r.headsign, mode: cfg.mode, color: colorOf([r.line]) },
  }));
  const shapeFeatures = reps.map((r) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: r.shapeLatLon.map(([lat, lon]) => [lon, lat]) },
    properties: { line: r.line, dir: r.dir, mode: cfg.mode },
  }));
  const metaLines = [...new Set(reps.map((r) => r.line))].sort(numSort).map((L) => ({
    line: L,
    mode: cfg.mode,
    // the panel files a chip by this: without it every train sat under
    // "Trams" — the U-Bahn, the S-Bahn and the RE alike (user report 10.09.2026)
    ...(cfg.mode === 'tram' && isRailTrunk(L) ? { metro: 1 } : {}),
    color: colorOf([L]),
    dirs: reps.filter((r) => r.line === L).map((r) => ({
      dir: r.dir, headsign: r.headsign, variants: r.variants, tripCount: r.tripCount,
      stops: r.stopSeq.length, lengthKm: Math.round(r.lengthKm * 100) / 100, stats: r.stats,
    })),
  }));

  return { routeFeatures, shapeFeatures, stopFeatures, streetFeatures, badgeAnchors, metaLines };
}

// ---------- run per mode + write shared files ----------
const results = [];
for (const cfg of MODES) results.push(await processMode(cfg));

const routeFeatures = results.flatMap((r) => r.routeFeatures);
const shapeFeatures = results.flatMap((r) => r.shapeFeatures);
const stopFeatures = results.flatMap((r) => r.stopFeatures);
const streetFeatures = results.flatMap((r) => r.streetFeatures);
const metaLines = results.flatMap((r) => r.metaLines);

// ---------- 10) line-number labels: SHARED across both modes ----------
// On a street shared by trams and buses the roadway and the track are parallel
// geometries 2–6 m apart — separate labels of both modes fought for space.
// Here we pair them geometrically: a tram run following a bus roadway gets
// `busLines` (one number segment: red + blue), and the covered bus run gets
// `nolabel` (its stroke stays, the track takes over its numbers).
{
  const [lon0, lat0] = streetFeatures[0].geometry.coordinates[0];
  const P = makeProj(lat0, lon0);
  const CELL = 60, NEAR = 18, STEP = 25;
  const wrap = (f) => {
    const xy = f.geometry.coordinates.map(([lon, lat]) => P.toXY(lat, lon));
    let len = 0;
    for (let i = 1; i < xy.length; i++) len += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    return { f, xy, len };
  };
  const labelable = (f) => !f.properties.roundabout && !f.properties.unmapped;
  const busF = streetFeatures.filter((f) => f.properties.mode === 'bus' && labelable(f)).map(wrap);
  // Metro NEVER adopts street numbers: a metro line is one 20-40 km run, so the
  // adoption union would collect every bus line the tunnel passes under — a
  // label listing lines that do not ride that street (user report, Iera Odos).
  // Only street-running trams (T6/T7) share corridors with buses.
  const tramF = streetFeatures.filter((f) => f.properties.mode === 'tram' && labelable(f) && !f.properties.metro).map(wrap);
  const gridOf = (list) => {
    const g = new Map();
    list.forEach((o, oi) => {
      for (let i = 0; i + 1 < o.xy.length; i++) {
        const [ax, ay] = o.xy[i], [bx, by] = o.xy[i + 1];
        for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
          for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
            const k = cx + ':' + cy;
            let arr = g.get(k);
            if (!arr) g.set(k, (arr = []));
            arr.push([ax, ay, bx, by, oi]);
          }
      }
    });
    return g;
  };
  const dSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const samplesOf = (xy) => {
    const out = [];
    let carry = 0;
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (!L) continue;
      let d = carry;
      while (d <= L) { const t = d / L; out.push([ax + t * (bx - ax), ay + t * (by - ay)]); d += STEP; }
      carry = d - L;
    }
    return out;
  };
  const nearAt = (grid, x, y) => {
    const hit = new Set();
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++)
      for (const [ax, ay, bx, by, oi] of grid.get(ix + ':' + iy) || [])
        if (!hit.has(oi) && dSeg(x, y, ax, ay, bx, by) <= NEAR) hit.add(oi);
    return hit;
  };
  const busGrid = gridOf(busF), tramGrid = gridOf(tramF);
  const adopted = new Set(); // bus runs whose numbers were taken over by some track
  // The adopted numbers are POSITIONAL. One union stamped on the whole run
  // listed every bus that shares any 60 m of a multi-km track somewhere along
  // it — at Słomiana the Kapelanka track printed 14 bus lines where 3 ride
  // (user report). So after the run-level qualification (which still filters
  // out crossing streets) the run is cut into stretches of constant
  // nearby-line set, and every piece carries only the numbers of the roadway
  // really beside it. Sub-75 m blips of the set are geometry noise (platform
  // bulges, stop islands), not a corridor change — absorbed by neighbours.
  const splitRuns = new Map(); // original tram feature → replacement pieces
  for (const o of tramF) {
    const smp = samplesOf(o.xy);
    if (smp.length < 2) continue;
    const nearLen = new Map();
    const perSample = [];
    let nearAny = 0;
    for (const [x, y] of smp) {
      const hit = nearAt(busGrid, x, y);
      if (hit.size) nearAny++;
      for (const oi of hit) nearLen.set(oi, (nearLen.get(oi) || 0) + STEP);
      perSample.push(hit);
    }
    if (nearAny / smp.length < 0.55) continue;
    const qualified = new Set();
    for (const [oi, L] of nearLen) {
      const b = busF[oi];
      // brief brushes (intersections) do not count as a shared corridor
      if (L >= Math.max(60, 0.35 * Math.min(o.len, b.len))) {
        qualified.add(oi);
        adopted.add(oi);
      }
    }
    if (!qualified.size) continue;
    // per-sample set: only the qualified roadways actually within reach HERE
    const setAt = perSample.map((hit) => {
      const ls = new Set();
      for (const oi of hit) if (qualified.has(oi))
        for (const s of busF[oi].f.properties.lines.split(', ')) ls.add(s);
      return [...ls].sort(numSort).join(', ');
    });
    // maximal blocks of one set, then despeckle the sub-3-sample blips
    const blocks = [];
    for (let i = 0; i < setAt.length; i++) {
      if (blocks.length && blocks[blocks.length - 1].key === setAt[i]) blocks[blocks.length - 1].i1 = i;
      else blocks.push({ key: setAt[i], i0: i, i1: i });
    }
    for (let changed = true; changed && blocks.length > 1;) {
      changed = false;
      for (let bi = 0; bi < blocks.length; bi++) {
        if (blocks[bi].i1 - blocks[bi].i0 + 1 >= 3) continue;
        const prev = blocks[bi - 1], next = blocks[bi + 1];
        if (prev && next && prev.key === next.key) { prev.i1 = next.i1; blocks.splice(bi, 2); }
        else if (!prev && next) { next.i0 = blocks[bi].i0; blocks.splice(bi, 1); }
        else if (!next && prev) { prev.i1 = blocks[bi].i1; blocks.splice(bi, 1); }
        else continue;
        changed = true;
        break;
      }
    }
    if (blocks.length === 1) {
      if (blocks[0].key) o.f.properties.busLines = blocks[0].key;
      continue;
    }
    // cut the geometry midway between neighbouring blocks' outermost samples
    const coords = o.f.geometry.coordinates;
    const cum = [0];
    for (let i = 1; i < o.xy.length; i++)
      cum.push(cum[i - 1] + Math.hypot(o.xy[i][0] - o.xy[i - 1][0], o.xy[i][1] - o.xy[i - 1][1]));
    const total = cum[cum.length - 1];
    const pointAt = (d) => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const L = cum[i] - cum[i - 1];
      const t = L ? Math.min(1, Math.max(0, (d - cum[i - 1]) / L)) : 0;
      return [round6(coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0])),
              round6(coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]))];
    };
    const pieces = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const d0 = bi === 0 ? 0 : (blocks[bi - 1].i1 + blocks[bi].i0) / 2 * STEP;
      const d1 = bi === blocks.length - 1 ? total : (blocks[bi].i1 + blocks[bi + 1].i0) / 2 * STEP;
      if (d1 - d0 < 1) continue;
      const cs = [pointAt(d0)];
      for (let i = 0; i < coords.length; i++) if (cum[i] > d0 && cum[i] < d1) cs.push(coords[i]);
      cs.push(pointAt(d1));
      const props = { ...o.f.properties };
      delete props.busLines;
      if (blocks[bi].key) props.busLines = blocks[bi].key;
      pieces.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: cs }, properties: props });
    }
    if (pieces.length) splitRuns.set(o.f, pieces);
  }
  if (splitRuns.size) {
    const rebuilt = streetFeatures.flatMap((f) => splitRuns.get(f) || [f]);
    streetFeatures.length = 0;
    streetFeatures.push(...rebuilt);
  }
  busF.forEach((o, oi) => {
    if (!adopted.has(oi)) return; // numbers not adopted anywhere — the label stays
    const smp = samplesOf(o.xy);
    if (smp.length < 2) return;
    let nearAny = 0;
    for (const [x, y] of smp) if (nearAt(tramGrid, x, y).size) nearAny++;
    if (nearAny / smp.length >= 0.7) o.f.properties.nolabel = 1;
  });

  // Numbers per street: one label per (street name × line set) pair — a set
  // change on the same street or the next street = a new label. A group holds
  // every run of that pair; EACH run that is not a twin carriageway of an
  // already-labeled one gets its own anchor, because a group is not one
  // continuous street: the same name × set reappears on the far side of the
  // city, and with a single anchor on the longest run those stretches carried
  // no numbers at all (user report). The point carries the street BEARING: the
  // frontend rotates the text parallel to the road and offsets it aside, so the
  // number stands BESIDE the roadway along its course.
  var labelFeatures = [];
  const groups = new Map(); // (name|set) → all runs of the group + the longest one
  let anonId = 0;
  for (const f of streetFeatures) {
    const p = f.properties;
    if (p.roundabout || p.nolabel) continue;
    const coords = f.geometry.coordinates;
    const xy = coords.map(([lon, lat]) => P.toXY(lat, lon));
    const segLens = [];
    let total = 0;
    for (let i = 1; i < xy.length; i++) {
      const L = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
      segLens.push(L);
      total += L;
    }
    // 40 m: one-block connectors between two avenues are a real part of the
    // route and must be able to show their numbers too
    if (total < 40) continue;
    // no name (links, construction) means no street identity — each run on its own
    const gKey = (p.name || `~${anonId++}`) + '|' + p.lines + '|' + (p.busLines || '');
    const entry = { f, coords, xy, segLens, total };
    let g = groups.get(gKey);
    if (!g) groups.set(gKey, (g = { runs: [], best: null }));
    g.runs.push(entry);
    if (!g.best || total > g.best.total) g.best = entry;
  }
  const WIN = 30;
  // One label per RUN of the group (twin carriageways excluded, see TWIN below)
  // PLUS extra anchors tagged extra:1 spaced along every run of a couple of
  // blocks or more. The extras are the numbers' FALLBACK positions: stop names
  // outrank numbers in the frontend ladder, so where a name takes the main
  // anchor's spot the row must be able to reappear further down the street —
  // every anchor is collision-managed, so only the free ones actually render.
  // The spacings are deliberately tight (they used to be 500/550/300, i.e. only
  // avenues got a second chance): in a city centre the runs are 100–250 m
  // blocks, so most streets had exactly ONE candidate position and showed no
  // numbers at all whenever a stop name took that spot — measured at z14 in
  // Rybnik centre, 15 of 112 anchors survived. Now every block-length run
  // carries fallbacks; the frontend renders only the ones that are free.
  const LONG_RUN = 120, SPACING = 210, EXCL = 130;
  // a run whose points mostly lie within TWIN metres of an already-labeled run
  // of the SAME group is its second carriageway (or a re-traced overlay) —
  // labeling it again would print the same row twice across one street
  const TWIN = 35, TWIN_FRAC = 0.6, MAIN_EXCL = 150;
  const tryPlace = (e, d) => {
    const { coords, xy, segLens, total } = e;
    const at = (dd) => {
      let acc = 0;
      for (let i = 0; i < segLens.length; i++) {
        if (acc + segLens[i] >= dd || i === segLens.length - 1) {
          const t = segLens[i] ? Math.min(1, Math.max(0, (dd - acc) / segLens[i])) : 0;
          return {
            x: xy[i][0] + t * (xy[i + 1][0] - xy[i][0]), y: xy[i][1] + t * (xy[i + 1][1] - xy[i][1]),
            lon: coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), lat: coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
          };
        }
        acc += segLens[i];
      }
    };
    const c = at(d), a = at(Math.max(0, d - WIN)), b = at(Math.min(total, d + WIN));
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 5) return null; // tight bend — no clean bearing here
    let ang = Math.atan2(-dy, dx) * 180 / Math.PI; // clockwise degrees, screen y downwards
    if (ang > 90) ang -= 180;   // normalization: text never upside down
    if (ang < -90) ang += 180;
    return { c, ang, dx, dy };
  };
  // Cairo corridors carry up to ~100 paratransit routes; a label listing all of
  // them is unreadable and kilometers long — display caps at 12 + a "+N" tail.
  // (`arr` stays complete: the frontend filters and highlights on it.)
  const PSET = MODES[0].mlineSet || new Set();
  const TSET = new Set(MODES.flatMap((m) => [...(m.trolleySet || [])])); // trolleybus numbers
  const capList = (s) => {
    const a = s.split(', ');
    return a.length > 14 ? a.slice(0, 12).join(', ') + ' +' + (a.length - 12) : s;
  };
  for (const g of groups.values()) {
    const p = g.best.f.properties;
    const arr = p.busLines ? [...p.lines.split(', '), ...p.busLines.split(', ')] : p.lines.split(', ');
    const baseProps = { lines: p.lines, color: p.color, mode: p.mode, arr, ...(p.metro ? { metro: 1 } : {}) };
    if (p.busLines) baseProps.busLines = p.busLines;
    // mixed bus+trolleybus roadway: the label keeps the trolleybus numbers
    // GREEN in a two-colour row (user 14.08.2026, Athens pattern) —
    // all-trolleybus sets already come out green whole via colorOf
    if (p.mode === 'bus' && TSET.size) {
      const tl = arr.filter((l) => TSET.has(l));
      if (tl.length && tl.length < arr.length) {
        baseProps.tLines = tl.join(', ');
        baseProps.ntLines = arr.filter((l) => !TSET.has(l)).join(', ');
      }
    }
    // mixed paratransit corridors carry both halves so the frontend can show
    // only the relevant one when a single network is toggled on
    if (p.mode === 'bus' && p.mline === 'mix') {
      baseProps.mLines = capList(arr.filter((l) => PSET.has(l)).join(', '));
      baseProps.nmLines = capList(arr.filter((l) => !PSET.has(l)).join(', '));
    }
    const anchors = [];
    // The collision engine knows nothing about the STROKES, so on a dual
    // carriageway the row happily settles between the roadways — parked on
    // the twin's stroke while the outer side is empty (user report, AGH/UR).
    // The box of a bottom-anchored row extends to (sin θ, cos θ) in map
    // meters (the ±90° angle normalization makes it the north-ish side);
    // probe both sides for foreign runs and mark the row side:-1 when the
    // default side lies on strokes and the other one is cleaner.
    const sidePref = (placed) => {
      const th = placed.ang * Math.PI / 180;
      const ux = Math.sin(th), uy = Math.cos(th);
      const runsAt = (s) => nearAt(busGrid, placed.c.x + s * ux * 14, placed.c.y + s * uy * 14).size +
                            nearAt(tramGrid, placed.c.x + s * ux * 14, placed.c.y + s * uy * 14).size;
      return runsAt(1) > runsAt(-1) ? -1 : 1;
    };
    const emit = (placed, extra, ei) => {
      const props = { ...baseProps, angle: Math.round(placed.ang * 10) / 10 };
      if (extra) {
        props.extra = 1;
        // ordinal along the run — the frontend's density row thins the
        // repeats deterministically on this index (every 2nd, 3rd, …)
        if (ei !== undefined) props.ei = ei;
      }
      if (sidePref(placed) < 0) props.side = -1;
      labelFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [round6(placed.c.lon), round6(placed.c.lat)] }, properties: props });
      anchors.push([placed.c.x, placed.c.y]);
    };
    // Main anchors, longest run first: every run of the group gets one at its
    // midpoint (a tight bend there → a straighter spot nearby), skipping runs
    // that merely double an already-labeled one.
    const labeled = []; // xy polylines of the runs that already carry an anchor
    const overTwin = (xy) => {
      const smp = samplesOf(xy);
      if (smp.length < 2) return false;
      let near = 0;
      for (const [x, y] of smp) {
        for (const poly of labeled) {
          let hit = false;
          for (let i = 1; i < poly.length && !hit; i++) {
            if (dSeg(x, y, poly[i - 1][0], poly[i - 1][1], poly[i][0], poly[i][1]) <= TWIN) hit = true;
          }
          if (hit) { near++; break; }
        }
      }
      return near / smp.length > TWIN_FRAC;
    };
    for (const e of [...g.runs].sort((a, b) => b.total - a.total)) {
      if (labeled.length && overTwin(e.xy)) continue;
      for (const frac of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const placed = tryPlace(e, frac * e.total);
        if (!placed) continue;
        if (anchors.some(([ax, ay]) => Math.hypot(ax - placed.c.x, ay - placed.c.y) < MAIN_EXCL)) continue;
        emit(placed, false);
        labeled.push(e.xy);
        break;
      }
    }
    for (const e of g.runs) {
      if (e.total < LONG_RUN) continue;
      let ei = 0;
      for (let d = SPACING / 2; d < e.total; d += SPACING) {
        const placed = tryPlace(e, d);
        if (!placed) continue;
        if (anchors.some(([ax, ay]) => Math.hypot(ax - placed.c.x, ay - placed.c.y) < EXCL)) continue;
        emit(placed, true, ei++);
      }
    }
  }
  // Same-content mains: a corridor keeps its line set across street-name
  // changes, so one physical street prints the IDENTICAL row once per group
  // (Kawiory→Chopina→Czarnowiejska = three copies a few hundred metres apart,
  // user report at the sparsest density). Rank the mains of identical text
  // chained within 1 km: the one nearest the chain's centre stays unmarked,
  // the rest get mi=1,2,… — the frontend's sparsest density step keeps only
  // the unmarked representative.
  {
    const mains = labelFeatures.filter((f) => !f.properties.extra);
    const byText = new Map();
    for (const f of mains) {
      const key = f.properties.lines + '|' + (f.properties.busLines || '');
      if (!byText.has(key)) byText.set(key, []);
      byText.get(key).push(f);
    }
    for (const list of byText.values()) {
      if (list.length < 2) continue;
      const pts = list.map((f) => P.toXY(f.geometry.coordinates[1], f.geometry.coordinates[0]));
      const parent = list.map((_, i) => i);
      const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]) < 1000) parent[find(i)] = find(j);
      const clusters = new Map();
      list.forEach((f, i) => {
        const r = find(i);
        if (!clusters.has(r)) clusters.set(r, []);
        clusters.get(r).push(i);
      });
      for (const idxs of clusters.values()) {
        if (idxs.length < 2) continue;
        const cx = idxs.reduce((s, i) => s + pts[i][0], 0) / idxs.length;
        const cy = idxs.reduce((s, i) => s + pts[i][1], 0) / idxs.length;
        const order = [...idxs].sort((a, b) =>
          Math.hypot(pts[a][0] - cx, pts[a][1] - cy) - Math.hypot(pts[b][0] - cx, pts[b][1] - cy));
        order.forEach((i, rank) => { if (rank > 0) list[i].properties.mi = rank; });
      }
    }
  }
  const nShared = streetFeatures.filter((f) => f.properties.mode === 'tram' && f.properties.busLines).length;
  log(`Labels: ${nShared} shared bus+tram segments, ${busF.filter((o) => o.f.properties.nolabel).length} roadways hand their numbers to tracks, ` +
      `${labelFeatures.length} number labels (${labelFeatures.filter((f) => f.properties.extra).length} zoom-in repeats)`);
}

// ---------- 11) terminus line badges: grids fuse into one complex when they collide ----------
// Each terminating line gets its own small box, laid out in a centered grid under
// the loop. The grid lives in SCREEN space while loops live in metres, so two
// neighbouring loops overlap when zoomed out and stand apart when zoomed in. The
// layout is therefore computed for several ZOOM BANDS: inside a band, anchors whose
// grids would overlap are merged into ONE complex (union of lines, centroid
// position), and the frontend shows the band matching the current zoom.
const badgeFeatures = [];
// Grids are fused for the WORST CASE inside a band (its lower zoom edge), so
// wide bands mean badly oversized complexes near the band's top — the
// whole-map poster renders around z13.9 and with a [13,14] band the Kaponiera
// complex (fused for z13.0) boxed out its neighbours' stop names. Narrower
// bands keep the fusion honest at every zoom.
const BADGE_BANDS = [[13, 13.6], [13.6, 14.4], [14.4, 15.5], [15.5, 16.8], [16.8, 22]];
{
  const anchors = results.flatMap((r) => r.badgeAnchors);
  // Cell spacing is in ems (scales with badge text), but each box also carries
  // FIXED pixels (icon-text-fit padding + rim) that don't scale — at low zoom a
  // 3-digit box outgrew a 3.0/1.5 em cell and neighbours overlapped, so the
  // cells are wider than the naive text estimate.
  const PER_ROW = 5, CELL_W = 3.4, CELL_H = 2.0, BASE_Y = 1.1;
  // MapLibre stores glyph offsets as Int16 (offset px × 32, at the 24 px layout
  // em): past ±42.6 em the value WRAPS — the numbers of rows 21+ detached from
  // their boxes and landed ~40 em above the complex (Ataba: bottom rows empty,
  // a cloud of bare numbers over Al-Shohadaa). Mega-complexes therefore grow
  // WIDE instead of tall — target ≤6 rows (squat grids also blot out less of
  // the street grid on the poster), columns capped at 24 (the x offsets hit
  // the same Int16 wall at ±42 em; rows only pass 20 — y 41.1 em — beyond
  // 500 lines in one complex, hence the emission-time warning below).
  const perRowOf = (n) => Math.min(24, Math.max(PER_ROW, Math.ceil(n / 6)));
  const EM = 9, PAD = 10; // px: label em size in the band, plus breathing room
  // Name-row metrics. The frontend wraps names at text-max-width 10 em with
  // line-height 1.1 (set explicitly in app.js) — roughly 18 chars per line at
  // ~0.55 em/char — so both the row stacking and the fusion test must use the
  // WRAPPED height and width: a two-line name laid out on a one-line slot
  // overprints the row above it, and two neighbouring complexes whose grids
  // clear each other can still cross name stacks.
  const NAME_EM = 10, NAME_CHW = 0.55, NAME_WRAP = 18, NAME_LH = 1.1, NAME_BASE = 0.8;
  // A complex may carry at most MAX_NAMES terminus names — one huge fused
  // block (Katowice centre: 11 names, 55 boxes) reads as noise because the
  // names lose their loops. Clusters that collide but may not fuse are pushed
  // apart by the separation pass below instead.
  const MAX_NAMES = 3;
  // …and at most MAX_LINES boxes: on the whole-map poster the downtown fusions
  // walled over whole blocks of streets and nobody could tell which loop the
  // lines belonged to (user report at Abdel Moneim Riad). A single loop that
  // alone carries more lines stays intact — the cap only stops MERGING.
  const MAX_LINES = 20;
  // Crowded complexes SHRINK: past SC_FREE lines the whole grid — boxes,
  // numbers and name rows — scales down (to 0.7 at the largest loops), so the
  // poster bands stop hiding the street grid under badge walls (user report,
  // second round). The zoom-in bands keep full size: there is room at street
  // level, and 0.7 × 10 px would be squinting territory in the field.
  const SC_FREE = 12;
  const scFor = (band, n) => {
    if (band >= 3 || n <= SC_FREE) return 1;
    const sc = Math.max(0.7, (SC_FREE / n) ** 0.3);
    return band === 2 ? Math.max(sc, 0.85) : sc;
  };
  // loop names never drop below 0.85 — they carry the name↔loop association
  const nameScFor = (band, n) => Math.max(scFor(band, n), 0.85);
  const nameRows = (nm) => Math.max(1, Math.ceil(nm.length / NAME_WRAP));
  const nameWpx = (nm) => Math.min(nm.length, Math.ceil(nm.length / nameRows(nm)) + 2) * NAME_CHW * NAME_EM;
  // full complex footprint in px: box grid below the anchor + name stack above
  const rectOf = (c, band) => {
    const n = c.lines.length;
    const g = geom(n, band);
    const nsc = nameScFor(band, n);
    const stackH = c.names.reduce((s, nm) => s + nameRows(nm) * NAME_LH, 0);
    const w = Math.max(g.w, ...c.names.map((nm) => nameWpx(nm) * nsc));
    const top = -(NAME_BASE + stackH) * NAME_EM * nsc;
    const bottom = g.yc + g.h / 2;
    return { w, cy: (top + bottom) / 2, h: bottom - top };
  };
  const latMid = anchors.length ? anchors.reduce((s, a) => s + a.lat, 0) / anchors.length : 50;
  const P2 = makeProj(latMid, anchors.length ? anchors[0].lon : 19.94);
  // grid footprint in px for n lines: width, height and the centre's offset below
  // the anchor (the grid hangs under the dot)
  const geom = (n, band) => {
    const p = perRowOf(n), sc = scFor(band, n);
    const rows = Math.ceil(n / p), cols = Math.min(p, n);
    return {
      w: cols * CELL_W * EM * sc + PAD,
      h: ((rows - 1) * CELL_H + 1) * EM * sc + PAD,
      yc: (BASE_Y + ((rows - 1) * CELL_H) / 2) * EM * sc,
    };
  };
  let mergedTotal = 0;
  BADGE_BANDS.forEach(([z0], band) => {
    // metres per pixel at the band's lower edge (worst case inside the band);
    // 512 px tiles ⇒ the classic 256 px formula at z+1
    const mpp = (156543.03392 * Math.cos((latMid * Math.PI) / 180)) / 2 ** (z0 + 1);
    const cl = anchors.map((a) => {
      const [x, y] = P2.toXY(a.lat, a.lon);
      return { x, y, n: 1, lines: a.lines.slice(), names: [a.name] };
    });
    for (let pass = 0; pass < 12; pass++) {
      let merged = false;
      for (let i = 0; i < cl.length; i++) {
        for (let j = i + 1; j < cl.length; j++) {
          const A = cl[i], B = cl[j];
          const ra = rectOf(A, band), rb = rectOf(B, band);
          const dx = Math.abs(A.x - B.x);
          const dy = Math.abs((A.y - ra.cy * mpp) - (B.y - rb.cy * mpp));
          if (dx >= ((ra.w + rb.w) / 2) * mpp || dy >= ((ra.h + rb.h) / 2) * mpp) continue;
          if (new Set([...A.names, ...B.names]).size > MAX_NAMES) continue;
          const seen = new Set(A.lines.map((l) => l.line));
          const add = B.lines.filter((l) => !seen.has(l.line));
          if (A.lines.length + add.length > MAX_LINES) continue;
          for (const l of add) A.lines.push(l);
          for (const nm of B.names) if (!A.names.includes(nm)) A.names.push(nm);
          A.x = (A.x * A.n + B.x * B.n) / (A.n + B.n);
          A.y = (A.y * A.n + B.y * B.n) / (A.n + B.n);
          A.n += B.n;
          cl.splice(j--, 1);
          merged = true;
        }
      }
      if (!merged) break;
    }
    // Separation: complexes that still overlap (the MAX_NAMES cap stopped the
    // merge) are nudged apart along the axis needing the smaller correction,
    // half each. The terminus DOTS are drawn from stops.geojson at the true
    // loop positions and do not move, so a nudged complex stays next to its
    // loop and the name→loop association survives.
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < cl.length; i++) {
        for (let j = i + 1; j < cl.length; j++) {
          const A = cl[i], B = cl[j];
          const ra = rectOf(A, band), rb = rectOf(B, band);
          const dxp = (A.x - B.x) / mpp;
          const dyp = ((A.y - ra.cy * mpp) - (B.y - rb.cy * mpp)) / mpp;
          const ox = (ra.w + rb.w) / 2 - Math.abs(dxp);
          const oy = (ra.h + rb.h) / 2 - Math.abs(dyp);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = (dxp >= 0 ? 1 : -1) * (ox / 2 + 2) * mpp;
            A.x += s; B.x -= s;
          } else {
            const s = (dyp >= 0 ? 1 : -1) * (oy / 2 + 2) * mpp;
            A.y += s; B.y -= s;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    mergedTotal += anchors.length - cl.length;
    for (const c of cl) {
      const lines = c.lines.slice().sort((a, b) => numSort(a.line, b.line));
      const [lon, lat] = P2.toLonLat(c.x, c.y);
      // The terminus NAME(S) ride with the complex: reserved rows stacked
      // right above the grid, drawn unconditionally like the boxes. The
      // collision-managed name layer could stay nameless at saturated nodes
      // (Bałtyk at Kaponiera) — and a nameless loop is a hard error on a
      // printed map, so from z13 these rows replace it.
      // metro contributes 'metro', not 'tram' — the name row follows whichever
      // of the complex's networks is still toggled on
      const modes = [...new Set(lines.map((l) => (l.metro ? 'metro' : l.mode)))].join(',');
      // a complex where EVERY terminating line is a metrolinia follows the
      // metrolines toggle (its boxes are filtered per-box by color)
      const mall = lines.every((l) => l.color === MLINE_YELLOW) ? 1 : 0;
      const msome = lines.some((l) => l.color === MLINE_YELLOW) ? 1 : 0;
      // per-complex shrink rides along as `sc` — the frontend multiplies the
      // band's constant text size by it (em offsets follow the font size, so
      // the whole grid scales as one)
      const scC = Math.round(scFor(band, lines.length) * 100) / 100;
      const nscC = Math.round(nameScFor(band, lines.length) * 100) / 100;
      let yOff = NAME_BASE;
      for (const nm of [...c.names].sort((a, b) => b.localeCompare(a))) {
        badgeFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
          properties: { name: nm, band, modes, arr: lines.map((l) => l.line), off: [0, -Math.round(yOff * 100) / 100], ...(nscC < 1 ? { sc: nscC } : {}), ...(mall ? { mall: 1 } : {}), ...(msome ? { msome: 1 } : {}) },
        });
        yOff += nameRows(nm) * NAME_LH;
      }
      const pRow = perRowOf(lines.length);
      if (Math.ceil(lines.length / pRow) > 20) log(`WARNING: badge complex "${c.names[0]}" carries ${lines.length} lines — y offsets nearing the Int16 wrap`);
      lines.forEach((l, i) => {
        const row = Math.floor(i / pRow), col = i % pRow;
        const rowLen = Math.min(pRow, lines.length - row * pRow);
        badgeFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
          properties: {
            line: l.line, mode: l.mode, color: l.color, colorDark: l.colorDark, band,
            ...(l.metro ? { metro: 1 } : {}),
            ...(scC < 1 ? { sc: scC } : {}),
            off: [
              Math.round((col - (rowLen - 1) / 2) * CELL_W * 100) / 100,
              Math.round((BASE_Y + row * CELL_H) * 100) / 100,
            ],
          },
        });
      });
    }
  });
  log(`Badges: ${badgeFeatures.length} boxes across ${BADGE_BANDS.length} zoom bands ` +
      `(${mergedTotal} colliding grids fused)`);
}

// ---------- 12) street-name geometry: the runs re-joined by NAME ----------
// The stroke layer is cut wherever the LINE SET changes, so one avenue arrives
// here as a dozen fragments — median 21 px on screen at z12.6, far too short to
// carry their own name, which is why the map ran nameless at low zoom (user
// report). Street names therefore get their own geometry: the same runs merged
// by name only, so a street is one long polyline that MapLibre can label along
// its whole course, repeatedly, at any zoom.
const nameFeatures = mergeRuns(streetFeatures
  .filter((f) => f.properties.name && !f.properties.roundabout && !f.properties.unmapped)
  .map((f) => ({ coords: f.geometry.coordinates, name: f.properties.name, linesKey: f.properties.name, roundabout: 0 })))
  .map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: { name: r.name } }));
log(`Street names: ${nameFeatures.length} named polylines re-joined from ${streetFeatures.filter((f) => f.properties.name).length} runs`);

let bLonMin = Infinity, bLonMax = -Infinity, bLatMin = Infinity, bLatMax = -Infinity;
for (const f of routeFeatures) for (const [lon, lat] of f.geometry.coordinates) {
  if (lon < bLonMin) bLonMin = lon; if (lon > bLonMax) bLonMax = lon;
  if (lat < bLatMin) bLatMin = lat; if (lat > bLatMax) bLatMax = lat;
}

// ---------- display labels ----------
// The keys keep their prefixes; every string the map PRINTS loses them. Two
// keys can now print the same number — that is the point, because the street
// prints the same number — so each colour group is deduplicated on its own
// (the groups ride in separate properties, so a green 9 and a navy 9 both
// survive: there the colour is the difference).
const relabel = (s) => {
  const out = [];
  for (const k of s.split(', ')) {
    const v = LBL.get(k) ?? k;
    if (!out.includes(v)) out.push(v);
  }
  return out.join(', ');
};
for (const features of [routeFeatures, streetFeatures, labelFeatures, stopFeatures, badgeFeatures]) {
  for (const f of features) {
    const p = f.properties;
    for (const k of ['lines', 'busLines', 'tLines', 'ntLines', 'mLines', 'nmLines']) {
      if (typeof p[k] === 'string' && p[k]) p[k] = relabel(p[k]);
    }
    if (typeof p.line === 'string' && LBL.has(p.line)) p.lbl = LBL.get(p.line);
  }
}
log(`Display labels: ${LBL.size} keys print the number the city signs`);

const outDir = join(ROOT, 'data/out');
mkdirSync(outDir, { recursive: true });
const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(join(outDir, 'route.geojson'), fc(routeFeatures));
writeFileSync(join(outDir, 'streets.geojson'), fc(streetFeatures));
writeFileSync(join(outDir, 'labels.geojson'), fc(labelFeatures));
writeFileSync(join(outDir, 'street-names.geojson'), fc(nameFeatures));
writeFileSync(join(outDir, 'stops.geojson'), fc(stopFeatures));
writeFileSync(join(outDir, 'badges.geojson'), fc(badgeFeatures));
writeFileSync(join(outDir, 'gtfs-shape.geojson'), fc(shapeFeatures));
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  bbox: [bLonMin, bLatMin, bLonMax, bLatMax],
  badgeBands: BADGE_BANDS,
  modes: MODES.map((m) => ({ mode: m.mode, label: m.label, color: m.color })),
  // the chips keep `line` as their value (selection matches keys) and print
  // `label` where the city's number differs from the pipeline's key
  // which operator runs a line — the panel groups its chip cloud by this,
  // because Verbund-wide the same number belongs to several of them
  ops: SCOPE.opName || {},
  lines: metaLines.map((l) => ({
    ...(LBL.has(l.line) ? { ...l, label: LBL.get(l.line) } : l),
    ...(LINE_OP.has(l.line) ? { op: LINE_OP.get(l.line) } : {}),
  })),
}, null, 2));
log(`Wrote data/out/{route,streets,labels,street-names,stops,badges,gtfs-shape}.geojson + meta.json`);

// Night lines print black, and sort last where the lists carry no rank
// (user rule 8.09.2026): a post-pass over the written outputs, see night.mjs.
await (await import('./night.mjs')).nightPass(outDir, /^N\d/, { sort: true });
// …and a liveried line keeps its own colour in the number rows, even where it
// shares a corridor with another one (user rule, 9.09.2026): see railrows.mjs.
await (await import('./railrows.mjs')).railRowPass(outDir, /^N\d/, { log });
