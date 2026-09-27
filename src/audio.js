// VELOCIBONK — procedural audio engine.
// Every sound and all music is synthesized live with the Web Audio API (no files, no libraries).
//
//   audio.init()                          call from a user gesture (click/keydown). Idempotent; also resumes.
//   audio.setVolumes({master,music,sfx})  0..1 each, smoothed.
//   audio.play(name, {pitch, volume, pan, combo})
//   audio.startMusic('title'|'run'|'boss'|'final')   switches on the next bar; same mode = no-op.
//   audio.setIntensity(0..1)              run-mode layering (0 drums+bass, .3 arp, .6 lead, .85 extra perc).
//   audio.stopMusic()
//   audio.setSpeed(0..1)                  every frame; drives the wind-rush layer.
//   audio.duck(amount, seconds)           temporary music dip (merges with any active duck).
//   audio.ctx                             AudioContext or null.
//
// Every public method is a silent no-op before init() or when Web Audio is unavailable. Nothing throws.

const EPS = 0.0001;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };

function rng(seed) { // mulberry32
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------
let ctx = null;
let NYQ = 20000;
let master, comp, sfxBus, sfxVerb, musicVol, duckG, fadeG, musicMix, musicLP, instBus, drumBus, distIn, echoIn, echoL, echoR, musicVerb;
let noiseW = null, noiseP = null, pulse25 = null, pulse12 = null;
let windG, windBP, whistleG, whistleBP;
const vols = { master: 0.8, music: 0.8, sfx: 1 };
const MUSIC_TRIM = 0.5; // music sits roughly half as loud as SFX by default
const SFX_TRIM = 0.8;

const fq = (f) => clamp(f, 1, NYQ);

// ---------------------------------------------------------------------------------------------
// Low-level voice builder. A "voice" is a small graph that cleans itself up (disconnects every
// node) when its last-ending source fires onended.
// ---------------------------------------------------------------------------------------------
function voice(dest, t, gain, pan, p, k) {
  const out = ctx.createGain();
  out.gain.value = gain;
  const V = { t, p, k, out, nodes: [out], last: null, end: t };
  if (pan && ctx.createStereoPanner) {
    const pn = ctx.createStereoPanner();
    pn.pan.value = clamp(pan, -1, 1);
    out.connect(pn);
    pn.connect(dest);
    V.nodes.push(pn);
  } else out.connect(dest);
  return V;
}

function finish(V) {
  const nodes = V.nodes;
  const done = () => {
    for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* already gone */ } }
    nodes.length = 0;
  };
  if (V.last) V.last.onended = done; else done();
}

function src(V, n, t0, t1, off) {
  if (off == null) n.start(t0); else n.start(t0, off);
  n.stop(t1);
  V.nodes.push(n);
  if (t1 >= V.end) { V.end = t1; V.last = n; }
}

function env(p, t, a, peak, h, d) {
  p.setValueAtTime(EPS, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (h > 0) p.setValueAtTime(peak, t + a + h);
  p.exponentialRampToValueAtTime(EPS, t + a + h + d);
}

// Oscillator "tone": f -> f2 glide, attack/hold/exp-decay envelope. Times scale by V.k, freqs by V.p.
function T(V, o) {
  const k = V.k;
  const t = V.t + (o.at || 0) * k;
  const ra = o.a == null ? 0.002 : o.a, rh = o.hold || 0, rd = o.d == null ? 0.1 : o.d;
  const a = ra * k, h = rh * k, d = rd * k;
  const end = t + a + h + d;
  const osc = ctx.createOscillator();
  if (o.wave) osc.setPeriodicWave(o.wave); else osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(fq(o.f * V.p), t);
  if (o.f2) {
    const gt = t + (o.g == null ? ra + rh + rd : o.g) * k;
    const f1 = fq(o.f2 * V.p);
    if (o.lin) osc.frequency.linearRampToValueAtTime(f1, gt);
    else osc.frequency.exponentialRampToValueAtTime(f1, gt);
  }
  if (o.det) osc.detune.value = o.det;
  const g = ctx.createGain();
  g.gain.value = 0;
  env(g.gain, t, a, Math.max(o.v == null ? 0.3 : o.v, 0.001), h, d);
  osc.connect(g);
  g.connect(o.to || V.out);
  V.nodes.push(g);
  src(V, osc, t, end + 0.01);
  return { osc, g, t, end };
}

// Filtered noise burst (shared buffers, random offset so repeats never sound identical).
function Nz(V, o) {
  const k = V.k;
  const t = V.t + (o.at || 0) * k;
  const a = (o.a == null ? 0.001 : o.a) * k, h = (o.hold || 0) * k, d = (o.d == null ? 0.1 : o.d) * k;
  const end = t + a + h + d;
  const s = ctx.createBufferSource();
  s.buffer = o.pink ? noiseP : noiseW;
  s.loop = true;
  if (o.rate) s.playbackRate.value = o.rate;
  const g = ctx.createGain();
  g.gain.value = 0;
  if (!o.noenv) env(g.gain, t, a, Math.max(o.v == null ? 0.3 : o.v, 0.001), h, d);
  let f = null;
  if (o.ft) {
    f = ctx.createBiquadFilter();
    f.type = o.ft;
    f.Q.value = o.q == null ? 1 : o.q;
    const f0 = fq(o.ff * V.p);
    f.frequency.value = f0;
    if (o.ff2) {
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(fq(o.ff2 * V.p), o.fg == null ? end : t + o.fg * k);
    }
    s.connect(f);
    f.connect(g);
    V.nodes.push(f);
  } else s.connect(g);
  g.connect(o.to || V.out);
  V.nodes.push(g);
  src(V, s, t, end + 0.01, Math.random() * s.buffer.duration * 0.9);
  return { s, g, f, t, end };
}

function Flt(V, type, f, q, sw, dest) {
  const n = ctx.createBiquadFilter();
  n.type = type;
  n.Q.value = q == null ? 1 : q;
  const f0 = fq(f * V.p);
  n.frequency.value = f0;
  if (sw) {
    const t0 = V.t + (sw.at || 0) * V.k;
    n.frequency.setValueAtTime(f0, t0);
    n.frequency.exponentialRampToValueAtTime(fq(sw.f2 * V.p), t0 + sw.g * V.k);
    if (sw.f3) n.frequency.exponentialRampToValueAtTime(fq(sw.f3 * V.p), t0 + sw.g3 * V.k);
  }
  n.connect(dest || V.out);
  V.nodes.push(n);
  return n;
}

function Gn(V, v, dest) {
  const g = ctx.createGain();
  g.gain.value = v;
  g.connect(dest || V.out);
  V.nodes.push(g);
  return g;
}

const curves = {};
function curve(amt) {
  if (curves[amt]) return curves[amt];
  const n = 1024, c = new Float32Array(n), norm = Math.tanh(amt);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(amt * x) / norm; }
  return (curves[amt] = c);
}

function Sh(V, amt, dest, os) {
  const s = ctx.createWaveShaper();
  s.curve = curve(amt);
  s.oversample = os || 'none';
  s.connect(dest || V.out);
  V.nodes.push(s);
  return s;
}

function lfo(V, params, rate, depth, t0, t1, type) {
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.value = rate;
  const g = ctx.createGain();
  g.gain.value = depth;
  o.connect(g);
  const list = Array.isArray(params) ? params : [params];
  for (let i = 0; i < list.length; i++) g.connect(list[i]);
  V.nodes.push(g);
  src(V, o, t0, t1);
  return { osc: o, depth: g };
}

function send(V, bus, amt) {
  if (!bus) return;
  const g = ctx.createGain();
  g.gain.value = amt;
  V.out.connect(g);
  g.connect(bus);
  V.nodes.push(g);
}
const wet = (V, amt) => send(V, sfxVerb, amt);

// ---------------------------------------------------------------------------------------------
// SFX definitions. Signature (V, opts). V.p = pitch multiplier, V.k = gentle time stretch.
// ---------------------------------------------------------------------------------------------
const PENTA2 = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21]; // major pentatonic ladder, 2 octaves

