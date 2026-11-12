// NewtonWars-Netzwerkschicht: Telnet-Handshake, Bot-Binärprotokoll, Rate-Limiter, Reconnect.
//
// Server-Fakten (network.c):
//  * Rate-Limit: Bucket 512 Byte, +1 Byte alle 3 Frames (~20 B/s bei 60 fps). Überschreitung => Disconnect.
//  * Pro IP nur EINE Verbindung. Jeder Verbindungsversuch sperrt die IP für 600 Frames (~10 s);
//    ein Versuch während der Sperre setzt die Sperre neu. => Reconnect frühestens nach >10 s.
//  * 5 min ohne Eingabe => Disconnect.
//  * "b <version>" schaltet auf Binärprotokoll (uint32 little endian).

import net from 'node:net';
import { EventEmitter } from 'node:events';

export const MSG = { OWNID: 1, PLAYERLEAVE: 2, PLAYERPOS: 3, SHOTFINISHED: 4, SHOTBEGIN: 5, SHOTFIN: 6, GAMEMODE: 7, OWN_ENERGY: 8, PLANETPOS: 9 };

const okCoord = (v) => Number.isFinite(v) && v > -20000 && v < 20000;

export class NWConnection extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = {
      host: '192.168.8.8', port: 3490, name: 'NewtonBot', botVersion: 9,
      rateCapacity: 512, rateRefill: 16, rateReserve: 40, reconnectDelay: 12,
      autoReconnect: true,
      ...cfg,
    };
    this.state = 'idle';
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.mode = 'text';
    this.tokens = this.cfg.rateCapacity;
    this.lastRefill = Date.now();
    this.queue = [];
    this.bytesSent = 0;
    this.bytesRecv = 0;
    this.resyncs = 0;
    this.nextAttempt = 0;
    this.lastSendAt = 0;
    this.connectedAt = 0;
    this.refusals = 0;
    this.pumpTimer = setInterval(() => this._pump(), 40);
    this.reconnTimer = null;
    this.wantOnline = false;
  }

  log(level, text) { this.emit('log', { level, text }); }

  setConfig(c) {
    Object.assign(this.cfg, c);
    if (c.rateCapacity) this.tokens = Math.min(this.tokens, c.rateCapacity);
  }

  _setState(s, extra = {}) {
    this.state = s;
    this.emit('status', { state: s, ...extra });
  }

  connect() {
    this.wantOnline = true;
    if (this.sock) return;
    const wait = this.nextAttempt - Date.now();
    if (wait > 0) {
      this._scheduleReconnect(wait);
      return;
    }
    const { host, port } = this.cfg;
    this.log('info', `Verbinde zu ${host}:${port} …`);
    this._setState('connecting');
    this.buf = Buffer.alloc(0);
    this.mode = 'text';
    this.queue = [];
    this.tokens = this.cfg.rateCapacity;
    this.lastRefill = Date.now();
    this.gotWelcome = false;
    const sock = net.createConnection({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setTimeout(8000);
    // jeder Versuch sperrt die IP serverseitig ~10 s
    this.nextAttempt = Date.now() + this.cfg.reconnectDelay * 1000;
    sock.on('connect', () => {
      this.connectedAt = Date.now();
      this.lastRecvAt = Date.now();
      this.netErrors = 0;
      sock.setKeepAlive(true, 3000);
      this._setState('handshake');
      sock.setTimeout(0);
      this.welcomeTimer = setTimeout(() => {
        if (this.mode === 'text' && this.sock === sock) {
          this.log('warn', 'Kein Willkommens-Prompt erhalten, schalte trotzdem in den Bot-Modus');
          this._enterBotMode();
        }
      }, 2500);
    });
    sock.on('timeout', () => { this.log('warn', 'Timeout beim Verbinden'); this._netError(); sock.destroy(); });
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => {
      this.log('error', `Socket-Fehler: ${e.code || e.message}`);
      if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ETIMEDOUT'].includes(e.code)) this._netError();
    });
    sock.on('close', () => this._onClose(sock));
  }

  // Netzwerkfehler zählen; viele in Folge -> 'netstuck' (Prozess hängt evtl. an alter Route, macOS)
  _netError() {
    this.netErrors = (this.netErrors || 0) + 1;
    if (this.netErrors >= 6 && this.netErrors % 3 === 0) this.emit('netstuck', this.netErrors);
  }

  // Verbindung hart abbrechen (z.B. Netz weg, Socket hängt) -> normaler Reconnect-Pfad
  kill(reason) {
    if (!this.sock) return;
    this.log('warn', reason);
    this.sock.destroy();
  }

  disconnect() {
    this.wantOnline = false;
    clearTimeout(this.reconnTimer);
    if (this.sock) {
      try { this.sock.write('q\n'); } catch { /* egal */ }
      this.sock.end();
      setTimeout(() => this.sock && this.sock.destroy(), 300);
    }
    this._setState('idle');
  }

  _onClose(sock) {
    if (this.sock !== sock) return;
    this.sock = null;
    clearTimeout(this.welcomeTimer);
    const lived = Date.now() - this.connectedAt;
    const sinceSend = Date.now() - this.lastSendAt;
    if (!this.gotWelcome) {
      this.refusals++;
      this.log('warn', `Verbindung abgelehnt/geschlossen vor Willkommen (IP evtl. gesperrt oder schon verbunden – nur 1 Verbindung pro IP!)`);
    } else {
      this.refusals = 0;
      if (this.wantOnline && sinceSend < 3000 && this.tokens < 160) {
        const old = this.cfg.rateRefill;
        this.cfg.rateRefill = Math.max(3, old * 0.7);
        this.log('warn', `Disconnect kurz nach Senden bei niedrigem Budget → vermutlich Rate-Limit. Refill ${old.toFixed(1)} → ${this.cfg.rateRefill.toFixed(1)} B/s`);
        this.emit('ratelimitHit');
      } else if (this.wantOnline) this.log('warn', `Verbindung vom Server getrennt (nach ${(lived / 1000).toFixed(1)} s)`);
      else this.log('info', `Verbindung manuell beendet („Trennen“ im Panel, nach ${(lived / 1000).toFixed(1)} s)`);
    }
    this.emit('disconnected');
    if (this.wantOnline && this.cfg.autoReconnect) {
      this._scheduleReconnect(Math.max(0, this.nextAttempt - Date.now()));
    } else this._setState('idle');
  }

  _scheduleReconnect(ms) {
    clearTimeout(this.reconnTimer);
    this._setState('waiting', { retryAt: Date.now() + ms });
    this.log('info', `Neuer Versuch in ${(ms / 1000).toFixed(1)} s (Server-Sperre pro IP)`);
    this.reconnTimer = setTimeout(() => { if (this.wantOnline) this.connect(); }, ms + 50);
  }

  _enterBotMode() {
    if (this.mode !== 'text') return;
    this.mode = 'sync';
    this.buf = Buffer.alloc(0);
    // direkt schreiben (Handshake), zählt aber gegen den Bucket
    this._rawWrite(`b ${this.cfg.botVersion}\nn ${this.cfg.name}\n`);
  }

  _onData(d) {
    this.bytesRecv += d.length;
    this.lastRecvAt = Date.now();
    if (this.mode === 'text') {
      const s = d.toString('latin1');
      this.textBuf = (this.textBuf || '') + s;
      if (this.textBuf.includes('> ') || this.textBuf.includes('interpreted as a shooting angle')) {
        this.gotWelcome = true;
        clearTimeout(this.welcomeTimer);
        this.textBuf = '';
        this.log('ok', 'Willkommen erhalten, aktiviere Bot-Protokoll');
        this._enterBotMode();
      }
      return;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this._parse();
  }

  _parse() {
    let b = this.buf;
    let off = 0;
    if (this.mode === 'sync') {
      // Text-Reste verwerfen bis zur ersten Binärnachricht (OWNID oder GAMEMODE)
      let found = -1;
      for (let i = 0; i + 8 <= b.length; i++) {
        const t = b.readUInt32LE(i), p = b.readUInt32LE(i + 4);
        if ((t === MSG.OWNID || t === MSG.GAMEMODE) && p < 64) { found = i; break; }
      }
      if (found < 0) { this.buf = b.subarray(Math.max(0, b.length - 7)); return; }
      off = found;
      this.mode = 'bin';
      this.gotWelcome = true;
      this._setState('online');
    }
    while (b.length - off >= 8) {
      const type = b.readUInt32LE(off), p = b.readUInt32LE(off + 4);
      let need = 0, msg = null, bad = false;
      switch (type) {
        case MSG.OWNID: case MSG.PLAYERLEAVE:
          need = 8; if (p >= 64) bad = true; else msg = { type, id: p }; break;
        case MSG.PLAYERPOS:
          need = 16; if (b.length - off < need) break;
          if (p >= 64) { bad = true; break; }
          msg = { type, id: p, x: b.readFloatLE(off + 8), y: b.readFloatLE(off + 12) };
          if (!okCoord(msg.x) || !okCoord(msg.y)) bad = true; break;
        case MSG.SHOTBEGIN:
          need = 24; if (b.length - off < need) break;
          if (p >= 64) { bad = true; break; }
          msg = { type, id: p, angle: b.readDoubleLE(off + 8), vel: b.readDoubleLE(off + 16) };
          if (!(Math.abs(msg.angle) < 1e4) || !(msg.vel >= 0 && msg.vel <= 1000)) bad = true; break;
        case MSG.SHOTFINISHED: {
          if (b.length - off < 12) { need = 12; break; }
          const n = b.readUInt32LE(off + 8);
          if (p >= 64 || n > 2100) { bad = true; break; }
          need = 12 + n * 8; if (b.length - off < need) break;
          const dots = new Float32Array(n * 2);
          for (let i = 0; i < n * 2; i++) dots[i] = b.readFloatLE(off + 12 + i * 4);
          msg = { type, id: p, angle: NaN, vel: NaN, dots };
          if (n && (!okCoord(dots[0]) || !okCoord(dots[1]))) bad = true;
          break;
        }
        case MSG.SHOTFIN: {
          if (b.length - off < 28) { need = 28; break; }
          const n = b.readUInt32LE(off + 24);
          const angle = b.readDoubleLE(off + 8), vel = b.readDoubleLE(off + 16);
          if (p >= 64 || n > 2100 || !(Math.abs(angle) < 1e4) || !(vel >= 0 && vel <= 1000)) { bad = true; break; }
          need = 28 + n * 8; if (b.length - off < need) break;
          const dots = new Float32Array(n * 2);
          for (let i = 0; i < n * 2; i++) dots[i] = b.readFloatLE(off + 28 + i * 4);
          msg = { type, id: p, angle, vel, dots };
          if (n && (!okCoord(dots[0]) || !okCoord(dots[1]) || !okCoord(dots[2 * n - 2]))) bad = true;
          break;
        }
        case MSG.GAMEMODE:
          need = 12; if (b.length - off < need) break;
          msg = { type, id: p, mode: b.readUInt32LE(off + 8) }; if (p >= 64) bad = true; break;
        case MSG.OWN_ENERGY:
          need = 16; if (b.length - off < need) break;
          msg = { type, id: p, energy: b.readDoubleLE(off + 8) };
          if (p >= 64 || !Number.isFinite(msg.energy)) bad = true; break;
        case MSG.PLANETPOS: {
          if (b.length - off < 12) { need = 12; break; }
          const n = p, size = b.readUInt32LE(off + 8);
          if (n > 64 || size !== 32) { bad = true; break; }
          need = 12 + n * size; if (b.length - off < need) break;
          const planets = [];
          for (let i = 0; i < n; i++) {
            const o = off + 12 + i * size;
            planets.push({ x: b.readDoubleLE(o), y: b.readDoubleLE(o + 8), r: b.readDoubleLE(o + 16), m: b.readDoubleLE(o + 24) });
          }
          msg = { type, planets };
          if (planets.some(q => !okCoord(q.x) || !(q.r > 0 && q.r < 500))) bad = true;
          break;
        }
        default: bad = true;
      }
      if (bad) {
        // Stream aus dem Tritt (z.B. partielles send() mit MSG_DONTWAIT) -> byteweise resynchronisieren
        this.resyncs++;
        if (this.resyncs % 50 === 1) this.log('warn', `Binärstrom-Resync (#${this.resyncs}) bei Typ ${type}`);
        off += 1;
        continue;
      }
      if (!msg) break; // unvollständig
      off += need;
      this.emit('msg', msg);
    }
    this.buf = off ? b.subarray(off) : b;
  }

  // ---------------------------------------------------------------- Senden mit Rate-Limit
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.cfg.rateCapacity, this.tokens + (now - this.lastRefill) / 1000 * this.cfg.rateRefill);
    this.lastRefill = now;
  }

  budget() { this._refill(); return this.tokens; }

  _rawWrite(str) {
    if (!this.sock) return false;
    this._refill();
    this.tokens -= str.length;
    this.bytesSent += str.length;
    this.lastSendAt = Date.now();
    this.sock.write(str);
    this.emit('sent', str);
    return true;
  }

  // prio: 0 = Schuss (hoch), 1 = normal, 2 = niedrig (Energie-Abfrage)
  send(lines, prio = 1, tag = null) {
    if (this.state !== 'online') return false;
    const data = (Array.isArray(lines) ? lines : [lines]).map(l => l + '\n').join('');
    if (tag) this.queue = this.queue.filter(q => q.tag !== tag);
    this.queue.push({ data, prio, tag, at: Date.now() });
    this.queue.sort((a, b) => a.prio - b.prio || a.at - b.at);
    this._pump();
    return true;
  }

  canSend(bytes, prio = 1) {
    const reserve = prio === 0 ? this.cfg.rateReserve * 0.5 : prio === 1 ? this.cfg.rateReserve : this.cfg.rateCapacity * 0.55;
    return this.budget() - bytes >= reserve;
  }

  _pump() {
    if (!this.sock || this.state !== 'online' || !this.queue.length) return;
    while (this.queue.length) {
      const q = this.queue[0];
      if (!this.canSend(q.data.length, q.prio)) break;
      this.queue.shift();
      this._rawWrite(q.data);
    }
  }
}
