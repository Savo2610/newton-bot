// Dummy-Spieler für lokale Tests: Text-Clients, die zufällig schießen.
import net from 'node:net';
const host = process.argv[2] || '127.0.0.1';
const n = Number(process.argv[3] || 4);
const every = Number(process.argv[4] || 4000);
for (let i = 0; i < n; i++) {
  const s = net.createConnection({ host, port: 3490 }, () => {
    s.write(`n Dummy${i}\nv ${6 + Math.random() * 8}\n`);
    setInterval(() => s.write(`${(Math.random() * 360).toFixed(2)}\n`), every + Math.random() * 1500);
  });
  s.on('data', () => {});
  s.on('error', e => console.log('dummy', i, e.message));
}