const SFX = {
  hit(V) {
    const j = rand(0.85, 1.15);
    Nz(V, { d: 0.045, v: 0.5, ft: 'bandpass', ff: 1900 * j, q: 1.1 });
    T(V, { type: 'triangle', f: 520 * j, f2: 170 * j, g: 0.05, a: 0.001, d: 0.06, v: 0.3 });
  },

  crit(V) {
    const j = rand(0.92, 1.08);
    Nz(V, { d: 0.06, v: 0.38, ft: 'highpass', ff: 1500 * j, q: 0.8 });
    const sh = Sh(V, 5);
    T(V, { type: 'square', f: 880 * j, f2: 220 * j, g: 0.06, a: 0.001, d: 0.07, v: 0.14, to: sh });
    T(V, { type: 'triangle', f: 320 * j, f2: 110 * j, g: 0.06, a: 0.001, d: 0.08, v: 0.3 });
    // metallic ping (inharmonic partials)
    T(V, { f: 2350 * j, a: 0.001, d: 0.3, v: 0.1 });
    T(V, { f: 3410 * j, a: 0.001, d: 0.2, v: 0.06 });
    T(V, { f: 5120 * j, a: 0.001, d: 0.12, v: 0.035 });
  },

  kill(V) {
    const j = rand(0.9, 1.1);
    T(V, { f: 1100 * j, f2: 140 * j, g: 0.09, a: 0.001, d: 0.11, v: 0.4 });
    T(V, { type: 'triangle', f: 1600 * j, f2: 600 * j, g: 0.03, a: 0.001, d: 0.035, v: 0.12 });
    Nz(V, { at: 0.004, a: 0.004, d: 0.12, v: 0.4, ft: 'lowpass', ff: 3400 * j, ff2: 280, fg: 0.12, q: 3 });
  },

  // THE signature sound: hollow wooden cartoon BONK.
  bonk(V) {
    const j = rand(0.94, 1.06);
    Nz(V, { d: 0.012, v: 0.3, ft: 'highpass', ff: 3200, q: 0.7 });                            // crack transient
    T(V, { f: 620 * j, f2: 150 * j, g: 0.11, a: 0.001, d: 0.26, v: 0.62 });                    // hollow body drop
    T(V, { type: 'triangle', f: 930 * j, f2: 225 * j, g: 0.09, a: 0.001, d: 0.15, v: 0.2 });   // hollow 3:2 partial
    T(V, { f: 1900 * j, f2: 1450 * j, g: 0.03, a: 0.0005, d: 0.035, v: 0.28 });               // woodblock "tok"
    Nz(V, { d: 0.045, v: 1.6, ft: 'bandpass', ff: 1250 * j, q: 6 });                            // resonant wood click
    Nz(V, { d: 0.08, v: 1.4, ft: 'bandpass', ff: 700 * j, q: 12 });                             // box resonance
    T(V, { f: 135 * j, f2: 55, g: 0.09, a: 0.001, d: 0.13, v: 0.42 });                          // weight thump
    const b = T(V, { at: 0.03, f: 235 * j, f2: 300 * j, g: 0.3, lin: 1, a: 0.012, d: 0.3, v: 0.1 }); // boing tail
    lfo(V, b.osc.frequency, 16, 30 * j * V.p, b.t, b.end + 0.01);
  },

  swing(V) {
    const j = rand(0.9, 1.1);
    Nz(V, { a: 0.06, d: 0.13, v: 0.5, ft: 'bandpass', ff: 420 * j, ff2: 2700 * j, fg: 0.13, q: 1.6 });
    Nz(V, { at: 0.03, a: 0.03, d: 0.07, v: 0.12, ft: 'highpass', ff: 3500 * j });
  },

  shoot(V) {
    const j = rand(0.95, 1.05);
    T(V, { type: 'triangle', f: 1500 * j, f2: 520 * j, g: 0.09, a: 0.002, d: 0.1, v: 0.18 });
    T(V, { f: 3000 * j, f2: 1300 * j, g: 0.05, a: 0.001, d: 0.05, v: 0.045 });
  },

  zap(V) {
    const j = rand(0.9, 1.1);
    const t = V.t, D = 0.15 * V.k;
    const gate = Gn(V, 0);
    let x = 0;
    while (x < D) { gate.gain.setValueAtTime(Math.random() < 0.62 ? rand(0.55, 1) : 0.04, t + x); x += rand(0.005, 0.011) * V.k; }
    gate.gain.setValueAtTime(0, t + D);
    const bp = Flt(V, 'bandpass', 1500 * j, 0.7, null, gate);
    const sh = Sh(V, 6, bp);
    const o = T(V, { type: 'sawtooth', f: 95 * j, a: 0.002, hold: 0.09, d: 0.06, v: 0.5, to: sh });
    for (let y = 0.012; y < 0.15; y += 0.012) o.osc.frequency.setValueAtTime(fq(95 * j * V.p * rand(0.7, 1.5)), t + y * V.k);
    T(V, { type: 'square', f: 1800 * j, f2: 900 * j, g: 0.15, a: 0.002, hold: 0.08, d: 0.06, v: 0.05, to: gate });
    Nz(V, { a: 0.001, hold: 0.08, d: 0.07, v: 0.3, ft: 'highpass', ff: 2600, to: gate });
  },

  explosion(V) {
    const j = rand(0.9, 1.1);
    const sh = Sh(V, 2.5);
    T(V, { f: 150 * j, f2: 32, g: 0.45, a: 0.003, d: 0.7, v: 0.85, to: sh });
    Nz(V, { a: 0.004, d: 0.95, v: 0.75, ft: 'lowpass', ff: 3500 * j, ff2: 150, fg: 0.8, q: 0.8, pink: 1 });
    Nz(V, { d: 0.05, v: 0.35, ft: 'highpass', ff: 1200 });
    wet(V, 0.25);
  },

  fire(V) {
    const j = rand(0.9, 1.1);
    Nz(V, { a: 0.03, d: 0.26, v: 0.55, ft: 'lowpass', ff: 380 * j, ff2: 2400 * j, fg: 0.1, q: 1.5, pink: 1 });
    T(V, { f: 110 * j, f2: 60, g: 0.2, a: 0.02, d: 0.2, v: 0.22 });
    const cg = Gn(V, 0);
    const times = [];
    for (let i = 0; i < 7; i++) times.push(rand(0.01, 0.28));
    times.sort((a, b) => a - b);
    let lastOff = 0;
    for (const ct of times) {
      const tt = V.t + ct * V.k;
      if (tt <= lastOff) continue;
      cg.gain.setValueAtTime(rand(0.3, 0.8), tt);
      cg.gain.setValueAtTime(0, tt + 0.005);
      lastOff = tt + 0.005;
    }
    Nz(V, { a: 0.001, hold: 0.28, d: 0.02, v: 0.8, ft: 'highpass', ff: 2200, to: cg });
  },

  boomerang(V) {
    const j = rand(0.95, 1.05);
    const lp = Flt(V, 'lowpass', 700, 7);
    const o = T(V, { type: 'sawtooth', f: 165 * j, f2: 138 * j, a: 0.03, hold: 0.16, d: 0.2, v: 0.28, to: lp });
    lfo(V, lp.frequency, 13, 520 * V.p, o.t, o.end + 0.01);
    const trem = Gn(V, 0.7);
    lfo(V, trem.gain, 13, 0.3, o.t, o.end + 0.01);
    T(V, { type: 'triangle', f: 330 * j, f2: 280 * j, a: 0.03, hold: 0.16, d: 0.2, v: 0.08, to: trem });
  },

  saw(V) {
    const j = rand(0.94, 1.06);
    const bp = Flt(V, 'bandpass', 3200, 3);
    T(V, { type: 'sawtooth', f: 1400 * j, f2: 2300 * j, g: 0.12, a: 0.002, d: 0.16, v: 0.14, to: bp });
    T(V, { f: 2600 * j, f2: 3100 * j, g: 0.1, a: 0.001, d: 0.2, v: 0.08 });
    T(V, { f: 3770 * j, a: 0.001, d: 0.14, v: 0.05 });
    Nz(V, { d: 0.02, v: 0.2, ft: 'highpass', ff: 5000 });
  },

  lance(V) {
    const j = rand(0.97, 1.03);
    Nz(V, { a: 0.002, d: 0.08, v: 0.3, ft: 'highpass', ff: 2500 * j });
    const lp = Flt(V, 'lowpass', 900, 5, { f2: 5000, g: 0.35 });
    T(V, { type: 'sawtooth', f: 260 * j, f2: 1300 * j, g: 0.38, a: 0.02, hold: 0.2, d: 0.2, v: 0.16, to: lp });
    T(V, { type: 'sawtooth', f: 262 * j, f2: 1310 * j, g: 0.38, det: 14, a: 0.02, hold: 0.2, d: 0.2, v: 0.11, to: lp });
    T(V, { f: 130 * j, f2: 650 * j, g: 0.38, a: 0.02, hold: 0.2, d: 0.2, v: 0.14 });
    Nz(V, { a: 0.1, hold: 0.1, d: 0.2, v: 0.2, ft: 'bandpass', ff: 1500 * j, ff2: 6000 * j, fg: 0.4, q: 2 });
  },

  // XP pickup: each combo step climbs one rung of a major-pentatonic ladder (wraps every 2 octaves).
  // The ladder is rooted so it always sits inside the current music key.
  gem(V, o) {
    const c = Math.max(0, Math.floor(+o.combo || 0));
    const base = (MODES[curMode || pendMode || 'run'] || MODES.run).gem;
    const f = mtof(base + PENTA2[c % PENTA2.length]);
    T(V, { f: f * 0.985, f2: f, g: 0.012, a: 0.002, d: 0.09, v: 0.2 });
    T(V, { type: 'triangle', f: f * 2, a: 0.001, d: 0.05, v: 0.05 });
  },

  coin(V) {
    const lp = Flt(V, 'lowpass', 6000, 0.7);
    T(V, { type: 'square', f: 987.77, a: 0.001, hold: 0.07, d: 0.012, v: 0.11, to: lp });
    T(V, { type: 'square', at: 0.075, f: 1318.5, a: 0.001, hold: 0.05, d: 0.35, v: 0.11, to: lp });
  },

  heal(V) {
    [0, 4, 7, 12].forEach((n, i) => {
      const f = 523.25 * Math.pow(2, n / 12);
      T(V, { at: i * 0.07, f, a: 0.01, d: 0.45, v: 0.12 });
      T(V, { type: 'triangle', at: i * 0.07, f: f * 2, a: 0.005, d: 0.2, v: 0.025 });
    });
    T(V, { f: 523.25, f2: 1046.5, g: 0.3, a: 0.15, d: 0.3, v: 0.05 });
    wet(V, 0.4);
  },

  levelup(V) {
    const lp = Flt(V, 'lowpass', 5200, 0.8);
    [72, 76, 79, 84, 88, 91].forEach((m, i) => {
      T(V, { wave: pulse25, type: 'square', at: i * 0.06, f: mtof(m), a: 0.003, hold: 0.04, d: 0.18, v: 0.1, to: lp });
    });
    [72, 76, 79, 84].forEach((m) => {
      T(V, { type: 'sawtooth', at: 0.38, f: mtof(m), det: rand(-7, 7), a: 0.01, hold: 0.3, d: 0.35, v: 0.055, to: lp });
      T(V, { wave: pulse25, type: 'square', at: 0.38, f: mtof(m), det: 5, a: 0.01, hold: 0.3, d: 0.35, v: 0.045, to: lp });
    });
    T(V, { type: 'triangle', at: 0.38, f: mtof(48), a: 0.005, hold: 0.2, d: 0.4, v: 0.25 });
    [0, 4, 7, 12, 7, 16].forEach((n, i) => T(V, { at: 0.4 + i * 0.05, f: mtof(96 + n), a: 0.001, d: 0.12, v: 0.03 }));
    Nz(V, { at: 0.38, d: 0.5, v: 0.12, ft: 'highpass', ff: 5000 });
    wet(V, 0.35);
  },

  pick(V) {
    T(V, { wave: pulse25, type: 'square', f: mtof(79), a: 0.002, hold: 0.04, d: 0.08, v: 0.11 });
    T(V, { wave: pulse25, type: 'square', at: 0.07, f: mtof(84), a: 0.002, hold: 0.06, d: 0.25, v: 0.11 });
    T(V, { at: 0.07, f: mtof(91), a: 0.002, d: 0.3, v: 0.05 });
    Nz(V, { d: 0.03, v: 0.12, ft: 'highpass', ff: 4000 });
    wet(V, 0.25);
  },

  legendary(V) {
    const lp = Flt(V, 'lowpass', 900, 1.5, { f2: 7000, g: 0.6 });
    [48, 55, 60, 64, 67, 71, 74].forEach((m) => {
      for (const d of [-9, 9]) T(V, { type: 'sawtooth', f: mtof(m), det: d + rand(-3, 3), a: 0.05, hold: 1.0, d: 0.8, v: 0.035, to: lp });
    });
    const trem = Gn(V, 0.7);
    lfo(V, trem.gain, 7, 0.3, V.t, V.t + 2 * V.k);
    [84, 88, 91, 95].forEach((m) => T(V, { at: 0.1, f: mtof(m), a: 0.2, hold: 0.8, d: 0.7, v: 0.03, to: trem }));
    [72, 76, 79, 84, 88, 91, 96].forEach((m, i) => T(V, { type: 'triangle', at: i * 0.05, f: mtof(m), a: 0.002, d: 0.3, v: 0.05 }));
    T(V, { f: 110, f2: 55, g: 0.5, a: 0.005, d: 0.5, v: 0.3 });
    Nz(V, { d: 1.2, v: 0.12, ft: 'highpass', ff: 4500 });
    wet(V, 0.5);
  },

  chest(V) {
    const bp = Flt(V, 'bandpass', 800, 6);
    const c = T(V, { type: 'sawtooth', f: 60, f2: 95, lin: 1, a: 0.03, hold: 0.25, d: 0.08, v: 0.4, to: bp });
    lfo(V, c.osc.frequency, 19, 16, c.t, c.end + 0.01, 'sawtooth');
    T(V, { at: 0.36, f: 300, f2: 900, g: 0.06, a: 0.001, d: 0.08, v: 0.25 });
    [84, 86, 88, 91, 93, 96, 100].forEach((m, i) => {
      T(V, { at: 0.4 + i * 0.045, f: mtof(m), a: 0.002, d: 0.3, v: 0.07 });
      T(V, { type: 'triangle', at: 0.4 + i * 0.045, f: mtof(m) * 2, a: 0.002, d: 0.12, v: 0.015 });
    });
    [72, 76, 79, 84].forEach((m) => T(V, { type: 'triangle', at: 0.4, f: mtof(m), a: 0.05, hold: 0.2, d: 0.5, v: 0.04 }));
    wet(V, 0.4);
  },

  shrine(V) {
    const lp = Flt(V, 'lowpass', 500, 2, { f2: 4500, g: 1.2 });
    [57, 64, 69, 71, 76].forEach((m) => {
      for (const d of [-8, 8]) T(V, { type: 'sawtooth', f: mtof(m), f2: mtof(m + 2), g: 1.3, lin: 1, det: d, a: 0.8, hold: 0.2, d: 0.5, v: 0.035, to: lp });
    });
    const s = T(V, { f: mtof(88), f2: mtof(90), g: 1.3, lin: 1, a: 0.6, hold: 0.3, d: 0.6, v: 0.04 });
    lfo(V, s.osc.frequency, 5.5, 9 * V.p, s.t, s.end + 0.01);
    Nz(V, { a: 0.9, d: 0.5, v: 0.08, ft: 'bandpass', ff: 1200, ff2: 6000, fg: 1.3, q: 2 });
    wet(V, 0.6);
  },

  jump(V) {
    const j = rand(0.97, 1.03);
    T(V, { type: 'triangle', f: 240 * j, f2: 640 * j, g: 0.09, a: 0.003, d: 0.13, v: 0.3 });
    T(V, { f: 120 * j, f2: 320 * j, g: 0.09, a: 0.003, d: 0.1, v: 0.18 });
  },

  doublejump(V) {
    const j = rand(0.97, 1.03);
    const trem = Gn(V, 0.7);
    const o = T(V, { type: 'triangle', f: 420 * j, f2: 1050 * j, g: 0.08, a: 0.003, d: 0.16, v: 0.26, to: trem });
    lfo(V, trem.gain, 34, 0.3, o.t, o.end + 0.01);
    T(V, { at: 0.05, f: 700 * j, f2: 1400 * j, g: 0.06, a: 0.002, d: 0.08, v: 0.1 });
    Nz(V, { a: 0.02, d: 0.1, v: 0.14, ft: 'bandpass', ff: 1500, ff2: 5000, fg: 0.1, q: 1.5 });
  },

  land(V) {
    T(V, { f: 130, f2: 50, g: 0.08, a: 0.002, d: 0.12, v: 0.4 });
    Nz(V, { d: 0.07, v: 0.4, ft: 'lowpass', ff: 500, q: 0.7, pink: 1 });
  },

  slide(V) {
    const j = rand(0.95, 1.05);
    const grit = Gn(V, 0.7);
    lfo(V, grit.gain, 47, 0.3, V.t, V.t + 0.32 * V.k, 'square');
    Nz(V, { a: 0.02, hold: 0.1, d: 0.18, v: 0.6, ft: 'lowpass', ff: 1400 * j, ff2: 650 * j, fg: 0.3, q: 2.5, to: grit });
    Nz(V, { a: 0.01, hold: 0.08, d: 0.15, v: 0.15, ft: 'bandpass', ff: 3200 * j, q: 2, to: grit });
  },

  slam(V) {
    Nz(V, { a: 0.01, d: 0.28, v: 0.5, ft: 'bandpass', ff: 2600, ff2: 250, fg: 0.25, q: 1.3 }); // downward whoosh
    const sh = Sh(V, 3);
    T(V, { at: 0.03, f: 120, f2: 28, g: 0.35, a: 0.002, d: 0.55, v: 0.8, to: sh });
    Nz(V, { at: 0.03, d: 0.5, v: 0.7, ft: 'lowpass', ff: 1800, ff2: 120, fg: 0.45, pink: 1 });
    Nz(V, { at: 0.03, d: 0.04, v: 0.3, ft: 'highpass', ff: 1500 });
    T(V, { at: 0.03, type: 'triangle', f: 320, f2: 90, g: 0.06, a: 0.001, d: 0.1, v: 0.25 });
    wet(V, 0.2);
  },

  jumppad(V) {
    const o = T(V, { f: 160, f2: 620, g: 0.35, a: 0.004, hold: 0.1, d: 0.4, v: 0.4 });
    const o2 = T(V, { type: 'triangle', f: 320, f2: 1240, g: 0.35, a: 0.004, hold: 0.1, d: 0.3, v: 0.12 });
    const l1 = lfo(V, o.osc.frequency, 15, 60 * V.p, o.t, o.end + 0.01);
    const l2 = lfo(V, o2.osc.frequency, 15, 120 * V.p, o2.t, o2.end + 0.01);
    for (const l of [l1, l2]) {
      l.depth.gain.setValueAtTime(l.depth.gain.value, o.t);
      l.depth.gain.exponentialRampToValueAtTime(Math.max(l.depth.gain.value * 0.05, EPS), o.t + 0.5 * V.k);
    }
    T(V, { f: 90, f2: 50, g: 0.1, a: 0.001, d: 0.12, v: 0.3 });
  },

  boost(V) {
    Nz(V, { a: 0.12, d: 0.35, v: 0.45, ft: 'bandpass', ff: 300, ff2: 4500, fg: 0.4, q: 1.2 });
    const lp = Flt(V, 'lowpass', 600, 4, { f2: 3500, g: 0.35 });
    T(V, { type: 'sawtooth', f: 90, f2: 360, g: 0.4, a: 0.05, hold: 0.1, d: 0.3, v: 0.18, to: lp });
    T(V, { type: 'sawtooth', f: 91.5, f2: 366, g: 0.4, a: 0.05, hold: 0.1, d: 0.3, v: 0.13, to: lp });
  },

  hurt(V) {
    const j = rand(0.95, 1.05);
    const lp = Flt(V, 'lowpass', 1300, 1.5);
    const sh = Sh(V, 5, lp);
    T(V, { type: 'square', f: 190 * j, f2: 70 * j, g: 0.16, a: 0.003, d: 0.22, v: 0.3, to: sh });
    T(V, { f: 110 * j, f2: 45 * j, g: 0.12, a: 0.002, d: 0.2, v: 0.5 });
    Nz(V, { d: 0.08, v: 0.4, ft: 'bandpass', ff: 900 * j, q: 1.2 });
    const bp = Flt(V, 'bandpass', 550, 4);
    T(V, { type: 'sawtooth', f: 160 * j, f2: 95 * j, g: 0.2, a: 0.01, d: 0.2, v: 0.45, to: bp });
  },

  // Sad trombone: wah-wah-wah-waaaah.
  death(V) {
    const notes = [55, 54, 53, 52], starts = [0, 0.42, 0.84, 1.26], durs = [0.36, 0.36, 0.36, 1.0];
    notes.forEach((m, i) => {
      const t = V.t + starts[i] * V.k, dur = durs[i] * V.k;
      const lp = Flt(V, 'lowpass', 300, 5);
      lp.frequency.setValueAtTime(fq(300 * V.p), t);
      lp.frequency.exponentialRampToValueAtTime(fq(1700 * V.p), t + 0.09 * V.k);
      lp.frequency.exponentialRampToValueAtTime(fq(450 * V.p), t + dur);
      const f = mtof(m), last = i === 3;
      const a = T(V, { type: 'sawtooth', at: starts[i], f, f2: f * (last ? 0.94 : 0.97), g: durs[i], a: 0.03, hold: durs[i] - 0.1, d: 0.14, v: 0.22, to: lp });
      const b = T(V, { type: 'square', at: starts[i], f, f2: f * (last ? 0.94 : 0.97), g: durs[i], det: -8, a: 0.03, hold: durs[i] - 0.1, d: 0.14, v: 0.09, to: lp });
      if (last) {
        const l = lfo(V, [a.osc.frequency, b.osc.frequency], 5.5, 0.0001, a.t, a.end + 0.01);
        l.depth.gain.setValueAtTime(0.0001, a.t);
        l.depth.gain.linearRampToValueAtTime(f * 0.025 * V.p, a.t + 0.5 * V.k);
      }
    });
    wet(V, 0.25);
  },

  ram(V) {
    const j = rand(0.93, 1.07);
    T(V, { f: 460 * j, f2: 95 * j, g: 0.13, a: 0.001, d: 0.3, v: 0.66 });
    T(V, { type: 'triangle', f: 690 * j, f2: 140 * j, g: 0.1, a: 0.001, d: 0.16, v: 0.24 });
    T(V, { f: 1500 * j, f2: 1100 * j, g: 0.03, a: 0.0005, d: 0.035, v: 0.25 });
    Nz(V, { d: 0.05, v: 1.6, ft: 'bandpass', ff: 950 * j, q: 5 });
    const sh = Sh(V, 2.5);
    T(V, { f: 95, f2: 38, g: 0.15, a: 0.001, d: 0.25, v: 0.55, to: sh });
    let at = 0.012;
    for (let i = 0; i < 4; i++) { Nz(V, { at, d: 0.05, v: 0.3, ft: 'bandpass', ff: rand(600, 2400), q: 2.5 }); at += rand(0.01, 0.025); }
    Nz(V, { d: 0.25, v: 0.4, ft: 'lowpass', ff: 900, ff2: 200, fg: 0.2, pink: 1 });
  },

  bossroar(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 220, 6, { f2: 1900, g: 0.5, f3: 700, g3: 1.3 });
    lp.frequency.exponentialRampToValueAtTime(fq(250 * V.p), t + 2 * k);
    const sh = Sh(V, 8, lp, '2x');
    const growl = Gn(V, 0.7, sh);
    const l = lfo(V, growl.gain, 27, 0.3, t, t + 2.05 * k);
    l.osc.frequency.setValueAtTime(27, t);
    l.osc.frequency.linearRampToValueAtTime(18, t + 2 * k);
    for (const [f, det] of [[55, -12], [55, 10], [82.4, 5], [41.2, 0]]) {
      const o = T(V, { type: 'sawtooth', f: f * 0.8, f2: f * 1.15, g: 0.5, a: 0.15, hold: 1.3, d: 0.5, v: 0.2, det, to: growl });
      o.osc.frequency.exponentialRampToValueAtTime(fq(f * 0.75 * V.p), t + 2 * k);
    }
    Nz(V, { a: 0.2, hold: 1.0, d: 0.6, v: 0.3, ft: 'bandpass', ff: 500, ff2: 900, fg: 0.6, q: 1.5, to: growl });
    wet(V, 0.3);
  },

  bossslam(V) {
    const sh = Sh(V, 4);
    T(V, { f: 90, f2: 24, g: 0.9, a: 0.002, d: 1.3, v: 0.85, to: sh });
    T(V, { f: 55, f2: 30, g: 0.6, a: 0.005, d: 1.0, v: 0.6 });
    Nz(V, { d: 1.4, v: 0.8, ft: 'lowpass', ff: 2200, ff2: 90, fg: 1.1, pink: 1 });
    Nz(V, { d: 0.06, v: 0.5, ft: 'highpass', ff: 900 });
    T(V, { type: 'triangle', f: 240, f2: 60, g: 0.12, a: 0.001, d: 0.15, v: 0.3 });
    wet(V, 0.35);
  },

  // Alarm: wee-woo, wee-woo.
  warning(V) {
    const lp = Flt(V, 'lowpass', 3200, 0.8);
    const a = T(V, { type: 'square', f: 880, a: 0.01, hold: 0.95, d: 0.08, v: 0.12, to: lp });
    const b = T(V, { type: 'sawtooth', f: 880, det: 8, a: 0.01, hold: 0.95, d: 0.08, v: 0.07, to: lp });
    for (const o of [a.osc, b.osc]) {
      const fr = o.frequency, t = V.t, k = V.k, hi = fq(880 * V.p), lo = fq(660 * V.p);
      for (let i = 0; i < 2; i++) {
        const t0 = t + i * 0.5 * k;
        fr.setValueAtTime(hi, t0 + 0.001);
        fr.setValueAtTime(hi, t0 + 0.22 * k);
        fr.linearRampToValueAtTime(lo, t0 + 0.26 * k);
        fr.setValueAtTime(lo, t0 + 0.47 * k);
        if (i === 0) fr.linearRampToValueAtTime(hi, t0 + 0.5 * k);
      }
    }
    T(V, { f: 110, a: 0.01, hold: 0.95, d: 0.08, v: 0.15 });
  },

  swarm(V) {
    const t = V.t, k = V.k;
    Nz(V, { a: 1.35, d: 0.15, v: 0.3, ft: 'bandpass', ff: 200, ff2: 5000, fg: 1.45, q: 3 });
    const lp = Flt(V, 'lowpass', 300, 3, { f2: 4000, g: 1.4 });
    const trem = Gn(V, 0.7, lp);
    const l = lfo(V, trem.gain, 4, 0.3, t, t + 1.52 * k);
    l.osc.frequency.setValueAtTime(4, t);
    l.osc.frequency.exponentialRampToValueAtTime(22, t + 1.45 * k);
    for (const d of [-15, 0, 15]) T(V, { type: 'sawtooth', f: 55, f2: 220, g: 1.45, a: 1.3, d: 0.15, v: 0.12, det: d, to: trem });
    T(V, { f: 27.5, f2: 55, g: 1.45, a: 1.2, d: 0.25, v: 0.3 });
    wet(V, 0.3);
  },

  uihover(V) {
    T(V, { f: 2400, a: 0.001, d: 0.02, v: 0.06 });
    Nz(V, { d: 0.006, v: 0.05, ft: 'highpass', ff: 6000 });
  },

  uiclick(V) {
    T(V, { f: 1000, f2: 420, g: 0.04, a: 0.001, d: 0.05, v: 0.24 });
    T(V, { type: 'triangle', f: 2000, a: 0.0005, d: 0.015, v: 0.07 });
    Nz(V, { d: 0.01, v: 0.18, ft: 'highpass', ff: 3000 });
  },

  reroll(V) {
    let at = 0;
    for (let i = 0; i < 9; i++) { Nz(V, { at, a: 0.001, d: 0.022, v: 0.3, ft: 'bandpass', ff: 2200 + i * 260, q: 2.2 }); at += rand(0.022, 0.034); }
    T(V, { type: 'triangle', f: 400, f2: 900, g: 0.28, a: 0.02, d: 0.26, v: 0.06 });
  },

  newbest(V) {
    const lp = Flt(V, 'lowpass', 5500, 0.7);
    [[0, 72, 0.1], [0.11, 76, 0.1], [0.22, 79, 0.1], [0.33, 84, 0.22], [0.58, 79, 0.1], [0.69, 84, 0.55]].forEach(([at, m, d]) => {
      T(V, { wave: pulse25, type: 'square', at, f: mtof(m), a: 0.003, hold: d * 0.7, d: d * 0.6 + 0.08, v: 0.1, to: lp });
      T(V, { type: 'triangle', at, f: mtof(m - 12), a: 0.003, hold: d * 0.6, d: d * 0.5 + 0.05, v: 0.1 });
    });
    [72, 76, 79].forEach((m) => T(V, { type: 'sawtooth', at: 0.69, f: mtof(m), det: rand(-7, 7), a: 0.01, hold: 0.35, d: 0.4, v: 0.045, to: lp }));
    [0, 4, 7, 12].forEach((n, i) => T(V, { at: 0.69 + i * 0.06, f: mtof(96 + n), a: 0.001, d: 0.4, v: 0.035 }));
    Nz(V, { at: 0.69, d: 0.6, v: 0.12, ft: 'highpass', ff: 5000 });
    wet(V, 0.35);
  },
};

