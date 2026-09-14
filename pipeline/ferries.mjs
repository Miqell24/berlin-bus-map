// The ferries' WATER (14.09.2026). BVG's F10–F24 and Strausberg's F39 cross
// the Havel, the Spree, the Dahme, the Müggelsee and the Straussee, and
// nothing in the inputs draws those crossings: the road graph ends at the
// landing stages and the VBB shapes are straight chords. So the water itself
// is made the network — the method written for Copenhagen's harbour buses
// (copenhagen-bus-map/pipeline/harbour.mjs), with two Berlin differences:
//
//  * AREAS. The seven lines lie up to 50 km apart, so there is no one grid:
//    the stops are grouped by the lines joining them, and every group gets a
//    4 m grid of its own (its stops plus MARGIN).
//  * STRAIGHT CROSSINGS. Most of these ferries go from one bank to the other,
//    a few hundred metres at most. Where the straight line between two
//    landing stages stays on the water, that line is the crossing; only a leg
//    that would cut across land (F10 Wannsee–Kladow) is routed through the
//    grid, smoothed and docked.
//
// Per area: OSM water polygons (natural=water, riverbank) and piers become an
// occupancy grid, every water cell learns its clearance from the nearest shore
// (exact distance transform), every stop gets a BERTH on land — its pier, or
// the bank BERTH_DEPTH cells behind the water's edge — and every course starts
// and ends exactly there. The finished courses are sampled every metre against
// the mask: on land only within LAND_OK of a berth, or the course is not drawn
// as it stands. Written as synthetic route=ferry ways named after the water
// they cross (data/osm/berlin-ferry.json, with the berth of every stop, which
// build.mjs draws the stop discs on).
//
// Usage: node pipeline/ferries.mjs [--png]
// Reads data/gtfs, data/scope.json (ferry), data/osm/berlin-water.json
// (pipeline/water-cut.py); writes data/osm/berlin-ferry.json and
// data/ferries-qa.geojson.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';
import { makeProj, resample } from './lib/geo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');
const WATER_FILE = join(ROOT, 'data/osm/berlin-water.json');
const OUT_FILE = join(ROOT, 'data/osm/berlin-ferry.json');
const QA_FILE = join(ROOT, 'data/ferries-qa.geojson');

const ARGS = process.argv.slice(2);
const CELL = 4;                             // m — grid cell; a river is 40–400 m wide, banks matter to ~5 m
const MARGIN = 1500;                        // m — grid around an area's stops
const CLEAR_MIN = 6;                        // m — the hard floor: no routed course runs nearer to land
const CLEAR_MID = 20;                       // m — the corridor a boat keeps whenever the water allows it…
const CORR_PEN = 3;                         // …a step inside it costs three times over
const K_MID = 25;                           // m — mid-channel pull: a step costs len × (1 + K_MID / clearance)
const CLEAR_SNAP = 6;                       // m — the water point a routed course starts from
const SNAP_MAX = 85;                        // m — how far that point may be from the berth
const CLEAR_SMOOTH = 15;                    // m — the relaxation may cut a corner down to this clearance, never further
const BERTH_DEPTH = 2;                      // cells — a berth on a bank sits this deep behind the edge (≈ 6 m)
const BERTH_MAX = 90;                       // m — how far the berth may be from the feed's coordinate
const LAND_OK = 14;                         // m — only this close to its berth may a course be over land
const APPROACH = 0.3;                       // past LAND_OK a course must gain this much clearance per metre from the berth
const STOP_DRIFT = 35;                      // m — the water course: how far a call may slide off its water point
const DOCK_MAX = 90;                        // m — the stretch either side of a call that bends in to its berth
const DOCK_ITER = 1500;                     // bending steps once the calls are pinned to their berths
const BEND_ITER = 4000, BEND_RATE = 0.05;   // bending flow: steps and rate (explicit scheme, stable below 1/16)
const SMOOTH_STEP = 8;                      // m — vertex spacing of a relaxed course
const SMOOTH_ITER = 120;                    // curvature flow steps at 8 m spacing
const DP_TOL = 6;                           // m — Douglas–Peucker tolerance on the grid path
const BASIN_MIN = 150;                      // m — a shorter stretch of another water's name is a boundary wobble
const OPEN_WATER_MIN = 20000;               // m² — a water body smaller than this is a pond, not what a ferry rides
const WATER_MAX_SHARE = 0.85;               // an area's grid more water than this means a ring filled the land

