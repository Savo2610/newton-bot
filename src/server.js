// Control-Panel-Server: statische Dateien + Server-Sent-Events + JSON-API. Keine Abhängigkeiten.
//
// Aufruf (normalerweise über src/supervisor.js bzw. die NewtonBot.app):
//   --connect            sofort mit dem Spielserver verbinden
//   --host=… --port=… --name=…
//   --http=8090          Port des Panels
//   --config=pfad.json   Ort der gespeicherten Einstellungen (App: ~/Library/Application Support/NewtonBot)
// Das Panel lauscht nur auf 127.0.0.1 (nur dieser Mac).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Bot, DEFAULT_CONFIG } from './bot.js';
import { NetCheck } from './netcheck.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const CFG_FILE = args.config ? path.resolve(args.config) : path.join(ROOT, 'config.local.json');
const HTTP_PORT = Number(args.http || process.env.PORT || 8090);
const SUPERVISED = !!process.env.NWBOT_SUPERVISED;
const EXIT_RESTART = 75, EXIT_QUIT = 76;

// ---------------------------------------------------------------- Konfiguration
let saved = {};
try { saved = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { /* erste Ausführung */ }
const initial = { ...saved };
if (args.host) initial.host = args.host;
if (args.port) initial.port = Number(args.port);
if (args.name) initial.name = args.name;
if (args.connect) initial.autoConnect = true;

const bot = new Bot(initial);
const persist = () => {
  const out = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (k === 'autoConnect') continue; // wird per Startparameter gesteuert
    if (JSON.stringify(bot.cfg[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) out[k] = bot.cfg[k];
  }
  fs.mkdir(path.dirname(CFG_FILE), { recursive: true }, () => fs.writeFile(CFG_FILE, JSON.stringify(out, null, 2), () => {}));
};
bot.on('config', persist);

// ---------------------------------------------------------------- Netzwerk
const net = new NetCheck(() => bot.cfg, SUPERVISED ? process.ppid : process.pid);
net.on('log', e => bot.log(e.level, e.text));
net.on('status', s => broadcast('net', s));

// ---------------------------------------------------------------- SSE
const clients = new Set();
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function broadcast(event, data) { for (const c of clients) sse(c, event, data); }

bot.on('log', e => broadcast('log', e));
bot.on('traj', t => broadcast('traj', t));
bot.on('model', () => broadcast('model', modelPayload()));
bot.on('reset', () => broadcast('reset', {}));
bot.on('config', () => broadcast('config', bot.cfg));
setInterval(() => { if (clients.size) broadcast('state', bot.snapshot()); }, 120);

function modelPayload() {
  return { source: bot.model.source, planets: bot.model.planets, stats: bot.model.stats, version: bot.model.version, truth: bot.truth || null, truthErr: bot.model.truthErr || null };
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function quit(code) {
  setTimeout(() => { net.close(); bot.close(); process.exit(code); }, 400);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1500\n\n');
    sse(res, 'config', bot.cfg);
    sse(res, 'model', modelPayload());
    sse(res, 'init', { trajs: bot.trajs, logs: bot.logs.slice(-150), field: { W: 1885.618, H: 1060.66 }, supervised: SUPERVISED });
    sse(res, 'net', net.status);
    sse(res, 'state', bot.snapshot());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    const body = await readBody(req);
    const action = url.pathname.slice(5);
    let result = { ok: true };
    switch (action) {
      case 'connect': if (body.config) bot.setConfig(body.config); bot.connect(); break;
      case 'disconnect': bot.disconnect(); break;
      case 'reconnect': bot.reconnect(); break;
      case 'ping': break;
      case 'restart':
        bot.log('warn', '↻ Bot-Neustart angefordert');
        if (SUPERVISED) quit(EXIT_RESTART);
        else { bot.log('warn', 'Ohne Supervisor gestartet – verbinde nur neu'); bot.reconnect(); }
        break;
      case 'quit':
        bot.log('warn', '⏻ Bot wird beendet');
        quit(EXIT_QUIT);
        break;
      case 'network-setup':
        net.setup();
        break;
      case 'config': bot.setConfig(body); break;
      case 'fire': bot.manualFire(Number(body.angle), Number(body.velocity)); break;
      case 'label': bot.setLabel(Number(body.id), body.label); break;
      case 'reset-model': bot.resetModel(); break;
      case 'refit': bot.refitNow(!!body.rebuild); break;
      default: result = { ok: false, error: 'unbekannte Aktion' };
    }
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const fp = path.join(PUB, file);
  if (!fp.startsWith(PUB)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Nur lokal lauschen: das Panel ist ausschließlich an diesem Mac bedienbar
let server = null;
function listen() {
  server = http.createServer(handler);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`Port ${HTTP_PORT} ist belegt – läuft NewtonBot schon?`); process.exit(SUPERVISED ? EXIT_QUIT : 1); }
    throw e;
  });
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`\n  NewtonBot Control Panel:  http://127.0.0.1:${HTTP_PORT}\n  Spielserver: ${bot.cfg.host}:${bot.cfg.port}\n`);
  });
}
listen();

bot.on('log', e => console.log(`[${new Date(e.t).toLocaleTimeString()}] ${e.level.padEnd(5)} ${e.text}`));

// Netz hängt? Wenn der Host per ping erreichbar ist, unsere Sockets aber scheitern -> Neustart durch den Supervisor
bot.conn.on('netstuck', (n) => {
  execFile('ping', ['-c', '1', '-t', '2', bot.cfg.host], (err) => {
    if (err) { bot.log('warn', `${n} Netzwerkfehler in Folge, Spielserver per ping nicht erreichbar – warte auf Netz`); return; }
    if (SUPERVISED) {
      bot.log('warn', `${n} Netzwerkfehler, aber ping geht → Prozess startet neu`);
      quit(EXIT_RESTART);
    } else bot.log('warn', `${n} Netzwerkfehler, aber ping geht → bitte Bot neu starten`);
  });
});

const shutdown = () => { net.close(); bot.close(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
