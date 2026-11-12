// Spiellogik: Zustand aus dem Binärprotokoll, Planetenmodell, Zielwahl, Feuern.
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { NWConnection, MSG } from './protocol.js';
import { FIELD, GOLDEN_ANGLE, packPlanets, simulateShot, END } from './physics.js';
import { decimate } from './aim.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);

export const DEFAULT_CONFIG = {
  host: '192.168.8.8',
  port: 3490,
  name: 'NewtonBot',
  botVersion: 9,
  autoConnect: false,
  autoFire: true,
  explore: true,            // Erkundungsschüsse, solange das Planetenmodell dünn ist
  targetMode: 'auto',       // auto | leader | nearest | fixed
  targetId: null,
  velocities: [3, 4, 5, 6, 8, 10, 13, 17, 22, 30, 40],
  velMin: 3,
  velMax: 40,
  maxFlightSec: 15,
  minPHit: 0.35,
  timeWeight: 1.5,
  costWeight: 1.0,
  exploreVel: 5,
  energyRate: 2.0,          // Server: rate (Energie/s)
  energyLimit: 200,
  energyPollSec: 3,
  rateRefill: 16,           // geschätzte Byte/s, die der Server nachfüllt (Server: ~20)
  rateCapacity: 512,
  rateReserve: 40,
  reconnectDelay: 12,
  roundTime: 300,
  boardTime: 20,
  salvo: false,             // mehrere Schüsse auf dasselbe Ziel gleichzeitig erlaubt
  tempo: 'turbo',           // turbo | normal | chill (Voreinstellung für die beiden Werte darunter)
  minShotInterval: 0,       // Sekunden zwischen eigenen Schüssen (0 = so schnell wie möglich)
  maxInflight: 0,           // max. gleichzeitig fliegende eigene Schüsse (0 = unbegrenzt)
  autoNetwork: true,        // fehlt die WLAN-Adresse, feste IP einrichten (macOS fragt nach dem Passwort)
  staticIp: '192.168.8.177',// feste IP im Spielnetz (ohne Router, Internet bleibt auf anderem Interface)
  debrisSpeed: 3.0,
  aimBudgetMs: 4000,
  aimWorkers: 0,            // 0 = automatisch (CPU-Kerne - 4, max. 5)
  useServerPlanets: true,   // false = Server-Planeten nur als Wahrheit zum Testen der Rekonstruktion
};

export const TEMPO = {
  turbo: { minShotInterval: 0, maxInflight: 0 },
  normal: { minShotInterval: 2, maxInflight: 2 },
  chill: { minShotInterval: 6, maxInflight: 1 },
};

const now = () => Date.now();