const t0 = Date.now();
const log = (m) => console.log(`[ferries ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------- 1) the ferry lines and their stop sequences ----------
const SCOPE = JSON.parse(readFileSync(join(ROOT, 'data/scope.json'), 'utf8'));
const FERRY = new Set(SCOPE.ferry || []);
if (!FERRY.size) { console.error('no ferries in data/scope.json — run pipeline/scope.mjs'); process.exit(1); }
const routeToLine = new Map();
for (const r of await readCsv(join(GD, 'routes.txt'))) if (FERRY.has(r.route_id)) routeToLine.set(r.route_id, (r.route_short_name || '').trim());
const tripLine = new Map();
for await (const t of iterCsv(join(GD, 'trips.txt'))) {
  const L = routeToLine.get(t.route_id);
  if (L) tripLine.set(t.trip_id, L);
}
const tripStops = new Map();
for await (const st of iterCsv(join(GD, 'stop_times.txt'))) {
  if (!tripLine.has(st.trip_id)) continue;
  let arr = tripStops.get(st.trip_id);
  if (!arr) tripStops.set(st.trip_id, (arr = []));
  arr.push([Number(st.stop_sequence), st.stop_id]);
}
// the unordered pairs of consecutive stops over every pattern of every line —
// one course per pair, both directions and every short-turn ride the same water
const pairs = new Map();    // "a|b" (sorted) → { a, b, lines }
const stopIds = new Set();
for (const [tid, arr] of tripStops) {
  const seq = arr.sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    if (a === b) continue;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (!pairs.has(k)) pairs.set(k, { a: a < b ? a : b, b: a < b ? b : a, lines: new Set() });
    pairs.get(k).lines.add(tripLine.get(tid));
  }
  for (const s of seq) stopIds.add(s);
}
const stops = new Map();
for await (const s of iterCsv(join(GD, 'stops.txt'))) {
  if (stopIds.has(s.stop_id)) stops.set(s.stop_id, { name: (s.stop_name || '').trim(), lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
}
log(`${routeToLine.size} ferry lines (${[...new Set(routeToLine.values())].sort().join(', ')}), ${stops.size} stops, ${pairs.size} stop pairs`);

// the AREAS: stops joined by a stop pair, transitively (union–find)
const parent = new Map([...stops.keys()].map((id) => [id, id]));
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
for (const { a, b } of pairs.values()) parent.set(find(a), find(b));
const areaOf = new Map();
for (const id of stops.keys()) {
  const root = find(id);
  if (!areaOf.has(root)) areaOf.set(root, { stops: [], pairs: [] });
  areaOf.get(root).stops.push(id);
}
for (const p of pairs.values()) areaOf.get(find(p.a)).pairs.push(p);
const AREAS = [...areaOf.values()];

const osm = JSON.parse(readFileSync(WATER_FILE, 'utf8'));
const eqPt = (a, b) => Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7;
// closed rings of a water feature: a closed way is one ring; a multipolygon's
// member ways are chained end to end (outer and inner alike — the even-odd
// fill lets an inner ring cut its island back out)
function ringsOf(el) {
  if (el.type === 'way') {
    const g = el.geometry;
    return { rings: g && g.length >= 4 && eqPt(g[0], g[g.length - 1]) ? [g] : [], unclosed: 0 };
  }
  const pieces = (el.members || []).filter((m) => m.type === 'way' && m.geometry && m.geometry.length >= 2).map((m) => m.geometry.slice());
  const rings = [];
  let unclosed = 0;
  while (pieces.length) {
    const ring = pieces.pop();
    for (let guard = 0; guard < 5000 && !eqPt(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      let idx = -1, rev = false;
      for (let i = 0; i < pieces.length; i++) {
        if (eqPt(pieces[i][0], end)) { idx = i; break; }
        if (eqPt(pieces[i][pieces[i].length - 1], end)) { idx = i; rev = true; break; }
      }
      if (idx < 0) break;
      const p = pieces.splice(idx, 1)[0];
      if (rev) p.reverse();
      for (let k = 1; k < p.length; k++) ring.push(p[k]);
    }
    if (ring.length >= 4 && eqPt(ring[0], ring[ring.length - 1])) rings.push(ring);
    else unclosed++;
  }
  return { rings, unclosed };
}
const isWaterFeature = (t) => t && (t.natural === 'water' || t.natural === 'bay' || t.waterway === 'riverbank' || t.waterway === 'dock');

// ---------- 2–6) one area: grid, mask, clearance, berths, courses ----------
function routeArea(area, ai) {
  const alog = (m) => log(`[${ai + 1}/${AREAS.length}] ${m}`);
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const id of area.stops) {
    const s = stops.get(id);
    latMin = Math.min(latMin, s.lat); latMax = Math.max(latMax, s.lat);
    lonMin = Math.min(lonMin, s.lon); lonMax = Math.max(lonMax, s.lon);
  }
  const proj = makeProj((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  const [xa, ya] = proj.toXY(latMin, lonMin), [xb, yb] = proj.toXY(latMax, lonMax);
  const X0 = xa - MARGIN, Y0 = ya - MARGIN;
  const W = Math.ceil((xb - xa + 2 * MARGIN) / CELL), H = Math.ceil((yb - ya + 2 * MARGIN) / CELL);
  const N = W * H;
  const colOf = (x) => Math.floor((x - X0) / CELL), rowOf = (y) => Math.floor((y - Y0) / CELL);
  const cxOf = (c) => X0 + (c + 0.5) * CELL, cyOf = (r) => Y0 + (r + 0.5) * CELL;
  const inGrid = (c, r) => c >= 0 && r >= 0 && c < W && r < H;
  const names = [...new Set(area.pairs.flatMap((p) => [...p.lines]))].sort().join(', ');
  alog(`${names}: ${area.stops.map((id) => stops.get(id).name).join(' · ')} — grid ${W} × ${H} cells`);

  // 3) the water mask
  const water = new Uint8Array(N), barrier = new Uint8Array(N), pier = new Uint8Array(N);
  const toXY = (g) => g.map((p) => proj.toXY(p.lat, p.lon));
  const bboxOf = (g) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const p of g) { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lon); d = Math.max(d, p.lon); } return [a, b, c, d]; };
  const [gLat0, gLon0] = proj.toLonLat(X0, Y0).reverse(), [gLat1, gLon1] = proj.toLonLat(X0 + W * CELL, Y0 + H * CELL).reverse();
  const nearGrid = (el) => {
    const gs = el.type === 'way' ? [el.geometry] : (el.members || []).map((m) => m.geometry).filter(Boolean);
    return gs.some((g) => { const [a, b, c, d] = bboxOf(g); return b >= gLat0 && a <= gLat1 && d >= gLon0 && c <= gLon1; });
  };
  function fillRings(rings, v, into) {
    let yLo = Infinity, yHi = -Infinity;
    for (const r of rings) for (const [, y] of r) { if (y < yLo) yLo = y; if (y > yHi) yHi = y; }
    const r0 = Math.max(0, rowOf(yLo)), r1 = Math.min(H - 1, rowOf(yHi));
    for (let r = r0; r <= r1; r++) {
      const yc = cyOf(r);
      const xs = [];
      for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
        if ((ay <= yc) === (by <= yc)) continue;
        xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - X0) / CELL - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - X0) / CELL - 0.5));
        for (let c = c0; c <= c1; c++) into[r * W + c] = v;
      }
    }
  }
  // an 8-connected cell line (Bresenham) into `into`
  const line = (c0, r0, c1, r1, into) => {
    const dc = Math.abs(c1 - c0), dr = -Math.abs(r1 - r0);
    const sc = c0 < c1 ? 1 : -1, sr = r0 < r1 ? 1 : -1;
    let err = dc + dr, c = c0, r = r0;
    for (;;) {
      if (inGrid(c, r)) into[r * W + c] = 1;
      if (c === c1 && r === r1) break;
      const e2 = 2 * err;
      if (e2 >= dr) { err += dr; c += sc; }
      if (e2 <= dc) { err += dc; r += sr; }
    }
  };
  const basins = [];
  let polyCount = 0, unclosed = 0, pierCount = 0;
  for (const el of osm.elements) {
    const t = el.tags;
    const wet = isWaterFeature(t), isPier = t?.man_made === 'pier';
    if ((!wet && !isPier) || !nearGrid(el)) continue;
    const got = ringsOf(el);
    unclosed += wet ? got.unclosed : 0;
    const rings = got.rings.map(toXY);
    // a LINEAR pier — a landing stage drawn as a line, as most of Berlin's
    // are — is a strip of land one cell wide: the ferries tie up at it
    if (isPier && !rings.length && el.type === 'way') {
      const g = toXY(el.geometry);
      for (let i = 0; i + 1 < g.length; i++) line(colOf(g[i][0]), rowOf(g[i][1]), colOf(g[i + 1][0]), rowOf(g[i + 1][1]), pier);
      pierCount++;
      continue;
    }
    if (!rings.length) continue;
    if (isPier) { fillRings(rings, 1, pier); pierCount++; continue; }
    polyCount++;
    fillRings(rings, 1, water);
    if (t.name) {
      let a2 = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const ring of rings) {
        let a = 0;
        for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
        a2 = Math.max(a2, Math.abs(a) / 2);
        for (const [x, y] of ring) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
      }
      basins.push({ name: t.name, rings, area: a2, bbox: [bx0, by0, bx1, by1] });
    }
  }
  // the coastline, where an area has one (none of Berlin's do): burnt in as
  // barriers, the cells between them voted sea or land by its convention —
  // land on the LEFT of the way
  const seedsW = [], seedsL = [];
  const burn = (c0, r0, c1, r1) => line(c0, r0, c1, r1, barrier);
  let coastSegs = 0;
  for (const el of osm.elements) {
    if (el.type !== 'way' || el.tags?.natural !== 'coastline' || !nearGrid(el)) continue;
    const g = toXY(el.geometry);
    for (let i = 0; i + 1 < g.length; i++) {
      const [ax, ay] = g[i], [bx, by] = g[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (!len) continue;
      coastSegs++;
      burn(colOf(ax), rowOf(ay), colOf(bx), rowOf(by));
      const nx = (by - ay) / len, ny = -(bx - ax) / len, mx = (ax + bx) / 2, my = (ay + by) / 2, off = 2.5 * CELL;
      const cw = colOf(mx + nx * off), rw = rowOf(my + ny * off), cl = colOf(mx - nx * off), rl = rowOf(my - ny * off);
      if (inGrid(cw, rw) && !barrier[rw * W + cw]) seedsW.push(rw * W + cw);
      if (inGrid(cl, rl) && !barrier[rl * W + cl]) seedsL.push(rl * W + cl);
    }
  }
  const queue = new Int32Array(N);
  if (coastSegs) {
    const comp = new Int32Array(N).fill(-1);
    let nComp = 0;
    for (let s = 0; s < N; s++) {
      if (barrier[s] || comp[s] >= 0) continue;
      const id = nComp++;
      let qh = 0, qt = 0;
      queue[qt++] = s; comp[s] = id;
      while (qh < qt) {
        const i = queue[qh++], c = i % W;
        for (const k of [c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1, i - W, i + W]) {
          if (k < 0 || k >= N || barrier[k] || comp[k] >= 0) continue;
          comp[k] = id; queue[qt++] = k;
        }
      }
    }
    const vW = new Int32Array(nComp), vL = new Int32Array(nComp);
    for (const i of seedsW) if (comp[i] >= 0) vW[comp[i]]++;
    for (const i of seedsL) if (comp[i] >= 0) vL[comp[i]]++;
    for (let i = 0; i < N; i++) if (!water[i] && comp[i] >= 0 && vW[comp[i]] > vL[comp[i]]) water[i] = 1;
    for (let i = 0; i < N; i++) if (barrier[i]) water[i] = 0;
  }
  // piers are land: OSM maps a pier over the water polygon, not as a hole
  for (let i = 0; i < N; i++) if (pier[i]) water[i] = 0;
  for (let c = 0; c < W; c++) { water[c] = 0; water[(H - 1) * W + c] = 0; }
  for (let r = 0; r < H; r++) { water[r * W] = 0; water[r * W + W - 1] = 0; }
  let waterCells = 0;
  for (let i = 0; i < N; i++) waterCells += water[i];
  alog(`mask: ${polyCount} water polygons${unclosed ? ` (${unclosed} unclosed rings skipped)` : ''}, ${pierCount} piers, ${coastSegs} coastline segments → ${(waterCells * CELL * CELL / 1e6).toFixed(2)} km² of water (${Math.round(100 * waterCells / N)} % of the grid)`);
  if (waterCells > WATER_MAX_SHARE * N) {
    console.error(`ferries: area ${ai + 1} (${names}) is ${Math.round(100 * waterCells / N)} % water — a ring filled the land; nothing written`);
    process.exit(1);
  }

  // 4) clearance: exact Euclidean distance to the nearest land cell
  const clear = new Float32Array(N);
  {
    const INF = 1e20, M = Math.max(W, H);
    const f = new Float64Array(M), d = new Float64Array(M), v = new Int32Array(M), z = new Float64Array(M + 1);
    const dt1d = (n) => {
      let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    };
    const g = new Float64Array(N);
    for (let c = 0; c < W; c++) {
      for (let r = 0; r < H; r++) f[r] = water[r * W + c] ? INF : 0;
      dt1d(H);
      for (let r = 0; r < H; r++) g[r * W + c] = d[r];
    }
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) f[c] = g[r * W + c];
      dt1d(W);
      for (let c = 0; c < W; c++) clear[r * W + c] = water[r * W + c] ? Math.sqrt(d[c]) * CELL : 0;
    }
  }
  const clearAt = (x, y) => { const c = colOf(x), r = rowOf(y); return inGrid(c, r) ? clear[r * W + c] : 0; };

  // 5) berths. OPEN water: 4-connected water bodies of OPEN_WATER_MIN or more
  // — a berth is a bank of the river, never of a garden pond beside it
  const openWater = new Uint8Array(N);
  {
    const seen = new Uint8Array(N);
    for (let s = 0; s < N; s++) {
      if (!water[s] || seen[s]) continue;
      let qh = 0, qt = 0;
      queue[qt++] = s; seen[s] = 1;
      while (qh < qt) {
        const i = queue[qh++], c = i % W;
        for (const k of [c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1, i - W, i + W]) {
          if (k < 0 || k >= N || !water[k] || seen[k]) continue;
          seen[k] = 1; queue[qt++] = k;
        }
      }
      if (qt * CELL * CELL >= OPEN_WATER_MIN) for (let q = 0; q < qt; q++) openWater[queue[q]] = 1;
    }
  }
  // the berth: nearest cell to the feed's coordinate that is a PIER next to
  // open water, or a bank cell exactly BERTH_DEPTH cells behind it
  const berth = (x, y) => {
    const c0 = colOf(x), r0 = rowOf(y), R = Math.ceil(BERTH_MAX / CELL);
    let best = null;
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      const c = c0 + dc, r = r0 + dr;
      if (c < BERTH_DEPTH + 1 || r < BERTH_DEPTH + 1 || c > W - BERTH_DEPTH - 2 || r > H - BERTH_DEPTH - 2) continue;
      const i = r * W + c;
      if (water[i]) continue;
      const d = Math.hypot(cxOf(c) - x, cyOf(r) - y);
      if (d > BERTH_MAX || (best && d >= best.d)) continue;
      const D = pier[i] ? 1 : BERTH_DEPTH;
      let near = false, ring = false;
      for (let er = -D; er <= D && !near; er++) for (let ec = -D; ec <= D; ec++) {
        if (!openWater[(r + er) * W + c + ec]) continue;
        if (Math.max(Math.abs(er), Math.abs(ec)) < D) { near = true; break; }
        ring = true;
      }
      if (near || !ring) continue;
      best = { i, d, x: cxOf(c), y: cyOf(r) };
    }
    return best;
  };
  // the water point out of a berth: nearest cell with CLEAR_SNAP m around it
  // that the berth SEES (land on the way only within LAND_OK)
  const snap = (x, y) => {
    const c0 = colOf(x), r0 = rowOf(y), R = Math.ceil(SNAP_MAX / CELL);
    const sees = (tx, ty) => {
      const L = Math.hypot(tx - x, ty - y), k = Math.ceil(L);
      for (let s = 1; s < k; s++) if (L * s / k > LAND_OK && clearAt(x + (tx - x) * s / k, y + (ty - y) * s / k) <= 0) return false;
      return true;
    };
    let best = null;
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      const c = c0 + dc, r = r0 + dr;
      if (!inGrid(c, r)) continue;
      const i = r * W + c;
      if (!water[i] || clear[i] < CLEAR_SNAP) continue;
      const d = Math.hypot(cxOf(c) - x, cyOf(r) - y);
      if (d <= SNAP_MAX && (!best || d < best.d) && sees(cxOf(c), cyOf(r))) best = { i, d };
    }
    return best;
  };
  // the clearance a course must keep at a point: none within LAND_OK of a
  // berth, then a ramp of APPROACH m per metre up to CLEAR_SMOOTH
  const needFrom = (berths) => (x, y) => {
    let d = Infinity;
    for (const b of berths) d = Math.min(d, Math.hypot(x - b[0], y - b[1]));
    return d <= LAND_OK ? -1 : Math.min(CLEAR_SMOOTH, (d - LAND_OK) * APPROACH);
  };
  // the proof: sampled every metre, the course is water everywhere but the
  // LAND_OK metres out of each of its two berths
  const audit = (pts) => {
    let minC = Infinity, minAt = null, land = 0, len = 0;
    const A = pts[0], B = pts[pts.length - 1];
    for (let i = 1; i < pts.length; i++) {
      const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]), n = Math.max(1, Math.ceil(L));
      len += L;
      for (let k = 0; k <= n; k++) {
        const x = pts[i - 1][0] + k / n * (pts[i][0] - pts[i - 1][0]), y = pts[i - 1][1] + k / n * (pts[i][1] - pts[i - 1][1]);
        if (Math.min(Math.hypot(x - A[0], y - A[1]), Math.hypot(x - B[0], y - B[1])) <= LAND_OK + 0.5) continue;
        const c = clearAt(x, y);
        if (c <= 0 && !land++) minAt = [x, y];
        if (!land && c < minC) { minC = c; minAt = [x, y]; }
      }
    }
    return { minC, minAt, land, len };
  };

  const snapOf = new Map(); // stop id → { i, x, y, d, bx, by, bd }
  for (const id of area.stops) {
    const s = stops.get(id);
    const [x, y] = proj.toXY(s.lat, s.lon);
    const q = berth(x, y);
    if (!q) { alog(`WARNING: ${s.name} — no bank of open water within ${BERTH_MAX} m`); continue; }
    const b = snap(q.x, q.y);
    snapOf.set(id, { i: b ? b.i : -1, x: b ? cxOf(b.i % W) : q.x, y: b ? cyOf((b.i - b.i % W) / W) : q.y, d: b ? b.d : 0, bx: q.x, by: q.y, bd: q.d });
    alog(`  berth ${s.name}: ${pier[q.i] ? 'pier' : 'bank'}, ${Math.round(q.d)} m from the feed's coordinate (${water[rowOf(y) * W + colOf(x)] ? 'in the water' : 'on land'})${b ? '' : ' — no deep water in sight'}`);
  }

  // 5a) every stop pair: the STRAIGHT crossing where it stays on the water,
  // otherwise berth → A* through the grid → berth
  const courses = [];
  const routed = [];
  const straightOk = (A, B) => {
    const need = needFrom([A, B]);
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]), n = Math.ceil(L);
    for (let k = 1; k < n; k++) {
      const x = A[0] + (B[0] - A[0]) * k / n, y = A[1] + (B[1] - A[1]) * k / n;
      const nd = need(x, y);
      if (nd >= 0 && (clearAt(x, y) <= 0 || clearAt(x, y) < nd)) return false;
    }
    return true;
  };
  for (const p of area.pairs) {
    const A = snapOf.get(p.a), B = snapOf.get(p.b);
    const na = stops.get(p.a).name, nb = stops.get(p.b).name;
    if (!A || !B) { alog(`SKIPPED ${na} – ${nb}: a stop without a berth`); continue; }
    const a = [A.bx, A.by], b = [B.bx, B.by];
    if (straightOk(a, b)) {
      const pts = resample([a, b], SMOOTH_STEP);
      courses.push({ a: p.a, b: p.b, pts, raw: [a, b], kind: 'straight', stats: audit(pts) });
      continue;
    }
    if (A.i < 0 || B.i < 0) { alog(`SKIPPED ${na} – ${nb}: not straight, and a berth sees no deep water`); continue; }
    const res = astar(A.i, B.i);
    if (!res) { alog(`SKIPPED ${na} – ${nb}: no water course with ${CLEAR_MIN} m clearance joins the two`); continue; }
    const wet = simplify(res.path);
    routed.push({ a: p.a, b: p.b, raw: [a, ...res.path, b], wet, simple: [a, ...wet, b], expanded: res.expanded });
  }

  // A* on the 8-connected grid, water cells with clearance ≥ CLEAR_MIN only
  function astar(start, goal) {
    const gCost = new Float64Array(N), came = new Int32Array(N), state = new Uint8Array(N); // 0 new, 1 open, 2 closed
    const heapK = [], heapV = [];
    const push = (k, v) => {
      heapK.push(k); heapV.push(v);
      let i = heapK.length - 1;
      while (i > 0) { const q = (i - 1) >> 1; if (heapK[q] <= heapK[i]) break; [heapK[q], heapK[i]] = [heapK[i], heapK[q]]; [heapV[q], heapV[i]] = [heapV[i], heapV[q]]; i = q; }
    };
    const pop = () => {
      const v = heapV[0];
      const lk = heapK.pop(), lv = heapV.pop();
      if (heapK.length) {
        heapK[0] = lk; heapV[0] = lv;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heapK.length && heapK[l] < heapK[m]) m = l;
          if (r < heapK.length && heapK[r] < heapK[m]) m = r;
          if (m === i) break;
          [heapK[m], heapK[i]] = [heapK[i], heapK[m]]; [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
          i = m;
        }
      }
      return v;
    };
    const gc = goal % W, gr = (goal - gc) / W;
    const h = (i) => { const c = i % W, r = (i - c) / W; return Math.hypot((c - gc) * CELL, (r - gr) * CELL); };
    const NB = [[1, 0, CELL], [-1, 0, CELL], [0, 1, CELL], [0, -1, CELL], [1, 1, CELL * Math.SQRT2], [1, -1, CELL * Math.SQRT2], [-1, 1, CELL * Math.SQRT2], [-1, -1, CELL * Math.SQRT2]];
    state[start] = 1; came[start] = -1;
    push(h(start), start);
    let expanded = 0;
    while (heapK.length) {
      const i = pop();
      if (state[i] === 2) continue;
      state[i] = 2;
      expanded++;
      if (i === goal) {
        const path = [];
        for (let j = i; j >= 0; j = came[j]) path.push([cxOf(j % W), cyOf((j - j % W) / W)]);
        return { path: path.reverse(), expanded };
      }
      const c = i % W, r = (i - c) / W;
      for (const [dc, dr, len] of NB) {
        const nc = c + dc, nr = r + dr;
        if (!inGrid(nc, nr)) continue;
        const j = nr * W + nc;
        if (!water[j] || clear[j] < CLEAR_MIN || state[j] === 2) continue;
        const ng = gCost[i] + len * (1 + K_MID / clear[j]) * (clear[j] < CLEAR_MID ? CORR_PEN : 1);
        if (state[j] === 0 || ng < gCost[j]) {
          state[j] = 1; gCost[j] = ng; came[j] = i;
          push(ng + h(j), j);
        }
      }
    }
    return null;
  }
  function segmentClear(a, b, minClear) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / (CELL / 2)));
    for (let k = 0; k <= n; k++) if (clearAt(a[0] + k / n * (b[0] - a[0]), a[1] + k / n * (b[1] - a[1])) < minClear) return false;
    return true;
  }
  function simplify(pts) {
    const distToSeg = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
    };
    const out = [pts[0]];
    const rec = (i, j) => {
      let bi = -1, bd = -1;
      for (let k = i + 1; k < j; k++) { const d = distToSeg(pts[k], pts[i], pts[j]); if (d > bd) { bd = d; bi = k; } }
      if (bi >= 0 && (bd > DP_TOL || !segmentClear(pts[i], pts[j], CLEAR_SNAP))) { rec(i, bi); rec(bi, j); }
      else out.push(pts[j]);
    };
    rec(0, pts.length - 1);
    return out;
  }
  // stage one, the WATER COURSE: calls on a STOP_DRIFT leash, free chain ends
  function relaxLeash(P, pins) {
    const anchor = new Map(pins.map((i) => [i, P[i].slice()]));
    const n = P.length;
    const tryMove = (Q, i, tx, ty) => {
      const an = anchor.get(i);
      if (an) {
        const dx = tx - an[0], dy = ty - an[1], d = Math.hypot(dx, dy);
        if (d > STOP_DRIFT) { tx = an[0] + dx / d * STOP_DRIFT; ty = an[1] + dy / d * STOP_DRIFT; }
      }
      if (clearAt(tx, ty) >= Math.min(CLEAR_SMOOTH, clearAt(P[i][0], P[i][1]))) Q[i] = [tx, ty];
    };
    for (let it = 0; it < SMOOTH_ITER; it++) {
      const Q = P.slice();
      for (let i = 1; i + 1 < n; i++) tryMove(Q, i, P[i][0] + 0.25 * (P[i - 1][0] + P[i + 1][0] - 2 * P[i][0]), P[i][1] + 0.25 * (P[i - 1][1] + P[i + 1][1] - 2 * P[i][1]));
      P = Q;
    }
    for (let it = 0; it < BEND_ITER; it++) {
      const Q = P.slice();
      for (let i = 1; i + 1 < n; i++) {
        let tx, ty;
        if (i >= 2 && i + 2 < n) {
          tx = P[i][0] - BEND_RATE * (P[i - 2][0] - 4 * P[i - 1][0] + 6 * P[i][0] - 4 * P[i + 1][0] + P[i + 2][0]);
          ty = P[i][1] - BEND_RATE * (P[i - 2][1] - 4 * P[i - 1][1] + 6 * P[i][1] - 4 * P[i + 1][1] + P[i + 2][1]);
        } else {
          tx = P[i][0] + 0.25 * (P[i - 1][0] + P[i + 1][0] - 2 * P[i][0]);
          ty = P[i][1] + 0.25 * (P[i - 1][1] + P[i + 1][1] - 2 * P[i][1]);
        }
        tryMove(Q, i, tx, ty);
      }
      for (const [e, a, b] of [[0, 1, 2], [n - 1, n - 2, n - 3]]) {
        if (n < 3) break;
        tryMove(Q, e, P[e][0] + 0.2 * (2 * P[a][0] - P[b][0] - P[e][0]), P[e][1] + 0.2 * (2 * P[a][1] - P[b][1] - P[e][1]));
      }
      for (let i = 1; i + 1 < n; i++) {
        const mx = (Q[i - 1][0] + Q[i + 1][0]) / 2, my = (Q[i - 1][1] + Q[i + 1][1]) / 2;
        const ex = Q[i + 1][0] - Q[i - 1][0], ey = Q[i + 1][1] - Q[i - 1][1], el = Math.hypot(ex, ey) || 1;
        const sp = ((mx - Q[i][0]) * ex + (my - Q[i][1]) * ey) / el;
        const tx = Q[i][0] + 0.3 * sp * ex / el, ty = Q[i][1] + 0.3 * sp * ey / el;
        if (clearAt(tx, ty) >= Math.min(CLEAR_SMOOTH, clearAt(Q[i][0], Q[i][1]))) Q[i] = [tx, ty];
      }
      P = Q;
    }
    return P;
  }
  // stage two, DOCKING: each call vertex carried onto its berth, the course
  // following over up to DOCK_MAX m either side, weighted (1 − s/L)²
  function dock(S, pins, berthXY) {
    let out = S.map((p) => p.slice());
    const n = S.length;
    const landAround = (Pts, lo, hi, bx, by) => {
      let m = 0;
      for (let i = Math.max(1, lo); i <= Math.min(n - 1, hi); i++) {
        const a = Pts[i - 1], b = Pts[i], k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
        for (let t = 0; t < k; t++) {
          const x = a[0] + (b[0] - a[0]) * t / k, y = a[1] + (b[1] - a[1]) * t / k;
          if (Math.hypot(x - bx, y - by) > LAND_OK && clearAt(x, y) <= 0) m++;
        }
      }
      return m;
    };
    pins.forEach((pi, k) => {
      const [bx, by] = berthXY[k];
      const dx = bx - out[pi][0], dy = by - out[pi][1];
      const room = (j) => (j < 0 || j >= pins.length ? Infinity : Math.abs(pins[j] - pi) * SMOOTH_STEP * 0.45);
      let best = null;
      for (let L = Math.min(DOCK_MAX, room(k - 1), room(k + 1)); L >= SMOOTH_STEP * 2; L -= SMOOTH_STEP) {
        const reach = Math.floor(L / SMOOTH_STEP);
        const T = out.map((p) => p.slice());
        for (let o = -reach; o <= reach; o++) {
          const i = pi + o;
          if (i < 0 || i >= n) continue;
          const u = Math.abs(o) * SMOOTH_STEP / L, w = (1 - u) * (1 - u);
          T[i][0] += dx * w; T[i][1] += dy * w;
        }
        const m = landAround(T, pi - reach, pi + reach + 1, bx, by);
        if (!best || m < best.m) best = { T, m };
        if (!m) break;
      }
      if (best) out = best.T;
      else { out[pi] = [bx, by]; }
    });
    return out;
  }
  // stage three: bent smooth again with the calls PINNED to their berths
  function relaxChain(P, pins, iters) {
    const fixed = new Set(pins);
    const need = needFrom(pins.map((i) => P[i].slice()));
    const n = P.length;
    const ok = (x, y, ox, oy) => {
      const nd = need(x, y);
      if (nd < 0) return true;
      const c = clearAt(x, y), oc = clearAt(ox, oy);
      if (oc <= 0 && need(ox, oy) >= 0) return true;
      return c > 0 && c >= Math.min(nd, oc);
    };
    const dry = (a, b) => {
      const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
      let m = 0;
      for (let s = 1; s < k; s++) {
        const x = a[0] + (b[0] - a[0]) * s / k, y = a[1] + (b[1] - a[1]) * s / k;
        if (clearAt(x, y) <= 0 && need(x, y) >= 0) m++;
      }
      return m;
    };
    const edgesOk = (A, o, t, B) => dry(A, t) + dry(t, B) <= dry(A, o) + dry(o, B);
    const tryMove = (Q, i, tx, ty) => {
      if (fixed.has(i) || !ok(tx, ty, P[i][0], P[i][1])) return;
      const t = [tx, ty];
      if (!edgesOk(Q[i - 1], P[i], t, Q[i + 1])) return;
      Q[i] = t;
    };
    for (let it = 0; it < SMOOTH_ITER; it++) {
      const Q = P.slice();
      for (let i = 1; i + 1 < n; i++) tryMove(Q, i, P[i][0] + 0.25 * (P[i - 1][0] + P[i + 1][0] - 2 * P[i][0]), P[i][1] + 0.25 * (P[i - 1][1] + P[i + 1][1] - 2 * P[i][1]));
      P = Q;
    }
    for (let it = 0; it < iters; it++) {
      const Q = P.slice();
      for (let i = 1; i + 1 < n; i++) {
        let tx, ty;
        if (i >= 2 && i + 2 < n) {
          tx = P[i][0] - BEND_RATE * (P[i - 2][0] - 4 * P[i - 1][0] + 6 * P[i][0] - 4 * P[i + 1][0] + P[i + 2][0]);
          ty = P[i][1] - BEND_RATE * (P[i - 2][1] - 4 * P[i - 1][1] + 6 * P[i][1] - 4 * P[i + 1][1] + P[i + 2][1]);
        } else {
          tx = P[i][0] + 0.25 * (P[i - 1][0] + P[i + 1][0] - 2 * P[i][0]);
          ty = P[i][1] + 0.25 * (P[i - 1][1] + P[i + 1][1] - 2 * P[i][1]);
        }
        tryMove(Q, i, tx, ty);
      }
      for (let i = 1; i + 1 < n; i++) {
        if (fixed.has(i)) continue;
        const mx = (Q[i - 1][0] + Q[i + 1][0]) / 2, my = (Q[i - 1][1] + Q[i + 1][1]) / 2;
        const ex = Q[i + 1][0] - Q[i - 1][0], ey = Q[i + 1][1] - Q[i - 1][1], el = Math.hypot(ex, ey) || 1;
        const s = ((mx - Q[i][0]) * ex + (my - Q[i][1]) * ey) / el;
        const tx = Q[i][0] + 0.3 * s * ex / el, ty = Q[i][1] + 0.3 * s * ey / el;
        if (ok(tx, ty, Q[i][0], Q[i][1]) && edgesOk(Q[i - 1], Q[i], [tx, ty], Q[i + 1])) Q[i] = [tx, ty];
      }
      P = Q;
    }
    return P;
  }

  // 5b) the routed legs chained through every stop joining exactly two of them,
  // each chain smoothed and docked as ONE curve, cut back into its legs
  const adj = new Map();
  routed.forEach((l, li) => { for (const s of [l.a, l.b]) { if (!adj.has(s)) adj.set(s, []); adj.get(s).push(li); } });
  const usedLeg = new Uint8Array(routed.length);
  const chains = [];
  const walk = (start, li) => {
    const seq = [start], ls = [];
    let cur = start, l = li;
    for (;;) {
      usedLeg[l] = 1; ls.push(l);
      const nxt = routed[l].a === cur ? routed[l].b : routed[l].a;
      seq.push(nxt);
      const deg = adj.get(nxt);
      if (deg.length !== 2 || nxt === start) break;
      const l2 = deg[0] === l ? deg[1] : deg[0];
      if (usedLeg[l2]) break;
      cur = nxt; l = l2;
    }
    chains.push({ stops: seq, legs: ls });
  };
  for (const [s, ls] of adj) if (ls.length !== 2) for (const l of ls) if (!usedLeg[l]) walk(s, l);
  for (const [s, ls] of adj) for (const l of ls) if (!usedLeg[l]) walk(s, l);
  for (const ch of chains) {
    const build = (key) => {
      const P = [], pins = [0];
      ch.legs.forEach((li, k) => {
        const leg = routed[li];
        const pts = resample(leg.a === ch.stops[k] ? leg[key] : [...leg[key]].reverse(), SMOOTH_STEP);
        P.push(...(k === 0 ? pts : pts.slice(1)));
        pins.push(P.length - 1);
      });
      return { P, pins };
    };
    const cutBy = (Pts, pins, k) => {
      const leg = routed[ch.legs[k]];
      const pts = Pts.slice(pins[k], pins[k + 1] + 1);
      return leg.a === ch.stops[k] ? pts : pts.reverse();
    };
    const berthXY = ch.stops.map((id) => [snapOf.get(id).bx, snapOf.get(id).by]);
    const wet = build('wet');
    let pins = wet.pins;
    let Q = relaxChain(dock(relaxLeash(wet.P, pins), pins, berthXY), pins, DOCK_ITER);
    if (ch.legs.some((_, k) => audit(cutBy(Q, pins, k)).land)) {
      alog(`WARNING chain ${ch.stops.map((s) => stops.get(s).name).join(' – ')}: the docked curve touched land — drawing the simplified courses instead`);
      ({ P: Q, pins } = build('simple'));
    }
    ch.legs.forEach((li, k) => {
      const leg = routed[li], pts = cutBy(Q, pins, k);
      courses.push({ a: leg.a, b: leg.b, pts, raw: leg.raw, kind: 'routed', stats: audit(pts) });
    });
  }
  for (const co of courses) {
    const st = co.stats;
    const where = st.minAt ? proj.toLonLat(st.minAt[0], st.minAt[1]).map((v) => v.toFixed(5)).reverse().join(',') : '';
    alog(`  ${stops.get(co.a).name} – ${stops.get(co.b).name}: ${co.kind}, ${Math.round(st.len)} m, min clearance ${Number.isFinite(st.minC) ? Math.round(st.minC) + ' m' : '—'} past the berths${where ? ` (@${where})` : ''}${st.land ? ` — ${st.land} LAND SAMPLES` : ''}`);
  }

  // 6) water names: the smallest named polygon a point lies in
  const inRings = (rings, x, y) => {
    let inside = false;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const basinAt = (x, y) => {
    let best = null;
    for (const b of basins) {
      if (x < b.bbox[0] || x > b.bbox[2] || y < b.bbox[1] || y > b.bbox[3]) continue;
      if ((!best || b.area < best.area) && inRings(b.rings, x, y)) best = b;
    }
    return best ? best.name : '';
  };

  if (ARGS.includes('--png')) writePng(join(ROOT, `data/ferries-mask-${ai + 1}.png`), W, H, water, clear, courses.map((co) => co.pts.map(([x, y]) => [colOf(x), rowOf(y)])));
  return { proj, courses, snapOf, basinAt };
}

