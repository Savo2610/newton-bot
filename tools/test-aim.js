// Offline-Test Aim-Solver mit exakten Planeten: Trefferquote prüfen
import { makeWorld } from './test-mapper.js';
import { solveAim } from '../src/aim.js';
import { packPlanets, simulateShot, END } from '../src/physics.js';
const { planets, players } = makeWorld(24, 6);
const me = players[0];
const t0 = Date.now();
const res = solveAim({ planets, me, players, targets: players.slice(1).map(p => ({ id: p.id })), velocities: [4, 6, 9, 13], maxFrames: 900 });
console.log('ms', Date.now() - t0, 'candidates', res.candidates.length);
const P = packPlanets(planets);
const pl = new Float64Array(players.flatMap(p => [p.x, p.y, p.id]));
for (const c of res.candidates.slice(0, 8)) {
  const r = simulateShot(P, pl, me.x, me.y, Number(c.angle.toFixed(4)), c.velocity, { selfId: me.id });
  console.log(`target ${c.target} v=${c.velocity} angle=${c.angle.toFixed(4)} window=${c.window.toFixed(4)}° frames=${c.frames} pHit=${c.pHit.toFixed(2)} score=${c.score.toFixed(3)} -> verify: ${r.end === END.PLAYER ? 'HIT ' + r.hitId : 'miss ' + r.end}`);
}
