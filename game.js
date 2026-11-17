/* LOOMLIGHT — pluck the wires, keep the dawn.
   A top-down night-defense game in vanilla JS + Canvas 2D. Zero dependencies.
   The simulation core (state, waves, threads, beam) is DOM-free and is also
   exported for Node so it can be smoke-tested headlessly; the browser layer
   (rendering, input, overlays) boots only when a document exists. */
'use strict';

/* ---------------- utilities ---------------- */

// mulberry32: small deterministic PRNG so seeded nights are reproducible.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/* ---------------- balance config ---------------- */

const ARENA = { w: 960, h: 640, cx: 480, cy: 320 };
const HEARTH_R = 26;
const POST_RING_R = 255;      // radius of the 8 anchor posts around the hearth
const POST_INNER_R = 175;     // radius of the bonus post pair from the dawn shop
const MAX_FLAME = 100;
const THREAD_START_TENSION = 100;
const THREAD_CROSS_COST = 30; // tension lost each time an enemy crosses a thread
const THREAD_BEAM_REGEN = 9;  // tension per second regained while lit by the beam
const PLUCK_RADIUS = 30;      // enemies this close to a plucked thread get snapped

const ENEMY_TYPES = {
  shade: { hp: 18, speed: 27, r: 11, gnaw: 1.7, embers: 2 },
  swift: { hp: 10, speed: 48, r: 9,  gnaw: 1.6, embers: 2 },
  wisp:  { hp: 15, speed: 31, r: 10, gnaw: 2.0, embers: 3 },
  brute: { hp: 85, speed: 15, r: 17, gnaw: 5.0, embers: 7 },
};

const SHOP = {
  thread:   { label: '+1 thread loom',      base: 12, max: 5 },
  sharp:    { label: 'Sharper wire (+6 cut)', base: 14, max: 99 },
  beam:     { label: 'Wider lantern beam',  base: 12, max: 4 },
  rekindle: { label: 'Rekindle hearth (+35)', base: 10, max: 99 },
  posts:    { label: 'Extra post pair',     base: 16, max: 1 },
};

/* ---------------- posts & waves ---------------- */

// 8 posts on a ring around the hearth; the shop can add an inner pair.
function basePosts() {
  const posts = [];
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 8) + (i * Math.PI) / 4;
    posts.push({ x: ARENA.cx + Math.cos(a) * POST_RING_R, y: ARENA.cy + Math.sin(a) * POST_RING_R });
  }
  return posts;
}

function innerPosts() {
  return [0.4, 0.4 + Math.PI].map((a) => ({
    x: ARENA.cx + Math.cos(a) * POST_INNER_R,
    y: ARENA.cy + Math.sin(a) * POST_INNER_R,
  }));
}

// Seeded spawn schedule for a night: same seed -> same spawns, every run.
function makeWave(night, seedBase) {
  const rng = makeRng(seedBase + night * 7919);
  const count = 9 + 3 * night;
  const interval = Math.max(0.85, 2.3 - 0.22 * (night - 1));
  const hpScale = 1 + 0.15 * (night - 1);
  const speedScale = 1 + 0.03 * (night - 1);
  const spawns = [];
  for (let i = 0; i < count; i++) {
    // Weighted type pick; nastier kinds unlock as the week goes on.
    const roll = rng();
    let type = 'shade';
    if (night >= 4 && roll > 0.90 - 0.01 * night) type = 'brute';
    else if (night >= 3 && roll > 0.72) type = 'wisp';
    else if (night >= 2 && roll > 0.45) type = 'swift';
    spawns.push({
      time: 1.2 + i * interval + rng() * 0.4,
      type,
      angle: rng() * Math.PI * 2,
      phase: rng() * Math.PI * 2,
      hpScale,
      speedScale,
    });
  }
  return spawns;
}

// Where a ray from the hearth at `angle` meets the arena border.
function spawnPoint(angle) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const tx = dx > 0 ? (ARENA.w - 14 - ARENA.cx) / dx : dx < 0 ? (14 - ARENA.cx) / dx : Infinity;
  const ty = dy > 0 ? (ARENA.h - 14 - ARENA.cy) / dy : dy < 0 ? (14 - ARENA.cy) / dy : Infinity;
  const t = Math.min(Math.abs(tx), Math.abs(ty));
  return { x: ARENA.cx + dx * t, y: ARENA.cy + dy * t };
}

/* ---------------- game state + simulation (DOM-free) ---------------- */

function createGame(seedBase) {
  return {
    seedBase: seedBase || 4242,
    phase: 'title', // title | night | shop | won | lost
    night: 0,
    time: 0,
    flame: MAX_FLAME,
    embers: 0,
    kills: 0,
    nightsCleared: 0,
    posts: basePosts(),
    hasInnerPosts: false,
    threads: [],        // {a, b, tension} — a/b are post indices
    threadCapacity: 4,
    cutDamage: 14,
    beamHalf: 0.17,     // half-angle of the lantern beam, radians
    beamDps: 9,
    beamAngle: -Math.PI / 2,
    beamSpeed: 0.22,    // radians per second, slowly sweeping
    enemies: [],        // {x,y,type,hp,maxHp,speed,r,gnaw,embers,phase,cutCd:Map}
    spawns: [],
    spawnIdx: 0,
    shopOwned: { thread: 0, sharp: 0, beam: 0, rekindle: 0, posts: 0 },
    events: [],         // renderer-facing event queue (cut/death/snap/pluck)
    stats: { cuts: 0, plucks: 0, snaps: 0, beamBurn: 0 },
    nextEnemyId: 1,
  };
}

function shopPrice(state, key) {
  return SHOP[key].base + 4 * state.shopOwned[key];
}

function startNight(state) {
  state.night += 1;
  state.spawns = makeWave(state.night, state.seedBase);
  state.spawnIdx = 0;
  state.time = 0;
  state.enemies = [];
  state.phase = 'night';
}

