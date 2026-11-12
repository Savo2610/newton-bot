// Netzwerk-Check und automatische Einrichtung (macOS).
//
// Hintergrund: Das Event-WLAN vergibt evtl. keine DHCP-Adresse. Dann bekommt der Mac nur 169.254.x.x und
// der Spielserver ist unerreichbar. Abhilfe: feste IP im Spielnetz ohne Router (Internet bleibt auf anderem
// Interface). macOS verwirft so eine IP bei WLAN-Re-Assoziation, daher hält ein Root-Wächter sie fest –
// genau so lange, wie der Bot läuft. Danach stellt er DHCP wieder her.
//
// Wichtig: Der Spielserver wird nur per ping geprüft, nie per TCP auf Port 3490 (jeder Versuch sperrt die IP ~10 s).

import { execFile } from 'node:child_process';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err }));
});

export class NetCheck extends EventEmitter {
  constructor(getCfg, watchPid) {
    super();
    this.getCfg = getCfg;
    this.watchPid = watchPid;           // solange dieser Prozess lebt, hält der Wächter die IP
    this.mac = process.platform === 'darwin';
    this.status = { checked: false };
    this.wifiDev = null;
    this.setupState = 'idle';           // idle | asking | active | failed | cancelled
    this.badSince = 0;
    this.autoTried = false;
    this.timer = setInterval(() => this.check(), 4000);
    this.check();
  }

  log(level, text) { this.emit('log', { level, text }); }

  async _wifiDevice() {
    if (this.wifiDev || !this.mac) return this.wifiDev;
    const r = await run('networksetup', ['-listallhardwareports']);
    const m = r.stdout.match(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/);
    this.wifiDev = m ? m[1] : 'en0';
    return this.wifiDev;
  }

  subnetOf(host) {
    const p = String(host).split('.');
    return p.length === 4 ? p.slice(0, 3).join('.') + '.' : null;
  }

  async check() {
    const cfg = this.getCfg();
    const host = cfg.host;
    const subnet = this.subnetOf(host);
    const dev = await this._wifiDevice();
    const ifs = os.networkInterfaces();
    const wifiIp = dev && (ifs[dev] || []).find(i => i.family === 'IPv4')?.address || null;
    let gameIp = null, gameIf = null;
    for (const [name, list] of Object.entries(ifs)) for (const i of list || []) {
      if (i.family === 'IPv4' && subnet && i.address.startsWith(subnet)) { gameIp = i.address; gameIf = name; }
    }
    const ping = await run('ping', this.mac ? ['-c', '1', '-t', '2', host] : ['-c', '1', '-W', '2', host], 5000);
    const reachable = ping.ok;
    const linkLocal = !!wifiIp && wifiIp.startsWith('169.254.');
    const prev = this.status;
    this.status = {
      checked: true, at: Date.now(), host, wifiDev: dev, wifiIp, gameIp, gameIf, reachable, linkLocal,
      staticIp: cfg.staticIp, setup: this.setupState, mac: this.mac,
    };
    if (prev.reachable !== reachable && prev.checked) this.log(reachable ? 'ok' : 'warn', reachable ? `Spielserver ${host} erreichbar (${gameIp || wifiIp})` : `Spielserver ${host} nicht erreichbar`);
    // Automatische Einrichtung: WLAN verbunden, aber keine DHCP-Adresse und Server nicht erreichbar
    if (!reachable && linkLocal && !gameIp) {
      this.badSince = this.badSince || Date.now();
      if (cfg.autoNetwork && !this.autoTried && Date.now() - this.badSince > 6000 && this.setupState === 'idle') {
        this.autoTried = true;
        this.log('warn', 'WLAN ohne Adresse (169.254.x.x) – richte feste IP ein (macOS fragt nach deinem Passwort)');
        this.setup();
      }
    } else this.badSince = 0;
    this.emit('status', this.status);
  }

  // Feste IP setzen + Root-Wächter starten (Passwort-Dialog von macOS)
  async setup() {
    if (!this.mac) { this.log('error', 'Automatische Netzwerk-Einrichtung gibt es nur auf macOS'); return false; }
    const cfg = this.getCfg();
    const dev = await this._wifiDevice();
    const ip = cfg.staticIp;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^en\d+$/.test(dev)) { this.log('error', `Ungültige IP/Interface (${ip}, ${dev})`); return false; }
    const pid = Number(this.watchPid) | 0;
    const loop = `while kill -0 ${pid} 2>/dev/null; do ifconfig ${dev} | grep -q 'inet ${ip} ' || ipconfig set ${dev} MANUAL ${ip} 255.255.255.0; sleep 2; done; ipconfig set ${dev} DHCP`;
    const script = `ipconfig set ${dev} MANUAL ${ip} 255.255.255.0; nohup sh -c "${loop}" >/dev/null 2>&1 &`;
    const as = `do shell script "${script.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges with prompt "NewtonBot möchte dem WLAN die feste Adresse ${ip} geben, damit der Spielserver erreichbar ist. Wird beim Beenden des Bots zurückgesetzt."`;
    this.setupState = 'asking';
    this.emit('status', { ...this.status, setup: this.setupState });
    const r = await run('osascript', ['-e', as], 120000);
    if (r.ok) {
      this.setupState = 'active';
      this.log('ok', `Feste IP ${ip} auf ${dev} gesetzt, Wächter aktiv (bis der Bot beendet wird)`);
    } else if (/User canceled|-128/.test(r.stderr)) {
      this.setupState = 'cancelled';
      this.log('warn', 'Netzwerk-Einrichtung abgebrochen');
    } else {
      this.setupState = 'failed';
      this.log('error', `Netzwerk-Einrichtung fehlgeschlagen: ${r.stderr.trim() || r.err?.message}`);
    }
    setTimeout(() => this.check(), 1500);
    return r.ok;
  }

  close() { clearInterval(this.timer); }
}
