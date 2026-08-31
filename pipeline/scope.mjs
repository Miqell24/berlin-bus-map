// Wyznacza zakres mapy Berlina z feedu CAŁEGO związku VBB (Berlin +
// Brandenburgia, 1254 linie od Prenzlau po Cottbus) i zapisuje listy route_id
// do data/scope.json:
//
//  autobusy (route_type 700 + 3 — VBB miesza oba kody dla tej samej roli):
//   - linia należy do mapy, gdy >=50% jej przystanków leży w promieniu 30 km
//     od Alexanderplatz; 30 km to nie okrągła liczba, tylko zasięg strefy C
//     taryfy berlińskiej: Poczdam (26 km), Oranienburg (30), Bernau (25),
//     Strausberg (30), Königs Wusterhausen (28), Ludwigsfelde (27) wchodzą,
//     Fürstenwalde (55), Nauen (40) i Brandenburg n. Hawelą (60) już nie;
//   - odpada linia z przystankiem dalej niż 55 km — inaczej jeden kurs
//     regionalny do Wittenbergi rozciągałby kadr na pół landu.
//  tramwaje (900): ta sama reguła promienia. Wchodzi BVG (M1–M17, 12–68),
//   Poczdam (91–99), Woltersdorf (87), Schöneiche–Rüdersdorf (88) i
//   Strausberg (89); Cottbus (1–4), Frankfurt nad Odrą (5) i Brandenburg
//   nad Hawelą (6) zostają poza kadrem — i przy okazji nie kolidują
//   numerami z berlińskimi.
//  U-Bahn (400): wszystkie, bez reguły promienia — to sieć wyłącznie miejska.
//  S-Bahn (109): reguła promienia 50 km (cała sieć i tak mieści się w 35 km),
//   ale z niej odsiewa się to, co feed VBB trzyma pod tym samym kodem, a
//   berlińską S-Bahn nie jest.
//  poza mapą: kolej regionalna RB/RE (100 i 106 — rozciągałaby mapę na cały
//   land) i promy BVG F10–F39 (1000; silnik nie ma grafu wodnego).
//
// Uruchamiane przez download.sh po pobraniu GTFS; build.mjs wymaga wyniku.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GD = join(ROOT, 'data/gtfs');

const CX = 13.4132, CY = 52.5219;          // Alexanderplatz
const CORE_KM = 30, CORE_SHARE = 0.5, CAP_KM = 55;
const RAIL_CORE_KM = 50, RAIL_CAP_KM = 70;

const t0 = Date.now();
const log = (m) => console.log(`[scope ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const candidates = new Map();   // route_id → 'bus' | 'tram' | 'sbahn'
const ubahn = [];
for (const r of await readCsv(join(GD, 'routes.txt'))) {
  const t = r.route_type;
  if (t === '700' || t === '3') candidates.set(r.route_id, 'bus');
  else if (t === '900') candidates.set(r.route_id, 'tram');
  else if (t === '109') candidates.set(r.route_id, 'sbahn');
  else if (t === '400') ubahn.push(r.route_id);
}
log(`kandydatów: ${[...candidates.values()].filter((v) => v === 'bus').length} bus, `
  + `${[...candidates.values()].filter((v) => v === 'tram').length} tram, `
  + `${[...candidates.values()].filter((v) => v === 'sbahn').length} S-Bahn; U-Bahn ${ubahn.length}`);

const mx = 111320 * Math.cos(CY * Math.PI / 180), my = 111132;
const stopKm = new Map();
for await (const s of iterCsv(join(GD, 'stops.txt'))) {
  const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    stopKm.set(s.stop_id, Math.hypot((lon - CX) * mx, (lat - CY) * my) / 1000);
  }
}
const t2r = new Map();
for await (const t of iterCsv(join(GD, 'trips.txt'))) {
  if (candidates.has(t.route_id)) t2r.set(t.trip_id, t.route_id);
}
log(`kursów do zmierzenia: ${t2r.size}`);

// jeden strumień przez stop_times: per trasa zbiór przystanków
const rStops = new Map();
for await (const st of iterCsv(join(GD, 'stop_times.txt'))) {
  const rid = t2r.get(st.trip_id);
  if (!rid) continue;
  let s = rStops.get(rid);
  if (!s) rStops.set(rid, (s = new Set()));
  s.add(st.stop_id);
}
log(`tras z przystankami: ${rStops.size}`);

const out = { bus: [], tram: [], sbahn: [], ubahn: ubahn.sort() };
const cut = { bus: 0, tram: 0, sbahn: 0 };
for (const [rid, stops] of rStops) {
  const kind = candidates.get(rid);
  const core = kind === 'sbahn' ? RAIL_CORE_KM : CORE_KM;
  const cap = kind === 'sbahn' ? RAIL_CAP_KM : CAP_KM;
  let n = 0, inside = 0, max = 0;
  for (const sid of stops) {
    const d = stopKm.get(sid);
    if (d === undefined) continue;
    n++; if (d <= core) inside++; if (d > max) max = d;
  }
  if (!n) continue;
  if (inside / n < CORE_SHARE) continue;
  if (max > cap) { cut[kind]++; continue; }
  out[kind].push(rid);
}
for (const k of ['bus', 'tram', 'sbahn']) out[k].sort();
log(`wybrano: bus ${out.bus.length} (odrzucone limitem: ${cut.bus}), `
  + `tram ${out.tram.length} (${cut.tram}), S-Bahn ${out.sbahn.length} (${cut.sbahn}), `
  + `U-Bahn ${out.ubahn.length}`);
writeFileSync(join(ROOT, 'data/scope.json'), JSON.stringify(out, null, 0));
log('zapisano data/scope.json');