function weaveThread(state, a, b) {
  if (a === b) return false;
  if (state.threads.length >= state.threadCapacity) return false;
  if (state.threads.some((t) => (t.a === a && t.b === b) || (t.a === b && t.b === a))) return false;
  state.threads.push({ a, b, tension: THREAD_START_TENSION });
  return true;
}

// Pluck: release a thread's stored tension as a snap along its whole length.
function pluckThread(state, thread) {
  const i = state.threads.indexOf(thread);
  if (i < 0) return 0;
  const pa = state.posts[thread.a], pb = state.posts[thread.b];
  const dmg = state.cutDamage * (0.8 + (thread.tension / 100) * 1.2);
  let hit = 0;
  for (const e of state.enemies) {
    if (distToSegment(e.x, e.y, pa.x, pa.y, pb.x, pb.y) <= PLUCK_RADIUS + e.r) {
      e.hp -= dmg;
      hit += 1;
    }
  }
  state.threads.splice(i, 1);
  state.stats.plucks += 1;
  state.events.push({ type: 'pluck', x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
  return hit;
}

function inBeam(state, x, y) {
  const d = Math.hypot(x - ARENA.cx, y - ARENA.cy);
  if (d > 345) return false;
  const ang = Math.atan2(y - ARENA.cy, x - ARENA.cx);
  return Math.abs(angleDiff(ang, state.beamAngle)) <= state.beamHalf;
}

function stepGame(state, dt) {
  if (state.phase !== 'night') return;
  state.time += dt;
  state.beamAngle += state.beamSpeed * dt;

  // Spawn due enemies.
  while (state.spawnIdx < state.spawns.length && state.spawns[state.spawnIdx].time <= state.time) {
    const s = state.spawns[state.spawnIdx++];
    const base = ENEMY_TYPES[s.type];
    const p = spawnPoint(s.angle);
    state.enemies.push({
      id: state.nextEnemyId++,
      x: p.x, y: p.y, type: s.type,
      hp: base.hp * s.hpScale, maxHp: base.hp * s.hpScale,
      speed: base.speed * s.speedScale, r: base.r,
      gnaw: base.gnaw, embers: base.embers, phase: s.phase,
      cutCd: new Map(),
    });
  }

  const dead = [];
  for (const e of state.enemies) {
    const dx = ARENA.cx - e.x, dy = ARENA.cy - e.y;
    const distC = Math.hypot(dx, dy);

    // Lantern light burns whatever it touches.
    if (inBeam(state, e.x, e.y)) {
      e.hp -= state.beamDps * dt;
      state.stats.beamBurn += state.beamDps * dt;
    }

    if (distC <= HEARTH_R + e.r) {
      // Reached the hearth: gnaw at the flame.
      state.flame -= e.gnaw * dt;
    } else {
      let vx = (dx / distC) * e.speed, vy = (dy / distC) * e.speed;
      if (e.type === 'wisp') {
        // Wisps weave side to side as they close in.
        const px = -dy / distC, py = dx / distC;
        const sway = Math.cos(state.time * 3 + e.phase) * e.speed * 0.55;
        vx += px * sway; vy += py * sway;
      }
      e.x += vx * dt; e.y += vy * dt;
    }

    // Threads cut on contact; each crossing drains the thread's tension.
    for (const t of state.threads) {
      const cd = e.cutCd.get(t) || 0;
      if (cd > state.time) continue;
      const pa = state.posts[t.a], pb = state.posts[t.b];
      if (distToSegment(e.x, e.y, pa.x, pa.y, pb.x, pb.y) <= e.r + 3) {
        e.hp -= state.cutDamage;
        t.tension -= THREAD_CROSS_COST;
        e.cutCd.set(t, state.time + 0.6);
        state.stats.cuts += 1;
        state.events.push({ type: 'cut', x: e.x, y: e.y });
      }
    }

    if (e.hp <= 0) dead.push(e);
  }

  // Threads lit by the beam slowly regain tension; slack threads snap.
  for (let i = state.threads.length - 1; i >= 0; i--) {
    const t = state.threads[i];
    const pa = state.posts[t.a], pb = state.posts[t.b];
    if (inBeam(state, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2)) {
      t.tension = Math.min(THREAD_START_TENSION, t.tension + THREAD_BEAM_REGEN * dt);
    }
    if (t.tension <= 0) {
      state.threads.splice(i, 1);
      state.stats.snaps += 1;
      state.events.push({ type: 'snap', x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 });
    }
  }

  for (const e of dead) {
    state.enemies.splice(state.enemies.indexOf(e), 1);
    state.kills += 1;
    state.embers += e.embers;
    state.events.push({ type: 'death', x: e.x, y: e.y, embers: e.embers });
  }

  if (state.flame <= 0) {
    state.flame = 0;
    state.phase = 'lost';
    state.events.push({ type: 'lost' });
    return;
  }

  // Night cleared: everything spawned and nothing left standing.
  if (state.spawnIdx >= state.spawns.length && state.enemies.length === 0) {
    state.nightsCleared = state.night;
    state.phase = state.night >= 7 ? 'won' : 'shop';
    state.events.push({ type: state.phase === 'won' ? 'won' : 'dawn' });
  }
}

function buyUpgrade(state, key) {
  const item = SHOP[key];
  if (!item || state.shopOwned[key] >= item.max) return false;
  if (key === 'rekindle' && state.flame >= MAX_FLAME) return false;
  const price = shopPrice(state, key);
  if (state.embers < price) return false;
  state.embers -= price;
  state.shopOwned[key] += 1;
  if (key === 'thread') state.threadCapacity += 1;
  if (key === 'sharp') state.cutDamage += 6;
  if (key === 'beam') state.beamHalf += 0.045;
  if (key === 'rekindle') state.flame = Math.min(MAX_FLAME, state.flame + 35);
  if (key === 'posts') {
    state.posts = state.posts.concat(innerPosts());
    state.hasInnerPosts = true;
  }
  return true;
}

function score(state) {
  return state.kills * 10 + state.nightsCleared * 150 + Math.floor(state.flame);
}

/* ---------------- browser layer: rendering + input + overlays ---------------- */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createGame, startNight, weaveThread, pluckThread, buyUpgrade,
    stepGame, makeWave, score, shopPrice, inBeam, ARENA, SHOP,
  };
}

