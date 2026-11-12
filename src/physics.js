// Exakte Nachbildung der NewtonWars-Physik (simulation.c)
// G = 1, a = sum m * (p - x) / |p - x|^3, Velocity-Verlet mit 25 Substeps pro Frame (dt = 1/25)

export const FIELD = {
  W: Math.sqrt(2e6 * 16 / 9), // 1885.6
  H: Math.sqrt(2e6 * 9 / 16), // 1060.7
  margin: 500,
  playerSize: 4,
  steps: 25,
  maxSegments: 2000,
};

export const END = { PLANET: 1, PLAYER: 2, OUT: 3, MAX: 4, TIMEOUT: 5 };

// planets: [{x,y,r,m}] -> Float64Array [x,y,r,m,...]
export function packPlanets(planets) {
  const P = new Float64Array(planets.length * 4);
  planets.forEach((p, i) => {
    P[i * 4] = p.x; P[i * 4 + 1] = p.y; P[i * 4 + 2] = p.r; P[i * 4 + 3] = p.m;
  });
  return P;
}

export function accelAt(P, x, y, out) {
  let ax = 0, ay = 0;
  const n = P.length;
  for (let o = 0; o < n; o += 4) {
    const dx = P[o] - x, dy = P[o + 1] - y;
    const l2 = dx * dx + dy * dy;
    const f = P[o + 3] / (l2 * Math.sqrt(l2));
    ax += dx * f; ay += dy * f;
  }
  out[0] = ax; out[1] = ay;
}

/**
 * Simuliert einen Schuss exakt wie der Server.
 * players: Float64Array [x,y,id, x,y,id, ...] (alle aktiven Spieler inkl. Schütze)
 * opts: { selfId, maxFrames, record, targets: Int32Array der Ziel-IDs (Abstandsmessung), field }
 * Rückgabe: { end, hitId, frames, minD: Float64Array (pro Ziel), minFrame, dots }
 */
export function simulateShot(P, players, sx, sy, angleDeg, vel, opts = {}) {
  const F = opts.field || FIELD;
  const selfId = opts.selfId ?? -1;
  const maxFrames = Math.min(opts.maxFrames ?? (F.maxSegments - 2), F.maxSegments - 2);
  const steps = F.steps, dt = 1 / steps, hdt2 = 0.5 * dt * dt, hdt = 0.5 * dt;
  const ps = F.playerSize, ps1 = ps + 1;
  const xmin = -F.margin, xmax = F.W + F.margin, ymin = -F.margin, ymax = F.H + F.margin;
  const targets = opts.targets;
  const nt = targets ? targets.length : 0;
  const minD = new Float64Array(nt).fill(Infinity);
  const minFrame = new Int32Array(nt);
  // Ziel-Indizes in players auflösen
  const tIdx = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    tIdx[t] = -1;
    for (let k = 0; k < players.length; k += 3) if (players[k + 2] === targets[t]) tIdx[t] = k;
  }
  const np = players.length;
  const nP = P.length;
  const rad = Math.PI / 180;
  let x = sx, y = sy;
  let vx = vel * Math.cos(angleDeg * rad);
  let vy = vel * -Math.sin(angleDeg * rad);
  const a = [0, 0];
  accelAt(P, x, y, a);
  let ax = a[0], ay = a[1];
  let leftSource = false;
  const dots = opts.record ? [x, y] : null;
  let end = 0, hitId = -1, frames = 0, selfMin = Infinity;

  outer:
  for (frames = 1; frames <= maxFrames; frames++) {
    for (let i = 0; i < steps; i++) {
      const nx = x + vx * dt + ax * hdt2;
      const ny = y + vy * dt + ay * hdt2;
      // acc(new_pos) + Planetenkollision in einem Durchlauf
      let nax = 0, nay = 0, hitPlanet = false;
      for (let o = 0; o < nP; o += 4) {
        const dx = P[o] - nx, dy = P[o + 1] - ny;
        const l2 = dx * dx + dy * dy;
        const l = Math.sqrt(l2);
        const f = P[o + 3] / (l2 * l);
        nax += dx * f; nay += dy * f;
        if (l <= P[o + 2]) hitPlanet = true;
      }
      vx += (ax + nax) * hdt; vy += (ay + nay) * hdt;
      x = nx; y = ny; ax = nax; ay = nay;
      if (hitPlanet) { end = END.PLANET; break outer; }
      for (let k = 0; k < np; k += 3) {
        const dx = players[k] - x, dy = players[k + 1] - y;
        const l = Math.sqrt(dx * dx + dy * dy);
        const id = players[k + 2];
        if (l <= ps && leftSource) { end = END.PLAYER; hitId = id; break; }
        if (l > ps1 && id === selfId) leftSource = true;
        if (id === selfId && frames > 3 && l < selfMin) selfMin = l;
      }
      for (let t = 0; t < nt; t++) {
        const k = tIdx[t];
        if (k < 0) continue;
        const dx = players[k] - x, dy = players[k + 1] - y;
        const d = dx * dx + dy * dy;
        if (d < minD[t]) { minD[t] = d; minFrame[t] = frames; }
      }
      if (end) break outer;
      if (x < xmin || x > xmax || y < ymin || y > ymax) { end = END.OUT; break outer; }
    }
    if (dots) dots.push(x, y);
    if (frames + 1 >= F.maxSegments - 1) { end = END.MAX; break; }
  }
  if (!end) { end = END.TIMEOUT; frames = maxFrames; }
  if (dots && (dots[dots.length - 2] !== x || dots[dots.length - 1] !== y)) dots.push(x, y);
  for (let t = 0; t < nt; t++) minD[t] = Math.sqrt(minD[t]);
  return { end, hitId, frames, minD, minFrame, dots, x, y, selfMin };
}

// Gleichverteilte Prüfpunkte (Fibonacci) etc.
export const GOLDEN_ANGLE = 137.50776405003785;