export class Bot extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.conn = new NWConnection(this._connCfg());
    this.conn.on('log', (l) => this.log(l.level, l.text));
    this.conn.on('status', (s) => { this.connStatus = s; if (s.state === 'online') this._onOnline(); this.emit('changed'); });
    this.conn.on('msg', (m) => this._onMsg(m));
    this.conn.on('disconnected', () => { this.myId = null; this.pending = null; this.serverVel = null; });
    this.conn.on('ratelimitHit', () => { this.cfg.rateRefill = this.conn.cfg.rateRefill; this.emit('config'); });
    this.connStatus = { state: 'idle' };

    this.myId = null;
    this.players = new Map();
    this.labels = new Map();
    this.energy = { value: 20, at: now(), polledAt: 0, source: 'est' };
    this.model = { planets: [], ensemble: [], source: 'none', stats: null, version: 0, updatedAt: 0 };
    this.trajs = [];            // für UI
    this.trajSeq = 0;
    this.inflight = [];         // eigene Schüsse in der Luft
    this.pending = null;        // gesendet, Server hat noch nicht gefeuert
    this.plan = null;           // aktuelle Lösung
    this.serverVel = null;
    this.exploreIdx = Math.floor(Math.random() * 360);
    this.stats = { shots: 0, kills: 0, deaths: 0, suicides: 0, explore: 0, aimed: 0, aimHits: 0 };
    this.round = { start: null, resets: 0 };
    this.recentReposition = [];
    this.pendingKill = new Map(); // victimId -> {shooter, at}
    this.debris = new Map();
    this.logs = [];
    this.manualQueue = [];
    this.lastShotFinAt = 0;
    this.killedBy = [];
    this.boardSuspect = 0;

    this.mapW = this._mkWorker('map');
    const nAim = this.cfg.aimWorkers || Math.max(2, Math.min(5, (os.availableParallelism?.() || os.cpus().length) - 4));
    this.aimPool = Array.from({ length: nAim }, (_, i) => this._mkWorker('aim', i));
    this.sol = new Map();       // Lösungs-Cache pro Ziel
    this.fitBusy = false; this.fitDirty = false; this.fitTimer = null;
    this.aimBusy = false;
    this.reqId = 0;
    this.tickTimer = setInterval(() => this._tick(), 150);
    if (this.cfg.autoConnect) this.connect();
  }

  _connCfg() {
    const c = this.cfg;
    return { host: c.host, port: c.port, name: c.name, botVersion: c.botVersion, rateRefill: c.rateRefill, rateCapacity: c.rateCapacity, rateReserve: c.rateReserve, reconnectDelay: c.reconnectDelay };
  }

  _mkWorker(role, idx = 0) {
    const w = new Worker(WORKER_URL);
    w.on('message', (m) => this._onWorker(role, m));
    w.on('error', (e) => this.log('error', `Worker ${role}: ${e.message}`));
    w.on('exit', (code) => {
      if (this.closed) return;
      this.log('warn', `Worker ${role} beendet (${code}), starte neu`);
      if (role === 'map') { this.mapW = this._mkWorker('map'); this.fitBusy = false; this._resendTrajs(); }
      else { this.aimPool[idx] = this._mkWorker('aim', idx); this._aimCtx = null; this.aimBusy = false; }
    });
    return w;
  }

  log(level, text) {
    const e = { t: now(), level, text };
    this.logs.push(e);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', e);
  }

  // ---------------------------------------------------------------- Steuerung
  connect() { this.conn.setConfig(this._connCfg()); this.conn.connect(); }
  disconnect() { this.log('info', 'Trennen angefordert'); this.conn.disconnect(); }
  reconnect() {
    this.log('info', 'Neu verbinden angefordert');
    this.conn.disconnect();
    // Server sperrt die IP nach jedem Versuch ~10 s -> connect() wartet das selbst ab
    setTimeout(() => this.connect(), 800);
  }

  setConfig(patch) {
    const before = { ...this.cfg };
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_CONFIG) this.cfg[k] = v;
    if (patch.tempo && TEMPO[patch.tempo]) {
      Object.assign(this.cfg, TEMPO[patch.tempo]);
      this.log('info', `Tempo: ${({ turbo: 'Turbo', normal: 'Normal', chill: 'Gemütlich' })[patch.tempo]}`);
    }
    if (patch.autoFire !== undefined && patch.autoFire !== before.autoFire) this.log('info', patch.autoFire ? '▶ Auto-Feuer an' : '⏸ Auto-Feuer pausiert');
    this.conn.setConfig(this._connCfg());
    if (patch.name && patch.name !== before.name && this.conn.state === 'online') this.conn.send(`n ${this.cfg.name}`, 1, 'name');
    this.plan = null;
    this.emit('config');
    this.emit('changed');
  }

  setLabel(id, label) { if (label) this.labels.set(id, label); else this.labels.delete(id); this.emit('changed'); }

  manualFire(angle, vel) {
    if (this.conn.state !== 'online') return this.log('warn', 'Nicht verbunden');
    this._fire({ angle, velocity: vel, target: null, kind: 'manual', frames: 0 });
  }

  resetModel() {
    this._resetRound('manuell');
  }

  refitNow(rebuild = false) { this._scheduleFit(0, rebuild); }

  // ---------------------------------------------------------------- Protokoll-Ereignisse
  _onOnline() {
    this.players.clear();
    this.serverVel = null;
    this.energy = { value: 20, at: now(), polledAt: 0, source: 'est' };
    this.log('ok', `Online als "${this.cfg.name}" (Bot-Protokoll v${this.cfg.botVersion})`);
  }

  _onMsg(m) {
    const t = now();
    switch (m.type) {
      case MSG.OWNID:
        this.myId = m.id;
        this.log('info', `Eigene Spieler-ID: ${m.id}`);
        break;
      case MSG.PLAYERLEAVE:
        if (this.players.has(m.id)) this.log('info', `Spieler ${this._pname(m.id)} hat das Spiel verlassen`);
        this.players.delete(m.id);
        break;
      case MSG.PLAYERPOS: this._onPlayerPos(m, t); break;
      case MSG.SHOTBEGIN: this._onShotBegin(m, t); break;
      case MSG.SHOTFIN:
      case MSG.SHOTFINISHED: this._onShotFin(m, t); break;
      case MSG.OWN_ENERGY:
        this.energy = { value: m.energy, at: t, polledAt: t, source: 'server' };
        break;
      case MSG.PLANETPOS:
        if (m.planets.length && !this.cfg.useServerPlanets) {
          this.truth = m.planets;
          this.log('info', `Server-Planeten empfangen (${m.planets.length}) – nur als Referenz (Testmodus)`);
        } else if (m.planets.length) {
          this.model = { planets: m.planets, ensemble: [], source: 'server', stats: { note: 'vom Server gesendet' }, version: this.model.version + 1, updatedAt: t };
          this.log('ok', `Server schickt Planeten (${m.planets.length}) – exakte Physik verfügbar!`);
          this.plan = null;
          this.emit('model');
        }
        break;
      case MSG.GAMEMODE: break;
    }
    this.emit('changed');
  }

  _onPlayerPos(m, t) {
    const old = this.players.get(m.id);
    const pk = this.pendingKill.get(m.id);
    const deb = this.debris.get(m.id);
    const died = (pk && t - pk.at < 1500) || (deb && t - deb.at < 500 && deb.n >= 3);
    if (!old) {
      this.players.set(m.id, { id: m.id, x: m.x, y: m.y, kills: 0, deaths: 0, since: t });
      if (this.myId !== null && m.id !== this.myId) this.log('info', `Spieler ${m.id} ist da (${m.x.toFixed(0)}, ${m.y.toFixed(0)})`);
      return;
    }
    const moved = Math.hypot(old.x - m.x, old.y - m.y) > 0.5;
    old.x = m.x; old.y = m.y;
    if (!moved) return;
    if (died) {
      this.pendingKill.delete(m.id);
      old.deaths++;
      if (m.id === this.myId) {
        this.stats.deaths++;
        this.energy = { value: 20, at: t, polledAt: this.energy.polledAt, source: 'est' };
        const by = pk ? (pk.shooter === m.id ? 'mich selbst' : this._pname(pk.shooter)) : '?';
        if (pk && pk.shooter === m.id) this.stats.suicides++;
        if (pk && pk.shooter !== m.id) this.killedBy.push({ id: pk.shooter, t });
        this.log('bad', `☠ Ich wurde getroffen von ${by}. Neue Position (${m.x.toFixed(0)}, ${m.y.toFixed(0)})`);
      }
      if (pk && pk.shooter !== m.id) {
        const sh = this.players.get(pk.shooter);
        if (sh) sh.kills++;
        if (pk.shooter === this.myId) {
          this.stats.kills++;
          this.log('ok', `🎯 Treffer! ${this._pname(m.id)} abgeschossen`);
          this.energy.polledAt = 0; // Energie (+ halbe Opfer-Energie) neu abfragen
        }
      }
      this.plan = null;
      return;
    }
    // Neupositionierung ohne Tod -> Rundenwechsel?
    this.recentReposition = this.recentReposition.filter(r => t - r < 1500);
    this.recentReposition.push(t);
    if (process.env.NWBOT_DEBUG) this.log('info', `DEBUG Reposition ohne Tod: #${m.id} pk=${pk ? (t - pk.at) + 'ms' : '-'} deb=${deb ? (t - deb.at) + 'ms/n' + deb.n : '-'} recent=${this.recentReposition.length}`);
    if ((m.id === this.myId || this.recentReposition.length >= 2) && !(this.round.start && t - this.round.start < 8000)) {
      this.recentReposition = [];
      this._resetRound('Neupositionierung erkannt');
    }
    this.plan = null;
  }

  _onShotBegin(m, t) {
    if (m.vel === this.cfg.debrisSpeed) {
      const d = this.debris.get(m.id);
      if (d && t - d.at < 300) d.n++; else this.debris.set(m.id, { at: t, n: 1 });
    }
    if (m.id !== this.myId) return;
    if (this.pending && Math.abs(this.pending.velocity - m.vel) < 1e-6) {
      const p = this.pending;
      this.pending = null;
      this.stats.shots++;
      this.energy.value -= m.vel;
      this.inflight.push({ ...p, firedAt: t, angleSent: m.angle });
      if (this.inflight.length > 20) this.inflight.shift();
    } else if (m.vel !== this.cfg.debrisSpeed) {
      this.energy.value -= m.vel;
    }
  }

  _classifyEnd(dots, shooter) {
    const n = dots.length / 2;
    const ex = dots[2 * n - 2], ey = dots[2 * n - 1];
    const M = FIELD.margin;
    if (ex < -M + 1 || ey < -M + 1 || ex > FIELD.W + M - 1 || ey > FIELD.H + M - 1) return { kind: 'out' };
    if (n >= FIELD.maxSegments - 1) return { kind: 'max' };
    let best = null, bd = 1e9;
    for (const p of this.players.values()) {
      const d = Math.hypot(p.x - ex, p.y - ey);
      if (d < bd) { bd = d; best = p; }
    }
    if (best && bd <= FIELD.playerSize + 0.6) {
      // eigener Schütze direkt am Start ist keine Kollision (leftSource)
      if (!(best.id === shooter && n < 4)) return { kind: 'player', victim: best.id };
    }
    return { kind: 'planet' };
  }

  _onShotFin(m, t) {
    this.lastShotFinAt = t;
    if (this.boardSuspect) { this.boardSuspect = 0; this.log('info', 'Geschosse fliegen wieder'); }
    const dots = m.dots;
    const n = dots.length / 2;
    if (n < 2) return;
    const end = this._classifyEnd(dots, m.id);
    if (end.kind === 'player') this.pendingKill.set(end.victim, { shooter: m.id, at: t });
    const own = m.id === this.myId;
    const tr = {
      seq: ++this.trajSeq, owner: m.id, own, angle: m.angle, vel: m.vel, end: end.kind, victim: end.victim,
      dots: decimate(dots, 260), at: t, debris: m.vel === this.cfg.debrisSpeed,
    };
    this.trajs.push(tr);
    if (this.trajs.length > 80) this.trajs.shift();
    this.emit('traj', tr);
    // eigener Schuss: Ergebnis auswerten
    if (own) {
      const idx = this.inflight.findIndex(s => Math.abs(s.velocity - m.vel) < 1e-6 && Math.abs(norm(s.angleSent ?? s.angle) - norm(m.angle)) < 1e-3);
      if (idx >= 0) {
        const s = this.inflight.splice(idx, 1)[0];
        if (s.kind === 'aim') {
          if (end.kind === 'player' && end.victim === s.target) this.stats.aimHits++;
          else if (end.kind === 'player') this.log('info', `Schuss auf ${this._pname(s.target)} traf stattdessen ${this._pname(end.victim)}`);
          else this.log('info', `Fehlschuss auf ${this._pname(s.target)} (${end.kind}, ${n} Frames, erwartet ${s.frames}) → Modell lernt`);
        }
      }
    }
    // an den Mapper (nur wenn nicht der Server die Planeten liefert)
    if (this.model.source !== 'server') {
      this.mapW.postMessage({ type: 'add', trajs: [{ dots: Array.from(dots), angle: m.angle, vel: m.vel, owner: m.id, end: end.kind }] });
      this._allTrajs = this._allTrajs || [];
      this._allTrajs.push({ dots: Array.from(dots), angle: m.angle, vel: m.vel, owner: m.id, end: end.kind });
      if (this._allTrajs.length > 400) this._allTrajs.shift();
      this._scheduleFit(own ? 300 : 900);
    }
  }

  _resendTrajs() {
    this.mapW.postMessage({ type: 'add', trajs: this._allTrajs || [] });
    this._scheduleFit(200);
  }

  _resetRound(reason) {
    const t0 = now();
    // Rundenlänge lernen (Abstand zweier Resets = Spielzeit + Pause)
    if (this.round.start && reason !== 'manuell') {
      const per = (t0 - this.round.start) / 1000;
      if (per > 40 && per < 4000) {
        const rt = Math.round(per - this.cfg.boardTime);
        if (Math.abs(rt - this.cfg.roundTime) > 3) { this.log('info', `Rundenlänge gelernt: ${rt} s`); this.cfg.roundTime = rt; this.emit('config'); }
      }
    }
    this.boardSuspect = 0;
    this.round.start = t0;
    this.round.resets++;
    this.log('warn', `Neue Runde (${reason}) – Planetenmodell wird neu gelernt`);
    this.trajs = [];
    this._allTrajs = [];
    this.inflight = [];
    this.pending = null;
    this.plan = null;
    this.sol = new Map();
    this.energy = { value: 20, at: now(), polledAt: 0, source: 'est' };
    this.serverVel = this.serverVel; // Geschwindigkeit wird bei initPlayer(clear) auf 10 gesetzt
    this.serverVel = null;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; }
    this.stats.kills = 0; this.stats.deaths = 0;
    if (this.model.source !== 'server') {
      this.model = { planets: [], ensemble: [], source: 'none', stats: null, version: this.model.version + 1, updatedAt: now() };
      this.mapW.postMessage({ type: 'reset' });
      this.emit('model');
    }
    this.emit('reset');
  }

  // ---------------------------------------------------------------- Mapper
  _scheduleFit(delay, rebuild = false) {
    this.fitDirty = true;
    this.fitRebuild = this.fitRebuild || rebuild;
    if (this.fitTimer) return;
    this.fitTimer = setTimeout(() => {
      this.fitTimer = null;
      if (this.fitBusy) return;
      this.fitBusy = true; this.fitDirty = false;
      this.mapW.postMessage({ type: 'fit', id: ++this.reqId, rebuild: this.fitRebuild });
      this.fitRebuild = false;
    }, delay);
  }

  _onWorker(role, m) {
    if (m.type === 'error') {
      this.log('error', `Worker ${role}: ${m.error.split('\n')[0]}`);
      if (role === 'map') this.fitBusy = false;
      else if (this._aimCtx && this._aimCtx.jobs.has(m.id)) this._onAimResult({ id: m.id, candidates: [], ms: 0 });
      return;
    }
    if (m.type === 'fit') {
      this.fitBusy = false;
      if (this.model.source !== 'server' && this._allTrajs && this._allTrajs.length) {
        const prevN = this.model.planets.length;
        this.model = { planets: m.planets, ensemble: m.ensemble, source: m.planets.length ? 'estimated' : 'none', stats: m.stats, version: this.model.version + 1, updatedAt: now() };
        if (this.truth) this.model.truthErr = compareModel(this.truth, m.planets);
        if (m.planets.length !== prevN) this.log('info', `Planetenmodell: ${m.planets.length} Planeten (Samples ${m.stats.samples}, Replay ${(100 * (m.stats.reproduced || 0)).toFixed(0)}%, ${m.stats.ms} ms)${this.model.truthErr ? ` · Wahrheit: ${this.model.truthErr.matched}/${this.model.truthErr.total} getroffen, ${this.model.truthErr.spurious} falsch, Fehler ${this.model.truthErr.medErr?.toFixed(2)} px` : ''}`);
        this.emit('model');
      }
      if (this.fitDirty) this._scheduleFit(400);
    }
    if (m.type === 'aim') this._onAimResult(m);
  }

  modelQuality() {
    const M = this.model;
    if (M.source === 'server') return 1;
    if (M.source !== 'estimated' || !M.stats) return 0;
    const s = M.stats;
    const rep = s.replayed ? (0.5 * (s.reproduced || 0) + 0.5 * (s.horizonMedian || 0)) : 0.3;
    const dataF = Math.min(1, (s.trajectories || 0) / 40);
    return Math.max(0, Math.min(1, rep * (0.4 + 0.6 * dataF)));
  }

  // ---------------------------------------------------------------- Energie
  energyNow() {
    const e = this.energy;
    const v = Math.min(this.cfg.energyLimit, e.value + (now() - e.at) / 1000 * this.cfg.energyRate);
    return v;
  }

  // ---------------------------------------------------------------- Hauptschleife
  _tick() {
    const t = now();
    // Energie fortschreiben
    const ev = this.energyNow();
    this.energy.value = ev; this.energy.at = t;
    if (this.conn.state === 'online' && t - this.conn.lastRecvAt > 15000) {
      this.conn.kill('Seit 15 s keine Daten vom Server – Verbindung tot (WLAN/IP weg?), baue neu auf');
      return;
    }
    if (this.conn.state !== 'online' || this.myId === null || !this.players.has(this.myId)) return;
    // Energie periodisch abfragen (2 Byte), niedrige Priorität
    if (this.cfg.botVersion >= MSG.OWN_ENERGY && t - this.energy.polledAt > this.cfg.energyPollSec * 1000) {
      this.energy.polledAt = t;
      this.conn.send('u', 2, 'u');
    }
    // Stillstand erkennen: eigener Schuss deutlich überfällig -> Rundenpause (Geschosse eingefroren)
    for (const s of this.inflight) {
      if (!s.stallChecked && s.kind !== 'explore' && t - s.firedAt > (s.frames / 60 + 2.5) * 1000 && t - this.lastShotFinAt > 2500) {
        s.stallChecked = true;
        if (!this.boardSuspect) { this.boardSuspect = t; this.log('warn', 'Geschosse eingefroren → vermutlich Rundenpause, Feuer eingestellt bis zur neuen Runde'); }
      }
    }
    if (this.boardSuspect && t - this.boardSuspect > 30000) this.boardSuspect = 0;
    // abgelaufene Schüsse aufräumen
    this.inflight = this.inflight.filter(s => t - s.firedAt < (s.frames / 60 + 6) * 1000);
    if (this.pending && t - this.pending.sentAt > 8000) { this.log('warn', 'Schuss wurde vom Server nicht ausgelöst (Energie?)'); this.pending = null; }
    if (this.manualQueue.length) return;
    if (!this.cfg.autoFire || this.pending) return;
    // Tempo-Bremse (Modus Normal/Gemütlich)
    if (this.cfg.minShotInterval > 0 && t - (this.lastFireAt || 0) < this.cfg.minShotInterval * 1000) return;
    if (this.cfg.maxInflight > 0 && this.inflight.length >= this.cfg.maxInflight) return;
    if (this._inBoardPhase()) return;

    const q = this.modelQuality();
    if (!this.model.planets.length) {
      if (this.cfg.explore) this._explore(ev, 'kein Modell');
      return;
    }
    const targets = this._targets();
    // 1) beste gecachte Lösung für ein freies Ziel, die jetzt bezahlbar ist
    const thr = this.model.source === 'server' ? 0.5 : Math.min(0.9, this.cfg.minPHit + 0.35 * (1 - q));
    let best = null;
    for (const tg of targets) {
      const e = this._solEntry(tg.id);
      if (!e) continue;
      for (const c of e.cands) {
        if (c.pHit < thr) continue;
        const sc = this._score(c, ev, tg.value);
        const affordable = c.velocity <= ev - 0.05;
        if (!best || (affordable && !best.affordable) || (affordable === best.affordable && sc > best.sc)) best = { c, e, sc, affordable, value: tg.value };
      }
    }
    this.plan = best ? { ...best.c, kind: 'aim', waiting: !best.affordable } : null;
    if (best && best.affordable && this.conn.canSend(16, 0)) {
      const c = best.c;
      best.e.cands = best.e.cands.filter(x => x !== c); // verbraucht (auch bei Fehlschuss nicht wiederholen)
      if (c.modelVersion !== this.model.version && !this._verify(c)) {
        this.stats.rejected = (this.stats.rejected || 0) + 1;
        return;
      }
      this._fire({ ...c, kind: 'aim' });
      return;
    }
    // 2) fehlende Lösungen im Hintergrund berechnen
    if (!this.aimBusy) {
      const need = targets.filter(tg => this._needsSolve(tg.id, thr));
      if (need.length) { this._requestAim(need, ev, q); return; }
    }
    // 3) nichts zu tun und Modell schwach -> erkunden
    if (!best && !this.aimBusy && this.cfg.explore && q < 0.6 && targets.every(tg => { const e = this._solEntry(tg.id); return e && !e.cands.some(c => c.pHit >= thr); })) {
      this._explore(ev, 'keine sichere Lösung');
    }
  }

  _score(c, energy, value = 1) {
    const L = this.cfg.energyLimit;
    const costW = this.cfg.costWeight * Math.min(1, Math.max(0.05, (L - energy) / L)); // voller Tank -> Tempo ist gratis
    let sc = c.pHit * value / (c.velocity * costW + (c.frames / 60) * this.cfg.timeWeight + 1);
    // Byte-Budget knapp -> Lösungen mit bereits eingestellter Geschwindigkeit bevorzugen (spart "v X\n")
    if (this.serverVel !== null && c.velocity !== this.serverVel) {
      const b = this.conn.budget() / this.cfg.rateCapacity;
      sc *= b < 0.5 ? 0.75 : 0.97;
    }
    return sc;
  }

  _pkey(id) { const p = this.players.get(id); return p ? `${p.x.toFixed(2)},${p.y.toFixed(2)}` : null; }

  _solEntry(id) {
    const e = this.sol.get(id);
    if (!e || e.tKey !== this._pkey(id) || e.meKey !== this._pkey(this.myId)) return null;
    return e;
  }

  _needsSolve(id, thr) {
    const e = this._solEntry(id);
    if (!e) return true;
    if (e.cands.some(c => c.pHit >= thr)) return false;
    // keine brauchbare Lösung: nach Modell-Update (Modell lernt noch) erneut rechnen
    return now() - e.at > 3000 && e.modelVersion !== this.model.version;
  }

  _inBoardPhase() {
    if (this.boardSuspect) return true;
    if (!this.round.start) return false;
    const el = (now() - this.round.start) / 1000;
    const per = this.cfg.roundTime + this.cfg.boardTime;
    const ph = el % per;
    return ph > this.cfg.roundTime - 0.5;
  }

  _posKey() {
    return [...this.players.values()].map(p => `${p.id}:${p.x.toFixed(1)},${p.y.toFixed(1)}`).sort().join('|');
  }

  _targets() {
    const me = this.players.get(this.myId);
    const t = now();
    const locked = new Set(this.cfg.salvo ? [] : this.inflight
      .filter(s => s.kind === 'aim' && s.pHit > 0.5 && t < s.firedAt + (s.frames / 60 + 0.7) * 1000)
      .map(s => s.target));
    let list = [...this.players.values()].filter(p => p.id !== this.myId && !locked.has(p.id));
    // Leader (Extrapunkte, Server-Modus "best": meiste Kills, dann wenigste Tode)
    let leader = null;
    for (const p of this.players.values()) {
      if (!leader || p.kills > leader.kills || (p.kills === leader.kills && p.deaths < leader.deaths)) leader = p;
    }
    this.killedBy = this.killedBy.filter(k => t - k.t < 90000);
    const threat = (id) => Math.min(2, this.killedBy.filter(k => k.id === id).length);
    const value = (p) => 1 + ((leader && p.id === leader.id && (p.kills > 0)) ? 1 : 0) + threat(p.id);
    if (this.cfg.targetMode === 'fixed' && this.cfg.targetId !== null) list = list.filter(p => p.id === Number(this.cfg.targetId));
    if (this.cfg.targetMode === 'leader' && leader && leader.id !== this.myId) list = list.filter(p => p.id === leader.id);
    if (this.cfg.targetMode === 'nearest' && me) list = list.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y)).slice(0, 1);
    return list.map(p => ({ id: p.id, value: value(p) }));
  }

  _requestAim(targets, energy, quality) {
    const me = this.players.get(this.myId);
    const vels = this.cfg.velocities.filter(v => v >= this.cfg.velMin && v <= this.cfg.velMax && v <= this.cfg.energyLimit).sort((a, b) => a - b);
    if (!vels.length) return;
    const est = this.model.source === 'estimated';
    const base = {
      planets: this.model.planets,
      ensemble: est ? this.model.ensemble : [],
      me: { id: me.id, x: me.x, y: me.y },
      players: [...this.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y })),
      targets,
      // unsicheres Modell -> nur kurze Flüge (robust), mehr Abstand zu uns selbst
      maxFrames: Math.round(Math.min(this.cfg.maxFlightSec * 60, est ? 90 + 900 * quality : Infinity)),
      selfSafety: est ? 12 + 40 * (1 - quality) : 6,
      sigmaDeg: est ? 0.004 + 0.08 * (1 - quality) : 0.001,
      energy: 1e9, energyRate: this.cfg.energyRate,
      timeWeight: this.cfg.timeWeight, costWeight: 0.3,
      budgetMs: this.cfg.aimBudgetMs,
    };
    // Geschwindigkeiten reihum auf den Worker-Pool verteilen (langsame = teure gleichmäßig streuen)
    const n = Math.min(this.aimPool.length, vels.length);
    const parts = Array.from({ length: n }, () => []);
    vels.forEach((v, i) => parts[i % n].push(v));
    const ctx = { jobs: new Set(), results: [], at: now(), modelVersion: this.model.version, meKey: this._pkey(this.myId), tKeys: new Map(targets.map(tg => [tg.id, this._pkey(tg.id)])), ms: 0 };
    this.aimBusy = true;
    this._aimCtx = ctx;
    parts.forEach((vs, i) => {
      const id = ++this.reqId;
      ctx.jobs.add(id);
      this.aimPool[i].postMessage({ type: 'aim', id, req: { ...base, velocities: vs } });
    });
  }

  _onAimResult(m) {
    const ctx = this._aimCtx;
    if (!ctx || !ctx.jobs.has(m.id)) return;
    ctx.jobs.delete(m.id);
    ctx.results.push(...m.candidates);
    ctx.ms = Math.max(ctx.ms, m.ms);
    if (ctx.jobs.size) return;
    this.aimBusy = false;
    this._aimCtx = null;
    const wall = now() - ctx.at;
    if (ctx.meKey !== this._pkey(this.myId)) return; // ich bin inzwischen gestorben
    const all = ctx.results.sort((a, b) => b.score - a.score);
    let solved = 0;
    for (const [id, tKey] of ctx.tKeys) {
      if (tKey !== this._pkey(id)) continue; // Ziel ist inzwischen respawnt
      const cands = all.filter(c => c.target === id).slice(0, 4)
        .map(c => ({ ...c, modelVersion: ctx.modelVersion }));
      if (cands.length) solved++;
      this.sol.set(id, { tKey, meKey: ctx.meKey, at: now(), modelVersion: ctx.modelVersion, cands });
    }
    this.lastAim = { ms: wall, n: all.length, at: now(), targets: ctx.tKeys.size, solved, workers: this.aimPool.length };
    this.emit('plan');
  }

  _verify(p) {
    const me = this.players.get(this.myId);
    if (!me || !this.model.planets.length) return false;
    const pl = new Float64Array([...this.players.values()].flatMap(q => [q.x, q.y, q.id]));
    const r = simulateShot(packPlanets(this.model.planets), pl, me.x, me.y, p.angle, p.velocity, { selfId: me.id, maxFrames: Math.round(this.cfg.maxFlightSec * 60) + 60 });
    return r.end === END.PLAYER && r.hitId === p.target;
  }

  _explore(energy, why) {
    const v = this.cfg.exploreVel;
    if (energy < v + 0.05 || !this.conn.canSend(14, 1)) return;
    this.exploreIdx = (this.exploreIdx + GOLDEN_ANGLE) % 360;
    this.stats.explore++;
    this._fire({ angle: norm(this.exploreIdx), velocity: v, target: null, kind: 'explore', frames: 600, why });
  }

  _fire(p) {
    this.lastFireAt = now();
    const lines = [];
    if (this.serverVel === null || Math.abs(this.serverVel - p.velocity) > 1e-9) lines.push(`v ${fmt(p.velocity, 4)}`);
    const dec = p.window ? Math.min(7, Math.max(2, Math.ceil(-Math.log10(p.window / 40)))) : 3;
    const angleStr = fmt(p.angle, dec);
    lines.push(angleStr);
    if (!this.conn.send(lines, 0, 'shot')) return;
    this.serverVel = p.velocity;
    this.pending = { ...p, angle: Number(angleStr), sentAt: now() };
    if (p.kind === 'aim') {
      this.stats.aimed++;
      this.log('shot', `→ Ziel ${this._pname(p.target)}: ${angleStr}° v=${p.velocity} (Fenster ${p.window.toFixed(3)}°, p=${(p.pHit * 100).toFixed(0)}%, ${(p.frames / 60).toFixed(1)} s)`);
    } else if (p.kind === 'explore') this.log('info', `Erkundungsschuss ${angleStr}° v=${p.velocity} (${p.why})`);
    else this.log('shot', `Manueller Schuss ${angleStr}° v=${p.velocity}`);
    this.plan = null;
  }

  _pname(id) {
    if (id === this.myId) return `ich (#${id})`;
    const l = this.labels.get(id);
    return l ? `${l} (#${id})` : `#${id}`;
  }

  // ---------------------------------------------------------------- Snapshot für das Panel
  snapshot() {
    const c = this.conn;
    return {
      t: now(),
      conn: {
        state: c.state, retryAt: this.connStatus.retryAt || null, budget: c.budget(), capacity: c.cfg.rateCapacity,
        refill: c.cfg.rateRefill, sent: c.bytesSent, recv: c.bytesRecv, resyncs: c.resyncs, queue: c.queue.length,
        host: c.cfg.host, port: c.cfg.port,
      },
      myId: this.myId,
      energy: this.energyNow(), energySource: this.energy.source,
      players: [...this.players.values()].map(p => ({ ...p, label: this.labels.get(p.id) || null, me: p.id === this.myId })),
      model: { source: this.model.source, n: this.model.planets.length, stats: this.model.stats, version: this.model.version, quality: this.modelQuality(), truthErr: this.model.truthErr || null },
      plan: this.plan ? { target: this.plan.target, angle: this.plan.angle, velocity: this.plan.velocity, window: this.plan.window, pHit: this.plan.pHit, frames: this.plan.frames, path: this.plan.path, waiting: !!this.plan.waiting } : null,
      pending: this.pending ? { angle: this.pending.angle, velocity: this.pending.velocity, target: this.pending.target, kind: this.pending.kind, path: this.pending.path } : null,
      inflight: this.inflight.map(s => ({ target: s.target, kind: s.kind, angle: s.angle, velocity: s.velocity, firedAt: s.firedAt, frames: s.frames, path: s.path })),
      stats: this.stats,
      lastAim: this.lastAim || null,
      solutions: [...this.players.keys()].filter(id => id !== this.myId).map(id => {
        const e = this._solEntry(id);
        const c = e && e.cands.length ? [...e.cands].sort((a, b) => this._score(b, this.energyNow()) - this._score(a, this.energyNow()))[0] : null;
        return { target: id, n: e ? e.cands.length : null, best: c && { angle: c.angle, velocity: c.velocity, window: c.window, frames: c.frames, pHit: c.pHit } };
      }),
      round: { start: this.round.start, resets: this.round.resets, board: this._inBoardPhase() },
      fitBusy: this.fitBusy, aimBusy: this.aimBusy,
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.tickTimer);
    this.conn.disconnect();
    clearInterval(this.conn.pumpTimer);
    this.mapW.terminate(); this.aimPool.forEach(w => w.terminate());
  }
}

function compareModel(truth, est) {
  let matched = 0; const errs = [];
  for (const t of truth) {
    let bd = Infinity; for (const e of est) bd = Math.min(bd, Math.hypot(e.x - t.x, e.y - t.y));
    if (bd < 15) { matched++; errs.push(bd); }
  }
  errs.sort((a, b) => a - b);
  return { matched, total: truth.length, spurious: est.length - matched, medErr: errs.length ? errs[errs.length >> 1] : null };
}

function norm(a) { a %= 360; if (a > 180) a -= 360; if (a <= -180) a += 360; return a; }
function fmt(x, dec) { return Number(x.toFixed(dec)).toString(); }