// Voice limiting: [min interval ms, max concurrent voices, priority 0 low / 1 normal / 2 high]
const LIMITS = {
  hit: [35, 5, 0], crit: [45, 4, 0], kill: [30, 5, 0], bonk: [40, 5, 1], swing: [60, 3, 0],
  shoot: [40, 4, 0], zap: [60, 3, 0], explosion: [70, 4, 1], fire: [60, 3, 0], boomerang: [90, 3, 0],
  saw: [50, 3, 0], lance: [90, 3, 0], gem: [25, 6, 0], coin: [60, 3, 1], heal: [150, 2, 1],
  levelup: [300, 1, 2], pick: [100, 2, 2], legendary: [300, 1, 2], chest: [300, 2, 2], shrine: [400, 1, 2],
  jump: [60, 2, 1], doublejump: [60, 2, 1], land: [80, 2, 1], slide: [120, 2, 1], slam: [150, 2, 2],
  jumppad: [120, 2, 1], boost: [150, 2, 1], hurt: [120, 2, 2], death: [1000, 1, 2], ram: [45, 4, 1],
  bossroar: [500, 1, 2], bossslam: [150, 2, 2], warning: [800, 1, 2], swarm: [800, 1, 2],
  uihover: [30, 2, 1], uiclick: [40, 3, 2], reroll: [100, 2, 2], newbest: [800, 1, 2],
};
const GLOBAL_CAP = [24, 40, 60]; // max total active voices before a sound of that priority is dropped
// Big stingers dip the music automatically (merged with any explicit duck()).
const AUTODUCK = {
  levelup: [0.45, 0.9], legendary: [0.5, 1.6], bossroar: [0.55, 1.8], warning: [0.35, 1.0],
  newbest: [0.45, 1.3], death: [0.6, 2.0], shrine: [0.35, 1.4], swarm: [0.3, 1.2], chest: [0.3, 0.8],
};

