// Planeten-Rekonstruktion aus beobachteten Flugbahnen.
//
// Idee: Der Server schickt (im Bot-Modus) die komplette Flugbahn jedes Schusses aller Spieler,
// ein Punkt pro Frame (Zeitschritt = 1). Die zweite Differenz x[i+1] - 2x[i] + x[i-1] ist exakt das
// Integral der Beschleunigung mit Dreieckskern über [-1, 1]. Die Beschleunigung ist linear in den
// Planetenmassen -> NNLS auf einem Gitter liefert Kandidaten, Levenberg-Marquardt verfeinert (x, y, m, r).
// Zusätzliche Constraints:
//   * Freiraum: Wo ein Geschoss geflogen ist, kann kein Planet sein (Abstand zum Zentrum > r).
//   * Einschläge: Endpunkte von Schüssen, die in einem Planeten enden, liegen auf der Oberfläche.
//   * Server-Formel m = r^3 / 10 als (weicher) Prior.

import { FIELD, packPlanets, simulateShot, END } from './physics.js';

// Quadratur des Dreieckskerns auf [-1,1]
const QT = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];
const QW = QT.map(t => (1 - Math.abs(t)) / 4);
const NQ = QT.length;

function lagrange(ts, ps, t) {
  // kubische Lagrange-Interpolation durch 4 Knoten
  let r = 0;
  for (let i = 0; i < 4; i++) {
    let w = 1;
    for (let j = 0; j < 4; j++) if (j !== i) w *= (t - ts[j]) / (ts[i] - ts[j]);
    r += w * ps[i];
  }
  return r;
}

