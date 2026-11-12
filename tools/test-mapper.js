// Offline-Test: Zufallsplaneten wie der Server erzeugen, Schüsse simulieren, Mapper fitten, mit Wahrheit vergleichen.
import { FIELD, packPlanets, simulateShot, END } from '../src/physics.js';
import { Mapper } from '../src/mapper.js';

const seed = Number(process.argv[2] || 1);
const nShots = Number(process.argv[3] || 40);
let s = seed;
const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };

function makePlanets(n = 24) {
  const ps = [];
  for (let i = 0; i < n; i++) {
    let p, nok;
    do {
      const r = 20 + rand() * 20;
      p = { r, m: r * r * r / 10, x: r + rand() * (FIELD.W - 2 * r), y: r + rand() * (FIELD.H - 2 * r) };
      nok = ps.some(q => Math.hypot(q.x - p.x, q.y - p.y) <= q.r + p.r);
    } while (nok);
    ps.push(p);
  }
  return ps;
}

export function makeWorld(n = 24, nPlayers = 6) {
  const planets = makePlanets(n);
  const players = [];
  while (players.length < nPlayers) {
    const x = rand() * FIELD.W, y = rand() * FIELD.H;
    if (planets.some(p => Math.hypot(p.x - x, p.y - y) < p.r + 30)) continue;
    if (players.some(q => Math.hypot(q.x - x, q.y - y) < 210)) continue;
    players.push({ id: players.length, x, y });
  }
  return { planets, players };
}

function endKind(sim) {
  return sim.end === END.PLANET ? 'planet' : sim.end === END.PLAYER ? 'player' : sim.end === END.OUT ? 'out' : 'max';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { planets, players } = makeWorld();
  const P = packPlanets(planets);
  const pl = new Float64Array(players.flatMap(p => [p.x, p.y, p.id]));
  const mapper = new Mapper();
  for (let i = 0; i < nShots; i++) {
    const sh = players[i % players.length];
    const angle = rand() * 360, vel = 4 + rand() * 14;
    const sim = simulateShot(P, pl, sh.x, sh.y, angle, vel, { selfId: sh.id, record: true });
    mapper.addTrajectory({ dots: Float32Array.from(sim.dots), angle, vel, owner: sh.id, end: endKind(sim) });
    if ((i + 1) % 10 === 0 || i === nShots - 1) {
      const r = mapper.fit();
      // Abgleich
      let matched = 0, posErr = [], rErr = [];
      for (const t of planets) {
        let best = null, bd = Infinity;
        for (const e of r.planets) { const d = Math.hypot(e.x - t.x, e.y - t.y); if (d < bd) { bd = d; best = e; } }
        if (bd < 15) { matched++; posErr.push(bd); rErr.push(Math.abs(best.r - t.r)); }
      }
      const med = a => a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(2) : '-';
      if (process.env.DIAG && i === nShots - 1) diagnose(mapper, planets, r.planets);
      console.log(`shots=${i + 1} samples=${r.stats.samples} est=${r.planets.length} matched=${matched}/${planets.length} posErrMed=${med(posErr)} rErrMed=${med(rErr)} redChi2=${r.stats.redChi2?.toFixed(2)} horizon=${r.stats.horizonMedian?.toFixed(2)} reproduced=${r.stats.reproduced?.toFixed(2)} ${r.stats.ms}ms`);
    }
  }
}

export function diagnose(mapper, planets, est) {
  for (const t of planets) {
    let bd = Infinity, best;
    for (const e of est) { const d = Math.hypot(e.x - t.x, e.y - t.y); if (d < bd) { bd = d; best = e; } }
    if (bd >= 15) {
      const nv = mapper._nearestVisited(t.x, t.y, 300);
      const ns = mapper.samples.filter(q => Math.hypot(q.x - t.x, q.y - t.y) < 150).length;
      console.log(`  MISSING (${t.x.toFixed(0)},${t.y.toFixed(0)}) r=${t.r.toFixed(1)} nearestEst=${bd.toFixed(0)}px m=${best?.m.toFixed(0)} nearestVisited=${nv ? nv.d.toFixed(0) : '>300'} samples<150=${ns}`);
    }
  }
  for (const e of est) {
    let bd = Infinity; for (const t of planets) bd = Math.min(bd, Math.hypot(e.x - t.x, e.y - t.y));
    if (bd >= 15) console.log(`  SPURIOUS (${e.x.toFixed(0)},${e.y.toFixed(0)}) m=${e.m.toFixed(0)} r=${e.r.toFixed(1)} d=${bd.toFixed(0)}`);
  }
}