const lastPlay = {};
const activeByName = {};
const activeAll = [];
function prune(arr, now) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > now) arr[w++] = arr[i];
  arr.length = w;
  return arr;
}

// ---------------------------------------------------------------------------------------------
// Music
// ---------------------------------------------------------------------------------------------
const R_TITLE = [
  [[0, 4], [6, 2], [8, 6]],
  [[0, 2], [2, 2], [4, 4], [10, 2], [12, 4]],
  [[0, 6], [6, 6], [12, 4]],
  [[2, 2], [4, 2], [6, 2], [8, 8]],
  [[0, 3], [3, 3], [6, 2], [10, 6]],
];
const R_RUN = [
  [[0, 3], [3, 3], [6, 2], [8, 2], [10, 2], [12, 4]],
  [[0, 2], [2, 2], [4, 4], [8, 3], [11, 3], [14, 2]],
  [[0, 4], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
  [[0, 3], [3, 5], [8, 3], [11, 5]],
  [[2, 2], [4, 2], [6, 4], [10, 2], [12, 4]],
  [[0, 6], [6, 2], [8, 2], [10, 2], [12, 2], [14, 2]],
];
const R_BOSS = [
  [[0, 6], [6, 6], [12, 4]],
  [[0, 3], [3, 3], [6, 10]],
  [[0, 8], [8, 4], [12, 2], [14, 2]],
  [[0, 2], [2, 2], [4, 4], [8, 8]],
];
const ARPS = [
  [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3],
  [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0, 1, 2, 3],
  [0, 2, 1, 3, 0, 2, 1, 3, 1, 3, 2, 0, 1, 3, 2, 3],
  [3, 2, 1, 0, 3, 2, 1, 0, 2, 1, 0, 1, 2, 3, 2, 1],
];

// prog: [root pitch class, chord intervals] per bar (4-bar loop). scale: melody pitch classes.
// gem: MIDI root of the pickup ladder (a major pentatonic that lives inside the key).
const MODES = {
  title: { bpm: 100, swing: 0.12, prog: [[5, [0, 4, 7, 11]], [4, [0, 3, 7, 10]], [2, [0, 3, 7, 10]], [0, [0, 4, 7, 11]]], scale: [0, 2, 4, 7, 9], lo: 72, hi: 88, rhythms: R_TITLE, seeds: [11, 12, 11, 13], gem: 72 },
  run: { bpm: 150, swing: 0, prog: [[9, [0, 3, 7]], [5, [0, 4, 7]], [0, [0, 4, 7]], [7, [0, 4, 7]]], scale: [0, 2, 4, 7, 9], lo: 67, hi: 84, rhythms: R_RUN, seeds: [21, 22, 21, 23], gem: 72 },
  boss: { bpm: 150, swing: 0, prog: [[0, [0, 3, 7]], [8, [0, 4, 7]], [5, [0, 3, 7]], [7, [0, 4, 7]]], scale: [0, 2, 3, 5, 7, 8, 11], lo: 60, hi: 79, rhythms: R_BOSS, seeds: [31, 32, 31, 33], gem: 75 },
  final: { bpm: 165, swing: 0, prog: [[2, [0, 3, 7]], [10, [0, 4, 7]], [0, [0, 4, 7]], [9, [0, 4, 7]]], scale: [2, 4, 5, 7, 9, 10, 1], lo: 65, hi: 84, rhythms: R_RUN, seeds: [41, 42, 43, 42], gem: 77 },
};

let curMode = null, pendMode = null, timer = null, nextT = 0, mstep = 0, stopToken = 0;
let wantMode = null; // startMusic() requested before init(): honoured once the context exists
let intensity = 0;
const LOOKAHEAD = 0.12, TICK_MS = 25;

function voicing(pc, ivs, lo) {
  const v = ivs.map((iv) => { let n = pc + iv; while (n < lo) n += 12; while (n >= lo + 12) n -= 12; return n; });
  return v.sort((a, b) => a - b);
}
function arpTones(pc, ivs, lo) { const v = voicing(pc, ivs, lo); if (v.length < 4) v.push(v[0] + 12); return v; }
function bassRoot(pc, lo) { let n = pc + 12; while (n < lo) n += 12; while (n >= lo + 12) n -= 12; return n; }
function pool(pcs, lo, hi) { const out = []; for (let n = lo; n <= hi; n++) if (pcs.indexOf(((n % 12) + 12) % 12) >= 0) out.push(n); return out; }

const melCache = {};
function genBars(M, seed) {
  const r = rng(seed * 7919 + 13);
  const scale = pool(M.scale, M.lo, M.hi);
  let prev = scale[Math.floor(scale.length / 2)];
  const bars = [];
  for (let b = 0; b < 4; b++) {
    const [pc, ivs] = M.prog[b];
    const ct = pool(ivs.map((iv) => (pc + iv) % 12), M.lo, M.hi);
    const tmpl = M.rhythms[Math.floor(r() * M.rhythms.length)];
    const ev = [];
    for (let i = 0; i < tmpl.length; i++) {
      const [st, len] = tmpl[i];
      const strong = st % 4 === 0 || len >= 4;
      const src = strong ? ct : scale;
      const dir = r() < 0.5 ? -1 : 1;
      const target = prev + dir * (1 + Math.floor(r() * (r() < 0.2 ? 6 : 3)));
      let best = src[0], bestScore = 1e9;
      for (const n of src) {
        const sc = Math.abs(n - target) + (n === prev ? 1.5 : 0) + r() * 1.2;
        if (sc < bestScore) { bestScore = sc; best = n; }
      }
      ev.push([st, len, best]);
      prev = best;
    }
    bars.push(ev);
  }
  // resolve the phrase ending onto the last chord's root
  const lastBar = bars[3], lastEv = lastBar[lastBar.length - 1];
  const roots = pool([M.prog[3][0]], M.lo, M.hi);
  if (roots.length) lastEv[2] = roots.reduce((a, n) => (Math.abs(n - lastEv[2]) < Math.abs(a - lastEv[2]) ? n : a), roots[0]);
  return bars;
}
function mel(mk, seed) { const key = mk + ':' + seed; return melCache[key] || (melCache[key] = genBars(MODES[mk], seed)); }
// 8-bar phrase: A0 A1 A2 A3 | A0 A1 B2 B3, and a new seed every 8 bars (so the hook returns but varies).
function leadEv(mk, bar, s) {
  const M = MODES[mk];
  const phrase = Math.floor(bar / 8), pb = bar % 8;
  const seed = M.seeds[phrase % M.seeds.length];
  const evs = pb < 4 ? mel(mk, seed)[pb] : pb < 6 ? mel(mk, seed)[pb - 4] : mel(mk, seed + 100)[pb - 4];
  for (let i = 0; i < evs.length; i++) if (evs[i][0] === s) return evs[i];
  return null;
}

// --- instruments -------------------------------------------------------------------------------
function mv(t, dest, pan) { return voice(dest, t, 1, pan || 0, 1, 1); }

function mKick(t, v) {
  const V = mv(t, drumBus);
  T(V, { f: 160, f2: 44, g: 0.09, a: 0.001, d: 0.32, v: 0.95 * v });
  T(V, { type: 'triangle', f: 1400, f2: 250, g: 0.012, a: 0.0005, d: 0.014, v: 0.22 * v });
  finish(V);
}
function mSnare(t, v) {
  const V = mv(t, drumBus, 0.04);
  Nz(V, { d: 0.13, v: 0.5 * v, ft: 'bandpass', ff: 2800, q: 0.6 });
  T(V, { type: 'triangle', f: 220, f2: 160, g: 0.05, a: 0.001, d: 0.07, v: 0.3 * v });
  finish(V);
}
function mClap(t, v) {
  const V = mv(t, drumBus, -0.05);
  const n = Nz(V, { d: 0.17, ft: 'bandpass', ff: 1500, q: 1.1, noenv: 1 });
  const g = n.g.gain, p = Math.max(0.6 * v, 0.001);
  g.setValueAtTime(p, t); g.exponentialRampToValueAtTime(p * 0.12, t + 0.009);
  g.setValueAtTime(p * 0.9, t + 0.011); g.exponentialRampToValueAtTime(p * 0.12, t + 0.02);
  g.setValueAtTime(p * 0.85, t + 0.022); g.exponentialRampToValueAtTime(EPS, t + 0.17);
  finish(V);
}
function mHat(t, v, open) {
  const V = mv(t, drumBus, 0.22);
  Nz(V, { d: open ? 0.14 : 0.03, v, ft: 'highpass', ff: 7200, q: 0.7 });
  finish(V);
}
function mShaker(t, v) {
  const V = mv(t, drumBus, -0.28);
  Nz(V, { a: 0.006, d: 0.045, v, ft: 'bandpass', ff: 6000, q: 1.4 });
  finish(V);
}
function mRim(t, v) {
  const V = mv(t, drumBus, 0.1);
  T(V, { type: 'triangle', f: 1800, a: 0.0005, d: 0.025, v: 0.16 * v });
  Nz(V, { d: 0.012, v: 0.14 * v, ft: 'bandpass', ff: 3200, q: 2 });
  finish(V);
}
function mTom(t, f, v) {
  const V = mv(t, drumBus, clamp((f - 200) / 300, -0.5, 0.5));
  T(V, { f, f2: f * 0.55, g: 0.22, a: 0.001, d: 0.28, v: 0.5 * v });
  Nz(V, { d: 0.02, v: 0.14 * v, ft: 'lowpass', ff: 3000 });
  finish(V);
}
function mCrash(t, v) {
  const V = mv(t, drumBus);
  Nz(V, { d: 1.5, v: 0.17 * v, ft: 'highpass', ff: 3800, q: 0.5 });
  Nz(V, { d: 0.5, v: 0.08 * v, ft: 'bandpass', ff: 8500, q: 1.2 });
  finish(V);
}
function mRiser(t, dur, v) {
  const V = mv(t, drumBus);
  Nz(V, { a: dur * 0.97, d: 0.04, v: 0.16 * v, ft: 'bandpass', ff: 350, ff2: 7500, fg: dur, q: 2.2 });
  finish(V);
}
function mBass(t, m, dur, v, bright) {
  const V = mv(t, instBus);
  const cut = 250 + 1400 * bright;
  const lp = Flt(V, 'lowpass', cut, 5);
  lp.frequency.setValueAtTime(fq(cut * 3), t);
  lp.frequency.exponentialRampToValueAtTime(fq(cut), t + 0.09);
  T(V, { type: 'sawtooth', f: mtof(m), a: 0.003, hold: dur * 0.5, d: dur * 0.6, v: 0.3 * v, to: lp });
  if (m < 45) T(V, { f: mtof(m), a: 0.003, hold: dur * 0.5, d: dur * 0.6, v: 0.24 * v });
  finish(V);
}
function mSoftBass(t, m, dur, v) {
  const V = mv(t, instBus);
  T(V, { type: 'triangle', f: mtof(m), a: 0.006, hold: dur * 0.4, d: dur * 0.7, v: 0.3 * v });
  T(V, { f: mtof(m), a: 0.006, hold: dur * 0.4, d: dur * 0.7, v: 0.24 * v });
  finish(V);
}
function mDBass(t, m, dur, v) {
  const V = mv(t, distIn);
  T(V, { type: 'sawtooth', f: mtof(m), a: 0.002, hold: dur * 0.55, d: dur * 0.5, v: 0.3 * v });
  T(V, { type: 'square', f: mtof(m), det: 9, a: 0.002, hold: dur * 0.55, d: dur * 0.5, v: 0.18 * v });
  T(V, { f: mtof(m), a: 0.002, hold: dur * 0.55, d: dur * 0.5, v: 0.2 * v, to: instBus });
  finish(V);
}
function mPluck(t, m, dur, v, cut, wave, pan) {
  const V = mv(t, instBus, pan);
  const lp = Flt(V, 'lowpass', cut, 3);
  lp.frequency.setValueAtTime(fq(cut * 3), t);
  lp.frequency.exponentialRampToValueAtTime(fq(cut), t + 0.08);
  T(V, { wave: wave || pulse25, type: 'square', f: mtof(m), a: 0.002, d: dur, v: 0.13 * v, to: lp });
  send(V, echoIn, 0.3);
  finish(V);
}
function mTPluck(t, m, dur, v, pan) {
  const V = mv(t, instBus, pan);
  T(V, { type: 'triangle', f: mtof(m), a: 0.002, d: dur, v: 0.12 * v });
  T(V, { f: mtof(m + 12), a: 0.002, d: dur * 0.4, v: 0.04 * v });
  send(V, echoIn, 0.35);
  finish(V);
}
function mLead(t, m, dur, v, cut) {
  const V = mv(t, instBus);
  const lp = Flt(V, 'lowpass', cut, 1.5);
  const f = mtof(m), hold = Math.max(0.01, dur - 0.05);
  const a = T(V, { wave: pulse25, type: 'square', f, a: 0.008, hold, d: 0.12, v: 0.12 * v, to: lp });
  const b = T(V, { type: 'sawtooth', f, det: 9, a: 0.008, hold, d: 0.12, v: 0.055 * v, to: lp });
  if (dur > 0.28) {
    const l = lfo(V, [a.osc.frequency, b.osc.frequency], 5.8, 0.0001, t, a.end + 0.01);
    l.depth.gain.setValueAtTime(0.0001, t);
    l.depth.gain.setValueAtTime(0.0001, t + 0.15);
    l.depth.gain.linearRampToValueAtTime(f * 0.012, t + 0.3);
  }
  send(V, echoIn, 0.28);
  finish(V);
}
function mMarimba(t, m, v) {
  const V = mv(t, instBus, 0.15);
  const f = mtof(m);
  T(V, { f, a: 0.001, d: 0.35, v: 0.22 * v });
  T(V, { f: f * 3.93, a: 0.001, d: 0.06, v: 0.06 * v });
  T(V, { type: 'triangle', f: f * 2, a: 0.001, d: 0.1, v: 0.035 * v });
  send(V, echoIn, 0.22);
  send(V, musicVerb, 0.15);
  finish(V);
}
function mPad(t, notes, dur, v, cut) {
  const V = mv(t, instBus);
  const lp = Flt(V, 'lowpass', cut, 0.8);
  const a = Math.min(0.4, dur * 0.3), hold = Math.max(0.01, dur - a - 0.1);
  for (const m of notes) for (const d of [-7, 7]) T(V, { type: 'sawtooth', f: mtof(m), det: d + rand(-2, 2), a, hold, d: 0.4, v: 0.04 * v, to: lp });
  send(V, musicVerb, 0.4);
  finish(V);
}
function mStab(t, notes, v) {
  const V = mv(t, instBus);
  const lp = Flt(V, 'lowpass', 4500, 2);
  lp.frequency.setValueAtTime(4500, t);
  lp.frequency.exponentialRampToValueAtTime(500, t + 0.18);
  for (const m of notes) for (const d of [-10, 10]) T(V, { type: 'sawtooth', f: mtof(m), det: d, a: 0.003, hold: 0.06, d: 0.22, v: 0.065 * v, to: lp });
  send(V, musicVerb, 0.3);
  send(V, echoIn, 0.12);
  finish(V);
}

// --- sequencers (one call per 16th step) -----------------------------------------------------
const SEQ = {
  title(s, bar, t, sd) {
    const M = MODES.title, [pc, ivs] = M.prog[bar % 4];
    const tt = t + (s % 2 ? sd * M.swing : 0);
    if (bar >= 2) {
      if (s === 0 || s === 8) mKick(t, 0.55);
      if (s === 11) mKick(tt, 0.25);
      if (s === 4 || s === 12) mRim(t, 0.9);
      if (s % 2 === 0) mShaker(t, s % 4 === 2 ? 0.13 : 0.07);
      else if (s % 4 === 3) mShaker(tt, 0.045);
    }
    const bs = { 0: 0, 3: 0, 6: 7, 8: 0, 11: 12, 14: 7 }[s];
    if (bs !== undefined) mSoftBass(tt, bassRoot(pc, 33) + bs, sd * (s === 6 || s === 14 ? 2 : 3) * 0.9, 0.9);
    if (s === 0) mPad(t, voicing(pc, ivs, 55), sd * 16, 0.9, 1100);
    if (s % 2 === 0) {
      const vc = arpTones(pc, ivs, 67);
      mTPluck(t, vc[[0, 2, 1, 3, 2, 1, 3, 2][s / 2] % vc.length], sd * 2.5, 0.8, s % 4 ? 0.25 : -0.25);
    }
    if (bar >= 4) { const ev = leadEv('title', bar - 4, s); if (ev) mMarimba(tt, ev[2], 0.9); }
  },

  run(s, bar, t, sd) {
    const M = MODES.run, x = intensity, [pc, ivs] = M.prog[bar % 4];
    const root = bassRoot(pc, 33), pb = bar % 8, phrase = bar >> 3;
    if (s % 4 === 0) mKick(t, 1);
    if (s === 4 || s === 12) mClap(t, 0.8);
    if (s % 4 === 2) mHat(t, 0.2, true);
    else if (s % 2 === 1 && x > 0.12) mHat(t, 0.05 + 0.08 * x, false);
    if (s === 0 && pb === 0 && bar > 0) mCrash(t, 0.5 + 0.5 * x);
    mBass(t, root + [0, 0, 12, 0][s % 4], sd * 0.85, [1, 0.55, 0.8, 0.6][s % 4], 0.25 + 0.75 * x);
    if (x >= 0.3) {
      const vc = arpTones(pc, ivs, 64), pat = ARPS[phrase % ARPS.length];
      mPluck(t, vc[pat[s] % vc.length] + (pb >= 4 && s >= 8 ? 12 : 0), sd * 1.4, 0.85 * clamp((x - 0.3) / 0.15, 0, 1), 1200 + 3000 * x, pulse25, s % 2 ? 0.3 : -0.3);
    }
    if (x >= 0.45 && s === 0) mPad(t, voicing(pc, ivs, 57), sd * 16, 0.7 * clamp((x - 0.45) / 0.2, 0, 1), 900 + 2000 * x);
    if (x >= 0.6) { const ev = leadEv('run', bar, s); if (ev) mLead(t, ev[2], ev[1] * sd * 0.92, clamp((x - 0.6) / 0.1, 0, 1), 1800 + 5000 * x); }
    if (x >= 0.85) {
      const e = clamp((x - 0.85) / 0.1, 0, 1);
      mShaker(t, (s % 2 ? 0.08 : 0.12) * e);
      if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.9 * e);
      if (pb === 7 && s >= 12) mSnare(t, (0.25 + (s - 12) * 0.1) * e);
      if (pb === 3 && s >= 12) mTom(t, [300, 250, 200, 160][s - 12], 0.6 * e);
    }
  },

  boss(s, bar, t, sd) {
    const M = MODES.boss, [pc, ivs] = M.prog[bar % 4], root = bassRoot(pc, 31);
    if (s % 4 === 0 || s === 14) mKick(t, s === 14 ? 0.7 : 1);
    if (s === 4 || s === 12) mSnare(t, 0.85);
    mHat(t, s % 4 === 2 ? 0.14 : 0.06, false);
    if (bar % 2 === 1 && s >= 12) mTom(t, [260, 210, 170, 130][s - 12], 0.8);
    if (bar % 8 === 0 && s === 0 && bar > 0) mCrash(t, 0.8);
    mDBass(t, root + [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 7, 7, 12, 0][s], sd * 0.8, [1, 0.5, 0.8, 0.5][s % 4]);
    if ((bar % 2 === 0 && (s === 0 || s === 3 || s === 6)) || (bar % 2 === 1 && s === 0)) mStab(t, voicing(pc, ivs, 60), 0.9);
    if (s === 0) mPad(t, voicing(pc, ivs, 48), sd * 16, 0.6, 700);
    mPluck(t, arpTones(pc, ivs, 72)[[0, 1, 2, 1][s % 4]], sd * 1.2, 0.45, 2200, pulse12, s % 2 ? 0.35 : -0.35);
    if (bar % 8 >= 4) { const ev = leadEv('boss', bar, s); if (ev) mLead(t, ev[2], ev[1] * sd * 0.92, 0.8, 2600); }
  },

  final(s, bar, t, sd) {
    const M = MODES.final, [pc, ivs] = M.prog[bar % 4], root = bassRoot(pc, 31), pb = bar % 8;
    if (s % 4 === 0) mKick(t, 1);
    if (s === 4 || s === 12) { mClap(t, 0.8); mSnare(t, 0.4); }
    mHat(t, s % 4 === 2 ? 0.2 : 0.07, s % 4 === 2);
    mShaker(t, s % 2 ? 0.07 : 0.1);
    if (s === 0 && bar % 4 === 0 && bar > 0) mCrash(t, 0.8);
    if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.9);
    if (pb === 7 && s >= 8) mSnare(t, 0.2 + (s - 8) * 0.06);
    if (pb === 3 && s >= 12) mTom(t, [300, 240, 190, 150][s - 12], 0.7);
    mDBass(t, root + [0, 12, 0, 12][s % 4], sd * 0.8, [1, 0.6, 0.8, 0.6][s % 4]);
    const vc = arpTones(pc, ivs, 64), pat = ARPS[(bar >> 3) % ARPS.length];
    mPluck(t, vc[pat[s] % vc.length] + 12, sd * 1.3, 0.7, 3500, pulse25, s % 2 ? 0.3 : -0.3);
    if ((s === 0 && bar % 2 === 0) || (s === 14 && bar % 2 === 1)) mStab(t, voicing(pc, ivs, 60), 0.8);
    if (s === 0) mPad(t, voicing(pc, ivs, 55), sd * 16, 0.6, 2200);
    const ev = leadEv('final', bar, s);
    if (ev) mLead(t, ev[2], ev[1] * sd * 0.92, 0.95, 5000);
  },
};