function writePng(file, W, H, water, clear, paths) {
  return import('node:zlib').then(({ deflateSync }) => {
    const S = 1, PW = W, PH = H;
    const px = new Uint8Array(PW * PH);
    for (let r = 0; r < PH; r++) for (let c = 0; c < PW; c++) {
      const i = (H - 1 - r * S) * W + c * S;
      px[r * PW + c] = water[i] ? Math.min(240, 150 + clear[i] * 0.6) : 60;
    }
    for (const p of paths) for (const [c, rr] of p) {
      const r = PH - 1 - rr;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (c + dc >= 0 && r + dr >= 0 && c + dc < PW && r + dr < PH) px[(r + dr) * PW + c + dc] = 0;
    }
    const raw = new Uint8Array((PW + 1) * PH);
    for (let r = 0; r < PH; r++) { raw[r * (PW + 1)] = 0; raw.set(px.subarray(r * PW, (r + 1) * PW), r * (PW + 1) + 1); }
    const crcT = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c; }
    const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
    const be = (v) => Buffer.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'); return Buffer.concat([be(data.length), t, data, be(crc(Buffer.concat([t, data])))]); };
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.concat([be(PW), be(PH), Buffer.from([8, 0, 0, 0, 0])])), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    writeFileSync(file, png);
  });
}

