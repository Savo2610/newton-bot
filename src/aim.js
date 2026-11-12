// Aim-Solver: findet Winkel/Geschwindigkeit, die ein Ziel treffen, per Simulation.
// Sweep über alle Winkel -> lokale Minima des Abstands zum Ziel -> Goldener-Schnitt-Verfeinerung
// -> Trefferfenster (Winkelbreite) per Bisektion -> Mitte des Fensters zielen (robust).
// Optional: Trefferwahrscheinlichkeit gegen ein Ensemble gestörter Planetenmodelle.

import { FIELD, packPlanets, simulateShot, END } from './physics.js';

const PHI = (Math.sqrt(5) - 1) / 2;

export function solveAim(req) {
  const t0 = Date.now();
  const F = { ...FIELD, ...(req.field || {}) };
  const P = packPlanets(req.planets);
  const ens = (req.ensemble || []).map(packPlanets);
  const me = req.me;
  const players = new Float64Array(req.players.flatMap(p => [p.x, p.y, p.id]));
  const targets = req.targets; // [{id, value}]
  if (!targets.length) return { candidates: [], ms: 0 };
  const tIds = Int32Array.from(targets.map(t => t.id));
  const value = new Map(targets.map(t => [t.id, t.value ?? 1]));
  const maxFrames = req.maxFrames ?? 900;
  const step = req.angleStep ?? 0.6;
  const hitR = F.playerSize * 0.92;
  const budgetMs = req.budgetMs ?? 4000;
  const sim = (ang, v, extra = {}) => simulateShot(P, players, me.x, me.y, ang, v, { selfId: me.id, maxFrames, targets: tIds, field: F, ...extra });
  const hitsTarget = (r, id) => r.end === END.PLAYER && r.hitId === id;

  const candidates = [];
  for (const v of req.velocities) {
    if (Date.now() - t0 > budgetMs) break;
    const N = Math.round(360 / step);
    const D = targets.map(() => new Float64Array(N));
    for (let k = 0; k < N; k++) {
      const r = sim(k * step, v);
      for (let t = 0; t < targets.length; t++) D[t][k] = r.minD[t];
    }
    for (let t = 0; t < targets.length; t++) {
      const id = tIds[t];
      const d = D[t];
      // lokale Minima (zyklisch), die nahe genug sind
      const mins = [];
      for (let k = 0; k < N; k++) {
        const a = d[(k - 1 + N) % N], b = d[k], c = d[(k + 1) % N];
        if (b <= a && b <= c && b < (req.nearThreshold ?? 80)) mins.push(k);
      }
      mins.sort((a, b) => d[a] - d[b]);
      for (const k of mins.slice(0, req.maxMinimaPerTarget ?? 6)) {
        if (Date.now() - t0 > budgetMs) break;
        // Goldener Schnitt auf [k-1, k+1]
        let lo = (k - 1) * step, hi = (k + 1) * step;
        let x1 = hi - PHI * (hi - lo), x2 = lo + PHI * (hi - lo);
        let f1 = sim(x1, v).minD[t], f2 = sim(x2, v).minD[t];
        for (let it = 0; it < 40 && hi - lo > 1e-7; it++) {
          if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - PHI * (hi - lo); f1 = sim(x1, v).minD[t]; }
          else { lo = x1; x1 = x2; f1 = f2; x2 = lo + PHI * (hi - lo); f2 = sim(x2, v).minD[t]; }
          if (Math.min(f1, f2) < hitR * 0.3) break;
        }
        const best = f1 < f2 ? x1 : x2;
        const rb = sim(best, v);
        if (!hitsTarget(rb, id)) continue;
        // Fensterränder per Bisektion
        const edge = (dir) => {
          let inside = best, outside = best + dir * step;
          if (hitsTarget(sim(outside, v), id)) return outside; // sehr breites Fenster
          for (let i = 0; i < 26; i++) {
            const m = (inside + outside) / 2;
            if (hitsTarget(sim(m, v), id)) inside = m; else outside = m;
          }
          return inside;
        };
        const a0 = edge(-1), a1 = edge(1);
        let center = (a0 + a1) / 2;
        let rc = sim(center, v, { record: true });
        if (!hitsTarget(rc, id)) { center = best; rc = sim(best, v, { record: true }); }
        if (rc.selfMin < (req.selfSafety ?? 0)) continue; // Bahn kommt uns selbst gefährlich nahe
        candidates.push({
          target: id, angle: norm(center), velocity: v, window: a1 - a0,
          frames: rc.frames, path: rc.dots, value: value.get(id),
        });
      }
    }
  }

  // Ensemble-Robustheit + Score
  const sigma0 = req.sigmaDeg ?? 0.01;
  for (const c of candidates) {
    let p;
    const widthP = erf(c.window / 2 / (Math.SQRT2 * sigma0 * (1 + c.frames / 400)));
    if (ens.length) {
      let hits = 0;
      for (const E of ens) {
        const r = simulateShot(E, players, me.x, me.y, c.angle, c.velocity, { selfId: me.id, maxFrames, field: F });
        if (r.end === END.PLAYER && r.hitId === c.target) hits++;
        else if (r.end === END.PLAYER && r.hitId === me.id) hits -= 1; // Eigentor im Ensemble: hart bestrafen
      }
      c.ensembleP = hits / ens.length;
      p = Math.min(widthP, Math.max(0, hits + 0.5) / (ens.length + 1));
    } else p = widthP;
    c.pHit = p;
    const wait = Math.max(0, (c.velocity - (req.energy ?? 1e9)) / (req.energyRate ?? 2));
    const time = c.frames / 60 + wait;
    c.score = p * c.value / (c.velocity * (req.costWeight ?? 1) + time * (req.timeWeight ?? 1.5) + 1);
  }
  candidates.sort((a, b) => b.score - a.score);
  // pro Ziel die besten 3 behalten, Pfad nur für die beste Lösung je Ziel (Datenmenge)
  const perT = new Map();
  const out = [];
  for (const c of candidates) {
    const n = perT.get(c.target) || 0;
    if (n >= 3) continue;
    perT.set(c.target, n + 1);
    if (c.path) c.path = n === 0 ? decimate(c.path, 300) : undefined;
    out.push(c);
  }
  return { candidates: out, ms: Date.now() - t0 };
}

function norm(a) { a %= 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; }

function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export function decimate(dots, maxPts) {
  const n = dots.length / 2;
  if (n <= maxPts) return Array.from(dots);
  const out = [];
  const stride = n / maxPts;
  for (let i = 0; i < maxPts; i++) { const k = Math.floor(i * stride); out.push(dots[2 * k], dots[2 * k + 1]); }
  out.push(dots[dots.length - 2], dots[dots.length - 1]);
  return out;
}