function stepDur() { return 60 / MODES[curMode].bpm / 4; }

function musicLPFor(mode, x) {
  if (mode !== 'run') return 18000;
  return 3000 * Math.pow(2, clamp(x / 0.6, 0, 1) * 2.58); // ~3 kHz -> ~18 kHz, fully open at 0.6
}

function applyMode(mode, t) {
  curMode = mode;
  mstep = 0;
  const echoT = (0.75 * 60) / MODES[mode].bpm; // dotted eighth
  echoL.delayTime.setTargetAtTime(echoT, t, 0.03);
  echoR.delayTime.setTargetAtTime(echoT, t, 0.03);
  lastLP = musicLPFor(mode, intensity);
  musicLP.frequency.setTargetAtTime(lastLP, t, 0.1);
}

function tick() {
  if (!ctx || !curMode) return;
  try {
    const now = ctx.currentTime;
    let sd = stepDur();
    if (nextT < now - 0.08) { // fell behind (throttled background tab): skip ahead on the grid
      const n = Math.ceil((now - nextT) / sd);
      nextT += n * sd;
      mstep += n;
    }
    let guard = 0;
    while (nextT < now + LOOKAHEAD && guard++ < 64) {
      if (mstep % 16 === 0 && pendMode) {
        const target = pendMode;
        pendMode = null;
        applyMode(target, nextT);
        if (target !== 'title') mCrash(nextT, 0.9);
        sd = stepDur();
      }
      const s = mstep % 16, bar = Math.floor(mstep / 16);
      SEQ[curMode](s, bar, nextT, sd);
      if (pendMode && pendMode !== 'title') { // transition fill into the next bar
        if (s >= 12) mSnare(nextT, 0.2 + (s - 12) * 0.12);
        else if (s >= 8 && s % 2 === 0) mSnare(nextT, 0.15);
      }
      nextT += sd;
      mstep++;
    }
  } catch (e) { /* never let the scheduler throw */ }
}

