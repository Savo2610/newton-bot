// Analyse eines Live-Snapshots: welche Ziele sind mit welchen Geschwindigkeiten erreichbar, wie lange dauert der Solve?
import fs from 'node:fs';
import { solveAim } from '../src/aim.js';
const snap = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const me = snap.players.find(p => p.id === snap.myId);
const others = snap.players.filter(p => p.id !== snap.myId);
for (const v of [3, 5, 8, 10, 13, 17, 22, 30, 40]) {
  const t0 = Date.now();
  const r = solveAim({ planets: snap.planets, me, players: snap.players, targets: others.map(p => ({ id: p.id })), velocities: [v], maxFrames: 1998, budgetMs: 60000 });
  const by = {};
  for (const c of r.candidates) (by[c.target] ||= []).push(`${c.angle.toFixed(2)}°/${c.window.toFixed(3)}/${(c.frames / 60).toFixed(1)}s`);
  console.log(`v=${v} ${Date.now() - t0}ms`, Object.entries(by).map(([k, a]) => `#${k}:${a.length}[${a.slice(0, 2).join(' ')}]`).join('  '));
}