function cholSolve(A, b, n) {
  // A: Float64Array n*n (wird überschrieben), löst A x = b
  const L = A;
  for (let j = 0; j < n; j++) {
    let s = L[j * n + j];
    for (let k = 0; k < j; k++) s -= L[j * n + k] * L[j * n + k];
    if (s <= 1e-300) return null;
    const d = Math.sqrt(s);
    L[j * n + j] = d;
    for (let i = j + 1; i < n; i++) {
      let t = L[i * n + j];
      for (let k = 0; k < j; k++) t -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let t = b[i];
    for (let k = 0; k < i; k++) t -= L[i * n + k] * y[k];
    y[i] = t / L[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let t = y[i];
    for (let k = i + 1; k < n; k++) t -= L[k * n + i] * y[k];
    y[i] = t / L[i * n + i];
  }
  return y;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export class Mapper {
  constructor(opts = {}) {
    this.opts = {
      minRadius: 18,       // Freiraum-Radius (Server: r >= 20)
      gridCell: 22,        // NNLS-Gitter
      minPeakMass: 350,    // kleinste akzeptierte Planetenmasse (r≈15)
      maxPlanets: 64,
      maxSamples: 2600,
      nnlsSamples: 1100,
      radiusPriorSigma: 1.5,
      ...opts,
    };
    this.field = opts.field || FIELD;
    this.reset();
  }

  reset() {
    this.trajs = [];          // {dots: Float32Array, angle, vel, owner, end}
    this.planets = [];        // aktuelles Modell
    this.visited = new Map(); // Spatial-Hash besuchter Punkte (Zelle 8px)
    this.fitCount = 0;
    this.lastStats = null;
  }

  // ---------------------------------------------------------------- Daten
  addTrajectory(t) {
    const d = t.dots;
    const L = d.length / 2;
    if (L < 2) return;
    this.trajs.push(t);
    // besuchte Punkte = alle regulären Frame-Punkte (der letzte Punkt kann im Planeten liegen)
    for (let i = 0; i < L - 1; i++) this._visit(d[2 * i], d[2 * i + 1]);
  }

  _visit(x, y) {
    if (x < -60 || y < -60 || x > this.field.W + 60 || y > this.field.H + 60) return;
    const k = ((Math.floor(x / 8) + 512) << 12) | (Math.floor(y / 8) + 512);
    const arr = this.visited.get(k);
    if (!arr) this.visited.set(k, [x, y]);
    else if (arr.length < 8) arr.push(x, y);
  }

  // nächster besuchter Punkt zu (x,y) innerhalb von rmax
  _nearestVisited(x, y, rmax) {
    const c0 = Math.floor((x - rmax) / 8), c1 = Math.floor((x + rmax) / 8);
    const r0 = Math.floor((y - rmax) / 8), r1 = Math.floor((y + rmax) / 8);
    let best = rmax * rmax, bx = 0, by = 0, found = false;
    for (let cx = c0; cx <= c1; cx++) for (let cy = r0; cy <= r1; cy++) {
      const arr = this.visited.get(((cx + 512) << 12) | (cy + 512));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 2) {
        const dx = arr[i] - x, dy = arr[i + 1] - y, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bx = arr[i]; by = arr[i + 1]; found = true; }
      }
    }
    return found ? { x: bx, y: by, d: Math.sqrt(best) } : null;
  }

  _buildSamples() {
    const F = this.field;
    const buckets = new Map();
    const S = []; // [x, y, ax, ay, sigma, qx..., qy...]
    const ends = [];
    // neueste Bahnen zuerst, damit sie bei Begrenzung bevorzugt werden
    for (let ti = this.trajs.length - 1; ti >= 0; ti--) {
      const t = this.trajs[ti];
      const d = t.dots;
      const L = d.length / 2;
      const R = L - 1; // reguläre Punkte: 0..R-1
      // Endpunkt-Klassifikation
      if (t.end === 'planet' && R >= 2) {
        const ex = d[2 * (L - 1)], ey = d[2 * (L - 1) + 1];
        const px = d[2 * (R - 1)], py = d[2 * (R - 1) + 1];
        const stepLen = Math.hypot(ex - px, ey - py) || 1; // Weg im letzten (Teil-)Frame
        ends.push({ x: ex, y: ey, s: Math.min(stepLen, 60) / F.steps * 2 });
      }
      for (let i = 2; i <= R - 3; i++) {
        const x = d[2 * i], y = d[2 * i + 1];
        if (x < -400 || y < -400 || x > F.W + 400 || y > F.H + 400) continue;
        const bk = (Math.floor(x / 14) + 1000) * 4096 + Math.floor(y / 14) + 1000;
        const c = buckets.get(bk) || 0;
        if (c >= 2) continue;
        buckets.set(bk, c + 1);
        const ax = d[2 * i + 2] - 2 * x + d[2 * i - 2];
        const ay = d[2 * i + 3] - 2 * y + d[2 * i - 1];
        const amag = Math.hypot(ax, ay);
        // Float32-Rauschen + relativer Modellfehler
        const sigma = 2.5e-4 + Math.abs(x) * 1e-7 + 0.02 * amag;
        const q = new Float64Array(NQ * 3);
        for (let k = 0; k < NQ; k++) {
          const tq = QT[k];
          let ts, xs, ys;
          if (tq < 0) { ts = [-2, -1, 0, 1]; xs = [d[2 * i - 4], d[2 * i - 2], x, d[2 * i + 2]]; ys = [d[2 * i - 3], d[2 * i - 1], y, d[2 * i + 3]]; }
          else { ts = [-1, 0, 1, 2]; xs = [d[2 * i - 2], x, d[2 * i + 2], d[2 * i + 4]]; ys = [d[2 * i - 1], y, d[2 * i + 3], d[2 * i + 5]]; }
          q[k * 3] = lagrange(ts, xs, tq);
          q[k * 3 + 1] = lagrange(ts, ys, tq);
          q[k * 3 + 2] = QW[k];
        }
        S.push({ x, y, ax, ay, sigma, q });
      }
    }
    let samples = S;
    if (samples.length > this.opts.maxSamples) {
      const r = rng(12345 + this.trajs.length);
      // zufällig ausdünnen, aber stark beschleunigte (planetennahe) Samples bevorzugen
      samples = samples
        .map(s => ({ s, k: r() / (1 + 10 * Math.hypot(s.ax, s.ay)) }))
        .sort((a, b) => a.k - b.k)
        .slice(0, this.opts.maxSamples)
        .map(o => o.s);
    }
    this.samples = samples;
    this.ends = ends;
  }

  // ---------------------------------------------------------------- Modell-Auswertung
  _predict(P, s, out) {
    let ax = 0, ay = 0;
    const q = s.q, n = P.length;
    for (let k = 0; k < NQ; k++) {
      const x = q[k * 3], y = q[k * 3 + 1], w = q[k * 3 + 2];
      for (let o = 0; o < n; o += 4) {
        const dx = P[o] - x, dy = P[o + 1] - y;
        const l2 = dx * dx + dy * dy;
        const f = w * P[o + 3] / (l2 * Math.sqrt(l2));
        ax += dx * f; ay += dy * f;
      }
    }
    out[0] = ax; out[1] = ay;
  }

  residuals(planets) {
    const P = packPlanets(planets);
    const out = [0, 0];
    return this.samples.map(s => {
      this._predict(P, s, out);
      return [s.ax - out[0], s.ay - out[1]];
    });
  }

  chi2(planets) {
    const P = packPlanets(planets);
    const out = [0, 0];
    let c = 0;
    for (const s of this.samples) {
      this._predict(P, s, out);
      const rx = (s.ax - out[0]) / s.sigma, ry = (s.ay - out[1]) / s.sigma;
      c += rx * rx + ry * ry;
    }
    return c;
  }

  // ---------------------------------------------------------------- Kandidatensuche (NNLS)
  _nnlsPeaks(planets, res) {
    const F = this.field, g = this.opts.gridCell;
    const nx = Math.ceil(F.W / g), ny = Math.ceil(F.H / g);
    // Teilmenge der Samples
    let idx = this.samples.map((_, i) => i);
    if (idx.length > this.opts.nnlsSamples) {
      const r = rng(777 + idx.length);
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
      idx = idx.slice(0, this.opts.nnlsSamples);
    }
    const N = idx.length;
    if (N < 20) return [];
    // Kandidatenzellen: nicht im Freiraum, nicht in bekannten Planeten
    const cells = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const cx = (i + 0.5) * g, cy = (j + 0.5) * g;
      if (this._nearestVisited(cx, cy, this.opts.minRadius)) continue;
      let inside = false;
      for (const p of planets) if (Math.hypot(p.x - cx, p.y - cy) < p.r * 0.7) { inside = true; break; }
      if (inside) continue;
      cells.push([cx, cy, i, j]);
    }
    const K = cells.length;
    if (!K) return [];
    const rows = 2 * N;
    const A = new Float32Array(K * rows);
    const norms = new Float64Array(K);
    const b = new Float64Array(rows);
    for (let n = 0; n < N; n++) {
      const s = this.samples[idx[n]];
      b[2 * n] = res[idx[n]][0] / s.sigma;
      b[2 * n + 1] = res[idx[n]][1] / s.sigma;
    }
    for (let k = 0; k < K; k++) {
      const [cx, cy] = cells[k];
      let nn = 0;
      const base = k * rows;
      for (let n = 0; n < N; n++) {
        const s = this.samples[idx[n]], q = s.q;
        let ax = 0, ay = 0;
        for (let t = 0; t < NQ; t++) {
          const dx = cx - q[t * 3], dy = cy - q[t * 3 + 1];
          const l2 = dx * dx + dy * dy;
          const f = q[t * 3 + 2] / (l2 * Math.sqrt(l2));
          ax += dx * f; ay += dy * f;
        }
        ax /= s.sigma; ay /= s.sigma;
        A[base + 2 * n] = ax; A[base + 2 * n + 1] = ay;
        nn += ax * ax + ay * ay;
      }
      norms[k] = nn;
    }
    // projizierter Koordinatenabstieg
    const m = new Float64Array(K);
    const r = Float64Array.from(b);
    for (let sweep = 0; sweep < 60; sweep++) {
      let change = 0;
      for (let k = 0; k < K; k++) {
        if (norms[k] <= 0) continue;
        const base = k * rows;
        let gk = 0;
        for (let i = 0; i < rows; i++) gk += A[base + i] * r[i];
        const nm = Math.max(0, m[k] + gk / norms[k]);
        const dm = nm - m[k];
        if (dm !== 0) {
          for (let i = 0; i < rows; i++) r[i] -= A[base + i] * dm;
          m[k] = nm;
          change += Math.abs(dm);
        }
      }
      if (change < 1) break;
    }
    // Peaks gierig clustern
    const order = [...m.keys()].filter(k => m[k] > 0).sort((a, b2) => m[b2] - m[a]);
    const used = new Uint8Array(K);
    const peaks = [];
    for (const k of order) {
      if (used[k]) continue;
      const [cx, cy] = cells[k];
      let M = 0, sx = 0, sy = 0;
      for (const k2 of order) {
        if (used[k2]) continue;
        const [x2, y2] = cells[k2];
        if (Math.hypot(x2 - cx, y2 - cy) <= 46) { used[k2] = 1; M += m[k2]; sx += m[k2] * x2; sy += m[k2] * y2; }
      }
      if (M >= this.opts.minPeakMass) peaks.push({ x: sx / M, y: sy / M, m: M });
    }
    return peaks;
  }

  // ---------------------------------------------------------------- Levenberg-Marquardt
  _lm(planets, iters = 25) {
    const n = planets.length;
    if (!n) return { planets, chi2: this.chi2(planets), cov: [] };
    const NPm = 4 * n;
    let par = new Float64Array(NPm);
    planets.forEach((p, j) => { par[4 * j] = p.x; par[4 * j + 1] = p.y; par[4 * j + 2] = p.m; par[4 * j + 3] = p.r; });
    let lambda = 1e-3;
    const toPlanets = (pp) => {
      const out = [];
      for (let j = 0; j < n; j++) out.push({ x: pp[4 * j], y: pp[4 * j + 1], m: pp[4 * j + 2], r: pp[4 * j + 3] });
      return out;
    };
    const build = (pp) => {
      const JTJ = new Float64Array(NPm * NPm);
      const JTr = new Float64Array(NPm);
      let cost = 0;
      const jx = new Float64Array(NPm), jy = new Float64Array(NPm);
      const nzs = [];
      // Beschleunigungs-Samples
      for (const s of this.samples) {
        jx.fill(0); jy.fill(0);
        let px = 0, py = 0;
        const q = s.q;
        for (let j = 0; j < n; j++) {
          const cx = pp[4 * j], cy = pp[4 * j + 1], m = pp[4 * j + 2];
          let dax_dcx = 0, dax_dcy = 0, day_dcy = 0, dax_dm = 0, day_dm = 0;
          for (let k = 0; k < NQ; k++) {
            const w = q[k * 3 + 2];
            const dx = cx - q[k * 3], dy = cy - q[k * 3 + 1];
            const l2 = dx * dx + dy * dy, l = Math.sqrt(l2);
            const il3 = 1 / (l2 * l), il5 = il3 / l2;
            px += w * m * dx * il3; py += w * m * dy * il3;
            dax_dm += w * dx * il3; day_dm += w * dy * il3;
            dax_dcx += w * m * (il3 - 3 * dx * dx * il5);
            dax_dcy += w * m * (-3 * dx * dy * il5);
            day_dcy += w * m * (il3 - 3 * dy * dy * il5);
          }
          jx[4 * j] = dax_dcx; jx[4 * j + 1] = dax_dcy; jx[4 * j + 2] = dax_dm;
          jy[4 * j] = dax_dcy; jy[4 * j + 1] = day_dcy; jy[4 * j + 2] = day_dm;
        }
        const is = 1 / s.sigma;
        const rx = (s.ax - px) * is, ry = (s.ay - py) * is;
        cost += rx * rx + ry * ry;
        // Residuum r = obs - pred -> dr/dp = -J ; Normalgleichung: (JTJ) d = JT r
        for (let a = 0; a < NPm; a++) {
          const ja = jx[a] * is, jb = jy[a] * is;
          if (ja === 0 && jb === 0) continue;
          JTr[a] += ja * rx + jb * ry;
          const row = a * NPm;
          for (let c = a; c < NPm; c++) JTJ[row + c] += ja * jx[c] * is + jb * jy[c] * is;
        }
      }
      // Einschläge auf Oberflächen
      for (const e of this.ends) {
        let best = -1, bd = Infinity;
        for (let j = 0; j < n; j++) {
          const l = Math.hypot(e.x - pp[4 * j], e.y - pp[4 * j + 1]);
          const dd = Math.abs(l - pp[4 * j + 3]);
          if (dd < bd) { bd = dd; best = j; }
        }
        if (best < 0 || bd > 20) continue;
        const j = best;
        const dx = pp[4 * j] - e.x, dy = pp[4 * j + 1] - e.y;
        const l = Math.hypot(dx, dy) || 1e-6;
        const sig = e.s * 0.5 + 0.4;
        const r = -(l - (pp[4 * j + 3] - e.s * 0.5)) / sig; // obs(0) - pred
        cost += r * r;
        const J = [[4 * j, dx / l / sig], [4 * j + 1, dy / l / sig], [4 * j + 3, -1 / sig]];
        nzs.push([J, r]);
      }
      // Prior m = r^3/10
      for (let j = 0; j < n; j++) {
        const m = Math.max(pp[4 * j + 2], 1), r = pp[4 * j + 3];
        const sig = this.opts.radiusPriorSigma;
        const rr = -(r - Math.cbrt(10 * m)) / sig;
        cost += rr * rr;
        const dcb = (10 / 3) * Math.pow(10 * m, -2 / 3);
        nzs.push([[[4 * j + 3, 1 / sig], [4 * j + 2, -dcb / sig]], rr]);
      }
      // Freiraum: Planet darf keine besuchten Punkte enthalten
      for (let j = 0; j < n; j++) {
        const cx = pp[4 * j], cy = pp[4 * j + 1], r = pp[4 * j + 3];
        const nv = this._nearestVisited(cx, cy, r + 1.5);
        if (!nv) continue;
        const dx = cx - nv.x, dy = cy - nv.y, l = nv.d || 1e-6;
        const sig = 0.7;
        const rr = -(r + 1.5 - l) / sig;
        cost += rr * rr;
        nzs.push([[[4 * j + 3, 1 / sig], [4 * j, -dx / l / sig], [4 * j + 1, -dy / l / sig]], rr]);
      }
      for (const [J, r] of nzs) {
        for (const [a, va] of J) {
          JTr[a] += va * r;
          for (const [c, vc] of J) if (c >= a) JTJ[a * NPm + c] += va * vc;
        }
      }
      for (let a = 0; a < NPm; a++) for (let c = 0; c < a; c++) JTJ[a * NPm + c] = JTJ[c * NPm + a];
      return { JTJ, JTr, cost };
    };

    let cur = build(par);
    for (let it = 0; it < iters; it++) {
      let improved = false;
      for (let tries = 0; tries < 8; tries++) {
        const A = Float64Array.from(cur.JTJ);
        for (let a = 0; a < NPm; a++) A[a * NPm + a] += lambda * (cur.JTJ[a * NPm + a] + 1e-9) + 1e-12;
        const delta = cholSolve(A, cur.JTr, NPm);
        if (!delta) { lambda *= 10; continue; }
        const np = Float64Array.from(par);
        for (let a = 0; a < NPm; a++) np[a] += delta[a];
        for (let j = 0; j < n; j++) {
          np[4 * j + 2] = Math.max(np[4 * j + 2], 20);
          np[4 * j + 3] = Math.min(Math.max(np[4 * j + 3], 3), 120);
        }
        const nb = build(np);
        if (nb.cost < cur.cost) {
          par = np; const rel = (cur.cost - nb.cost) / cur.cost; cur = nb;
          lambda = Math.max(lambda / 3, 1e-7); improved = true;
          if (rel < 1e-6) it = iters;
          break;
        }
        lambda *= 6;
      }
      if (!improved) break;
    }
    // Kovarianz (Diagonale) aus (JTJ)^-1, skaliert mit reduziertem chi²
    const dof = Math.max(1, 2 * this.samples.length - NPm);
    const scale = Math.max(1, cur.cost / dof);
    const cov = [];
    const A = Float64Array.from(cur.JTJ);
    for (let a = 0; a < NPm; a++) A[a * NPm + a] += 1e-9;
    for (let j = 0; j < n; j++) {
      const e = new Float64Array(NPm);
      const v = [];
      for (let c = 0; c < 4; c++) {
        e.fill(0); e[4 * j + c] = 1;
        const col = cholSolve(Float64Array.from(A), e, NPm);
        v.push(col ? Math.sqrt(Math.max(0, col[4 * j + c]) * scale) : 50);
      }
      cov.push(v);
    }
    return { planets: toPlanets(par), chi2: cur.cost, cov };
  }

  _prune(planets) {
    let ps = planets.filter(p => p.m >= this.opts.minPeakMass * 0.5 && p.x > -60 && p.y > -60 &&
      p.x < this.field.W + 60 && p.y < this.field.H + 60);
    // überlappende Planeten verschmelzen (Server erzeugt keine Überlappungen)
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i], b = ps[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * 0.85) {
          const M = a.m + b.m;
          const c = { x: (a.x * a.m + b.x * b.m) / M, y: (a.y * a.m + b.y * b.m) / M, m: M, r: Math.cbrt(10 * M) };
          ps = ps.filter((_, k) => k !== i && k !== j);
          ps.push(c);
          merged = true;
          break outer;
        }
      }
    }
    return ps;
  }

  // Verdächtige Planeten (verschmolzene Paare o.ä.) entfernen und lokal neu besetzen
  _splitSuspicious(best, pen, maxTries = 4) {
    const P0 = best.planets;
    if (!P0.length) return best;
    const res = this.residuals(P0);
    const scored = P0.map((p, j) => {
      let c = 0, k = 0;
      this.samples.forEach((s, i) => {
        if (Math.hypot(s.x - p.x, s.y - p.y) < 220) {
          c += (res[i][0] / s.sigma) ** 2 + (res[i][1] / s.sigma) ** 2; k++;
        }
      });
      const local = k ? c / (2 * k) : 0;
      const priorDev = Math.abs(p.r - Math.cbrt(10 * p.m));
      return { j, score: local + priorDev, local, priorDev };
    }).filter(o => o.local > 3 || o.priorDev > 4).sort((a, b) => b.score - a.score).slice(0, maxTries);
    for (const o of scored) {
      const cur = best.planets;
      const p = P0[o.j];
      // den aktuellen Planeten nahe p finden (Index kann sich verschoben haben)
      let jj = -1, bd = 1e9;
      cur.forEach((q, k) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; jj = k; } });
      if (jj < 0 || bd > 30) continue;
      const without = cur.filter((_, k) => k !== jj);
      const peaks = this._nnlsPeaks(without, this.residuals(without))
        .filter(q => Math.hypot(q.x - p.x, q.y - p.y) < 160);
      if (!peaks.length) continue;
      let cand = without.concat(peaks.map(q => ({ x: q.x, y: q.y, m: q.m, r: Math.max(Math.cbrt(10 * q.m), 8) })));
      let r = this._lm(cand, 25);
      const pr = this._prune(r.planets);
      if (pr.length !== r.planets.length) r = this._lm(pr, 15);
      if (pen(r) < pen(best)) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------- Hauptfunktion
  fit({ rebuild = false } = {}) {
    const t0 = Date.now();
    this._buildSamples();
    if (this.samples.length < 30) {
      this.lastStats = { samples: this.samples.length, trajectories: this.trajs.length, ms: Date.now() - t0, note: 'zu wenige Daten' };
      return { planets: this.planets, stats: this.lastStats, cov: [] };
    }
    this.fitCount++;
    const attempt = (start) => {
      let planets = start.map(p => ({ ...p }));
      let res = { planets, chi2: this.chi2(planets), cov: [] };
      for (let round = 0; round < 6; round++) {
        if (planets.length) { res = this._lm(planets, 20); planets = this._prune(res.planets); }
        if (planets.length >= this.opts.maxPlanets) break;
        const peaks = this._nnlsPeaks(planets, this.residuals(planets));
        const add = peaks.slice(0, Math.min(8, this.opts.maxPlanets - planets.length));
        if (!add.length) break;
        for (const p of add) planets.push({ x: p.x, y: p.y, m: p.m, r: Math.max(Math.cbrt(10 * p.m), 8) });
      }
      res = this._lm(planets, 30);
      planets = this._prune(res.planets);
      if (planets.length !== res.planets.length) res = this._lm(planets, 15);
      return res;
    };
    const pen = (r) => r.chi2 + 35 * r.planets.length; // BIC-artige Modellkomplexitäts-Strafe
    let best = attempt(rebuild ? [] : this.planets);
    // regelmäßig auch komplett neu aufbauen und das bessere Modell nehmen
    if (!rebuild && this.planets.length && this.fitCount % 4 === 0) {
      const alt = attempt([]);
      if (pen(alt) < pen(best)) best = alt;
    }
    best = this._splitSuspicious(best, pen);
    this.planets = best.planets;
    const dof = Math.max(1, 2 * this.samples.length - 4 * best.planets.length);
    const replay = this.replay(best.planets);
    this.lastStats = {
      samples: this.samples.length,
      trajectories: this.trajs.length,
      impacts: this.ends.length,
      redChi2: best.chi2 / dof,
      ms: Date.now() - t0,
      ...replay,
    };
    return { planets: best.planets, cov: best.cov, stats: this.lastStats };
  }

  // Bahnen mit dem Modell nachsimulieren: wie viele Frames stimmt die Vorhersage (< 4px)?
  replay(planets, maxN = 24) {
    const P = packPlanets(planets);
    const list = this.trajs.filter(t => Number.isFinite(t.angle) && t.vel > 0 && t.dots.length >= 8).slice(-maxN);
    if (!list.length || !planets.length) return { horizonMedian: 0, reproduced: 0, replayed: 0 };
    const hs = [];
    let full = 0;
    for (const t of list) {
      const d = t.dots;
      const L = d.length / 2;
      const sim = simulateShot(P, new Float64Array(0), d[0], d[1], t.angle, t.vel, { record: true, maxFrames: L + 2, field: this.field });
      const sd = sim.dots;
      let h = 0;
      const R = Math.min(L - 1, 150); // nur die ersten 2,5 s zählen (so lang fliegen unsere Schüsse typischerweise)
      for (let i = 0; i < R && 2 * i + 1 < sd.length; i++) {
        if (Math.hypot(sd[2 * i] - d[2 * i], sd[2 * i + 1] - d[2 * i + 1]) > 4) break;
        h = i;
      }
      const frac = R > 1 ? h / (R - 1) : 1;
      hs.push(frac);
      if (frac >= 0.999) full++;
    }
    hs.sort((a, b) => a - b);
    return { horizonMedian: hs[Math.floor(hs.length / 2)], reproduced: full / list.length, replayed: list.length };
  }
}

// Ensemble aus dem Kovarianz-Schätzer, für robuste Trefferwahrscheinlichkeiten
export function perturbedModels(planets, cov, k = 6, seed = 1) {
  const r = rng(seed);
  const gauss = () => { const u = Math.max(r(), 1e-12), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(planets.map((p, j) => {
      const c = cov[j] || [3, 3, p.m * 0.05, 1];
      const sx = Math.min(c[0], 25), sy = Math.min(c[1], 25), sm = Math.min(c[2], p.m * 0.5), sr = Math.min(c[3], 8);
      const m = Math.max(20, p.m + gauss() * sm);
      return { x: p.x + gauss() * sx, y: p.y + gauss() * sy, m, r: Math.max(3, p.r + gauss() * sr) };
    }));
  }
  return out;
}

export { END };
