// Rechen-Worker: Planeten-Mapping und Aim-Solver laufen außerhalb des Netzwerk-Threads.
import { parentPort } from 'node:worker_threads';
import { Mapper, perturbedModels } from './mapper.js';
import { solveAim } from './aim.js';

let mapper = new Mapper();

parentPort.on('message', (msg) => {
  try {
    switch (msg.type) {
      case 'reset':
        mapper = new Mapper(msg.opts || {});
        parentPort.postMessage({ type: 'reset', id: msg.id });
        break;
      case 'add':
        for (const t of msg.trajs) mapper.addTrajectory({ ...t, dots: Float32Array.from(t.dots) });
        break;
      case 'fit': {
        const r = mapper.fit({ rebuild: !!msg.rebuild });
        const ensemble = r.planets.length ? perturbedModels(r.planets, r.cov || [], 6, mapper.fitCount) : [];
        parentPort.postMessage({ type: 'fit', id: msg.id, planets: r.planets, cov: r.cov, stats: r.stats, ensemble });
        break;
      }
      case 'aim': {
        const r = solveAim(msg.req);
        parentPort.postMessage({ type: 'aim', id: msg.id, ...r });
        break;
      }
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', id: msg.id, error: String(e && e.stack || e) });
  }
});
