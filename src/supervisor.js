// Startet den Bot-Server und startet ihn neu, wenn er mit Code 75 (Neustart/Netz hängt) oder unerwartet endet.
// Code 76 = "Beenden" aus dem Panel -> Supervisor endet auch.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./server.js', import.meta.url));
let child = null, stopping = false, restarts = 0;
const crashes = [];

function start(extraArgs = []) {
  child = spawn(process.execPath, [entry, ...process.argv.slice(2), ...extraArgs], { stdio: 'inherit', env: { ...process.env, NWBOT_SUPERVISED: '1' } });
  child.on('exit', (code, sig) => {
    if (stopping || code === 76) { console.log('[supervisor] Bot beendet.'); return process.exit(0); }
    restarts++;
    crashes.push(Date.now());
    while (crashes.length && Date.now() - crashes[0] > 60000) crashes.shift();
    if (code !== 75 && crashes.length >= 6) { console.log('[supervisor] Bot stürzt wiederholt ab – gebe auf. Log prüfen.'); return process.exit(1); }
    const delay = code === 75 ? 1000 : Math.min(15000, 2000 * restarts);
    console.log(`[supervisor] Bot beendet (code ${code ?? sig}), Neustart #${restarts} in ${delay / 1000} s`);
    // nach einem Neustart sofort wieder verbinden
    const args = process.argv.includes('--connect') ? [] : ['--connect'];
    setTimeout(() => start(args), delay);
  });
}

// macOS: Ruhezustand verhindern, solange der Bot läuft
if (process.platform === 'darwin' && !process.argv.includes('--allow-sleep')) {
  try {
    const caf = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' });
    caf.on('error', () => {});
    console.log('[supervisor] Mac bleibt wach, solange der Bot läuft');
  } catch { /* egal */ }
}

for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; child?.kill(s); setTimeout(() => process.exit(0), 1500); });
start();
