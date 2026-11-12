// NewtonBot Control Panel
(() => {
  const $ = (id) => document.getElementById(id);
  const W = 1885.618, H = 1060.66, PAD = 36;
  let S = null;           // letzter State-Snapshot
  let cfg = {};
  let model = { planets: [], source: 'none' };
  let trajs = [];
  let logs = [];
  let logFilter = 'all';
  let fieldImg = null, fieldVersion = -1;
  let hoverPlayer = null;
  let supervised = false;
  let netS = null;
  let quitting = false;
  const kills = [];       // Treffer-Animationen

  // ------------------------------------------------------------ API
  const api = (action, body = {}) => fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => ({}));
  const setCfg = (patch) => { Object.assign(cfg, patch); renderCfg(); return api('config', patch); };

  // ------------------------------------------------------------ SSE
  function connectSSE() {
    const es = new EventSource('/events');
    es.addEventListener('state', e => { S = JSON.parse(e.data); renderState(); });
    es.addEventListener('config', e => { cfg = JSON.parse(e.data); renderCfg(); });
    es.addEventListener('model', e => { model = JSON.parse(e.data); renderModel(); });
    es.addEventListener('traj', e => { const t = JSON.parse(e.data); trajs.push(t); if (trajs.length > 80) trajs.shift(); if (t.end === 'player') kills.push({ x: t.dots[t.dots.length - 2], y: t.dots[t.dots.length - 1], at: performance.now(), own: t.own }); });
    es.addEventListener('init', e => {
      const d = JSON.parse(e.data); trajs = d.trajs; logs = d.logs; renderLog(true);
      supervised = d.supervised;
    });
    es.addEventListener('log', e => { logs.push(JSON.parse(e.data)); if (logs.length > 400) logs.shift(); renderLog(); });
    es.addEventListener('reset', () => { trajs = []; });
    es.addEventListener('net', e => { netS = JSON.parse(e.data); renderNet(); });
    es.onerror = () => { if (quitting) { es.close(); return; } $('pillConn').className = 'pill'; $('pillConn').querySelector('b').textContent = 'Panel getrennt'; };
  }

  // ------------------------------------------------------------ Farben
  const hue = (id) => (id * 137.508 + 340) % 360;
  const pColor = (id, a = 1) => S && id === S.myId ? `rgba(77,226,255,${a})` : `hsla(${hue(id)},85%,62%,${a})`;
  const pname = (id) => { const p = S?.players.find(q => q.id === id); return p?.label ? `${p.label}` : `#${id}`; };

  // ------------------------------------------------------------ Canvas
  const cv = $('field'), ctx = cv.getContext('2d');
  let scale = 1, ox = 0, oy = 0, dpr = 1;
  function resize() {
    const r = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    scale = Math.min(cv.width / (W + 2 * PAD), cv.height / (H + 2 * PAD));
    ox = (cv.width - W * scale) / 2; oy = (cv.height - H * scale) / 2;
  }
  new ResizeObserver(resize).observe(cv);
  const X = (x) => ox + x * scale, Y = (y) => oy + y * scale;
  const toField = (cx, cy) => [((cx * dpr) - ox) / scale, ((cy * dpr) - oy) / scale];

  function buildFieldImage() {
    const gw = 240, gh = 135;
    const off = document.createElement('canvas'); off.width = gw; off.height = gh;
    const c = off.getContext('2d'); const img = c.createImageData(gw, gh);
    const P = model.planets;
    let vals = new Float32Array(gw * gh), max = 0;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = (i + .5) / gw * W, y = (j + .5) / gh * H;
      let a = 0;
      for (const p of P) { const d = Math.max(Math.hypot(p.x - x, p.y - y), p.r); a += p.m / (d * d); }
      vals[j * gw + i] = Math.log(1 + a * 40); if (vals[j * gw + i] > max) max = vals[j * gw + i];
    }
    for (let k = 0; k < vals.length; k++) {
      const v = max ? vals[k] / max : 0;
      img.data[4 * k] = 40 + 120 * v; img.data[4 * k + 1] = 30 + 60 * v; img.data[4 * k + 2] = 90 + 160 * v; img.data[4 * k + 3] = 200 * v * v;
    }
    c.putImageData(img, 0, 0);
    fieldImg = off; fieldVersion = model.version;
  }

  function path(dots, every = 1) {
    ctx.beginPath();
    for (let i = 0; i < dots.length; i += 2 * every) { const x = X(dots[i]), y = Y(dots[i + 1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.lineTo(X(dots[dots.length - 2]), Y(dots[dots.length - 1]));
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!cv.width) return;
    const now = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // Hintergrund + Spielfeld
    const g = ctx.createRadialGradient(cv.width * .5, cv.height * .45, 10, cv.width * .5, cv.height * .5, cv.width * .7);
    g.addColorStop(0, '#0a1020'); g.addColorStop(1, '#03050a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = 'rgba(77,226,255,.05)'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 100) { ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(H)); ctx.stroke(); }
    for (let y = 0; y <= H; y += 100) { ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(W), Y(y)); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(77,226,255,.18)'; ctx.strokeRect(X(0), Y(0), W * scale, H * scale);

    if ($('optField').checked && model.planets.length) {
      if (fieldVersion !== model.version) buildFieldImage();
      ctx.imageSmoothingEnabled = true; ctx.globalAlpha = .9;
      ctx.drawImage(fieldImg, X(0), Y(0), W * scale, H * scale); ctx.globalAlpha = 1;
    }

    // Planeten
    const est = model.source !== 'server';
    for (const p of model.planets) {
      const r = Math.max(p.r * scale, 2);
      const gr = ctx.createRadialGradient(X(p.x) - r * .35, Y(p.y) - r * .35, r * .1, X(p.x), Y(p.y), r);
      gr.addColorStop(0, est ? '#93a9dd' : '#b8c8ee'); gr.addColorStop(.7, est ? '#33456f' : '#3d5288'); gr.addColorStop(1, est ? '#1a2440' : '#202c4c');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = est ? 'rgba(169,139,255,.45)' : 'rgba(150,180,255,.5)'; ctx.lineWidth = 1 * dpr;
      if (est) ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r + 2 * dpr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }

    if (model.truth) {
      ctx.strokeStyle = 'rgba(77,255,154,.55)'; ctx.lineWidth = 1 * dpr;
      for (const p of model.truth) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), p.r * scale, 0, Math.PI * 2); ctx.stroke(); }
    }

    // Bahnen
    if ($('optTrails').checked) {
      const showDebris = $('optDebris').checked;
      const n = trajs.length;
      trajs.forEach((t, i) => {
        if (t.debris && !showDebris) return;
        const age = (n - i) / n;
        const a = Math.max(.08, (1 - age) * (t.own ? .9 : .55));
        ctx.strokeStyle = t.own ? `rgba(77,226,255,${a})` : pColor(t.owner, a * .8);
        ctx.lineWidth = (t.own ? 1.6 : 1) * dpr;
        path(t.dots); ctx.stroke();
        const ex = X(t.dots[t.dots.length - 2]), ey = Y(t.dots[t.dots.length - 1]);
        ctx.fillStyle = t.end === 'player' ? `rgba(255,84,112,${a + .2})` : `rgba(255,255,255,${a * .6})`;
        ctx.beginPath(); ctx.arc(ex, ey, (t.end === 'player' ? 3 : 1.5) * dpr, 0, Math.PI * 2); ctx.fill();
      });
    }

    if (S) {
      // fliegende eigene Schüsse (Vorhersage) + Plan
      for (const s of S.inflight) if (s.path) {
        const prog = Math.min(1, (Date.now() - s.firedAt) / (s.frames / 60 * 1000));
        ctx.strokeStyle = 'rgba(255,181,71,.25)'; ctx.lineWidth = 1 * dpr; path(s.path); ctx.stroke();
        const k = Math.min(s.path.length / 2 - 1, Math.floor(prog * (s.path.length / 2 - 1)));
        ctx.fillStyle = '#ffd59a'; ctx.shadowColor = '#ffb547'; ctx.shadowBlur = 12 * dpr;
        ctx.beginPath(); ctx.arc(X(s.path[2 * k]), Y(s.path[2 * k + 1]), 2.5 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
      const plan = S.plan || (S.pending && S.pending.path ? S.pending : null);
      if (plan && plan.path) {
        ctx.strokeStyle = 'rgba(255,181,71,.9)'; ctx.lineWidth = 1.6 * dpr; ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.lineDashOffset = -now / 40; path(plan.path); ctx.stroke(); ctx.setLineDash([]);
      }
      // Spieler
      const leader = [...S.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)[0];
      for (const p of S.players) {
        const x = X(p.x), y = Y(p.y), me = p.me;
        const r = Math.max(4 * scale, 4 * dpr);
        if (me) {
          const pulse = 1 + .25 * Math.sin(now / 300);
          ctx.strokeStyle = 'rgba(77,226,255,.35)'; ctx.lineWidth = 1 * dpr;
          ctx.beginPath(); ctx.arc(x, y, r * 4 * pulse, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = pColor(p.id); ctx.shadowColor = pColor(p.id); ctx.shadowBlur = 14 * dpr;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        const isTarget = (S.plan && S.plan.target === p.id) || (cfg.targetMode === 'fixed' && cfg.targetId === p.id);
        if (isTarget) {
          ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 1.5 * dpr; const R = r * 3.2, rot = now / 900;
          ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
          for (let k = 0; k < 4; k++) { const a = rot + k * Math.PI / 2; ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * R * .6, y + Math.sin(a) * R * .6); ctx.lineTo(x + Math.cos(a) * R * 1.4, y + Math.sin(a) * R * 1.4); ctx.stroke(); }
        }
        if (hoverPlayer === p.id) { ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, Math.PI * 2); ctx.stroke(); }
        ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`; ctx.fillStyle = me ? '#bff3ff' : 'rgba(220,228,245,.85)';
        const crown = leader && leader.id === p.id && p.kills > 0 ? '★ ' : '';
        ctx.fillText(`${crown}${me ? 'BOT' : (p.label || '#' + p.id)} ${p.kills}/${p.deaths}`, x + r + 5 * dpr, y - r - 3 * dpr);
      }
    }
    // Treffer-Explosionen
    for (let i = kills.length - 1; i >= 0; i--) {
      const k = kills[i], t = (now - k.at) / 900;
      if (t > 1) { kills.splice(i, 1); continue; }
      ctx.strokeStyle = k.own ? `rgba(77,255,154,${1 - t})` : `rgba(255,84,112,${1 - t})`;
      ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(X(k.x), Y(k.y), (6 + 40 * t) * dpr, 0, Math.PI * 2); ctx.stroke();
    }
  }
  requestAnimationFrame(draw);

  cv.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    const [fx, fy] = toField(e.clientX - r.left, e.clientY - r.top);
    hoverPlayer = null;
    if (S) for (const p of S.players) if (Math.hypot(p.x - fx, p.y - fy) * scale / dpr < 14) hoverPlayer = p.id;
    let txt = `x ${fx.toFixed(0)}  y ${fy.toFixed(0)}`;
    const me = S?.players.find(p => p.me);
    if (me) txt += `  ∠ ${(Math.atan2(-(fy - me.y), fx - me.x) * 180 / Math.PI).toFixed(2)}°`;
    if (hoverPlayer !== null) txt += `  · ${pname(hoverPlayer)}`;
    $('hover').textContent = txt;
  });
  cv.addEventListener('click', (e) => {
    const r = cv.getBoundingClientRect();
    const [fx, fy] = toField(e.clientX - r.left, e.clientY - r.top);
    const me = S?.players.find(p => p.me);
    if (e.shiftKey && me) { $('mAngle').value = (Math.atan2(-(fy - me.y), fx - me.x) * 180 / Math.PI).toFixed(3); return; }
    if (hoverPlayer !== null && hoverPlayer !== S?.myId) {
      if (cfg.targetMode === 'fixed' && cfg.targetId === hoverPlayer) setCfg({ targetMode: 'auto', targetId: null });
      else setCfg({ targetMode: 'fixed', targetId: hoverPlayer });
    }
  });

  // ------------------------------------------------------------ Rendering Panels
  function renderState() {
    const c = S.conn;
    renderControls();
    const pc = $('pillConn');
    const labels = { idle: 'offline', connecting: 'verbinde…', handshake: 'Handshake…', online: 'online', waiting: 'warte (IP-Sperre)' };
    pc.className = `pill ${c.state}`;
    let t = labels[c.state] || c.state;
    if (c.state === 'waiting' && c.retryAt) t += ` ${Math.max(0, (c.retryAt - Date.now()) / 1000).toFixed(0)}s`;
    pc.querySelector('b').textContent = t;
    $('pillId').textContent = S.myId === null ? 'ID –' : `ID ${S.myId}`;
    const q = S.model.quality;
    const pm = $('pillModel');
    pm.textContent = S.model.source === 'server' ? 'Planeten: Server (exakt)' : S.model.source === 'estimated' ? `Planeten: ${S.model.n} geschätzt · ${(q * 100).toFixed(0)}%` : 'Planeten: unbekannt';
    pm.className = `pill ${S.model.source === 'server' || q > .7 ? 'good' : S.model.n ? 'warn' : 'neutral'}`;
    const pr = $('pillRound');
    if (S.round.start) { const el = (Date.now() - S.round.start) / 1000; pr.textContent = S.round.board ? 'Rundenpause' : `Runde ${Math.floor(el / 60)}:${String(Math.floor(el % 60)).padStart(2, '0')}`; }
    else pr.textContent = 'Runde ?';
    $('kKills').textContent = S.stats.kills; $('kDeaths').textContent = S.stats.deaths; $('kShots').textContent = S.stats.shots;
    $('kAcc').textContent = S.stats.aimed ? `${Math.round(100 * S.stats.aimHits / S.stats.aimed)}%` : '–';
    $('energyBar').style.width = `${Math.min(100, S.energy / 2)}%`; $('energyVal').textContent = S.energy.toFixed(1);
    $('budgetBar').style.width = `${Math.max(0, 100 * c.budget / c.capacity)}%`; $('budgetVal').textContent = Math.max(0, c.budget).toFixed(0);
    $('connInfo').textContent = `${c.host}:${c.port} · ↑${c.sent} B ↓${fmtBytes(c.recv)} · Refill ${c.refill.toFixed(1)} B/s${c.resyncs ? ' · Resyncs ' + c.resyncs : ''}${c.queue ? ' · Queue ' + c.queue : ''}`;
    // Plan
    const p = S.plan || S.pending;
    if (p) {
      $('planMain').innerHTML = `<span class="big">${Number(p.angle).toFixed(3)}°</span><span class="tag">v ${p.velocity}</span>` +
        (p.target !== null && p.target !== undefined ? `<span class="tag">→ ${esc(pname(p.target))}</span>` : `<span class="tag">${p.kind || ''}</span>`) +
        (p.window ? `<span class="tag">Fenster ${p.window.toFixed(3)}°</span>` : '') + (p.pHit !== undefined ? `<span class="tag">p ${(p.pHit * 100).toFixed(0)}%</span>` : '') +
        (S.pending ? '<span class="tag" style="color:var(--green)">gesendet</span>' : p.waiting ? `<span class="tag">wartet auf Energie (${p.velocity})</span>` : '<span class="tag" style="color:var(--green)">feuerbereit</span>');
    } else $('planMain').innerHTML = `<span class="muted">${S.aimBusy ? 'berechne Lösungen…' : cfg.autoFire ? 'suche Ziel…' : 'Auto-Feuer aus'}</span>`;
    const la = S.lastAim;
    const sols = (S.solutions || []).slice().sort((a, b) => (b.best ? b.best.pHit : -1) - (a.best ? a.best.pHit : -1));
    $('candBody').innerHTML = sols.map(r => r.best
      ? `<tr><td>${esc(pname(r.target))}</td><td>${r.best.angle.toFixed(3)}</td><td>${r.best.velocity}</td><td>${r.best.window.toFixed(3)}°</td><td>${(r.best.frames / 60).toFixed(1)}s</td><td>${(r.best.pHit * 100).toFixed(0)}%</td></tr>`
      : `<tr class="none"><td>${esc(pname(r.target))}</td><td colspan="5" class="muted">${r.n === null ? 'wird berechnet…' : 'keine Lösung'}</td></tr>`).join('');
    $('aimInfo').textContent = la ? `Letzter Solve: ${la.solved}/${la.targets} Ziele, ${la.n} Lösungen in ${la.ms} ms auf ${la.workers} Kernen · vor ${((Date.now() - la.at) / 1000).toFixed(0)} s` : '';
    renderModelKv();
    renderPlayers();
  }

  function renderModel() { fieldVersion = -1; renderModelKv(); }
  function renderModelKv() {
    if (!S) return;
    const st = model.stats || {};
    const q = S.model.quality;
    $('qBar').style.width = `${q * 100}%`; $('qVal').textContent = `${(q * 100).toFixed(0)}%`;
    const rows = [
      ['Quelle', model.source === 'server' ? 'Server (exakt)' : model.source === 'estimated' ? 'rekonstruiert' : '–'],
      ['Planeten', model.planets.length],
      ['Bahnen', st.trajectories ?? '–'],
      ['Samples', st.samples ?? '–'],
      ['Einschläge', st.impacts ?? '–'],
      ['Replay exakt', st.replayed ? `${Math.round(st.reproduced * 100)}% von ${st.replayed}` : '–'],
      ['χ²/dof', st.redChi2 !== undefined ? st.redChi2.toFixed(2) : '–'],
      ...(S.model.truthErr ? [['vs. Wahrheit', `${S.model.truthErr.matched}/${S.model.truthErr.total} · ${S.model.truthErr.spurious} falsch · ${S.model.truthErr.medErr?.toFixed(2) ?? '–'} px`]] : []),
      ['Fit', S.fitBusy ? 'läuft…' : st.ms !== undefined ? `${st.ms} ms` : '–'],
    ];
    $('modelKv').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  let playersSig = '';
  function renderPlayers() {
    const box = $('players');
    const sig = JSON.stringify(S.players.map(p => [p.id, p.kills, p.deaths, p.label, p.me])) + cfg.targetMode + cfg.targetId;
    if (sig === playersSig || box.contains(document.activeElement)) return;
    playersSig = sig;
    const list = [...S.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    box.innerHTML = list.map(p => `
      <div class="prow ${p.me ? 'me' : ''} ${cfg.targetMode === 'fixed' && cfg.targetId === p.id ? 'sel' : ''}" data-id="${p.id}">
        <span class="sw" style="background:${pColor(p.id)}"></span>
        <span class="pid">#${p.id}</span>
        ${p.me ? `<span>${esc(cfg.name || 'Bot')} <span class="muted">(ich)</span></span>` : `<input value="${esc(p.label || '')}" placeholder="Name…" data-label="${p.id}">`}
        <span class="kd">${p.kills}/${p.deaths}</span>
      </div>`).join('') || '<span class="muted small">keine Spieler</span>';
  }
  $('players').addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const row = e.target.closest('.prow'); if (!row || row.classList.contains('me')) return;
    const id = Number(row.dataset.id);
    if (cfg.targetMode === 'fixed' && cfg.targetId === id) setCfg({ targetMode: 'auto', targetId: null }); else setCfg({ targetMode: 'fixed', targetId: id });
  });
  $('players').addEventListener('change', (e) => { if (e.target.dataset.label) api('label', { id: Number(e.target.dataset.label), label: e.target.value.trim() }); playersSig = ''; });

  function renderLog(full = false) {
    const box = $('log');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    const list = logs.filter(l => logFilter === 'all' || (logFilter === 'shot' ? (l.level === 'shot' || l.level === 'ok' || l.level === 'bad') : (l.level === 'warn' || l.level === 'error' || l.level === 'bad')));
    box.innerHTML = list.slice(-200).map(l => `<div class="${l.level}"><span class="t">${new Date(l.t).toLocaleTimeString()}</span>${esc(l.text)}</div>`).join('');
    if (stick || full) box.scrollTop = box.scrollHeight;
  }
  document.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); b.classList.add('on'); logFilter = b.dataset.f; renderLog(true);
  }));

  // ------------------------------------------------------------ Konfiguration
  function renderControls() {
    const fire = $('cbFire');
    const on = !!cfg.autoFire;
    fire.classList.toggle('paused', !on);
    fire.querySelector('.ico').textContent = on ? '⏸' : '▶';
    fire.querySelector('.lbl').textContent = on ? 'Pause' : 'Start';
    fire.title = on ? 'Auto-Feuer pausieren (bleibt verbunden)' : 'Auto-Feuer starten';
    document.querySelectorAll('#segTempo button').forEach(b => b.classList.toggle('on', b.dataset.v === (cfg.tempo || 'turbo')));
    const st = S?.conn.state || 'idle';
    const online = st !== 'idle';
    const cb = $('cbConn');
    cb.classList.toggle('on', st === 'online');
    cb.querySelector('.lbl').textContent = online ? 'Trennen' : 'Verbinden';
    $('cbReconnect').disabled = !online;
  }

  function renderCfg() {
    renderControls();
    const act = document.activeElement;
    const set = (id, v) => { const el = $(id); if (el !== act) el.value = v; };
    set('cHost', cfg.host ?? ''); set('cPort', cfg.port ?? 3490); set('cName', cfg.name ?? '');
    set('cRefill', cfg.rateRefill); set('cReserve', cfg.rateReserve);
    $('tAuto').checked = !!cfg.autoFire; $('tExplore').checked = !!cfg.explore; $('tSalvo').checked = !!cfg.salvo;
    document.querySelectorAll('#segTarget button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.targetMode));
    $('fixedInfo').textContent = cfg.targetMode === 'fixed' ? (cfg.targetId !== null ? `Festes Ziel: ${pname(cfg.targetId)}` : 'Ziel per Klick auf einen Spieler wählen') : '';
    set('vMin', cfg.velMin); set('vMax', cfg.velMax); $('vRangeVal').textContent = `${cfg.velMin} – ${cfg.velMax}`;
    set('flight', cfg.maxFlightSec); $('flightVal').textContent = `${cfg.maxFlightSec} s`;
    set('phit', cfg.minPHit); $('phitVal').textContent = `${Math.round(cfg.minPHit * 100)}%`;
    set('tw', cfg.timeWeight); $('twVal').textContent = Number(cfg.timeWeight).toFixed(2);
  }
  $('btnConnect').onclick = () => api('connect', { config: { host: $('cHost').value.trim(), port: Number($('cPort').value), name: $('cName').value.trim() || 'NewtonBot' } });
  $('btnDisconnect').onclick = () => { if (confirm('Vom Spielserver trennen?')) api('disconnect'); };
  $('cName').addEventListener('change', () => setCfg({ name: $('cName').value.trim() || 'NewtonBot' }));
  $('cRefill').addEventListener('change', () => setCfg({ rateRefill: Number($('cRefill').value) }));
  $('cReserve').addEventListener('change', () => setCfg({ rateReserve: Number($('cReserve').value) }));
  $('tAuto').addEventListener('change', e => setCfg({ autoFire: e.target.checked }));
  $('tExplore').addEventListener('change', e => setCfg({ explore: e.target.checked }));
  $('tSalvo').addEventListener('change', e => setCfg({ salvo: e.target.checked }));
  document.querySelectorAll('#segTarget button').forEach(b => b.addEventListener('click', () => setCfg({ targetMode: b.dataset.v, targetId: b.dataset.v === 'fixed' ? cfg.targetId : null })));
  const vm = () => { let a = Number($('vMin').value), b = Number($('vMax').value); if (a > b) [a, b] = [b, a]; setCfg({ velMin: a, velMax: b }); };
  $('vMin').addEventListener('change', vm); $('vMax').addEventListener('change', vm);
  $('vMin').addEventListener('input', () => $('vRangeVal').textContent = `${$('vMin').value} – ${$('vMax').value}`);
  $('vMax').addEventListener('input', () => $('vRangeVal').textContent = `${$('vMin').value} – ${$('vMax').value}`);
  $('flight').addEventListener('change', e => setCfg({ maxFlightSec: Number(e.target.value) }));
  $('flight').addEventListener('input', e => $('flightVal').textContent = `${e.target.value} s`);
  $('phit').addEventListener('change', e => setCfg({ minPHit: Number(e.target.value) }));
  $('phit').addEventListener('input', e => $('phitVal').textContent = `${Math.round(e.target.value * 100)}%`);
  $('tw').addEventListener('change', e => setCfg({ timeWeight: Number(e.target.value) }));
  $('btnRefit').onclick = () => api('refit', { rebuild: true });
  $('btnResetModel').onclick = () => { if (confirm('Planetenmodell verwerfen und neu lernen?')) api('reset-model'); };
  $('btnFire').onclick = () => api('fire', { angle: Number($('mAngle').value), velocity: Number($('mVel').value) });

  function fmtBytes(n) { return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? (n / 1e3).toFixed(0) + ' kB' : n + ' B'; }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // Netzwerk-Status: Pill oben + Hinweisbanner mit Aktion
  function renderNet() {
    const n = netS, pill = $('pillNet'), ban = $('netBanner'), act = $('nbAction');
    if (!n || !n.checked) { pill.className = 'pill neutral'; pill.textContent = 'Netz …'; ban.hidden = true; return; }
    if (n.reachable) {
      pill.className = 'pill good'; pill.textContent = `Netz ✓ ${n.gameIp || n.wifiIp || ''}`;
      ban.hidden = true; return;
    }
    pill.className = 'pill bad'; pill.textContent = 'Kein Spielnetz';
    let title, text, button = false, bad = false;
    if (n.setup === 'asking') {
      title = 'Warte auf dein Passwort …';
      text = `macOS fragt nach deinem Passwort, um dem WLAN die Adresse ${n.staticIp} zu geben.`;
    } else if (n.linkLocal) {
      title = 'WLAN verbunden, aber keine Adresse';
      text = `Das WLAN vergibt keine IP. NewtonBot kann die feste Adresse ${n.staticIp} setzen (braucht dein Passwort, wird beim Beenden zurückgesetzt).`;
      button = true;
    } else if (n.gameIp) {
      title = `Im Spielnetz (${n.gameIp}), aber ${n.host} antwortet nicht`;
      text = 'Läuft der Spielserver? Der Bot versucht es automatisch weiter.';
    } else {
      title = 'Nicht im NewtonWars-WLAN';
      text = 'Verbinde den Mac mit dem WLAN „NewtonWars“ – der Bot verbindet sich dann von selbst.';
      bad = true;
    }
    $('nbTitle').textContent = title; $('nbText').textContent = text;
    act.hidden = !button;
    ban.className = `netbanner${bad ? ' bad' : ''}`; ban.hidden = false;
  }
  $('nbAction').onclick = () => api('network-setup');

  // Steuerleiste
  $('cbFire').onclick = () => setCfg({ autoFire: !cfg.autoFire });
  document.querySelectorAll('#segTempo button').forEach(b => b.addEventListener('click', () => setCfg({ tempo: b.dataset.v })));
  $('cbConn').onclick = () => {
    const st = S?.conn.state || 'idle';
    if (st === 'idle') api('connect', { config: { host: $('cHost').value.trim(), port: Number($('cPort').value), name: $('cName').value.trim() || cfg.name } });
    else if (confirm('Vom Spielserver trennen?')) api('disconnect');
  };
  $('cbReconnect').onclick = () => { if (confirm('Verbindung neu aufbauen? (Server sperrt die IP danach ~10 s)')) api('reconnect'); };
  $('cbRestart').onclick = () => { if (confirm(supervised ? 'Bot-Programm komplett neu starten? Das Planetenmodell wird neu gelernt (~20 s).' : 'Bot läuft ohne Supervisor – nur neu verbinden?')) api('restart'); };

  $('cbQuit').onclick = () => {
    if (!confirm('NewtonBot komplett beenden?')) return;
    quitting = true;
    api('quit');
    document.body.innerHTML = `<div class="bye"><svg viewBox="0 0 32 32" width="56" height="56"><circle cx="16" cy="16" r="6.5" fill="#4de2ff"/><ellipse cx="16" cy="16" rx="14" ry="5" fill="none" stroke="#ffb547" stroke-width="2" transform="rotate(-25 16 16)"/></svg><h1>NewtonBot ist beendet</h1><p>Das Netzwerk wird zurückgesetzt. Du kannst dieses Fenster schließen.<br>Zum Neustarten einfach wieder die NewtonBot-App öffnen.</p></div>`;
  };

  connectSSE();
})();
