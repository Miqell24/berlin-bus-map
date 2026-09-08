// Reads the VBB feed of the WHOLE Verbund (Berlin + all of Brandenburg,
// 1255 lines) and writes data/scope.json: the route_id lists per mode, the
// line KEY of every route and the operator code behind it.
//
// Until 8.09.2026 this file was a filter — a 30 km radius around
// Alexanderplatz that cut the Verbund down to the metropolitan region. The
// map is now the Verbund itself, so nothing is cut for being far away and
// what remains to decide is only:
//
//  * Ersatzverkehr. An operator numbers its rail-replacement buses after the
//    line they replace, so the feed carries "buses" called U6, S7, RE3 and 12.
//    The discriminator is per OPERATOR, not per name: a bus is a replacement
//    when the SAME agency also runs a rail line of that name (BVG's bus M2,
//    S-Bahn Berlin's bus S3, DB Regio's bus RE2). Cottbusverkehr's buses 12,
//    16, 18, 21, 27 and 37 are real buses — Cottbus trams are 1–4 — and the
//    old Verbund-wide name list would have swallowed all six.
//  * Ferries (route_type 1000): BVG's F10–F39 and Strausberg's F39 — the
//    engine has no water graph.
//  * LINE KEYS. Verbund-wide the numbers are NOT unique: 184 bus numbers are
//    used by two operators or more (Oder-Spree and the Uckermark both number
//    their county lines 4xx), and trams 1–4 run in Cottbus, Frankfurt (Oder)
//    and Brandenburg an der Havel at once. A number shared by several
//    operators therefore carries the operator's code in the KEY (los:401,
//    uvg:401) and prints bare on the street through LBL — the Randstad rule.
//    The panel groups its chips by that operator code.
//
// Run by download.sh after the GTFS is unpacked; build.mjs refuses to guess
// without the result.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');