// ---------------------------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------------------------
function makeNoise(sec, pink) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * sec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (!pink) { for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; return buf; }
  let b0 = 0, b1 = 0, b2 = 0; // Paul Kellet's economy pink filter
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
  return buf;
}

function makePulse(duty) {
  if (!ctx.createPeriodicWave) return null;
  const n = 48, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    re[k] = Math.sin(2 * Math.PI * k * duty) / (Math.PI * k);
    im[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (Math.PI * k);
  }
  return ctx.createPeriodicWave(re, im);
}

function makeVerb(dest, level) { // small delay-network "room" (4 damped combs + 2 allpasses)
  const inp = ctx.createGain();
  const pre = ctx.createBiquadFilter(); pre.type = 'highpass'; pre.frequency.value = 250;
  const ap1 = ctx.createBiquadFilter(); ap1.type = 'allpass'; ap1.frequency.value = 900;
  const ap2 = ctx.createBiquadFilter(); ap2.type = 'allpass'; ap2.frequency.value = 2600;
  const out = ctx.createGain(); out.gain.value = level;
  inp.connect(pre);
  [[0.0297, 0.8], [0.0371, 0.78], [0.0411, 0.77], [0.0437, 0.76]].forEach(([dt, fbAmt]) => {
    const d = ctx.createDelay(0.1); d.delayTime.value = dt;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    const fb = ctx.createGain(); fb.gain.value = fbAmt;
    pre.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(ap1);
  });
  ap1.connect(ap2); ap2.connect(out); out.connect(dest);
  return inp;
}