// ---------- 7) synthetic ways + QA ----------
let nid = -7000000, wid = -7000000;
const stopNode = new Map();
const nodeOf = (id) => { if (!stopNode.has(id)) stopNode.set(id, nid--); return stopNode.get(id); };
const elements = [], qa = [], berths = {};
let totalLen = 0, nCourses = 0, landTotal = 0;
for (const [ai, area] of AREAS.entries()) {
  const { proj, courses, snapOf, basinAt } = routeArea(area, ai);
  const ll = (pts) => pts.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; });
  for (const co of courses) {
    landTotal += co.stats.land;
    const names = co.pts.map(([x, y]) => basinAt(x, y));
    const runs = [];
    for (let i = 0; i < names.length; i++) {
      if (runs.length && runs[runs.length - 1].name === names[i]) runs[runs.length - 1].i1 = i;
      else runs.push({ name: names[i], i0: i, i1: i });
    }
    const spanM = (r) => (r.i1 - r.i0) * SMOOTH_STEP;
    for (let changed = true; changed && runs.length > 1;) {
      changed = false;
      for (let k = 0; k < runs.length; k++) {
        if (spanM(runs[k]) >= BASIN_MIN) continue;
        const prev = runs[k - 1], next = runs[k + 1];
        const into = prev && next ? (spanM(prev) >= spanM(next) ? prev : next) : (prev || next);
        if (!into) break;
        into.i0 = Math.min(into.i0, runs[k].i0); into.i1 = Math.max(into.i1, runs[k].i1);
        runs.splice(k, 1);
        for (let m = 0; m + 1 < runs.length; m++) {
          if (runs[m].name !== runs[m + 1].name) continue;
          runs[m].i1 = runs[m + 1].i1;
          runs.splice(m + 1, 1);
          m--;
        }
        changed = true;
        break;
      }
    }
    runs.sort((p, q) => p.i0 - q.i0);
    let prevNode = nodeOf(co.a);
    runs.forEach((r, ri) => {
      const last = ri === runs.length - 1;
      const i0 = ri === 0 ? 0 : runs[ri - 1].i1, i1 = last ? co.pts.length - 1 : r.i1;
      if (i1 <= i0) return;
      const nodes = [], geometry = [];
      for (let i = i0; i <= i1; i++) {
        const id = i === i0 ? prevNode : (i === co.pts.length - 1 ? nodeOf(co.b) : nid--);
        const [lon, lat] = proj.toLonLat(co.pts[i][0], co.pts[i][1]);
        nodes.push(id); geometry.push({ lat: round6(lat), lon: round6(lon) });
      }
      prevNode = nodes[nodes.length - 1];
      elements.push({ type: 'way', id: wid--, nodes, geometry, tags: { route: 'ferry', name: r.name } });
    });
    totalLen += co.stats.len; nCourses++;
    const props = { from: stops.get(co.a).name, to: stops.get(co.b).name, m: Math.round(co.stats.len), kind: co.kind, waters: runs.map((r) => r.name || '—').join(' · ') };
    qa.push({ type: 'Feature', properties: { ...props, kind: 'course', how: co.kind }, geometry: { type: 'LineString', coordinates: ll(co.pts) } });
    qa.push({ type: 'Feature', properties: { ...props, kind: 'grid' }, geometry: { type: 'LineString', coordinates: ll(co.raw) } });
  }
  for (const [id, s] of snapOf) {
    const [blon, blat] = proj.toLonLat(s.bx, s.by);
    berths[id] = [round6(blat), round6(blon)];
    qa.push({ type: 'Feature', properties: { kind: 'berth', name: stops.get(id).name, offM: Math.round(s.bd) }, geometry: { type: 'Point', coordinates: [round6(blon), round6(blat)] } });
    qa.push({ type: 'Feature', properties: { kind: 'pontoon', name: stops.get(id).name }, geometry: { type: 'Point', coordinates: [stops.get(id).lon, stops.get(id).lat] } });
  }
}
if (landTotal) {
  console.error(`ferries: ${landTotal} land samples in the finished courses — nothing written`);
  process.exit(1);
}
writeFileSync(OUT_FILE, JSON.stringify({ version: 0.6, generator: 'pipeline/ferries.mjs', berths, elements }));
writeFileSync(QA_FILE, JSON.stringify({ type: 'FeatureCollection', features: qa }));
log(`wrote ${elements.length} route=ferry ways (${(totalLen / 1000).toFixed(1)} km of water courses, ${nCourses} stop pairs, ${AREAS.length} areas) → data/osm/berlin-ferry.json, QA → data/ferries-qa.geojson`);