const t0 = Date.now();
const log = (m) => console.log(`[scope ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const RAIL_TYPES = new Set(['900', '400', '109', '100', '106']);
const kindOf = (t) => (t === '700' || t === '3' ? 'bus'
  : t === '900' ? 'tram'
    : t === '109' ? 'sbahn'
      : t === '400' ? 'ubahn'
        : t === '100' || t === '106' ? 'rail' : null);

// Operator code for the key prefix and the panel grouping. Built from the
// agency name: the words that carry the identity, lowercased — "Busverkehr
// Oder-Spree GmbH" → los, "Uckermärkische Verkehrsgesellschaft mbH" → uvg.
// Anything not named here falls back to the initials of the agency name.
const OP_CODE = [
  [/Berliner Verkehrsbetriebe/i, 'bvg'],
  [/S-Bahn Berlin/i, 'sbahn'],
  [/Verkehrsbetrieb Potsdam/i, 'vip'],
  [/Cottbusverkehr/i, 'cb'],
  [/Frankfurt \(Oder\)/i, 'ffo'],
  [/Brandenburg an der Havel/i, 'brb'],
  [/Schöneicher Rüdersdorfer/i, 'srs'],
  [/Strausberger Eisenbahn/i, 'sre'],
  [/Woltersdorfer/i, 'wsw'],
  [/Oder-Spree/i, 'los'],
  [/Uckermärkische/i, 'uvg'],
  [/Barnimer/i, 'bbg'],
  [/Havelbus/i, 'hvb'],
  [/Ostprignitz-Ruppin|ORP/i, 'orp'],
  [/Prignitz/i, 'vgp'],
  [/Märkisch-Oderland|MOBUS/i, 'mol'],
  [/Dahme-Spreewald|RVS/i, 'lds'],
  [/Teltow-Fläming|VTF/i, 'tf'],
  [/Potsdam-Mittelmark|Regiobus/i, 'pm'],
  [/Elbe-Elster|VGB/i, 'ee'],
  [/Spree-Neiße|Neiße/i, 'spn'],
  [/Oberspreewald|OSL/i, 'osl'],
  [/Oberhavel|OVG/i, 'ohv'],
  [/DB Regio/i, 'db'],
  [/ODEG|Ostdeutsche Eisenbahn/i, 'odeg'],
  [/NEB|Niederbarnimer/i, 'neb'],
  [/Hanseatische Eisenbahn/i, 'hanse'],
  [/Mitteldeutsche Regiobahn/i, 'mrb'],
];
// fallback for the small private operators: the initials of the name, or the
// first word where those give less than two letters ("Glaser" → gla)
const initials = (name) => {
  const ini = (name.match(/\b[A-ZÄÖÜ]/g) || []).join('').slice(0, 4).toLowerCase();
  return ini.length >= 2 ? ini : (name.match(/[A-Za-zÄÖÜäöü]+/) || ['x'])[0].slice(0, 3).toLowerCase();
};
const codeOf = (name) => (OP_CODE.find(([re]) => re.test(name)) || [null, initials(name)])[1];

const agencies = new Map();
for (const a of await readCsv(join(GD, 'agency.txt'))) agencies.set(a.agency_id, a.agency_name);
const opCode = new Map();
for (const [id, name] of agencies) opCode.set(id, codeOf(name));

const routes = await readCsv(join(GD, 'routes.txt'));
// (agency, name) pairs that are RAIL — a bus wearing one is that agency's
// rail replacement
const railPairs = new Set();
for (const r of routes) {
  if (RAIL_TYPES.has(r.route_type)) railPairs.add(r.agency_id + '\u0000' + (r.route_short_name || '').trim());
}

const kept = [];
let ersatz = 0, ferry = 0;
for (const r of routes) {
  const kind = kindOf(r.route_type);
  if (!kind) { ferry++; continue; }
  const sn = (r.route_short_name || '').trim();
  if (kind === 'bus' && railPairs.has(r.agency_id + '\u0000' + sn)) { ersatz++; continue; }
  kept.push({ r, kind, sn });
}
log(`z ${routes.length} tras: ${kept.length} na mapę, ${ersatz} Ersatzverkehr, ${ferry} promów`);

// which names need an operator code: the same printed number run by more than
// one operator. Trams and buses share the pool — a Cottbus tram 1 and a
// Brandenburg village bus 1 are two different lines on one map.
const byName = new Map();
for (const { r, sn } of kept) {
  if (!sn) continue;
  let s = byName.get(sn);
  if (!s) byName.set(sn, (s = new Set()));
  s.add(opCode.get(r.agency_id));
}
const shared = new Set([...byName].filter(([, ops]) => ops.size > 1).map(([sn]) => sn));
log(`numerów używanych przez >1 przewoźnika: ${shared.size} (dostaną kod w kluczu)`);

// code → the operator's name for the panel head, trimmed of the legal form
const opName = {};
for (const [id, name] of agencies) {
  const code = opCode.get(id);
  const short = name.replace(/\s*\b(GmbH|mbH|AG|OHG|KG|& Co\.? ?KG)\b\.?/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!opName[code] || short.length < opName[code].length) opName[code] = short;
}

const out = { bus: [], tram: [], sbahn: [], ubahn: [], rail: [], key: {}, op: {}, opName };
for (const { r, kind, sn } of kept) {
  out[kind].push(r.route_id);
  const op = opCode.get(r.agency_id);
  out.key[r.route_id] = shared.has(sn) ? `${op}:${sn}` : sn;
  out.op[r.route_id] = op;
}
for (const k of ['bus', 'tram', 'sbahn', 'ubahn', 'rail']) out[k].sort();
log(`bus ${out.bus.length}, tram ${out.tram.length}, S-Bahn ${out.sbahn.length}, `
  + `U-Bahn ${out.ubahn.length}, kolej regionalna ${out.rail.length}`);

// The frame the OSM cut has to cover: the stop extent per graph (roads carry
// the buses, rails everything else). Printed so pbf-tiles.py can be checked
// against the data rather than against a memory of it.
const wanted = new Map();
for (const { r, kind } of kept) wanted.set(r.route_id, kind);
const t2r = new Map();
for await (const t of iterCsv(join(GD, 'trips.txt'))) {
  if (wanted.has(t.route_id)) t2r.set(t.trip_id, t.route_id);
}
const stops = new Map();
for await (const s of iterCsv(join(GD, 'stops.txt'))) {
  const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, [lat, lon]);
}
const box = { road: [90, -90, 180, -180], rail: [90, -90, 180, -180] };
for await (const st of iterCsv(join(GD, 'stop_times.txt'))) {
  const rid = t2r.get(st.trip_id);
  const p = stops.get(st.stop_id);
  if (!rid || !p) continue;
  const b = box[wanted.get(rid) === 'bus' ? 'road' : 'rail'];
  if (p[0] < b[0]) b[0] = p[0]; if (p[0] > b[1]) b[1] = p[0];
  if (p[1] < b[2]) b[2] = p[1]; if (p[1] > b[3]) b[3] = p[1];
}
out.bbox = box;
for (const k of ['road', 'rail']) {
  const b = box[k];
  log(`zasięg ${k}: ${b[0].toFixed(2)}–${b[1].toFixed(2)} N, ${b[2].toFixed(2)}–${b[3].toFixed(2)} E`);
}
writeFileSync(join(ROOT, 'data/scope.json'), JSON.stringify(out, null, 0));
log('zapisano data/scope.json');