function panNode(v) {
  if (!ctx.createStereoPanner) return ctx.createGain();
  const p = ctx.createStereoPanner(); p.pan.value = v; return p;
}

function build() {
  const c = ctx;
  NYQ = (c.sampleRate || 44100) * 0.45;
  master = c.createGain(); master.gain.value = vols.master;
  comp = c.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 6;
  comp.attack.value = 0.002; comp.release.value = 0.2;
  comp.connect(master); master.connect(c.destination);

  sfxBus = c.createGain(); sfxBus.gain.value = vols.sfx * SFX_TRIM; sfxBus.connect(comp);
  musicVol = c.createGain(); musicVol.gain.value = vols.music * MUSIC_TRIM; musicVol.connect(comp);
  duckG = c.createGain(); duckG.connect(musicVol);
  fadeG = c.createGain(); fadeG.gain.value = 0; fadeG.connect(duckG);
  musicMix = c.createGain(); musicMix.connect(fadeG);
  musicLP = c.createBiquadFilter(); musicLP.type = 'lowpass'; musicLP.frequency.value = 18000; musicLP.Q.value = 0.5; musicLP.connect(musicMix);
  instBus = c.createGain(); instBus.connect(musicLP);
  drumBus = c.createGain(); drumBus.connect(musicMix);

  // distorted-bass bus (one shared shaper for all boss/final bass notes)
  distIn = c.createGain();
  const dsh = c.createWaveShaper(); dsh.curve = curve(3); dsh.oversample = '2x';
  const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1100; dlp.Q.value = 3;
  const dout = c.createGain(); dout.gain.value = 0.45;
  distIn.connect(dsh); dsh.connect(dlp); dlp.connect(dout); dout.connect(instBus);

  // ping-pong echo for leads/arps
  echoIn = c.createGain();
  const elp = c.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 3000;
  echoL = c.createDelay(2); echoL.delayTime.value = 0.3;
  echoR = c.createDelay(2); echoR.delayTime.value = 0.3;
  const efb = c.createGain(); efb.gain.value = 0.45;
  const eout = c.createGain(); eout.gain.value = 0.55;
  const pl = panNode(-0.6), pr = panNode(0.6);
  echoIn.connect(elp); elp.connect(echoL);
  echoL.connect(pl); pl.connect(eout);
  echoL.connect(echoR); echoR.connect(pr); pr.connect(eout);
  echoR.connect(efb); efb.connect(echoL);
  eout.connect(musicMix);

  musicVerb = makeVerb(musicMix, 0.25);
  sfxVerb = makeVerb(sfxBus, 0.3);

  noiseW = makeNoise(2, false);
  noiseP = makeNoise(3, true);
  pulse25 = makePulse(0.25);
  pulse12 = makePulse(0.125);

  // speed wind-rush layer (always running, silent at rest)
  const ws = c.createBufferSource(); ws.buffer = noiseP; ws.loop = true;
  const gust = c.createGain(); gust.gain.value = 0.8;
  windBP = c.createBiquadFilter(); windBP.type = 'bandpass'; windBP.frequency.value = 400; windBP.Q.value = 0.6;
  windG = c.createGain(); windG.gain.value = 0;
  whistleBP = c.createBiquadFilter(); whistleBP.type = 'bandpass'; whistleBP.frequency.value = 1400; whistleBP.Q.value = 7;
  whistleG = c.createGain(); whistleG.gain.value = 0;
  ws.connect(gust); gust.connect(windBP); windBP.connect(windG); windG.connect(sfxBus);
  gust.connect(whistleBP); whistleBP.connect(whistleG); whistleG.connect(sfxBus);
  const l1 = c.createOscillator(); l1.frequency.value = 0.17;
  const l1g = c.createGain(); l1g.gain.value = 0.22; l1.connect(l1g); l1g.connect(gust.gain);
  const l2 = c.createOscillator(); l2.frequency.value = 0.29;
  const l2g = c.createGain(); l2g.gain.value = 140; l2.connect(l2g); l2g.connect(windBP.frequency);
  ws.start(); l1.start(); l2.start();
}