if (typeof document !== 'undefined') {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const state = createGame(4242);
  const particles = [];
  const rings = [];            // expanding shockwave rings (pluck / death)
  const motes = [];            // slow ambient dust drifting across the scene
  const enemyFx = new Map();   // id -> {hp, flash} render-side hit feedback
  let dragFrom = -1;
  let pointer = { x: 0, y: 0, down: false };
  let flicker = 0;
  let renderT = 0;             // render clock (seconds), advances in every phase
  let frameDt = 0.016;         // last frame delta, shared with the draw pass
  let shakeT = 0;              // screen-shake time remaining (pluck only)
  let hurtT = 0;               // red vignette pulse after the hearth takes damage
  let prevFlame = MAX_FLAME;
  let emberAcc = 0;            // fractional ember spawner for the hearth
  let beamDrift = 0;           // cosmetic beam sweep while on the title screen
  let groundCanvas = null;     // offscreen pre-rendered arena dressing

  { // Seed the ambient dust motes once (deterministic layout).
    const mrng = makeRng(777);
    for (let i = 0; i < 26; i++) {
      motes.push({
        x: mrng() * ARENA.w, y: mrng() * ARENA.h,
        vx: (mrng() - 0.5) * 7, vy: (mrng() - 0.5) * 5,
        r: 0.8 + mrng() * 1.6, tw: mrng() * Math.PI * 2,
      });
    }
  }

  const $ = (id) => document.getElementById(id);
  const titleEl = $('title-screen'), shopEl = $('shop'), endEl = $('end-screen');
  const hudEl = $('hud');

  function show(el, on) { el.classList.toggle('hidden', !on); }

  function refreshOverlays() {
    show(titleEl, state.phase === 'title');
    show(shopEl, state.phase === 'shop');
    show(endEl, state.phase === 'won' || state.phase === 'lost');
    if (state.phase === 'won' || state.phase === 'lost') {
      $('end-title').textContent = state.phase === 'won' ? '🌅 Dawn breaks — the hearth survives!' : '🕯️ The flame is snuffed out.';
      $('end-stats').textContent =
        `Nights cleared: ${state.nightsCleared} · Kills: ${state.kills} · Flame left: ${Math.floor(state.flame)} · Score: ${score(state)}`;
    }
    if (state.phase === 'shop') refreshShop();
    hudEl.textContent =
      `Night ${Math.max(1, state.night)}/7 · 🔥 ${Math.ceil(state.flame)} · ✨ ${state.embers} embers · ` +
      `🧵 threads ${state.threads.length}/${state.threadCapacity} · ☠️ ${state.kills} kills · Score ${score(state)}`;
  }

  function refreshShop() {
    $('shop-embers').textContent = state.embers;
    $('shop-night').textContent = state.night + 1;
    for (const key of Object.keys(SHOP)) {
      const btn = document.querySelector(`[data-buy="${key}"]`);
      const owned = state.shopOwned[key];
      const maxed = owned >= SHOP[key].max || (key === 'rekindle' && state.flame >= MAX_FLAME);
      btn.disabled = maxed || state.embers < shopPrice(state, key);
      btn.querySelector('.price').textContent = maxed ? '—' : `${shopPrice(state, key)} ✨`;
      btn.querySelector('.owned').textContent = owned > 0 ? `×${owned}` : '';
    }
  }

  document.querySelectorAll('[data-buy]').forEach((btn) => {
    btn.addEventListener('click', () => { buyUpgrade(state, btn.dataset.buy); refreshOverlays(); });
  });
  $('start-btn').addEventListener('click', () => { startNight(state); refreshOverlays(); });
  $('next-night-btn').addEventListener('click', () => { startNight(state); refreshOverlays(); });
  $('again-btn').addEventListener('click', () => { Object.assign(state, createGame(state.seedBase)); refreshOverlays(); });

  /* ----- input: drag post->post to weave, click a thread to pluck ----- */
  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * ARENA.w, y: ((ev.clientY - r.top) / r.height) * ARENA.h };
  }
  function postAt(p) {
    for (let i = 0; i < state.posts.length; i++) {
      if (Math.hypot(p.x - state.posts[i].x, p.y - state.posts[i].y) <= 16) return i;
    }
    return -1;
  }
  function threadAt(p) {
    let best = null, bestD = 12;
    for (const t of state.threads) {
      const pa = state.posts[t.a], pb = state.posts[t.b];
      const d = distToSegment(p.x, p.y, pa.x, pa.y, pb.x, pb.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const p = canvasPos(ev);
    pointer = { ...p, down: true };
    if (state.phase !== 'night' && state.phase !== 'shop') return;
    const post = postAt(p);
    if (post >= 0) { dragFrom = post; return; }
    const t = threadAt(p);
    if (t && state.phase === 'night') { pluckThread(state, t); burst(p.x, p.y, '#ffe9a3', 14); refreshOverlays(); }
  });
  canvas.addEventListener('pointermove', (ev) => { pointer = { ...canvasPos(ev), down: pointer.down }; });
  canvas.addEventListener('pointerup', (ev) => {
    const p = canvasPos(ev);
    pointer = { ...p, down: false };
    if (dragFrom >= 0) {
      const to = postAt(p);
      if (to >= 0 && state.phase === 'night') weaveThread(state, dragFrom, to);
      dragFrom = -1;
      refreshOverlays();
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'r' || ev.key === 'R') { Object.assign(state, createGame(state.seedBase)); startNight(state); refreshOverlays(); }
  });

  /* ----- particles & one-shot effects ----- */
  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 90;
      particles.push({
        kind: 'dot', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.45, maxLife: 0.45, size: 3, color, grav: 0, drag: 0, tw: 0,
      });
    }
  }

  // Falling spark fragments for a snapped thread.
  function burstSparks(x, y, n) {
    const palette = ['#ffd76a', '#ff9a5c', '#ff6a4d'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 24 + Math.random() * 70;
      const life = 0.5 + Math.random() * 0.35;
      particles.push({
        kind: 'spark', x: x + (Math.random() - 0.5) * 30, y: y + (Math.random() - 0.5) * 10,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30,
        life, maxLife: life, size: 2, color: palette[i % palette.length], grav: 300, drag: 0.6, tw: 0,
      });
    }
  }

  function spawnRing(x, y, maxR, vr, life, color) {
    rings.push({ x, y, r: 5, maxR, vr, life, maxLife: life, color });
  }

  function drainEvents() {
    for (const e of state.events) {
      if (e.type === 'cut') burst(e.x, e.y, '#ffd76a', 4);
      if (e.type === 'death') { burst(e.x, e.y, '#9be7ff', 10); spawnRing(e.x, e.y, 34, 150, 0.3, '159, 231, 255'); }
      if (e.type === 'snap') burstSparks(e.x, e.y, 12);
      if (e.type === 'pluck') {
        burst(e.x, e.y, '#ffe9a3', 10);
        spawnRing(e.x, e.y, 95, 330, 0.34, '255, 233, 163');
        shakeT = 0.12;
      }
    }
    state.events.length = 0;
  }

  /* ----- pre-rendered arena dressing (drawn once to an offscreen canvas) ----- */
  function buildGround() {
    groundCanvas = document.createElement('canvas');
    groundCanvas.width = ARENA.w;
    groundCanvas.height = ARENA.h;
    const c = groundCanvas.getContext('2d');
    const rng = makeRng(90210);
    const cx = ARENA.cx, cy = ARENA.cy;

    // Layered night ground: deep blue-green radial falloff.
    const g = c.createRadialGradient(cx, cy, 30, cx, cy, 580);
    g.addColorStop(0, '#1e2c26');
    g.addColorStop(0.4, '#122029');
    g.addColorStop(0.75, '#0a141f');
    g.addColorStop(1, '#05090f');
    c.fillStyle = g;
    c.fillRect(0, 0, ARENA.w, ARENA.h);

    // Warm earth tint pooled around the hearth.
    const wg = c.createRadialGradient(cx, cy, 8, cx, cy, 200);
    wg.addColorStop(0, 'rgba(122, 76, 30, 0.20)');
    wg.addColorStop(1, 'rgba(122, 76, 30, 0)');
    c.fillStyle = wg;
    c.fillRect(0, 0, ARENA.w, ARENA.h);

    // Noise speckle / fallen-star dust across the floor.
    for (let i = 0; i < 1100; i++) {
      const x = rng() * ARENA.w, y = rng() * ARENA.h;
      const warm = rng() < 0.4;
      c.fillStyle = warm
        ? `rgba(255, 214, 150, ${0.03 + rng() * 0.08})`
        : `rgba(170, 205, 255, ${0.03 + rng() * 0.09})`;
      const r = rng() < 0.85 ? 1 : 1.7;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }

    // Scattered stones.
    for (let i = 0; i < 46; i++) {
      const x = rng() * ARENA.w, y = rng() * ARENA.h;
      if (Math.hypot(x - cx, y - cy) < 78) continue;
      const s = 2 + rng() * 4.5, sh = 44 + Math.floor(rng() * 30);
      c.fillStyle = `rgba(${sh}, ${sh + 3}, ${sh + 10}, ${0.5 + rng() * 0.4})`;
      c.beginPath(); c.ellipse(x, y, s, s * 0.68, rng() * Math.PI, 0, Math.PI * 2); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.beginPath(); c.ellipse(x - s * 0.25, y - s * 0.25, s * 0.5, s * 0.3, 0, 0, Math.PI * 2); c.fill();
    }

    // Faint grass tufts.
    c.lineWidth = 1.1;
    for (let i = 0; i < 130; i++) {
      const x = rng() * ARENA.w, y = rng() * ARENA.h;
      if (Math.hypot(x - cx, y - cy) < 70) continue;
      c.strokeStyle = `rgba(40, 70, 46, ${0.25 + rng() * 0.3})`;
      for (let b = -1; b <= 1; b++) {
        const h = 4 + rng() * 5;
        c.beginPath(); c.moveTo(x, y);
        c.quadraticCurveTo(x + b * 2, y - h * 0.6, x + b * 3.2, y - h);
        c.stroke();
      }
    }

    // The ritual loom circle: etched rings, spokes and ticks in faint gold.
    const posts = basePosts();
    c.strokeStyle = 'rgba(255, 202, 85, 0.055)';
    c.lineWidth = 1.5;
    for (const p of posts) {
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(p.x, p.y); c.stroke();
    }
    const ring = (r, alpha, w) => {
      c.strokeStyle = `rgba(255, 202, 85, ${alpha})`;
      c.lineWidth = w;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    };
    ring(POST_RING_R, 0.10, 1.6);
    ring(POST_RING_R - 14, 0.05, 1);
    ring(232, 0.045, 1);
    ring(POST_INNER_R, 0.06, 1.2);
    ring(120, 0.04, 1);
    ring(64, 0.07, 1.2);
    c.strokeStyle = 'rgba(255, 202, 85, 0.09)';
    c.lineWidth = 1.4;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const r0 = POST_RING_R - (i % 4 === 0 ? 11 : 6);
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * POST_RING_R, cy + Math.sin(a) * POST_RING_R);
      c.stroke();
    }
    for (const p of posts) {
      c.strokeStyle = 'rgba(255, 202, 85, 0.10)';
      c.beginPath(); c.arc(p.x, p.y, 11, 0, Math.PI * 2); c.stroke();
    }

    // Edge silhouettes: a far tree line, then nearer pines / rocks / pillars.
    const silhouette = (x, y, s, kind, color) => {
      c.fillStyle = color;
      if (kind === 0) { // pine: stacked triangles over a short trunk
        c.fillRect(x - 1.5 * s, y, 3 * s, 5 * s);
        for (let t = 0; t < 3; t++) {
          const w = (13 - t * 3.4) * s, ty = y - t * 6.4 * s;
          c.beginPath();
          c.moveTo(x - w / 2, ty); c.lineTo(x + w / 2, ty); c.lineTo(x, ty - 8.5 * s);
          c.closePath(); c.fill();
        }
      } else if (kind === 1) { // rock: squat faceted blob
        c.beginPath();
        c.moveTo(x - 9 * s, y + 3 * s);
        c.lineTo(x - 5 * s, y - 4.5 * s);
        c.lineTo(x + 1 * s, y - 6.5 * s);
        c.lineTo(x + 7 * s, y - 2.5 * s);
        c.lineTo(x + 9 * s, y + 3 * s);
        c.closePath(); c.fill();
      } else { // broken pillar: shaft, capital lip, snapped top
        c.fillRect(x - 3.4 * s, y - 13 * s, 6.8 * s, 16 * s);
        c.fillRect(x - 4.6 * s, y - 14.6 * s, 9.2 * s, 2.2 * s);
        c.beginPath();
        c.moveTo(x - 3.4 * s, y - 13 * s);
        c.lineTo(x + 0.5 * s, y - 16.5 * s);
        c.lineTo(x + 3.4 * s, y - 13.8 * s);
        c.closePath(); c.fill();
      }
    };
    const rimSpot = () => {
      const edge = Math.floor(rng() * 4);
      const along = rng();
      if (edge === 0) return { x: 24 + along * (ARENA.w - 48), y: 16 + rng() * 22 };
      if (edge === 1) return { x: 24 + along * (ARENA.w - 48), y: ARENA.h - 10 - rng() * 20 };
      if (edge === 2) return { x: 14 + rng() * 20, y: 30 + along * (ARENA.h - 60) };
      return { x: ARENA.w - 14 - rng() * 20, y: 30 + along * (ARENA.h - 60) };
    };
    for (let i = 0; i < 16; i++) { const p = rimSpot(); silhouette(p.x, p.y, 0.55 + rng() * 0.4, Math.floor(rng() * 3), 'rgba(10, 18, 30, 0.55)'); }
    for (let i = 0; i < 15; i++) { const p = rimSpot(); silhouette(p.x, p.y, 0.85 + rng() * 0.6, Math.floor(rng() * 3), 'rgba(3, 6, 10, 0.92)'); }

    // Crescent moon, top-left of the backdrop.
    const mx = 66, my = 56;
    const mg = c.createRadialGradient(mx, my, 2, mx, my, 46);
    mg.addColorStop(0, 'rgba(190, 210, 255, 0.20)');
    mg.addColorStop(1, 'rgba(190, 210, 255, 0)');
    c.fillStyle = mg;
    c.fillRect(mx - 46, my - 46, 92, 92);
    c.save();
    c.beginPath();
    c.arc(mx, my, 16, 0, Math.PI * 2);
    c.arc(mx + 7, my - 5, 13.5, 0, Math.PI * 2, true);
    c.fillStyle = 'rgba(233, 239, 255, 0.88)';
    c.shadowColor = 'rgba(200, 215, 255, 0.85)';
    c.shadowBlur = 16;
    c.fill('evenodd');
    c.restore();

    // Baked vignette: corners fall away into the dark.
    const v = c.createRadialGradient(cx, cy, 330, cx, cy, 700);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(0, 0, 0, 0.52)');
    c.fillStyle = v;
    c.fillRect(0, 0, ARENA.w, ARENA.h);
  }

  // Thread colour follows tension: bright gold -> orange -> dull red.
  function tensionRGB(k) {
    let r, g, b;
    if (k > 0.5) {
      const u = (k - 0.5) * 2;
      r = 255; g = Math.round(148 + 66 * u); b = Math.round(58 + 52 * u);
    } else {
      const u = k * 2;
      r = Math.round(196 + 59 * u); g = Math.round(74 + 74 * u); b = Math.round(52 + 6 * u);
    }
    return [r, g, b];
  }

  window.addEventListener('resize', () => { groundCanvas = null; });

  function draw() {
    flicker += 0.09;
    if (!groundCanvas) buildGround();
    const cx = ARENA.cx, cy = ARENA.cy;
    const flameFrac = state.flame / MAX_FLAME;
    const beamVisual = state.beamAngle + (state.phase === 'title' ? beamDrift : 0);
    const inBeamVisual = (x, y) => {
      if (Math.hypot(x - cx, y - cy) > 345) return false;
      return Math.abs(angleDiff(Math.atan2(y - cy, x - cx), beamVisual)) <= state.beamHalf;
    };

    ctx.clearRect(0, 0, ARENA.w, ARENA.h);
    ctx.save();
    if (shakeT > 0) {
      const m = 3 * (shakeT / 0.12);
      ctx.translate((Math.random() - 0.5) * 2 * m, (Math.random() - 0.5) * 2 * m);
    }

    // Pre-rendered ground: gradient, speckle, ritual circle, silhouettes, moon.
    ctx.drawImage(groundCanvas, 0, 0);

    // Breathing pool of hearth-light on the earth.
    const breathe = 0.5 + 0.5 * Math.sin(renderT * 1.6);
    const pool = ctx.createRadialGradient(cx, cy, 8, cx, cy, 150 + breathe * 14);
    pool.addColorStop(0, `rgba(255, 166, 66, ${0.10 + 0.05 * breathe * flameFrac})`);
    pool.addColorStop(1, 'rgba(255, 166, 66, 0)');
    ctx.fillStyle = pool;
    ctx.fillRect(cx - 170, cy - 170, 340, 340);

    // Glowing rune ring around the hearth, pulsing with the flame.
    const runeA = (0.16 + 0.09 * Math.sin(renderT * 2.1)) * (0.35 + 0.65 * flameFrac);
    ctx.strokeStyle = `rgba(255, 190, 90, ${runeA})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, HEARTH_R + 17, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = `rgba(255, 190, 90, ${runeA * 0.55})`;
    ctx.beginPath(); ctx.arc(cx, cy, HEARTH_R + 11, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(255, 205, 110, ${Math.min(1, runeA * 1.7)})`;
    for (let i = 0; i < 12; i++) {
      const a = renderT * 0.06 + (i * Math.PI) / 6;
      const gx = cx + Math.cos(a) * (HEARTH_R + 17), gy = cy + Math.sin(a) * (HEARTH_R + 17);
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(a + Math.PI / 4);
      const s = i % 2 === 0 ? 3.1 : 2.2;
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.restore();
    }

    // The rotating lantern beam: three feathered layers soften the cone edge.
    for (const [extra, alpha] of [[0.06, 0.09], [0.03, 0.14], [0, 0.19]]) {
      const bg = ctx.createRadialGradient(cx, cy, 8, cx, cy, 345);
      bg.addColorStop(0, `rgba(255, 216, 120, ${alpha + 0.11})`);
      bg.addColorStop(0.55, `rgba(255, 205, 100, ${alpha * 0.55})`);
      bg.addColorStop(1, 'rgba(255, 200, 90, 0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, 345, beamVisual - state.beamHalf - extra, beamVisual + state.beamHalf + extra);
      ctx.closePath();
      ctx.fill();
    }

    // Threads: gradient glow, colour by tension, a pulse of light travelling along.
    for (const t of state.threads) {
      const pa = state.posts[t.a], pb = state.posts[t.b];
      const k = t.tension / 100;
      const [r, g, b] = tensionRGB(k);
      const grad = ctx.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.30 + 0.30 * k})`);
      grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${0.45 + 0.50 * k})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${0.30 + 0.30 * k})`);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.10 + 0.08 * k})`;
      ctx.lineWidth = 3 + 3.5 * k;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1 + 2 * k;
      ctx.shadowColor = `rgb(${r}, ${g}, ${b})`;
      ctx.shadowBlur = 9 * k;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.shadowBlur = 0;
      // Travelling pulse.
      const s = (renderT * 0.32 + ((t.a * 7 + t.b * 13) % 10) / 10) % 1;
      const px = pa.x + (pb.x - pa.x) * s, py = pa.y + (pb.y - pa.y) * s;
      ctx.fillStyle = `rgba(255, 246, 205, ${0.35 + 0.55 * k})`;
      ctx.shadowColor = '#ffe9a3';
      ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(px, py, 1.8 + 1.4 * k, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
    // Weave preview while dragging.
    if (dragFrom >= 0) {
      const pa = state.posts[dragFrom];
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pointer.x, pointer.y); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Posts: wooden stakes crowned with a glowing amber orb.
    state.posts.forEach((p, i) => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 6, 9, 3.4, 0, 0, Math.PI * 2); ctx.fill();
      const trunk = ctx.createLinearGradient(p.x - 3, p.y, p.x + 3, p.y);
      trunk.addColorStop(0, '#7a5230');
      trunk.addColorStop(0.5, '#5d3c20');
      trunk.addColorStop(1, '#3f2812');
      ctx.fillStyle = trunk;
      ctx.beginPath();
      ctx.moveTo(p.x - 3.2, p.y + 7);
      ctx.lineTo(p.x - 2.2, p.y - 3);
      ctx.lineTo(p.x + 2.2, p.y - 3);
      ctx.lineTo(p.x + 3.2, p.y + 7);
      ctx.closePath(); ctx.fill();
      const active = i === dragFrom;
      const halo = ctx.createRadialGradient(p.x, p.y - 5, 1, p.x, p.y - 5, active ? 17 : 13);
      halo.addColorStop(0, `rgba(255, 186, 84, ${active ? 0.55 : 0.34})`);
      halo.addColorStop(1, 'rgba(255, 186, 84, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(p.x - 18, p.y - 23, 36, 36);
      const orb = ctx.createRadialGradient(p.x - 1.2, p.y - 6.4, 0.5, p.x, p.y - 5, 4.6);
      orb.addColorStop(0, '#fff3c4');
      orb.addColorStop(0.55, '#ffc45e');
      orb.addColorStop(1, '#e08a26');
      ctx.fillStyle = orb;
      ctx.beginPath(); ctx.arc(p.x, p.y - 5, 4.4, 0, Math.PI * 2); ctx.fill();
    });

    // Enemies.
    for (const e of state.enemies) drawEnemy(e);

    // The hearth: individual stones, crossed logs, a layered living flame.
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.18;
      const sx = cx + Math.cos(a) * (HEARTH_R + 4), sy = cy + Math.sin(a) * (HEARTH_R + 4);
      const sh = 50 + ((i * 37) % 24);
      ctx.fillStyle = `rgb(${sh}, ${sh}, ${sh + 9})`;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(sx, sy, 8.6, 6.4, a, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.fillStyle = '#17110b';
    ctx.beginPath(); ctx.arc(cx, cy, HEARTH_R - 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#4a2f16';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 10, cy + 7); ctx.lineTo(cx + 9, cy + 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 8, cy + 2); ctx.lineTo(cx + 10, cy + 8); ctx.stroke();
    if (state.flame > 0) {
      const glowR = 40 + breathe * 6 + flameFrac * 14;
      const hg = ctx.createRadialGradient(cx, cy, 2, cx, cy, glowR);
      hg.addColorStop(0, `rgba(255, 170, 70, ${0.30 * flameFrac + 0.06})`);
      hg.addColorStop(1, 'rgba(255, 120, 40, 0)');
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(cx, cy, glowR, 0, Math.PI * 2); ctx.fill();
      const baseH = 11 + flameFrac * 17;
      const layers = [
        [1.0, 'rgba(255, 102, 36, 0.85)', 9.5],
        [0.68, 'rgba(255, 179, 71, 0.95)', 6.6],
        [0.42, 'rgba(255, 240, 179, 0.98)', 4.0],
      ];
      layers.forEach(([scale, color, w], li) => {
        const h = baseH * scale;
        const tip = Math.sin(renderT * 6.3 + li * 1.7) * (1.6 + li * 0.7) + Math.sin(flicker * 1.3 + li) * 1.1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - w, cy + 8);
        ctx.quadraticCurveTo(cx - w, cy + 8 - h * 0.55, cx + tip, cy + 8 - h);
        ctx.quadraticCurveTo(cx + w, cy + 8 - h * 0.55, cx + w, cy + 8);
        ctx.quadraticCurveTo(cx, cy + 11, cx - w, cy + 8);
        ctx.fill();
      });
      // Rising embers.
      emberAcc += frameDt * (3 + 7 * flameFrac);
      while (emberAcc >= 1) {
        emberAcc -= 1;
        if (particles.length < 420) {
          const life = 1.2 + Math.random() * 0.9;
          particles.push({
            kind: 'ember',
            x: cx + (Math.random() - 0.5) * 15, y: cy - 2,
            vx: (Math.random() - 0.5) * 9, vy: -(15 + Math.random() * 24),
            life, maxLife: life, size: 1.4 + Math.random() * 1.3,
            color: Math.random() < 0.5 ? '#ffc45e' : '#ff8a3c', grav: -6, drag: 0.4,
            tw: Math.random() * Math.PI * 2,
          });
        }
      }
    }

    // Shockwave rings.
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life -= frameDt;
      if (r.life <= 0) { rings.splice(i, 1); continue; }
      r.r = Math.min(r.maxR, r.r + r.vr * frameDt);
      const a = (r.life / r.maxLife) * 0.65;
      ctx.strokeStyle = `rgba(${r.color}, ${a})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
    }

    // Particles.
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= frameDt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      if (p.grav) p.vy += p.grav * frameDt;
      if (p.drag) { const d = Math.max(0, 1 - p.drag * frameDt); p.vx *= d; p.vy *= d; }
      p.x += p.vx * frameDt; p.y += p.vy * frameDt;
      const lf = Math.max(0, p.life / p.maxLife);
      if (p.kind === 'ember') {
        ctx.globalAlpha = lf * (0.5 + 0.5 * Math.abs(Math.sin(renderT * 11 + p.tw)));
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.globalAlpha = lf;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;

    // Ambient dust motes; the ones inside the beam catch the light.
    for (const m of motes) {
      m.x += m.vx * frameDt; m.y += m.vy * frameDt;
      if (m.x < -4) m.x = ARENA.w + 4; if (m.x > ARENA.w + 4) m.x = -4;
      if (m.y < -4) m.y = ARENA.h + 4; if (m.y > ARENA.h + 4) m.y = -4;
      const tw = 0.6 + 0.4 * Math.sin(renderT * 1.7 + m.tw);
      if (inBeamVisual(m.x, m.y)) {
        ctx.fillStyle = `rgba(255, 226, 150, ${0.55 * tw})`;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 0.5, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = `rgba(200, 214, 235, ${0.13 * tw})`;
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
      }
    }

    ctx.restore();

    // Red vignette: pulses while the hearth is being gnawed / freshly hurt.
    if (state.flame < prevFlame - 0.001) hurtT = Math.min(0.7, hurtT + 0.45);
    prevFlame = state.flame;
    hurtT = Math.max(0, hurtT - frameDt);
    let warnA = 0;
    if (state.phase === 'night' && state.flame < 30) warnA = 0.13 + 0.08 * Math.sin(renderT * 5.2);
    const hurtA = (hurtT / 0.7) * 0.38 + warnA;
    if (hurtA > 0.01) {
      const hv = ctx.createRadialGradient(cx, cy, 300, cx, cy, 640);
      hv.addColorStop(0, 'rgba(205, 32, 14, 0)');
      hv.addColorStop(1, `rgba(205, 32, 14, ${Math.min(0.5, hurtA)})`);
      ctx.fillStyle = hv;
      ctx.fillRect(0, 0, ARENA.w, ARENA.h);
    }
  }

  // Per-type enemy art. Movement is always toward the hearth, so trails,
  // streaks and leans all key off that direction. Purely cosmetic.
  function drawEnemy(e) {
    const cx = ARENA.cx, cy = ARENA.cy;
    const dx = cx - e.x, dy = cy - e.y;
    const dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl;
    const fx = enemyFx.get(e.id);
    const flash = fx ? fx.flash : 0;
    const lit = inBeam(state, e.x, e.y);
    const rim = lit ? '#ffca55' : '#3a3f5c';
    const eyes = (color, size, glow) => {
      const bx = e.x + ux * e.r * 0.22, by = e.y + uy * e.r * 0.22;
      const px = -uy, py = ux;
      ctx.fillStyle = color;
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 7; }
      ctx.beginPath();
      ctx.arc(bx + px * e.r * 0.34, by + py * e.r * 0.34, size, 0, Math.PI * 2);
      ctx.arc(bx - px * e.r * 0.34, by - py * e.r * 0.34, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    };

    if (e.type === 'swift') {
      // Motion streak trailing behind.
      const sg = ctx.createLinearGradient(e.x - ux * e.r * 3.2, e.y - uy * e.r * 3.2, e.x - ux * e.r * 0.8, e.y - uy * e.r * 0.8);
      sg.addColorStop(0, 'rgba(160, 190, 255, 0)');
      sg.addColorStop(1, 'rgba(160, 190, 255, 0.35)');
      ctx.strokeStyle = sg;
      ctx.lineWidth = e.r * 0.95;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(e.x - ux * e.r * 3.2, e.y - uy * e.r * 3.2);
      ctx.lineTo(e.x - ux * e.r * 0.8, e.y - uy * e.r * 0.8);
      ctx.stroke();
      // Lean body stretched along its run.
      ctx.fillStyle = '#101020';
      ctx.strokeStyle = rim;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(e.x, e.y, e.r * 1.32, e.r * 0.8, Math.atan2(uy, ux), 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      eyes('#e8ecff', 1.7, false);
    } else if (e.type === 'wisp') {
      const bobY = Math.sin(renderT * 3 + e.phase) * 1.6;
      const wg = ctx.createRadialGradient(e.x, e.y + bobY, 1, e.x, e.y + bobY, e.r * 1.55);
      wg.addColorStop(0, 'rgba(226, 246, 255, 0.90)');
      wg.addColorStop(0.45, 'rgba(165, 215, 255, 0.42)');
      wg.addColorStop(1, 'rgba(140, 190, 255, 0)');
      ctx.fillStyle = wg;
      ctx.beginPath(); ctx.arc(e.x, e.y + bobY, e.r * 1.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(244, 253, 255, 0.95)';
      ctx.shadowColor = '#bfe6ff';
      ctx.shadowBlur = 9;
      ctx.beginPath(); ctx.arc(e.x, e.y + bobY, e.r * 0.42, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#1c2f4a';
      ctx.beginPath();
      ctx.arc(e.x - e.r * 0.3, e.y + bobY - e.r * 0.08, 1.7, 0, Math.PI * 2);
      ctx.arc(e.x + e.r * 0.3, e.y + bobY - e.r * 0.08, 1.7, 0, Math.PI * 2);
      ctx.fill();
      if (lit) {
        ctx.strokeStyle = 'rgba(255, 202, 85, 0.75)';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(e.x, e.y + bobY, e.r * 0.95, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (e.type === 'brute') {
      ctx.fillStyle = '#0a0a15';
      ctx.strokeStyle = lit ? '#ffca55' : '#54303e';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // Ember cracks smouldering across the hide (pattern seeded by phase).
      const crng = makeRng(Math.floor(e.phase * 1000) + 7);
      ctx.strokeStyle = `rgba(255, 122, 48, ${0.5 + 0.3 * Math.sin(renderT * 5 + e.phase)})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = '#ff7a30';
      ctx.shadowBlur = 7;
      for (let i = 0; i < 4; i++) {
        let a = crng() * Math.PI * 2;
        let px = e.x + Math.cos(a) * e.r * 0.25, py = e.y + Math.sin(a) * e.r * 0.25;
        ctx.beginPath(); ctx.moveTo(px, py);
        for (let sgm = 0; sgm < 3; sgm++) {
          a += (crng() - 0.5) * 1.1;
          px += Math.cos(a) * e.r * 0.26;
          py += Math.sin(a) * e.r * 0.26;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      eyes('#ffb37a', 2.6, true);
    } else {
      // Shade: wispy body with a trailing fade and a frayed lower skirt.
      for (let i = 2; i >= 1; i--) {
        ctx.fillStyle = `rgba(17, 17, 31, ${0.10 * i})`;
        ctx.beginPath();
        ctx.arc(e.x - ux * e.r * i * 0.95, e.y - uy * e.r * i * 0.95, e.r * (1 - 0.16 * i), 0, Math.PI * 2);
        ctx.fill();
      }
      const wob = renderT * 7 + e.phase;
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 14) {
        const lower = Math.sin(a) > 0 ? 1 : 0.25;
        const rr = e.r + Math.sin(a * 3 + wob) * 1.7 * lower;
        const vx = e.x + Math.cos(a) * rr, vy = e.y + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
      }
      ctx.closePath();
      ctx.fillStyle = '#141424';
      ctx.fill();
      ctx.strokeStyle = rim;
      ctx.lineWidth = 2;
      ctx.stroke();
      eyes('#dfe6ff', 1.9, true);
    }

    // Hit flash.
    if (flash > 0) {
      ctx.fillStyle = `rgba(255, 255, 255, ${(flash / 0.13) * 0.5})`;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r + 1, 0, Math.PI * 2); ctx.fill();
    }

    // HP arc when hurt.
    if (e.hp < e.maxHp) {
      ctx.strokeStyle = '#ff7a6a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r + 4, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * e.hp) / e.maxHp);
      ctx.stroke();
    }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frameDt = dt;
    renderT += dt;
    shakeT = Math.max(0, shakeT - dt);
    if (state.phase === 'title') beamDrift += dt * state.beamSpeed;
    const before = state.phase;
    stepGame(state, dt);
    // Render-side hit feedback: an enemy whose HP just dropped flashes.
    const seen = new Set();
    for (const e of state.enemies) {
      seen.add(e.id);
      const f = enemyFx.get(e.id);
      if (!f) enemyFx.set(e.id, { hp: e.hp, flash: 0 });
      else {
        if (e.hp < f.hp - 0.001) f.flash = 0.13;
        f.hp = e.hp;
        f.flash = Math.max(0, f.flash - dt);
      }
    }
    for (const id of [...enemyFx.keys()]) if (!seen.has(id)) enemyFx.delete(id);
    drainEvents();
    if (state.phase !== before) refreshOverlays();
    draw();
    requestAnimationFrame(frame);
  }
  refreshOverlays();
  requestAnimationFrame(frame);
}