// ---------------------------------------------------------------------------------------------
// Context lifecycle helpers
// ---------------------------------------------------------------------------------------------
let lastResume = 0, autoSuspended = false, visHooked = false;
const now_ms = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const pageHidden = () => typeof document !== 'undefined' && !!document.hidden;

function tryResume() {
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || pageHidden()) return;
  const t = now_ms();
  if (t - lastResume < 400) return;
  lastResume = t;
  try { quiet(ctx.resume()); } catch (e) { /* ignore */ }
}

function hookVisibility() {
  if (visHooked || typeof document === 'undefined' || !document.addEventListener) return;
  visHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    try {
      if (document.hidden) {
        if (ctx.state === 'running') { autoSuspended = true; quiet(ctx.suspend()); }
      } else if (autoSuspended) {
        autoSuspended = false;
        quiet(ctx.resume());
      }
    } catch (e) { /* ignore */ }
  });
}

function holdParam(p, t) {
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t);
  else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v, t); }
}

let duckEnd = 0, duckAmt = 0;
function doDuck(amount, seconds) {
  if (!ctx || !duckG) return;
  const now = ctx.currentTime;
  amount = clamp(+amount || 0, 0, 1);
  const end = now + clamp(+seconds || 0, 0.05, 10);
  const active = now < duckEnd;
  if (active && duckAmt >= amount && duckEnd >= end) return; // a stronger & longer duck is already running
  duckAmt = active ? Math.max(duckAmt, amount) : amount;
  duckEnd = active ? Math.max(duckEnd, end) : end;
  const g = duckG.gain;
  g.cancelScheduledValues(now);
  g.setTargetAtTime(1 - duckAmt, now, 0.025);
  g.setTargetAtTime(1, duckEnd, 0.18);
}

let lastSpeed = -1, lastSpeedT = -1, lastLP = 18000;

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
export const audio = {
  init() {
    try {
      if (ctx) { tryResume(); return; }
      const g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {};
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return;
      let c;
      try { c = new AC({ latencyHint: 'interactive' }); } catch (e) { c = new AC(); }
      ctx = c;
      try { build(); } catch (e) { try { quiet(c.close()); } catch (e2) { /* ignore */ } ctx = null; return; }
      hookVisibility();
      if (ctx.state !== 'running') { lastResume = 0; tryResume(); }
      if (wantMode) { const m = wantMode; wantMode = null; audio.startMusic(m); }
    } catch (e) { ctx = null; }
  },

  setVolumes(v) {
    try {
      if (!v) return;
      for (const key of ['master', 'music', 'sfx']) if (v[key] != null && isFinite(+v[key])) vols[key] = clamp(+v[key], 0, 1);
      if (!ctx) return;
      const now = ctx.currentTime;
      master.gain.setTargetAtTime(vols.master, now, 0.04);
      musicVol.gain.setTargetAtTime(vols.music * MUSIC_TRIM, now, 0.04);
      sfxBus.gain.setTargetAtTime(vols.sfx * SFX_TRIM, now, 0.04);
    } catch (e) { /* ignore */ }
  },

  play(name, opts) {
    if (!ctx) return;
    try {
      const def = SFX[name];
      if (!def) return;
      if (ctx.state !== 'running') { tryResume(); return; }
      const o = opts || {};
      const lim = LIMITS[name] || [40, 3, 1];
      const now = ctx.currentTime;
      const last = lastPlay[name];
      if (last !== undefined && now - last < lim[0] / 1000 && now >= last) return;
      const mine = prune(activeByName[name] || (activeByName[name] = []), now);
      if (mine.length >= lim[1]) return;
      if (prune(activeAll, now).length >= GLOBAL_CAP[lim[2]]) return;

      const p = clamp(+o.pitch || 1, 0.25, 4);
      const k = clamp(Math.pow(1 / p, 0.5), 0.6, 1.6);
      const vol = clamp(o.volume == null ? 1 : +o.volume || 0, 0, 2);
      if (vol <= 0) return;
      const V = voice(sfxBus, now, vol, clamp(+o.pan || 0, -1, 1), p, k);
      try { def(V, o); } finally { finish(V); }
      lastPlay[name] = now;
      const end = Math.max(V.end, now + 0.02);
      mine.push(end);
      activeAll.push(end);
      const ad = AUTODUCK[name];
      if (ad) doDuck(ad[0], ad[1]);
    } catch (e) { /* never throw from gameplay code paths */ }
  },

  startMusic(mode) {
    if (!MODES[mode]) return;
    if (!ctx) { wantMode = mode; return; }
    try {
      if (curMode && timer) {
        if (curMode === mode) { pendMode = null; return; } // idempotent; also cancels a pending switch
        pendMode = mode; // switch musically on the next bar
        return;
      }
      stopToken++;
      const now = ctx.currentTime;
      pendMode = null;
      nextT = now + 0.06;
      applyMode(mode, now);
      holdParam(fadeG.gain, now);
      fadeG.gain.setTargetAtTime(1, now, 0.05);
      if (!timer) timer = setInterval(tick, TICK_MS);
      tick();
    } catch (e) { /* ignore */ }
  },

  setIntensity(x) {
    intensity = clamp(+x || 0, 0, 1);
    if (!ctx || !musicLP || !curMode) return;
    try {
      const f = musicLPFor(curMode, intensity);
      if (Math.abs(f - lastLP) / f < 0.02) return; // safe to call every frame
      lastLP = f;
      musicLP.frequency.setTargetAtTime(f, ctx.currentTime, 0.25);
    } catch (e) { /* ignore */ }
  },

  stopMusic() {
    pendMode = null;
    wantMode = null;
    if (!ctx || !curMode) { curMode = null; return; }
    try {
      curMode = null;
      const now = ctx.currentTime;
      holdParam(fadeG.gain, now);
      fadeG.gain.setTargetAtTime(0, now, 0.12);
      const tok = ++stopToken;
      setTimeout(() => {
        if (tok === stopToken && !curMode && timer) { clearInterval(timer); timer = null; }
      }, 900);
    } catch (e) { /* ignore */ }
  },

  setSpeed(speed01) {
    if (!ctx || !windG) return;
    try {
      const s = clamp(+speed01 || 0, 0, 1);
      const now = ctx.currentTime;
      const ds = Math.abs(s - lastSpeed);
      const edge = (s === 0 || s === 1) && s !== lastSpeed;   // always land exactly on rest / max
      if (!edge && ds < 0.01 && now - lastSpeedT < 0.25) return; // nothing meaningful changed
      if (!edge && now - lastSpeedT < 0.03 && ds < 0.15) return;  // throttle automation events
      lastSpeed = s; lastSpeedT = now;
      const tc = 0.12;
      const on = s < 0.04 ? 0 : Math.pow((s - 0.04) / 0.96, 1.5);
      windG.gain.setTargetAtTime(on * 0.45, now, tc);
      windBP.frequency.setTargetAtTime(300 + 2800 * Math.pow(s, 1.4), now, tc);
      windBP.Q.setTargetAtTime(0.5 + s, now, tc);
      whistleG.gain.setTargetAtTime(s > 0.55 ? 0.05 * Math.pow((s - 0.55) / 0.45, 2) : 0, now, tc);
      whistleBP.frequency.setTargetAtTime(900 + 2200 * s, now, tc);
    } catch (e) { /* ignore */ }
  },

  duck(amount, seconds) {
    try { doDuck(amount == null ? 0.5 : amount, seconds == null ? 0.6 : seconds); } catch (e) { /* ignore */ }
  },

  get ctx() { return ctx; },
};

export default audio;
