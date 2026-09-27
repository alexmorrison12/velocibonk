// VELOCIBONK — procedural audio engine.
// Every sound and all music is synthesized live with the Web Audio API (no files, no libraries).
//
//   audio.init()                          call from a user gesture (click/keydown). Idempotent; also resumes.
//   audio.setVolumes({master,music,sfx})  0..1 each, smoothed.
//   audio.play(name, {pitch, volume, pan, combo})
//   audio.startMusic(mode, biome = 'tropical')
//        mode: 'title' | 'run' | 'boss' | 'final' | 'victory'
//        biome: 'tropical' | 'frost' | 'desert' | 'grave' | 'volcano'  (title ignores it; unknown -> tropical)
//        Switches on the next bar; the same mode+biome = no-op. Changing only the biome also switches.
//        'victory' = 8-bar island-cleared anthem, then settles into a calm loop until the next startMusic().
//   audio.setIntensity(0..1)              run-mode layering (0 drums+bass, .3 arp, .45 pad, .6 lead, .85 extras).
//   audio.stopMusic()
//   audio.setAmbience(biome | null)       quiet looping biome ambience bed, 2 s crossfade; null = off.
//   audio.setSpeed(0..1)                  every frame; drives the wind-rush layer.
//   audio.duck(amount, seconds)           temporary music dip (merges with any active duck).
//   audio.ctx                             AudioContext or null.
//
// Every public method is a silent no-op before init() or when Web Audio is unavailable. Nothing throws.
// (startMusic / setAmbience requests made before init() are remembered and start once init() runs.)

const EPS = 0.0001;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

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
let master, comp, sfxBus, sfxVerb, musicVol, duckG, fadeG, musicMix, musicLP, instBus, drumBus, distIn, gtrIn, echoIn, echoL, echoR, musicVerb;
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
    const M = MODES[curMode || pendMode || 'run'] || MODES.run;
    // Tropical keys use the major-pentatonic ladder; biome keys may supply their own in-key 5-note ladder.
    const f = mtof(M.gem + (M.ladder ? M.ladder[c % 5] + 12 * (Math.floor(c / 5) % 2) : PENTA2[c % PENTA2.length]));
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

// ---------------------------------------------------------------------------------------------
// THE ARCHIPELAGO — extra SFX (portals, quests, stingers, boss attacks, biome hazards).
// Levels are matched to the originals: frequent weapon/hazard sounds peak ~0.3-0.6, big one-off
// stingers ~1.0 (the same headroom as bossslam / explosion), and every stinger auto-ducks the music.
// ---------------------------------------------------------------------------------------------

// Brass-section chord: detuned saw pairs through a lowpass that swells open then settles.
function brass(V, at, notes, a, hold, d, v, c0, c1) {
  const lp = Flt(V, 'lowpass', c0, 1.3, { at, f2: c1, g: a + 0.03, f3: Math.max(c0, c1 * 0.35), g3: a + hold + d });
  for (const m of notes) {
    T(V, { type: 'sawtooth', at, f: mtof(m), det: -7, a, hold, d, v, to: lp });
    T(V, { type: 'sawtooth', at, f: mtof(m), det: 7, a, hold, d, v: v * 0.8, to: lp });
  }
  return lp;
}
// Fanfare lead note (pulse + saw), optional delayed vibrato for held notes.
function fan(V, lp, at, m, hold, v, vib) {
  const d = vib ? 0.6 : 0.1;
  const a = T(V, { wave: pulse25, type: 'square', at, f: mtof(m), a: 0.008, hold, d, v, to: lp });
  const b = T(V, { type: 'sawtooth', at, f: mtof(m), det: 9, a: 0.008, hold, d, v: v * 0.45, to: lp });
  if (vib) {
    const l = lfo(V, [a.osc.frequency, b.osc.frequency], 5.8, 0.0001, a.t, a.end + 0.01);
    l.depth.gain.setValueAtTime(0.0001, a.t + 0.2 * V.k);
    l.depth.gain.linearRampToValueAtTime(mtof(m) * V.p * 0.012, a.t + 0.55 * V.k);
  }
}
// Timpani-ish hit.
function timp(V, at, f, v) {
  T(V, { at, f, f2: f * 0.58, g: 0.3, a: 0.003, d: 0.55, v: 0.42 * v });
  Nz(V, { at, d: 0.08, v: 0.16 * v, ft: 'lowpass', ff: 1400, pink: 1 });
}
// Random-edged gate for crackles / electric buzz (writes stepped values onto a gain param).
function crackle(V, g, t0, dur, gapA, gapB, lo, hi, openLen) {
  const end = t0 + dur * V.k;
  let tt = t0;
  while (tt < end) {
    g.gain.setValueAtTime(rand(lo, hi), tt);
    if (openLen) g.gain.setValueAtTime(0, tt + openLen);
    tt += rand(gapA, gapB) * V.k + (openLen || 0);
  }
  g.gain.setValueAtTime(0, end + (openLen || 0) + 0.001);
}

Object.assign(SFX, {
  // Ominous boss-portal activation: dissonant low hum rising an octave, tremolo accelerating, air swirling in.
  portal(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 160, 4, { f2: 1500, g: 1.35 });
    const trem = Gn(V, 0.65, lp);
    const l = lfo(V, trem.gain, 3, 0.35, t, t + 1.56 * k);
    l.osc.frequency.setValueAtTime(3, t);
    l.osc.frequency.exponentialRampToValueAtTime(16, t + 1.4 * k);
    for (const [f, det, v] of [[55, -10, 0.1], [55, 9, 0.1], [58.27, 0, 0.06], [82.4, 4, 0.07]]) {
      T(V, { type: 'sawtooth', f, f2: f * 2, g: 1.4, a: 0.55, hold: 0.75, d: 0.2, v, det, to: trem });
    }
    T(V, { f: 41.2, f2: 82.4, g: 1.4, a: 0.5, hold: 0.8, d: 0.2, v: 0.3 });
    Nz(V, { a: 1.2, d: 0.3, v: 0.2, ft: 'bandpass', ff: 300, ff2: 2600, fg: 1.4, q: 3, pink: 1 });
    T(V, { at: 1.3, f: 1760, f2: 2640, g: 0.2, a: 0.01, d: 0.22, v: 0.03 });
    wet(V, 0.35);
  },

  // Portal travel: huge up-then-down whoosh with a fluttering vortex band, rising "vworp", arrival boom.
  warp(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 250, 1.5, { f2: 7000, g: 1.0, f3: 300, g3: 2.0 });
    Nz(V, { a: 0.9, hold: 0.25, d: 0.85, v: 0.45, pink: 1, to: lp });
    const bp = Flt(V, 'bandpass', 400, 5, { f2: 6000, g: 1.1, f3: 900, g3: 1.9 });
    const fl = Gn(V, 0.6, bp);
    const lf = lfo(V, fl.gain, 6, 0.4, t, t + 2.02 * k);
    lf.osc.frequency.setValueAtTime(6, t);
    lf.osc.frequency.exponentialRampToValueAtTime(28, t + 1.1 * k);
    lf.osc.frequency.exponentialRampToValueAtTime(8, t + 2 * k);
    Nz(V, { a: 0.8, hold: 0.3, d: 0.9, v: 0.35, to: fl });
    const tl = Flt(V, 'lowpass', 500, 3, { f2: 4000, g: 1.0, f3: 600, g3: 2.0 });
    for (const [f, d] of [[110, -9], [165, 7], [220, 3]]) {
      const o = T(V, { type: 'sawtooth', f, f2: f * 4, g: 1.0, a: 0.5, hold: 0.6, d: 0.85, v: 0.055, det: d, to: tl });
      o.osc.frequency.exponentialRampToValueAtTime(fq(f * 1.5 * V.p), t + 1.94 * k);
    }
    T(V, { at: 1.15, f: 90, f2: 30, g: 0.6, a: 0.005, d: 0.8, v: 0.42 });
    [96, 91, 88, 84, 79, 76].forEach((m, i) => T(V, { at: 1.2 + i * 0.05, f: mtof(m), a: 0.002, d: 0.3, v: 0.028 }));
    wet(V, 0.4);
  },

  // Exit portal opening: rising harp glissando over three octaves + shimmering chord + airy sweep.
  portalopen(V) {
    [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96].forEach((m, i) => {
      T(V, { type: 'triangle', at: i * 0.035, f: mtof(m), a: 0.002, d: 0.35, v: 0.065 });
      if (i % 2) T(V, { at: i * 0.035, f: mtof(m + 12), a: 0.002, d: 0.15, v: 0.022 });
    });
    const trem = Gn(V, 0.6);
    lfo(V, trem.gain, 9, 0.4, V.t, V.t + 1.62 * V.k);
    [79, 84, 88, 91].forEach((m) => T(V, { at: 0.45, f: mtof(m), det: rand(-6, 6), a: 0.15, hold: 0.4, d: 0.6, v: 0.035, to: trem }));
    Nz(V, { a: 0.5, d: 0.6, v: 0.12, ft: 'bandpass', ff: 1500, ff2: 9000, fg: 1.0, q: 2.5 });
    wet(V, 0.5);
  },

  // Quest complete: three marimba taps up to a bright bell "ding" over a soft major chord.
  quest(V) {
    [[0, 79], [0.075, 84], [0.15, 88]].forEach(([at, m]) => {
      T(V, { at, f: mtof(m), a: 0.001, d: 0.22, v: 0.13 });
      T(V, { at, f: mtof(m) * 3.93, a: 0.001, d: 0.04, v: 0.03 });
    });
    const at = 0.24, f = mtof(91);
    T(V, { at, f, a: 0.001, d: 0.7, v: 0.1 });
    T(V, { at, f: f * 2.76, a: 0.001, d: 0.25, v: 0.03 });
    T(V, { at, f: f * 5.4, a: 0.001, d: 0.1, v: 0.015 });
    [72, 76, 79].forEach((m) => T(V, { type: 'triangle', at, f: mtof(m), a: 0.006, hold: 0.12, d: 0.45, v: 0.06 }));
    T(V, { at, f: 130, f2: 65, g: 0.12, a: 0.003, d: 0.15, v: 0.2 });
    Nz(V, { at, d: 0.3, v: 0.07, ft: 'highpass', ff: 6500 });
    wet(V, 0.35);
  },

  // Unlock: brass triplet pickup -> big major chord with timpani, cymbal and a sparkle run.
  unlock(V) {
    [0, 0.1, 0.2].forEach((at) => brass(V, at, [67, 74], 0.01, 0.045, 0.05, 0.05, 700, 3500));
    brass(V, 0.3, [48, 60, 67, 72, 76, 79], 0.03, 0.55, 0.65, 0.036, 500, 4500);
    const lp = Flt(V, 'lowpass', 5000, 0.8);
    fan(V, lp, 0.3, 84, 0.5, 0.06, true);
    timp(V, 0, 98, 0.45); timp(V, 0.3, 98, 1);
    Nz(V, { at: 0.3, d: 1.1, v: 0.1, ft: 'highpass', ff: 5000 });
    [84, 88, 91, 96, 100, 103].forEach((m, i) => T(V, { at: 0.36 + i * 0.05, f: mtof(m), a: 0.002, d: 0.3, v: 0.03 }));
    wet(V, 0.45);
  },

  // Island cleared: scale run -> Ab . Bb . C (bVI-bVII-I) brass cadence, timpani, crash, sparkles. ~2.6 s.
  victory(V) {
    [60, 62, 64, 65, 67, 69, 71, 72].forEach((m, i) => T(V, { wave: pulse25, type: 'square', at: i * 0.035, f: mtof(m), a: 0.002, hold: 0.02, d: 0.05, v: 0.05 }));
    brass(V, 0.3, [56, 63, 68, 72], 0.015, 0.13, 0.1, 0.04, 700, 3800);
    brass(V, 0.56, [58, 65, 70, 74], 0.015, 0.13, 0.1, 0.04, 700, 3800);
    brass(V, 0.82, [48, 55, 60, 64, 67, 72], 0.03, 1.0, 0.8, 0.034, 600, 5000);
    const lp = Flt(V, 'lowpass', 5200, 0.8);
    fan(V, lp, 0.3, 80, 0.12, 0.055); fan(V, lp, 0.56, 82, 0.12, 0.055); fan(V, lp, 0.82, 84, 1.0, 0.065, true);
    timp(V, 0.3, 104, 0.6); timp(V, 0.56, 116, 0.75); timp(V, 0.82, 98, 1);
    Nz(V, { at: 0.82, d: 1.6, v: 0.12, ft: 'highpass', ff: 4200, q: 0.5 });
    [84, 88, 91, 96, 100, 103, 108].forEach((m, i) => T(V, { at: 0.9 + i * 0.06, f: mtof(m), a: 0.001, d: 0.35, v: 0.026 }));
    wet(V, 0.45);
  },

  // The game is beaten: snare-roll crescendo, fanfare, Ab-Bb-C cadence, huge held C with bell cascade. ~5.4 s.
  truevictory(V) {
    for (let i = 0; i < 20; i++) Nz(V, { at: i * 0.045, d: 0.05, v: 0.05 + i * 0.011, ft: 'bandpass', ff: 2600, q: 0.7 });
    [55, 57, 59, 60, 62, 64, 65, 67, 69, 71].forEach((m, i) => T(V, { wave: pulse25, type: 'square', at: 0.45 + i * 0.045, f: mtof(m), a: 0.002, hold: 0.02, d: 0.05, v: 0.045 }));
    const B = 0.9, lp = Flt(V, 'lowpass', 5200, 0.8);
    brass(V, B, [48, 55, 60, 64, 67], 0.02, 0.9, 0.3, 0.03, 700, 4500);
    [[0, 72, 0.1], [0.15, 72, 0.1], [0.3, 72, 0.1], [0.45, 79, 0.62]].forEach(([at, m, h]) => fan(V, lp, B + at, m, h, 0.06));
    brass(V, B + 1.2, [53, 60, 65, 69, 72], 0.02, 0.6, 0.2, 0.03, 700, 4500);
    [[1.2, 81, 0.22], [1.5, 79, 0.22], [1.8, 77, 0.2]].forEach(([at, m, h]) => fan(V, lp, B + at, m, h, 0.06));
    brass(V, B + 2.1, [56, 63, 68, 72], 0.015, 0.22, 0.08, 0.034, 800, 4000);
    brass(V, B + 2.42, [58, 65, 70, 74], 0.015, 0.22, 0.08, 0.034, 800, 4000);
    fan(V, lp, B + 2.1, 80, 0.24, 0.06); fan(V, lp, B + 2.42, 82, 0.24, 0.06);
    brass(V, B + 2.74, [36, 48, 55, 60, 64, 67, 72], 0.04, 1.0, 0.8, 0.028, 600, 5500);
    fan(V, lp, B + 2.74, 84, 1.0, 0.07, true);
    [[0, 98, 1], [1.2, 87, 0.8], [2.1, 104, 0.7], [2.42, 116, 0.8], [2.74, 98, 1]].forEach(([at, f, v]) => timp(V, B + at, f, v));
    for (let i = 0; i < 8; i++) timp(V, B + 3.2 + i * 0.07, 98, 0.12 + i * 0.03);
    Nz(V, { at: B, d: 1.2, v: 0.1, ft: 'highpass', ff: 4200, q: 0.5 });
    Nz(V, { at: B + 2.74, d: 2.0, v: 0.13, ft: 'highpass', ff: 4200, q: 0.5 });
    [84, 88, 91, 96, 100, 103, 108, 103, 100, 96, 100, 103, 108].forEach((m, i) => T(V, { at: B + 2.8 + i * 0.09, f: mtof(m), a: 0.001, d: 0.4, v: 0.024 }));
    wet(V, 0.5);
  },

  // Boss title card: sub boom + crack + distorted-low brass "BWAAM" swell (C with a sour Db on top).
  bossintro(V) {
    const sh = Sh(V, 3);
    T(V, { f: 70, f2: 28, g: 1.0, a: 0.003, d: 1.4, v: 0.7, to: sh });
    Nz(V, { d: 0.08, v: 0.45, ft: 'highpass', ff: 1200 });
    Nz(V, { d: 1.2, v: 0.35, ft: 'lowpass', ff: 1800, ff2: 100, fg: 1.0, pink: 1 });
    const lp = Flt(V, 'lowpass', 150, 3, { at: 0.05, f2: 1400, g: 0.45, f3: 200, g3: 2.2 });
    for (const [m, d, v] of [[36, -8, 0.1], [36, 8, 0.1], [43, -5, 0.09], [48, 5, 0.08], [49, 0, 0.05]]) {
      T(V, { type: 'sawtooth', at: 0.05, f: mtof(m), det: d, a: 0.12, hold: 0.9, d: 1.0, v, to: lp });
    }
    wet(V, 0.4);
  },

  // Boss enrage: distorted rising roar + two alarm sweeps.
  phase2(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 400, 5, { f2: 2800, g: 0.4, f3: 600, g3: 1.4 });
    const sh = Sh(V, 7, lp, '2x');
    const growl = Gn(V, 0.7, sh);
    lfo(V, growl.gain, 32, 0.3, t, t + 1.45 * k);
    for (const [f, det] of [[73.4, -10], [73.4, 12], [110, 0]]) T(V, { type: 'sawtooth', f, f2: f * 1.6, g: 0.35, a: 0.04, hold: 0.7, d: 0.6, v: 0.16, det, to: growl });
    Nz(V, { a: 0.05, hold: 0.6, d: 0.6, v: 0.25, ft: 'bandpass', ff: 700, ff2: 1500, fg: 0.4, q: 1.5, to: growl });
    const al = Flt(V, 'lowpass', 3000, 0.8);
    for (let i = 0; i < 2; i++) T(V, { type: 'square', at: 0.1 + i * 0.5, f: 520, f2: 1250, g: 0.42, a: 0.01, hold: 0.36, d: 0.08, v: 0.06, to: al });
    wet(V, 0.3);
  },

  // Laser charge: whine rising 3+ octaves with vibrato that speeds up, plus a narrowing noise swell. 1 s.
  beamcharge(V) {
    const t = V.t, k = V.k;
    const o = T(V, { f: 220, f2: 2200, g: 0.95, a: 0.4, hold: 0.5, d: 0.1, v: 0.11 });
    T(V, { type: 'square', f: 110, f2: 1100, g: 0.95, a: 0.5, hold: 0.4, d: 0.1, v: 0.03, to: Flt(V, 'lowpass', 2500, 1) });
    const l = lfo(V, o.osc.frequency, 8, 10 * V.p, t, o.end + 0.01);
    l.osc.frequency.setValueAtTime(8, t);
    l.osc.frequency.exponentialRampToValueAtTime(40, t + 0.95 * k);
    l.depth.gain.setValueAtTime(10 * V.p, t);
    l.depth.gain.linearRampToValueAtTime(90 * V.p, t + 0.95 * k);
    Nz(V, { a: 0.8, d: 0.15, v: 0.14, ft: 'bandpass', ff: 800, ff2: 7000, fg: 0.95, q: 4 });
  },

  // Laser beam burst: buzzing distorted saw/square with square-wave FM, sizzle and a punchy onset. 0.6 s.
  beam(V) {
    const t = V.t, k = V.k, j = rand(0.95, 1.05);
    const bp = Flt(V, 'bandpass', 1400 * j, 0.8);
    const sh = Sh(V, 4, bp);
    const a = T(V, { type: 'sawtooth', f: 180 * j, a: 0.005, hold: 0.45, d: 0.15, v: 0.28, to: sh });
    const b = T(V, { type: 'square', f: 270 * j, det: 12, a: 0.005, hold: 0.45, d: 0.15, v: 0.14, to: sh });
    lfo(V, [a.osc.frequency, b.osc.frequency], 55, 40 * V.p, t, a.end + 0.01, 'square');
    T(V, { f: 2400 * j, f2: 1800 * j, g: 0.6, a: 0.003, hold: 0.4, d: 0.15, v: 0.045 });
    Nz(V, { a: 0.003, hold: 0.4, d: 0.18, v: 0.15, ft: 'highpass', ff: 3500 });
    T(V, { f: 400, f2: 90, g: 0.08, a: 0.001, d: 0.1, v: 0.3 });
  },

  // Crystalline eruption: sharp crack + upward snap + ringing glockenspiel-like ice partials + thump.
  icespike(V) {
    const j = rand(0.93, 1.07);
    Nz(V, { d: 0.03, v: 0.45, ft: 'highpass', ff: 2500 * j, q: 0.8 });
    Nz(V, { at: 0.005, d: 0.12, v: 0.25, ft: 'bandpass', ff: 5200 * j, q: 3 });
    T(V, { f: 180 * j, f2: 60, g: 0.1, a: 0.001, d: 0.15, v: 0.4 });
    T(V, { type: 'triangle', f: 700 * j, f2: 2100 * j, g: 0.06, a: 0.001, d: 0.07, v: 0.11 });
    for (const [r, d, v] of [[1, 0.35, 0.07], [2.76, 0.22, 0.045], [5.4, 0.14, 0.03], [8.93, 0.09, 0.02]]) T(V, { at: 0.01, f: 1180 * j * r, a: 0.001, d, v });
    wet(V, 0.2);
  },

  // Glass / ice shatter: crack, bright spray, then randomly scattered tinkling shards.
  shatter(V) {
    const j = rand(0.9, 1.1);
    Nz(V, { d: 0.02, v: 0.45, ft: 'highpass', ff: 3000 });
    Nz(V, { a: 0.002, d: 0.3, v: 0.22, ft: 'bandpass', ff: 6500 * j, q: 1.5 });
    T(V, { f: 240 * j, f2: 90, g: 0.06, a: 0.001, d: 0.08, v: 0.22 });
    for (let i = 0; i < 9; i++) T(V, { at: rand(0, 0.22), f: rand(2200, 7500) * j, a: 0.001, d: rand(0.04, 0.14), v: rand(0.03, 0.055) });
    wet(V, 0.2);
  },

  // Freeze: bright crackle spreading + descending shimmering whistle + frosty hiss.
  freeze(V) {
    const cg = Gn(V, 0);
    crackle(V, cg, V.t, 0.5, 0.01, 0.035, 0.3, 1, 0.004);
    Nz(V, { a: 0.001, hold: 0.52, d: 0.02, v: 0.4, ft: 'bandpass', ff: 4200, q: 1.2, to: cg });
    Nz(V, { a: 0.05, d: 0.5, v: 0.11, ft: 'highpass', ff: 6000 });
    const trem = Gn(V, 0.6);
    lfo(V, trem.gain, 23, 0.4, V.t, V.t + 0.72 * V.k);
    T(V, { f: 3520, f2: 1760, g: 0.6, a: 0.01, d: 0.6, v: 0.055, to: trem });
    T(V, { f: 4700, f2: 2350, g: 0.6, a: 0.01, d: 0.5, v: 0.035, to: trem });
    T(V, { type: 'triangle', f: 300, f2: 700, g: 0.05, a: 0.001, d: 0.06, v: 0.12 });
    wet(V, 0.3);
  },

  // Frost nova: deep icy whoomp + spray + sparkle cascade + shimmering high chord.
  frostnova(V) {
    const t = V.t, k = V.k;
    T(V, { f: 140, f2: 42, g: 0.35, a: 0.004, d: 0.5, v: 0.55 });
    Nz(V, { a: 0.03, d: 0.5, v: 0.45, ft: 'lowpass', ff: 2500, ff2: 180, fg: 0.45, q: 1, pink: 1 });
    Nz(V, { a: 0.01, d: 0.35, v: 0.18, ft: 'bandpass', ff: 7000, ff2: 2500, fg: 0.35, q: 1.5 });
    [88, 91, 93, 96, 98, 100, 103, 105].forEach((m, i) => T(V, { at: 0.08 + i * 0.06 + rand(0, 0.02), f: mtof(m), a: 0.001, d: 0.2, v: 0.032 }));
    const trem = Gn(V, 0.6);
    lfo(V, trem.gain, 11, 0.4, t, t + 1.0 * k);
    [81, 85, 88].forEach((m) => T(V, { at: 0.05, f: mtof(m), a: 0.05, hold: 0.2, d: 0.6, v: 0.028, to: trem }));
    wet(V, 0.35);
  },

  // Snowball throw: soft pink-noise "fff" whoosh with a faint rising tone.
  snowball(V) {
    const j = rand(0.9, 1.1);
    Nz(V, { a: 0.04, d: 0.12, v: 0.35, ft: 'bandpass', ff: 600 * j, ff2: 2000 * j, fg: 0.14, q: 1.4, pink: 1 });
    T(V, { type: 'triangle', f: 500 * j, f2: 900 * j, g: 0.1, a: 0.01, d: 0.08, v: 0.05 });
  },

  // Snowball impact: soft low thump + muffled burst + a few crunchy snow grains.
  snowimpact(V) {
    const j = rand(0.9, 1.1);
    T(V, { f: 150 * j, f2: 60, g: 0.08, a: 0.002, d: 0.12, v: 0.33 });
    Nz(V, { d: 0.12, v: 0.42, ft: 'lowpass', ff: 1400 * j, ff2: 400, fg: 0.1, q: 0.8, pink: 1 });
    const cg = Gn(V, 0);
    crackle(V, cg, V.t + 0.004, 0.1, 0.008, 0.02, 0.4, 1, 0.006);
    Nz(V, { a: 0.001, hold: 0.13, d: 0.02, v: 0.3, ft: 'bandpass', ff: 2600 * j, q: 1.2, to: cg });
  },

  // Burrow: gritty low dig rumble with a wobbling sub. ~1.2 s.
  burrow(V) {
    const t = V.t, k = V.k;
    const grit = Gn(V, 0.6);
    lfo(V, grit.gain, 18, 0.4, t, t + 1.22 * k, 'square');
    Nz(V, { a: 0.15, hold: 0.6, d: 0.45, v: 0.65, ft: 'lowpass', ff: 380, ff2: 180, fg: 1.2, q: 2, pink: 1, to: grit });
    Nz(V, { a: 0.1, hold: 0.5, d: 0.4, v: 0.16, ft: 'bandpass', ff: 900, q: 2, to: grit });
    const s = T(V, { f: 48, f2: 36, g: 1.2, a: 0.1, hold: 0.7, d: 0.4, v: 0.32 });
    lfo(V, s.osc.frequency, 7, 6 * V.p, t, s.end + 0.01);
  },

  // Eruption: massive distorted ground boom + blast + debris raining down.
  erupt(V) {
    const sh = Sh(V, 3);
    T(V, { f: 110, f2: 26, g: 0.8, a: 0.002, d: 1.1, v: 0.75, to: sh });
    Nz(V, { d: 1.2, v: 0.55, ft: 'lowpass', ff: 3000, ff2: 120, fg: 1.0, pink: 1 });
    Nz(V, { d: 0.06, v: 0.4, ft: 'highpass', ff: 1000 });
    T(V, { type: 'triangle', f: 300, f2: 70, g: 0.12, a: 0.001, d: 0.15, v: 0.22 });
    for (let i = 0; i < 10; i++) Nz(V, { at: 0.25 + rand(0, 1.0), d: rand(0.02, 0.05), v: rand(0.08, 0.2), ft: 'bandpass', ff: rand(900, 3500), q: 3 });
    wet(V, 0.35);
  },

  // Tornado: swirling band of wind orbiting in stereo, low roar and a whistle. 1.5 s.
  tornado(V) {
    const t = V.t, k = V.k;
    let dest = V.out;
    if (ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.connect(V.out);
      V.nodes.push(pn);
      lfo(V, pn.pan, 2.2, 0.7, t, t + 1.52 * k);
      dest = pn;
    }
    const bp = Flt(V, 'bandpass', 700, 3.5, null, dest);
    const l = lfo(V, bp.frequency, 2, 450 * V.p, t, t + 1.52 * k);
    l.osc.frequency.setValueAtTime(2, t);
    l.osc.frequency.linearRampToValueAtTime(5, t + 1.0 * k);
    Nz(V, { a: 0.5, hold: 0.5, d: 0.5, v: 0.6, pink: 1, to: bp });
    Nz(V, { a: 0.4, hold: 0.5, d: 0.5, v: 0.3, ft: 'lowpass', ff: 220, q: 1, pink: 1 });
    const wh = T(V, { f: 900, f2: 1400, g: 1.0, lin: 1, a: 0.5, hold: 0.4, d: 0.6, v: 0.025, to: dest });
    lfo(V, wh.osc.frequency, 3, 120 * V.p, t, wh.end + 0.01);
  },

  // Scarab: dry insect chittering (rapid resonant clicks + tiny chirps).
  scarab(V) {
    const j = rand(0.9, 1.15);
    let at = 0;
    for (let i = 0; i < 10; i++) {
      Nz(V, { at, a: 0.0005, d: 0.012, v: rand(0.25, 0.45), ft: 'bandpass', ff: rand(2500, 4500) * j, q: 4 });
      at += rand(0.018, 0.03);
    }
    for (let i = 0; i < 3; i++) T(V, { type: 'triangle', at: rand(0, 0.2), f: rand(2800, 3600) * j, f2: rand(2000, 2600) * j, g: 0.03, a: 0.001, d: 0.03, v: 0.04 });
  },

  // Skull shot: whooshing wail with vibrato and a hollow fifth.
  skull(V) {
    const t = V.t, k = V.k, j = rand(0.92, 1.08);
    Nz(V, { a: 0.05, d: 0.35, v: 0.3, ft: 'bandpass', ff: 500 * j, ff2: 1800 * j, fg: 0.3, q: 1.5, pink: 1 });
    const w = T(V, { f: 520 * j, f2: 880 * j, g: 0.15, a: 0.03, hold: 0.1, d: 0.3, v: 0.12 });
    w.osc.frequency.exponentialRampToValueAtTime(fq(440 * j * V.p), t + 0.42 * k);
    lfo(V, w.osc.frequency, 9, 25 * V.p, t, w.end + 0.01);
    const w2 = T(V, { type: 'triangle', f: 780 * j, f2: 1320 * j, g: 0.15, a: 0.03, hold: 0.1, d: 0.3, v: 0.04 });
    w2.osc.frequency.exponentialRampToValueAtTime(fq(660 * j * V.p), t + 0.42 * k);
  },

  // Teleport: reversed swoosh that snaps off into a sparkling shimmer.
  teleport(V) {
    const t = V.t, k = V.k;
    const n = Nz(V, { a: 0.28, d: 0.03, ft: 'bandpass', ff: 500, ff2: 6000, fg: 0.28, q: 1.4, noenv: 1 });
    n.g.gain.setValueAtTime(EPS, t);
    n.g.gain.exponentialRampToValueAtTime(0.4, t + 0.28 * k);
    n.g.gain.linearRampToValueAtTime(0, t + 0.3 * k);
    T(V, { f: 300, f2: 1800, g: 0.28, a: 0.26, d: 0.03, v: 0.09 });
    Nz(V, { at: 0.28, d: 0.04, v: 0.22, ft: 'highpass', ff: 4000 });
    const trem = Gn(V, 0.6);
    lfo(V, trem.gain, 18, 0.4, t + 0.28 * k, t + 0.95 * k);
    [2093, 2637, 3136].forEach((f, i) => T(V, { at: 0.28 + i * 0.03, f, a: 0.002, d: 0.45, v: 0.04, to: trem }));
  },

  // Scythe: heavy low-to-high slicing whoosh ending in a metallic "shing".
  scythe(V) {
    const j = rand(0.92, 1.08);
    Nz(V, { a: 0.08, d: 0.2, v: 0.55, ft: 'bandpass', ff: 250 * j, ff2: 1800 * j, fg: 0.22, q: 1.8, pink: 1 });
    Nz(V, { at: 0.12, a: 0.01, d: 0.12, v: 0.18, ft: 'highpass', ff: 4500 });
    for (const [f, d, v] of [[2150, 0.3, 0.05], [3310, 0.22, 0.035], [4870, 0.15, 0.025]]) T(V, { at: 0.13, f: f * j, a: 0.001, d, v });
    T(V, { at: 0.13, type: 'triangle', f: 160 * j, f2: 70, g: 0.1, a: 0.002, d: 0.12, v: 0.2 });
  },

  // Ghost: soft rising-then-falling wail with vibrato and breath (final-swarm spawns: quiet + heavily limited).
  ghost(V) {
    const t = V.t, k = V.k, j = rand(0.85, 1.2);
    const w = T(V, { f: 380 * j, f2: 640 * j, g: 0.35, a: 0.2, hold: 0.25, d: 0.45, v: 0.07 });
    w.osc.frequency.exponentialRampToValueAtTime(fq(300 * j * V.p), t + 0.88 * k);
    lfo(V, w.osc.frequency, 6, 14 * j * V.p, t, w.end + 0.01);
    const w2 = T(V, { type: 'triangle', f: 570 * j, f2: 960 * j, g: 0.35, a: 0.25, hold: 0.2, d: 0.45, v: 0.018 });
    w2.osc.frequency.exponentialRampToValueAtTime(fq(450 * j * V.p), t + 0.88 * k);
    Nz(V, { a: 0.25, d: 0.6, v: 0.09, ft: 'bandpass', ff: 900 * j, ff2: 500 * j, fg: 0.8, q: 3, pink: 1 });
    wet(V, 0.4);
  },

  // Fire breath: roaring rush + distorted growl + crackle. 1.5 s.
  breath(V) {
    const t = V.t, k = V.k;
    Nz(V, { a: 0.12, hold: 0.9, d: 0.45, v: 0.5, ft: 'lowpass', ff: 500, ff2: 3500, fg: 0.3, q: 1.2, pink: 1 });
    Nz(V, { a: 0.1, hold: 0.9, d: 0.4, v: 0.16, ft: 'bandpass', ff: 2500, q: 0.8 });
    const sh = Sh(V, 4, Flt(V, 'lowpass', 700, 1));
    const gr = Gn(V, 0.6, sh);
    lfo(V, gr.gain, 21, 0.4, t, t + 1.5 * k);
    T(V, { type: 'sawtooth', f: 65, f2: 55, g: 1.4, a: 0.1, hold: 0.9, d: 0.4, v: 0.1, to: gr });
    const cg = Gn(V, 0);
    crackle(V, cg, t + 0.05 * k, 1.3, 0.02, 0.07, 0.2, 0.7, 0.005);
    Nz(V, { a: 0.001, hold: 1.4, d: 0.05, v: 0.55, ft: 'highpass', ff: 2200, to: cg });
    wet(V, 0.2);
  },

  // Dragon roar: bigger & longer than bossroar, with a screeching formant layer and sub. 2.5 s.
  dragonroar(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 250, 5, { f2: 2400, g: 0.55, f3: 600, g3: 2.4 });
    const sh = Sh(V, 8, lp, '2x');
    const growl = Gn(V, 0.7, sh);
    const l = lfo(V, growl.gain, 24, 0.3, t, t + 2.55 * k);
    l.osc.frequency.setValueAtTime(24, t);
    l.osc.frequency.linearRampToValueAtTime(14, t + 2.5 * k);
    for (const [f, det] of [[46.2, -14], [46.2, 12], [69.3, 6], [34.6, 0], [92.5, -6]]) {
      const o = T(V, { type: 'sawtooth', f: f * 0.8, f2: f * 1.2, g: 0.6, a: 0.18, hold: 1.6, d: 0.7, v: 0.15, det, to: growl });
      o.osc.frequency.exponentialRampToValueAtTime(fq(f * 0.7 * V.p), t + 2.46 * k);
    }
    Nz(V, { a: 0.25, hold: 1.4, d: 0.8, v: 0.3, ft: 'bandpass', ff: 450, ff2: 1000, fg: 0.6, q: 1.3, to: growl });
    const bp = Flt(V, 'bandpass', 1200, 6, { at: 0.1, f2: 2600, g: 0.5, f3: 900, g3: 2.3 });
    T(V, { type: 'sawtooth', at: 0.1, f: 330, f2: 440, g: 0.5, a: 0.15, hold: 1.2, d: 0.9, v: 0.12, to: bp });
    T(V, { f: 38, f2: 30, g: 2.4, a: 0.2, hold: 1.4, d: 0.8, v: 0.28 });
    wet(V, 0.35);
  },

  // Wing flap: leathery low whoosh + chest-thump.
  wing(V) {
    const j = rand(0.9, 1.1);
    Nz(V, { a: 0.06, d: 0.22, v: 0.55, ft: 'lowpass', ff: 300 * j, ff2: 900 * j, fg: 0.07, q: 1.5, pink: 1 });
    T(V, { at: 0.05, f: 85 * j, f2: 40, g: 0.15, a: 0.005, d: 0.22, v: 0.42 });
    Nz(V, { at: 0.04, d: 0.08, v: 0.12, ft: 'bandpass', ff: 1400 * j, q: 1 });
  },

  // Falling coconut: hollow cavity bonk + a little bounce.
  coconut(V) {
    const j = rand(0.92, 1.08);
    Nz(V, { d: 0.01, v: 0.25, ft: 'highpass', ff: 2500 });
    T(V, { f: 480 * j, f2: 330 * j, g: 0.05, a: 0.001, d: 0.14, v: 0.42 });
    Nz(V, { d: 0.09, v: 1.3, ft: 'bandpass', ff: 520 * j, q: 14 });
    T(V, { f: 1250 * j, a: 0.0005, d: 0.03, v: 0.16 });
    T(V, { at: 0.2, f: 500 * j, f2: 360 * j, g: 0.04, a: 0.001, d: 0.08, v: 0.15 });
    Nz(V, { at: 0.2, d: 0.05, v: 0.5, ft: 'bandpass', ff: 540 * j, q: 12 });
  },

  // Lava: bubble "bloop" + pop + steam hiss.
  lava(V) {
    const j = rand(0.85, 1.2);
    T(V, { f: 90 * j, f2: 260 * j, g: 0.07, a: 0.004, d: 0.07, v: 0.33 });
    Nz(V, { at: 0.06, d: 0.015, v: 0.22, ft: 'bandpass', ff: 1800 * j, q: 2 });
    Nz(V, { at: 0.07, a: 0.02, d: 0.28, v: 0.09, ft: 'highpass', ff: 4500 });
  },

  // Black hole: deep vortex hum swelling with accelerating tremolo, sub drop, and a reverse "suck-in" sweep. 1.5 s.
  blackhole(V) {
    const t = V.t, k = V.k;
    const lp = Flt(V, 'lowpass', 120, 6, { f2: 900, g: 1.0, f3: 150, g3: 1.5 });
    const trem = Gn(V, 0.65, lp);
    const l = lfo(V, trem.gain, 4, 0.35, t, t + 1.52 * k);
    l.osc.frequency.setValueAtTime(4, t);
    l.osc.frequency.exponentialRampToValueAtTime(19, t + 1.3 * k);
    for (const [f, det] of [[41.2, -12], [41.2, 10], [61.7, 0]]) T(V, { type: 'sawtooth', f, f2: f * 0.75, g: 1.5, a: 0.6, hold: 0.5, d: 0.4, v: 0.13, det, to: trem });
    T(V, { f: 55, f2: 30, g: 1.5, a: 0.5, hold: 0.6, d: 0.4, v: 0.32 });
    Nz(V, { a: 1.1, d: 0.35, v: 0.2, ft: 'bandpass', ff: 5000, ff2: 300, fg: 1.4, q: 2.5 });
    wet(V, 0.3);
  },

  // Moai: grinding stone rumble + a low "ooh" choir.
  moai(V) {
    const t = V.t, k = V.k;
    const grit = Gn(V, 0.55);
    lfo(V, grit.gain, 13, 0.45, t, t + 1.32 * k, 'square');
    Nz(V, { a: 0.1, hold: 0.9, d: 0.3, v: 0.55, ft: 'bandpass', ff: 260, ff2: 180, fg: 1.2, q: 2.5, pink: 1, to: grit });
    Nz(V, { a: 0.1, hold: 0.8, d: 0.3, v: 0.12, ft: 'bandpass', ff: 1400, q: 3, to: grit });
    const f1 = Flt(V, 'bandpass', 420, 4), f2 = Flt(V, 'bandpass', 800, 5);
    const vg = Gn(V, 1, f1);
    vg.connect(f2);
    const vib = [];
    for (const [m, d] of [[43, -7], [43, 7], [50, 0], [55, -4]]) vib.push(T(V, { type: 'sawtooth', at: 0.3, f: mtof(m), det: d, a: 0.5, hold: 0.8, d: 0.6, v: 0.17, to: vg }).osc.frequency);
    lfo(V, vib, 4.8, 0.8 * V.p, t, t + 2.25 * k);
    T(V, { at: 0.3, f: 49, a: 0.3, hold: 1.0, d: 0.5, v: 0.22 });
    wet(V, 0.4);
  },

  // Totem trial start: three heavy war-drum hits (last is biggest) with a boom.
  totem(V) {
    [[0, 0.7], [0.28, 0.8], [0.56, 1]].forEach(([at, v]) => {
      T(V, { at, f: 110, f2: 55, g: 0.25, a: 0.002, d: 0.45, v: 0.5 * v });
      T(V, { at, type: 'triangle', f: 220, f2: 120, g: 0.05, a: 0.001, d: 0.08, v: 0.2 * v });
      Nz(V, { at, d: 0.12, v: 0.35 * v, ft: 'lowpass', ff: 1200, q: 0.8, pink: 1 });
      Nz(V, { at, d: 0.03, v: 0.15 * v, ft: 'bandpass', ff: 2500, q: 1 });
    });
    const sh = Sh(V, 2.5);
    T(V, { at: 0.56, f: 70, f2: 30, g: 0.6, a: 0.003, d: 0.8, v: 0.45, to: sh });
    wet(V, 0.35);
  },

  // Trial success: two drum hits, ascending brass G-C-E into a big C chord with a held lead.
  trialwin(V) {
    const lp = Flt(V, 'lowpass', 5200, 0.8);
    [[0, 67], [0.1, 72], [0.2, 76]].forEach(([at, m]) => brass(V, at, [m, m - 12], 0.01, 0.05, 0.05, 0.05, 800, 4000));
    brass(V, 0.3, [48, 60, 67, 72, 76], 0.03, 0.45, 0.45, 0.036, 700, 4500);
    fan(V, lp, 0.3, 79, 0.45, 0.06, true);
    timp(V, 0.1, 110, 0.5); timp(V, 0.3, 98, 1);
    Nz(V, { at: 0.3, d: 0.8, v: 0.1, ft: 'highpass', ff: 5000 });
    [0, 4, 7, 12, 16].forEach((n, i) => T(V, { at: 0.35 + i * 0.045, f: mtof(84 + n), a: 0.001, d: 0.25, v: 0.028 }));
    wet(V, 0.4);
  },

  // Trial failed: descending diminished arpeggio that sags at the end, with a low buzz.
  trialfail(V) {
    const lp = Flt(V, 'lowpass', 1600, 1);
    [[0, 71], [0.18, 67], [0.36, 64], [0.54, 61]].forEach(([at, m], i) => {
      const last = i === 3;
      T(V, { wave: pulse25, type: 'square', at, f: mtof(m), f2: last ? mtof(m - 3) : 0, g: 0.5, a: 0.005, hold: last ? 0.3 : 0.1, d: last ? 0.3 : 0.06, v: 0.09, to: lp });
      T(V, { type: 'triangle', at, f: mtof(m - 12), f2: last ? mtof(m - 15) : 0, g: 0.5, a: 0.005, hold: last ? 0.3 : 0.1, d: last ? 0.3 : 0.06, v: 0.12 });
    });
    T(V, { at: 0.54, type: 'sawtooth', f: 55, f2: 45, g: 0.6, a: 0.01, hold: 0.25, d: 0.3, v: 0.08, to: lp });
    wet(V, 0.2);
  },

  // Greed jackpot: a cascade of coin blips climbing, ending on a bell.
  greed(V) {
    const lp = Flt(V, 'lowpass', 7000, 0.7);
    [0, 4, 7, 12, 7, 12, 16, 12, 16, 19, 16, 24].forEach((n, i) => {
      const at = i * 0.055 + rand(0, 0.012), m = 79 + n;
      T(V, { type: 'square', at, f: mtof(m - 5), a: 0.001, hold: 0.03, d: 0.01, v: 0.045, to: lp });
      T(V, { type: 'square', at: at + 0.035, f: mtof(m), a: 0.001, hold: 0.02, d: 0.12, v: 0.045, to: lp });
    });
    T(V, { at: 0.7, f: mtof(96), a: 0.001, d: 0.7, v: 0.065 });
    T(V, { at: 0.7, f: mtof(96) * 2.76, a: 0.001, d: 0.25, v: 0.02 });
    Nz(V, { at: 0.7, d: 0.4, v: 0.08, ft: 'highpass', ff: 6000 });
    wet(V, 0.3);
  },

  // Pylon: electric magnet zap + inward whoosh + mains hum.
  pylon(V) {
    const t = V.t;
    const gate = Gn(V, 0);
    crackle(V, gate, t, 0.3, 0.006, 0.014, 0.05, 1, 0);
    const bp = Flt(V, 'bandpass', 1100, 0.8, null, gate);
    const sh = Sh(V, 5, bp);
    T(V, { type: 'sawtooth', f: 120, f2: 240, g: 0.3, a: 0.003, hold: 0.2, d: 0.1, v: 0.38, to: sh });
    Nz(V, { at: 0.1, a: 0.3, d: 0.25, v: 0.28, ft: 'bandpass', ff: 3000, ff2: 400, fg: 0.5, q: 2 });
    T(V, { type: 'triangle', f: 60, a: 0.02, hold: 0.4, d: 0.2, v: 0.12 });
    T(V, { type: 'sawtooth', f: 120, a: 0.02, hold: 0.4, d: 0.2, v: 0.03, to: Flt(V, 'lowpass', 600, 1) });
    wet(V, 0.2);
  },

  // FINAL SWARM start: dissonant formant choir swelling over a sub-drop, slamming in at ~1 s.
  swarmstart(V) {
    const t = V.t, k = V.k;
    const f1 = Flt(V, 'bandpass', 650, 3), f2 = Flt(V, 'bandpass', 1100, 4);
    const vg = Gn(V, 1, f1);
    vg.connect(f2);
    const fr = [];
    for (const [m, d] of [[50, -6], [53, 5], [56, -3], [57, 4], [62, 0]]) fr.push(T(V, { type: 'sawtooth', f: mtof(m), det: d, a: 0.9, hold: 0.9, d: 0.7, v: 0.13, to: vg }).osc.frequency);
    lfo(V, fr, 5.2, 3 * V.p, t, t + 2.55 * k);
    T(V, { f: 90, f2: 24, g: 2.0, a: 0.05, hold: 0.9, d: 1.2, v: 0.45 });
    Nz(V, { a: 0.9, d: 0.1, v: 0.28, ft: 'bandpass', ff: 300, ff2: 4000, fg: 0.95, q: 2, pink: 1 });
    const sh = Sh(V, 3);
    T(V, { at: 0.95, f: 80, f2: 28, g: 0.8, a: 0.003, d: 1.2, v: 0.55, to: sh });
    Nz(V, { at: 0.95, d: 1.0, v: 0.32, ft: 'lowpass', ff: 1500, ff2: 90, fg: 0.9, pink: 1 });
    wet(V, 0.5);
  },

  // Low-HP heartbeat: one soft "lub-dub".
  heartbeat(V) {
    const lp = Flt(V, 'lowpass', 320, 0.9);
    T(V, { f: 72, f2: 42, g: 0.1, a: 0.008, d: 0.16, v: 0.6, to: lp });
    T(V, { type: 'triangle', f: 150, f2: 90, g: 0.05, a: 0.004, d: 0.06, v: 0.12, to: lp });
    T(V, { at: 0.17, f: 64, f2: 38, g: 0.1, a: 0.008, d: 0.2, v: 0.45, to: lp });
    T(V, { type: 'triangle', at: 0.17, f: 130, f2: 80, g: 0.05, a: 0.004, d: 0.06, v: 0.08, to: lp });
  },
});

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
  // THE ARCHIPELAGO
  portal: [600, 1, 2], warp: [1500, 1, 2], portalopen: [800, 1, 2], quest: [300, 2, 2], unlock: [800, 1, 2],
  victory: [2000, 1, 2], truevictory: [4000, 1, 2], bossintro: [1500, 1, 2], phase2: [1000, 1, 2],
  beamcharge: [300, 2, 1], beam: [120, 2, 1], icespike: [60, 3, 1], shatter: [60, 3, 1], freeze: [120, 2, 1],
  frostnova: [150, 2, 1], snowball: [60, 3, 0], snowimpact: [50, 4, 0], burrow: [400, 1, 1], erupt: [300, 2, 2],
  tornado: [600, 1, 1], scarab: [80, 3, 0], skull: [80, 3, 0], teleport: [200, 2, 1], scythe: [100, 2, 1],
  ghost: [250, 2, 0], breath: [800, 1, 2], dragonroar: [1500, 1, 2], wing: [200, 2, 1], coconut: [80, 3, 1],
  lava: [90, 3, 0], blackhole: [500, 2, 1], moai: [1000, 1, 2], totem: [800, 1, 2], trialwin: [800, 1, 2],
  trialfail: [800, 1, 2], greed: [600, 1, 2], pylon: [300, 1, 1], swarmstart: [2000, 1, 2], heartbeat: [300, 1, 2],
};
const GLOBAL_CAP = [24, 40, 60]; // max total active voices before a sound of that priority is dropped
// Big stingers dip the music automatically (merged with any explicit duck()).
const AUTODUCK = {
  levelup: [0.45, 0.9], legendary: [0.5, 1.6], bossroar: [0.55, 1.8], warning: [0.35, 1.0],
  newbest: [0.45, 1.3], death: [0.6, 2.0], shrine: [0.35, 1.4], swarm: [0.3, 1.2], chest: [0.3, 0.8],
  portal: [0.3, 1.5], warp: [0.5, 2.1], portalopen: [0.3, 1.2], quest: [0.25, 0.8], unlock: [0.5, 1.7],
  victory: [0.6, 2.7], truevictory: [0.8, 5.4], bossintro: [0.6, 2.0], phase2: [0.45, 1.4], dragonroar: [0.5, 2.4],
  moai: [0.3, 1.8], totem: [0.3, 1.1], trialwin: [0.4, 1.2], trialfail: [0.4, 1.1], greed: [0.25, 1.0],
  swarmstart: [0.5, 2.4],
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
function barEvs(mk, bar) {
  const M = MODES[mk];
  const phrase = Math.floor(bar / 8), pb = bar % 8;
  const seed = M.seeds[phrase % M.seeds.length];
  return pb < 4 ? mel(mk, seed)[pb] : pb < 6 ? mel(mk, seed)[pb - 4] : mel(mk, seed + 100)[pb - 4];
}
function leadEv(mk, bar, s) {
  const evs = barEvs(mk, bar);
  for (let i = 0; i < evs.length; i++) if (evs[i][0] === s) return evs[i];
  return null;
}
function leadAt(mk, bar, s) { // the melody note sounding at step s (for tremolo-picked long notes)
  const evs = barEvs(mk, bar);
  for (let i = 0; i < evs.length; i++) if (s >= evs[i][0] && s < evs[i][0] + evs[i][1]) return evs[i];
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

// --- ARCHIPELAGO instruments -----------------------------------------------------------------
// Glockenspiel (inharmonic bar partials) or celesta (near-harmonic) pluck.
function mBell(t, m, dur, v, pan, glock) {
  const V = mv(t, instBus, pan);
  const f = mtof(m);
  T(V, { f, a: 0.001, d: dur, v: 0.13 * v });
  T(V, { f: f * (glock ? 2.76 : 2), a: 0.001, d: dur * 0.35, v: 0.04 * v });
  T(V, { f: f * (glock ? 5.4 : 3.01), a: 0.0005, d: dur * 0.15, v: 0.022 * v });
  send(V, echoIn, 0.3);
  send(V, musicVerb, 0.25);
  finish(V);
}
// Airy pad: soft detuned triangles + sine octave + a breath of high noise.
function mAirPad(t, notes, dur, v) {
  const V = mv(t, instBus);
  const a = Math.min(0.6, dur * 0.35), hold = Math.max(0.01, dur - a - 0.2);
  const lp = Flt(V, 'lowpass', 2600, 0.7);
  for (const m of notes) {
    T(V, { type: 'triangle', f: mtof(m), det: rand(-6, 6), a, hold, d: 0.6, v: 0.05 * v, to: lp });
    T(V, { f: mtof(m + 12), det: rand(-4, 4), a, hold, d: 0.6, v: 0.018 * v, to: lp });
  }
  Nz(V, { a, hold, d: 0.6, v: 0.05 * v, ft: 'bandpass', ff: 6000, q: 0.9 });
  send(V, musicVerb, 0.5);
  finish(V);
}
// Sleigh-bell shaker: bright noise tick + two tiny jingle pings.
function mSleigh(t, v) {
  const V = mv(t, drumBus, 0.3);
  Nz(V, { a: 0.004, d: 0.06, v: 0.8 * v, ft: 'highpass', ff: 7500, q: 0.8 });
  if (v >= 0.08) { // jingles only on the accented hits (keeps 16th-note shaking cheap)
    T(V, { f: rand(5200, 5600), a: 0.001, d: 0.05, v: 0.05 * v });
    T(V, { f: rand(6900, 7400), a: 0.001, d: 0.04, v: 0.035 * v });
  }
  finish(V);
}
// Oud-like pluck: saw with a fast-closing lowpass, a slight pitch settle and a pick tick.
function mOud(t, m, dur, v, pan) {
  const V = mv(t, instBus, pan);
  const f = mtof(m), d = clamp(dur, 0.12, 0.45);
  const lp = Flt(V, 'lowpass', 700, 2.5);
  lp.frequency.setValueAtTime(fq(4200), t);
  lp.frequency.exponentialRampToValueAtTime(fq(700), t + 0.12);
  T(V, { type: 'sawtooth', f: f * 1.012, f2: f, g: 0.03, a: 0.001, d, v: 0.13 * v, to: lp });
  T(V, { type: 'triangle', f: f * 2, a: 0.001, d: d * 0.4, v: 0.03 * v, to: lp });
  Nz(V, { d: 0.012, v: 0.05 * v, ft: 'bandpass', ff: 2500, q: 1.5 });
  send(V, echoIn, 0.15);
  send(V, musicVerb, 0.15);
  finish(V);
}
// Darbuka: 0 = DUM (deep centre), 1 = TEK (sharp rim), 2 = KA (soft rim).
function mDarbuka(t, kind, v) {
  const V = mv(t, drumBus, kind === 0 ? 0 : kind === 1 ? 0.18 : -0.2);
  if (kind === 0) {
    T(V, { f: 150, f2: 72, g: 0.07, a: 0.001, d: 0.3, v: 0.55 * v });
    Nz(V, { d: 0.03, v: 0.12 * v, ft: 'lowpass', ff: 900 });
  } else {
    Nz(V, { d: kind === 1 ? 0.05 : 0.03, v: (kind === 1 ? 0.5 : 0.3) * v, ft: 'bandpass', ff: kind === 1 ? 3400 : 2800, q: 1.6 });
    T(V, { type: 'triangle', f: kind === 1 ? 740 : 660, a: 0.0005, d: 0.035, v: 0.13 * v });
  }
  finish(V);
}
// Finger cymbals (zills).
function mZill(t, v) {
  const V = mv(t, drumBus, -0.35);
  T(V, { f: 3150, a: 0.001, d: 0.3, v: 0.045 * v });
  T(V, { f: 4410, a: 0.001, d: 0.22, v: 0.03 * v });
  Nz(V, { d: 0.02, v: 0.06 * v, ft: 'highpass', ff: 6000 });
  finish(V);
}
// Drone bass: tonic + fifth, one voice per bar with an overlapping tail so it never gaps.
function mDrone(t, m, dur, v) {
  const V = mv(t, instBus);
  const lp = Flt(V, 'lowpass', 350, 2);
  lp.frequency.setValueAtTime(350, t);
  lp.frequency.linearRampToValueAtTime(900, t + dur * 0.5);
  lp.frequency.linearRampToValueAtTime(350, t + dur);
  const a = 0.08, hold = Math.max(0.01, dur - 0.2);
  T(V, { type: 'sawtooth', f: mtof(m), det: -6, a, hold, d: 0.35, v: 0.09 * v, to: lp });
  T(V, { type: 'sawtooth', f: mtof(m + 7), det: 5, a, hold, d: 0.35, v: 0.05 * v, to: lp });
  T(V, { f: mtof(m), a, hold, d: 0.35, v: 0.14 * v });
  finish(V);
}
// Nasal reed (zurna-ish): narrow pulse, pitch scoop into the note, delayed vibrato.
function mReed(t, m, dur, v) {
  const V = mv(t, instBus, -0.12);
  const f = mtof(m), hold = Math.max(0.01, dur - 0.06);
  const bp = Flt(V, 'bandpass', 1300, 1.2);
  const o = T(V, { wave: pulse12, type: 'square', f: f * 0.97, f2: f, g: 0.06, a: 0.02, hold, d: 0.1, v: 0.15 * v, to: bp });
  if (dur > 0.25) {
    const l = lfo(V, o.osc.frequency, 6.2, 0.0001, t, o.end + 0.01);
    l.depth.gain.setValueAtTime(0.0001, t + 0.12);
    l.depth.gain.linearRampToValueAtTime(f * 0.018, t + 0.3);
  }
  send(V, echoIn, 0.2);
  send(V, musicVerb, 0.2);
  finish(V);
}
// Organ: detuned square pairs + sine octave with a gentle Leslie-ish tremolo.
function mOrgan(t, notes, dur, v, cut) {
  const V = mv(t, instBus);
  const lp = Flt(V, 'lowpass', cut || 2200, 0.8);
  const trem = Gn(V, 0.8, lp);
  lfo(V, trem.gain, 5.6, 0.2, t, t + dur + 0.25);
  const a = 0.03, hold = Math.max(0.01, dur - 0.08);
  for (const m of notes) {
    T(V, { type: 'square', f: mtof(m), det: -7, a, hold, d: 0.2, v: 0.026 * v, to: trem });
    T(V, { type: 'square', f: mtof(m), det: 7, a, hold, d: 0.2, v: 0.02 * v, to: trem });
    T(V, { f: mtof(m + 12), a, hold, d: 0.2, v: 0.018 * v, to: trem });
  }
  send(V, musicVerb, 0.45);
  finish(V);
}
// Theremin: sine (+ faint octave) gliding from the previous note, vibrato that blooms.
function mTheremin(t, m, dur, v, from) {
  const V = mv(t, instBus, 0.08);
  const f = mtof(m), f0 = from ? mtof(clamp(from, m - 12, m + 12)) : f;
  const hold = Math.max(0.02, dur - 0.08), g = Math.min(0.09, dur * 0.4);
  const o = T(V, { f: f0, f2: f, g, a: 0.05, hold, d: 0.22, v: 0.16 * v });
  const o2 = T(V, { type: 'triangle', f: f0 * 2, f2: f * 2, g, a: 0.05, hold, d: 0.22, v: 0.02 * v });
  const l = lfo(V, [o.osc.frequency, o2.osc.frequency], 5.4, 0.0001, t, o.end + 0.01);
  l.depth.gain.setValueAtTime(0.0001, t + 0.06);
  l.depth.gain.linearRampToValueAtTime(f * 0.02, t + Math.min(0.35, Math.max(0.08, dur)));
  send(V, echoIn, 0.3);
  send(V, musicVerb, 0.35);
  finish(V);
}
// Harpsichord: bright saw + narrow-pulse octave through a closing lowpass, quill click.
function mHarpsi(t, m, dur, v, pan) {
  const V = mv(t, instBus, pan);
  const f = mtof(m), d = clamp(dur, 0.2, 0.9);
  const hp = Flt(V, 'highpass', 300, 0.7);
  const lp = Flt(V, 'lowpass', 5000, 1, null, hp);
  lp.frequency.setValueAtTime(6500, t);
  lp.frequency.exponentialRampToValueAtTime(1800, t + d);
  T(V, { type: 'sawtooth', f, a: 0.001, d, v: 0.06 * v, to: lp });
  T(V, { wave: pulse12, type: 'square', f: f * 2, det: 4, a: 0.001, d: d * 0.6, v: 0.028 * v, to: lp });
  Nz(V, { d: 0.008, v: 0.05 * v, ft: 'highpass', ff: 4000 });
  send(V, echoIn, 0.18);
  finish(V);
}
// Church-bell toll (hum, prime, minor tierce, quint, nominal ...).
function mToll(t, m, v) {
  const V = mv(t, instBus, -0.1);
  const f = mtof(m);
  for (const [r, d, a] of [[0.5, 2.6, 0.07], [1, 2.2, 0.09], [1.19, 1.6, 0.045], [1.5, 1.4, 0.035], [2, 1.1, 0.045], [2.52, 0.7, 0.025], [3.01, 0.5, 0.018]]) T(V, { f: f * r, a: 0.002, d, v: a * v });
  send(V, musicVerb, 0.6);
  finish(V);
}
// Distorted power chord (root, fifth, octave) into the shared guitar amp bus. open=false -> palm mute.
function mChug(t, m, dur, v, open) {
  const V = mv(t, gtrIn);
  const lp = Flt(V, 'lowpass', open ? 5000 : 700, 1.5);
  const hold = open ? Math.max(0.01, dur - 0.1) : Math.min(dur * 0.4, 0.05), d = open ? 0.25 : 0.09;
  for (const [iv, det, vv] of [[0, -5, 0.5], [7, 5, 0.4], [12, 0, 0.3]]) T(V, { type: 'sawtooth', f: mtof(m + iv), det, a: 0.002, hold, d, v: vv * v, to: lp });
  finish(V);
}
// Tight kick for double-kick patterns (short decay, hard beater click).
function mTKick(t, v) {
  const V = mv(t, drumBus);
  T(V, { f: 190, f2: 50, g: 0.05, a: 0.001, d: 0.14, v: 0.8 * v });
  T(V, { type: 'triangle', f: 2200, f2: 400, g: 0.008, a: 0.0005, d: 0.01, v: 0.28 * v });
  finish(V);
}
// Aggressive saw lead: detuned saws + sub square, lightly driven, filter snap, vibrato on long notes.
function mSawLead(t, m, dur, v, cut) {
  const V = mv(t, instBus, 0.05);
  const f = mtof(m), hold = Math.max(0.01, dur - 0.05);
  const lvl = Gn(V, 0.55);
  const lp = Flt(V, 'lowpass', cut, 2, null, lvl);
  lp.frequency.setValueAtTime(fq(cut * 1.8), t);
  lp.frequency.exponentialRampToValueAtTime(fq(cut), t + 0.15);
  const sh = Sh(V, 2, lp);
  const a = T(V, { type: 'sawtooth', f, det: -11, a: 0.004, hold, d: 0.1, v: 0.09 * v, to: sh });
  const b = T(V, { type: 'sawtooth', f, det: 11, a: 0.004, hold, d: 0.1, v: 0.09 * v, to: sh });
  T(V, { type: 'square', f: f / 2, a: 0.004, hold, d: 0.1, v: 0.04 * v, to: sh });
  if (dur > 0.28) {
    const l = lfo(V, [a.osc.frequency, b.osc.frequency], 6, 0.0001, t, a.end + 0.01);
    l.depth.gain.setValueAtTime(0.0001, t + 0.15);
    l.depth.gain.linearRampToValueAtTime(f * 0.014, t + 0.3);
  }
  send(V, echoIn, 0.22);
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

// --- ARCHIPELAGO: per-biome sequencers --------------------------------------------------------
// One sequencer per biome, shared by its run / boss / final tracks: lvl 0 = run (layered by
// setIntensity), 1 = boss (full band, lead in the 2nd half of each 8-bar phrase), 2 = final (everything).
const SWING_OFF = [0, 0.33, 0.67, 0.33]; // 16th grid -> triplet-feel swing (grave)
const MAQSUM = [1, 0, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 2, 0, 0, 0]; // 1 dum, 2 tek
const SAIDI = [1, 0, 2, 0, 0, 0, 1, 0, 1, 0, 0, 0, 2, 0, 0, 0];
const FROST_BASS = [0, -1, 0, -1, 12, -1, 0, 0, 0, -1, 7, -1, 12, -1, 7, -1]; // -1 = rest
const FROST_FALL = [98, 97, 95, 93, 92, 90, 88, 86]; // D-lydian sparkle cascade
let glideFrom = 0; // theremin portamento memory
const fadeIn = (x, a, w) => clamp((x - a) / w, 0, 1);
const leadOn = (lvl, x, pb) => lvl === 2 || (lvl === 1 && pb >= 4) || (!lvl && x >= 0.6);
const phraseCrash = (s, bar, lvl) => s === 0 && bar > 0 && (bar % 8 === 0 || (lvl === 2 && bar % 4 === 0));

// FROST: crystalline. Glockenspiel arps, celesta lead, airy pads, light kit with sleigh shaker. D lydian / F# minor.
function frostSeq(s, bar, t, sd, M, lvl, mk) {
  const x = lvl ? 1 : intensity, [pc, ivs] = M.prog[bar % 4], pb = bar % 8, phrase = bar >> 3;
  const root = bassRoot(pc, 33);
  if (s === 0 || s === 8 || (s === 10 && (lvl || x >= 0.6)) || (lvl === 2 && s % 4 === 0)) mKick(t, lvl ? 0.8 : 0.65);
  if (s === 4 || s === 12) { mRim(t, 0.9); mSnare(t, lvl ? 0.42 : 0.28); if (lvl) mClap(t, 0.3); }
  if (s % 2 === 0) mSleigh(t, s % 4 === 2 ? 0.14 : 0.08);
  else if (lvl || x >= 0.85) mSleigh(t, 0.05);
  if (phraseCrash(s, bar, lvl)) mCrash(t, 0.35 + 0.35 * x);
  if (lvl) mBass(t, root + [0, 0, 12, 0][s % 4], sd * 0.85, [1, 0.5, 0.75, 0.5][s % 4], 0.35 + 0.2 * lvl);
  else if (FROST_BASS[s] >= 0) mBass(t, root + FROST_BASS[s], sd * 1.6, s % 4 === 0 ? 1 : 0.7, 0.15 + 0.5 * x);
  if (x >= 0.3 && (lvl || x >= 0.6 || s % 2 === 0)) {
    const vc = arpTones(pc, ivs, 76), ap = ARPS[phrase % ARPS.length];
    mBell(t, vc[ap[s] % vc.length] + (pb >= 4 && s >= 8 ? 12 : 0), 0.3, (lvl ? 0.5 : 0.6) * fadeIn(x, 0.3, 0.15), s % 2 ? 0.35 : -0.35, true);
  }
  if ((x >= 0.45 || lvl) && s === 0) mAirPad(t, voicing(pc, ivs, 62), sd * 16, lvl ? 0.8 : 0.9 * fadeIn(x, 0.45, 0.2));
  if (lvl && (s === 0 || s === 6 || (s === 12 && bar % 2 === 1))) for (const n of voicing(pc, ivs, 74)) mBell(t, n, 0.5, 0.4, 0, true);
  if (leadOn(lvl, x, pb)) {
    const ev = leadEv(mk, bar, s);
    if (ev) {
      const lv = lvl ? 1 : fadeIn(x, 0.6, 0.1);
      mBell(t, ev[2], Math.min(1.4, ev[1] * sd + 0.35), 1.15 * lv, 0.05, false);
      if (lvl === 2 || x >= 0.85) mBell(t, ev[2] + 12, 0.4, 0.35 * lv, -0.1, true);
    }
  }
  if (x >= 0.85 || lvl) {
    if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.7);
    if (pb === 7 && s >= 8) mBell(t, FROST_FALL[s - 8], 0.35, 0.4, (s - 12) / 5, true);
    if (pb === 7 && s >= 12) mSnare(t, 0.2 + (s - 12) * 0.08);
    if (lvl === 1 && bar % 2 === 1 && s >= 12) mTom(t, [300, 250, 200, 160][s - 12], 0.6);
  }
}

// DESERT: phrygian-dominant (boss: double harmonic). Oud plucks with tremolo-picked long notes,
// darbuka maqsum / saidi, a tonic drone under everything, reed doubling in boss/final.
function desertSeq(s, bar, t, sd, M, lvl, mk) {
  const x = lvl ? 1 : intensity, [pc, ivs] = M.prog[bar % 4], pb = bar % 8, phrase = bar >> 3;
  const hit = (lvl === 1 ? SAIDI : MAQSUM)[s];
  if (hit === 1) { mDarbuka(t, 0, 1); mKick(t, lvl ? 0.85 : 0.6); }
  else if (hit === 2) mDarbuka(t, 1, 1);
  else if (x >= 0.3 && (s % 2 === 0 || lvl === 2 || x >= 0.85)) mDarbuka(t, 2, s % 2 ? 0.3 : 0.5);
  if (lvl && (s === 4 || s === 12)) mClap(t, 0.4);
  if (s % 2 === 0) mShaker(t, s % 4 === 2 ? 0.09 : 0.05);
  if (phraseCrash(s, bar, lvl)) mCrash(t, 0.35 + 0.35 * x);
  if (s === 0) mDrone(t, bassRoot(M.tonic, 36), sd * 16, lvl ? 1 : 0.8);
  if (hit === 1 || (s === 14 && (lvl || x >= 0.45))) {
    const r = bassRoot(pc, 33);
    if (lvl) mDBass(t, r, sd * 1.5, 0.75); else mBass(t, r, sd * 1.5, 0.9, 0.3 + 0.5 * x);
  }
  if (x >= 0.3 && (lvl || x >= 0.6 || s % 2 === 0)) {
    const vc = arpTones(pc, ivs, 60), ap = ARPS[phrase % ARPS.length];
    mOud(t, vc[ap[s] % vc.length] + (pb >= 4 && s >= 8 ? 12 : 0), sd * 1.5, (lvl ? 0.5 : 0.6) * fadeIn(x, 0.3, 0.15), s % 2 ? 0.3 : -0.3);
  }
  if ((x >= 0.45 || lvl) && s === 0) mPad(t, voicing(pc, ivs, 52), sd * 16, 0.45 * (lvl ? 1 : fadeIn(x, 0.45, 0.2)), 800);
  if (leadOn(lvl, x, pb)) {
    const e = leadAt(mk, bar, s);
    if (e) {
      const lv = lvl ? 1 : fadeIn(x, 0.6, 0.1);
      if (e[0] === s) {
        mOud(t, e[2], e[1] * sd, 1.2 * lv, 0.05);
        if (lvl && e[1] >= 3) mReed(t, e[2], e[1] * sd * 0.95, 0.8 * lv);
      } else if (e[1] >= 4) mOud(t, e[2], sd * 1.2, 0.5 * lv, 0.05); // tremolo picking
    }
  }
  if (x >= 0.85 || lvl) {
    if (s % 4 === 2) mZill(t, lvl === 2 ? 0.9 : 0.6);
    if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.8);
    if (pb === 3 && s >= 12) mDarbuka(t, 1, 0.5 + (s - 12) * 0.15);
  }
}

// GRAVE: spooky swing. Walking bass, organ chords, harpsichord arps, theremin lead with glide, bell tolls.
function graveSeq(s, bar, t, sd, M, lvl, mk) {
  const x = lvl ? 1 : intensity, [pc, ivs] = M.prog[bar % 4], pb = bar % 8, phrase = bar >> 3;
  const sw = t + sd * M.sw8 * SWING_OFF[s % 4];
  if (s === 0 || s === 8 || (s === 14 && (lvl || x >= 0.6)) || (lvl === 2 && s === 6)) mKick(sw, 0.75);
  if (s === 4 || s === 12) { mSnare(t, lvl ? 0.55 : 0.4); if (lvl) mClap(t, 0.3); }
  if (s % 2 === 0) mHat(sw, s % 4 === 2 ? 0.1 : 0.05, false);
  if (x >= 0.3 && s % 4 === 2) mRim(sw, 0.5);
  if (phraseCrash(s, bar, lvl)) mCrash(t, 0.3 + 0.3 * x);
  if (s % 4 === 0) {
    const r = bassRoot(pc, 33), nr = bassRoot(M.prog[(bar + 1) % 4][0], 33);
    const line = [r, r + ivs[1], r + 7, nr - 1 === r + 7 ? nr + 1 : nr - 1];
    mSoftBass(t, line[s >> 2], sd * 3.2, 1);
  }
  if (x >= 0.3 && (s % 2 === 0 || lvl === 2 || x >= 0.85)) {
    const vc = arpTones(pc, ivs, 62), ap = ARPS[phrase % ARPS.length];
    mHarpsi(sw, vc[ap[s] % vc.length] + (s >= 8 && pb % 2 ? 12 : 0), sd * 2, 0.85 * (lvl ? 0.8 : fadeIn(x, 0.3, 0.15)), s % 4 ? 0.3 : -0.3);
  }
  if ((x >= 0.45 || lvl) && s === 0) mOrgan(t, voicing(pc, ivs, 55), sd * 16, lvl ? 0.8 : fadeIn(x, 0.45, 0.2), 1800);
  if (lvl && (s === 6 || s === 10)) mOrgan(sw, voicing(pc, ivs, 62), sd * 1.5, 0.65, 2600);
  if (leadOn(lvl, x, pb)) {
    const ev = leadEv(mk, bar, s);
    if (ev) { mTheremin(sw, ev[2], ev[1] * sd * 0.95, lvl ? 1 : fadeIn(x, 0.6, 0.1), glideFrom); glideFrom = ev[2]; }
  }
  if (x >= 0.85 || lvl) {
    if (s === 0 && (pb === 0 || (lvl && pb === 4))) mToll(t, 62, 0.9);
    if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.6);
    if (pb === 3 && s >= 12) mTom(sw, [300, 250, 200, 160][s - 12], 0.5);
  }
}

// VOLCANO: the heaviest. Double-kick gallops, distorted power-chord chugs, sub bass, aggressive saw lead. D phrygian.
function volcanoSeq(s, bar, t, sd, M, lvl, mk) {
  const x = lvl ? 1 : intensity, [pc, ivs] = M.prog[bar % 4], pb = bar % 8, phrase = bar >> 3;
  const r = bassRoot(pc, 38), full = lvl || x >= 0.85;
  if (full || s % 4 !== 1) mTKick(t, s % 4 === 0 ? 1 : 0.6);
  if (s === 4 || s === 12) { mSnare(t, 0.9); mClap(t, 0.45); }
  if (lvl === 2 && (s === 6 || s === 14)) mSnare(t, 0.35);
  if (s % 2 === 0) mHat(t, s % 4 === 2 ? 0.13 : 0.05, false);
  if (s === 0 && bar > 0 && (pb === 0 || (lvl && bar % 4 === 0))) mCrash(t, 0.5 + 0.4 * x);
  if (s === 0) mChug(t, r, sd * 3.5, 1, true);
  else if (s >= 4 && (full || s % 4 !== 1)) mChug(t, r, sd * 0.9, s % 4 === 0 ? 0.9 : 0.7, false);
  if (s % 2 === 0) mDBass(t, r - 12, sd * 1.8, s % 4 === 0 ? 0.6 : 0.45);
  if (x >= 0.3 && s % 2 === 0) {
    const vc = arpTones(pc, ivs, 62), ap = ARPS[phrase % ARPS.length];
    mPluck(t, vc[ap[s] % vc.length] + 12, sd * 1.4, 0.6 * (lvl ? 0.8 : fadeIn(x, 0.3, 0.15)), 2600, pulse12, s % 4 ? 0.3 : -0.3);
  }
  if ((x >= 0.45 || lvl) && s === 0) mPad(t, voicing(pc, ivs, 50), sd * 16, 0.5 * (lvl ? 1 : fadeIn(x, 0.45, 0.2)), 900);
  if (leadOn(lvl, x, pb)) {
    const ev = leadEv(mk, bar, s);
    if (ev) mSawLead(t, ev[2], ev[1] * sd * 0.92, lvl ? 1 : fadeIn(x, 0.6, 0.1), 2400 + 1400 * lvl);
  }
  if (full) {
    if (pb === 7 && s === 0) mRiser(t, sd * 16, 0.8);
    if (pb === 3 && s >= 12) mTom(t, [260, 210, 170, 130][s - 12], 0.8);
    if (pb === 7 && s >= 12) mSnare(t, 0.3 + (s - 12) * 0.12);
  }
}

// VICTORY: 8-bar fanfare anthem in C (I V vi IV | I V bVI-bVII | I), then a calm loop for the walk
// to the exit portal. The biome only tints the colour instruments.
const VIC_CH = [[0, [0, 4, 7]], [7, [0, 4, 7]], [9, [0, 3, 7]], [5, [0, 4, 7]], [0, [0, 4, 7]], [7, [0, 4, 7]], [8, [0, 4, 7]], [0, [0, 4, 7]]];
const VIC_MEL = [
  [[0, 2, 67], [2, 2, 72], [4, 2, 76], [6, 6, 79], [12, 2, 76], [14, 2, 79]],
  [[0, 6, 83], [6, 2, 81], [8, 4, 79], [12, 4, 74]],
  [[0, 4, 76], [4, 2, 72], [6, 2, 76], [8, 8, 81]],
  [[0, 4, 77], [4, 4, 81], [8, 4, 84], [12, 4, 81]],
  [[0, 2, 79], [2, 2, 79], [4, 2, 79], [6, 6, 84], [12, 4, 79]],
  [[0, 4, 83], [4, 4, 79], [8, 8, 86]],
  [[0, 6, 84], [6, 2, 80], [8, 6, 86], [14, 2, 82]],
  [[0, 16, 84]],
];
function vicColor(t, m, dur, biome, v) {
  if (biome === 'frost') mBell(t, m + 12, Math.min(1, dur + 0.3), v, 0.2, true);
  else if (biome === 'desert') mOud(t, m, dur, v, 0.2);
  else if (biome === 'grave') mHarpsi(t, m + 12, dur, v, 0.2);
  else if (biome === 'volcano') mSawLead(t, m - 12, dur * 0.94, v * 0.8, 2600);
  else mMarimba(t, m, v);
}
function vicArp(t, m, dur, biome, pan) {
  if (biome === 'frost') mBell(t, m + 12, 0.5, 0.45, pan, true);
  else if (biome === 'desert') mOud(t, m, dur, 0.5, pan);
  else if (biome === 'grave') mHarpsi(t, m, dur, 0.5, pan);
  else mTPluck(t, m, dur, 0.7, pan);
}
function vicMel(t, m, dur, biome) {
  if (biome === 'frost') mBell(t, m, Math.min(1.4, dur + 0.4), 0.8, 0, false);
  else if (biome === 'desert') mOud(t, m, dur, 0.8, 0);
  else if (biome === 'grave') mTheremin(t, m, dur * 0.95, 0.6, 0);
  else mMarimba(t, m, 0.85);
}
function victorySeq(s, bar, t, sd, M, biome, mk) {
  if (bar < 8) {
    const [pc, ivs] = bar === 6 && s >= 8 ? [10, [0, 4, 7]] : VIC_CH[bar];
    const root = bassRoot(pc, 33), last = bar === 7;
    if (last ? s === 0 || s === 8 : s % 4 === 0) mKick(t, last && s === 8 ? 0.5 : 1);
    if (!last && (s === 4 || s === 12)) { mSnare(t, 0.55); mClap(t, 0.7); }
    if (!last && s % 4 === 2) mHat(t, 0.16, true);
    if (s === 0 && (bar === 0 || bar === 4 || last)) mCrash(t, 0.9);
    if (bar === 3 && s >= 12) mTom(t, [300, 250, 200, 160][s - 12], 0.7);
    if (bar === 6 && s >= 12) mSnare(t, 0.3 + (s - 12) * 0.15);
    if (!last && s % 2 === 0) mBass(t, root + (s % 4 === 2 ? 12 : 0), sd * 1.7, s % 4 === 0 ? 1 : 0.7, 0.8);
    if (last && s === 0) mBass(t, root, sd * 14, 1, 0.6);
    if (s === 0 || (bar === 6 && s === 8)) {
      mPad(t, voicing(pc, ivs, 60), sd * (bar === 6 ? 8 : 16), 0.8, 2800);
      mStab(t, voicing(pc, ivs, 67), 0.8);
      if (biome === 'volcano') mChug(t, bassRoot(pc, 38), sd * (bar === 6 ? 7 : 14), 0.8, true);
    }
    if (!last) { const vc = arpTones(pc, ivs, 72); mPluck(t, vc[[0, 1, 2, 3, 2, 1, 2, 3][s % 8] % vc.length], sd * 1.2, 0.45, 3200, pulse25, s % 2 ? 0.3 : -0.3); }
    const evs = VIC_MEL[bar];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e[0] === s) { mLead(t, e[2], e[1] * sd * 0.94, 1, 5200); vicColor(t, e[2], e[1] * sd, biome, 0.55); }
    }
    return;
  }
  const cb = bar - 8, [pc, ivs] = M.prog[cb % 4];
  if (s === 0) { mPad(t, voicing(pc, ivs, 57), sd * 16, 0.6, 1300); mSoftBass(t, bassRoot(pc, 33), sd * 6, 0.8); }
  if (s === 10) mSoftBass(t, bassRoot(pc, 33) + 7, sd * 4, 0.5);
  if (cb >= 2) {
    if (s % 2 === 0) mShaker(t, s % 4 === 2 ? 0.05 : 0.03);
    if (s === 0) mKick(t, 0.35);
    if (s === 12) mRim(t, 0.45);
  }
  if (s % 2 === 0) { const vc = arpTones(pc, ivs, 67); vicArp(t, vc[[0, 2, 1, 3, 2, 1, 3, 2][s / 2] % vc.length], sd * 2.5, biome, s % 4 ? 0.25 : -0.25); }
  if (cb >= 4) { const ev = leadEv(mk, cb - 4, s); if (ev) vicMel(t, ev[2], ev[1] * sd, biome); }
}

// Keys + scales per biome. Tropical keeps the original MODES / SEQ entries untouched.
const BIOME_MUSIC = {
  frost: { // D lydian collection; boss/final lean on F# minor ("minor-ish lydian")
    seq: frostSeq, tonic: 2,
    run: { bpm: 140, prog: [[2, [0, 4, 7, 11]], [4, [0, 4, 7, 9]], [1, [0, 3, 7, 10]], [6, [0, 3, 7, 10]]], scale: [2, 4, 6, 8, 9, 11, 1], lo: 74, hi: 91, rhythms: R_RUN, seeds: [51, 52, 51, 53], gem: 74 },
    boss: { bpm: 140, prog: [[6, [0, 3, 7]], [2, [0, 4, 7, 11]], [4, [0, 4, 7]], [1, [0, 3, 7]]], scale: [6, 8, 9, 11, 1, 2, 4], lo: 69, hi: 88, rhythms: R_BOSS, seeds: [61, 62, 61, 63], gem: 74 },
    final: { bpm: 152, prog: [[6, [0, 3, 7, 10]], [4, [0, 4, 7]], [2, [0, 4, 7, 11]], [4, [0, 4, 7, 9]]], scale: [6, 8, 9, 11, 1, 2, 4], lo: 72, hi: 91, rhythms: R_RUN, seeds: [71, 72, 73, 72], gem: 74 },
  },
  desert: { // E phrygian dominant; boss = E double harmonic
    seq: desertSeq, tonic: 4,
    run: { bpm: 145, prog: [[4, [0, 4, 7]], [5, [0, 4, 7]], [2, [0, 3, 7]], [4, [0, 4, 7]]], scale: [4, 5, 8, 9, 11, 0, 2], lo: 64, hi: 81, rhythms: R_RUN, seeds: [54, 55, 54, 56], gem: 76, ladder: [0, 4, 5, 7, 10] },
    boss: { bpm: 145, prog: [[4, [0, 4, 7]], [5, [0, 4, 7]], [0, [0, 4, 8]], [5, [0, 4, 7]]], scale: [4, 5, 8, 9, 11, 0, 3], lo: 62, hi: 79, rhythms: R_BOSS, seeds: [64, 65, 64, 66], gem: 76, ladder: [0, 4, 5, 7, 11] },
    final: { bpm: 158, prog: [[4, [0, 4, 7]], [2, [0, 3, 7]], [0, [0, 4, 8]], [5, [0, 4, 7]]], scale: [4, 5, 8, 9, 11, 0, 2], lo: 64, hi: 83, rhythms: R_RUN, seeds: [74, 75, 76, 75], gem: 76, ladder: [0, 4, 5, 7, 10] },
  },
  grave: { // D harmonic minor, swung
    seq: graveSeq, tonic: 2, sw8: 0.9,
    run: { bpm: 132, prog: [[2, [0, 3, 7]], [10, [0, 4, 7]], [7, [0, 3, 7]], [9, [0, 4, 7, 10]]], scale: [2, 4, 5, 7, 9, 10, 1], lo: 69, hi: 86, rhythms: R_RUN, seeds: [57, 58, 57, 59], gem: 74, ladder: [0, 2, 3, 7, 8] },
    boss: { bpm: 132, prog: [[2, [0, 3, 7]], [1, [0, 3, 6]], [10, [0, 4, 7]], [9, [0, 4, 7]]], scale: [2, 4, 5, 7, 9, 10, 1], lo: 64, hi: 81, rhythms: R_BOSS, seeds: [67, 68, 67, 69], gem: 74, ladder: [0, 2, 3, 7, 8] },
    final: { bpm: 144, prog: [[7, [0, 3, 7]], [2, [0, 3, 7]], [9, [0, 4, 7, 10]], [2, [0, 3, 7]]], scale: [2, 4, 5, 7, 9, 10, 1], lo: 67, hi: 86, rhythms: R_RUN, seeds: [77, 78, 79, 78], gem: 74, ladder: [0, 2, 3, 7, 8] },
  },
  volcano: { // D phrygian
    seq: volcanoSeq, tonic: 2,
    run: { bpm: 160, prog: [[2, [0, 3, 7]], [3, [0, 4, 7]], [2, [0, 3, 7]], [0, [0, 3, 7]]], scale: [2, 3, 5, 7, 9, 10, 0], lo: 62, hi: 81, rhythms: R_RUN, seeds: [91, 92, 91, 93], gem: 70 },
    boss: { bpm: 160, prog: [[2, [0, 3, 7]], [10, [0, 4, 7]], [7, [0, 3, 7]], [3, [0, 4, 7]]], scale: [2, 3, 5, 7, 9, 10, 0], lo: 62, hi: 79, rhythms: R_BOSS, seeds: [94, 95, 94, 96], gem: 70 },
    final: { bpm: 172, prog: [[2, [0, 3, 7]], [3, [0, 4, 7]], [5, [0, 4, 7]], [3, [0, 4, 7]]], scale: [2, 3, 5, 7, 9, 10, 0], lo: 65, hi: 84, rhythms: R_RUN, seeds: [97, 98, 99, 98], gem: 70 },
  },
};

// Track registry: key -> { mode, biome }. Tropical keys are the original mode names; the rest are 'biome:mode'.
MODES.victory = { bpm: 126, swing: 0, prog: [[0, [0, 4, 7, 11]], [9, [0, 3, 7, 10]], [5, [0, 4, 7, 11]], [7, [0, 4, 7, 9]]], scale: [0, 2, 4, 7, 9], lo: 72, hi: 88, rhythms: R_TITLE, seeds: [81, 82, 81, 83], gem: 72 };
SEQ.victory = (s, bar, t, sd) => victorySeq(s, bar, t, sd, MODES.victory, 'tropical', 'victory');
const TRK = {};
for (const m of ['title', 'run', 'boss', 'final', 'victory']) TRK[m] = { mode: m, biome: 'tropical' };
const LVL = { run: 0, boss: 1, final: 2 };
for (const b of Object.keys(BIOME_MUSIC)) {
  const B = BIOME_MUSIC[b];
  for (const m of ['run', 'boss', 'final']) {
    const key = b + ':' + m, lvl = LVL[m];
    const M = (MODES[key] = Object.assign({ swing: 0, tonic: B.tonic, sw8: B.sw8 || 0 }, B[m]));
    SEQ[key] = (s, bar, t, sd) => B.seq(s, bar, t, sd, M, lvl, key);
    TRK[key] = { mode: m, biome: b };
  }
  const vk = b + ':victory';
  MODES[vk] = MODES.victory;
  SEQ[vk] = (s, bar, t, sd) => victorySeq(s, bar, t, sd, MODES.victory, b, vk);
  TRK[vk] = { mode: 'victory', biome: b };
}
function trackKey(mode, biome) {
  if (!has(TRK, mode)) return null;
  if (mode === 'title' || mode.indexOf(':') > 0) return mode;
  const b = has(BIOME_MUSIC, biome) ? biome : 'tropical';
  return b === 'tropical' ? mode : b + ':' + mode;
}

function stepDur() { return 60 / MODES[curMode].bpm / 4; }

function musicLPFor(mode, x) {
  if (!has(TRK, mode) || TRK[mode].mode !== 'run') return 18000;
  return 3000 * Math.pow(2, clamp(x / 0.6, 0, 1) * 2.58); // ~3 kHz -> ~18 kHz, fully open at 0.6
}

function applyMode(mode, t) {
  curMode = mode;
  mstep = 0;
  glideFrom = 0;
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

  // guitar-amp bus (volcano power chords): one shared drive + cab filter for every chug
  gtrIn = c.createGain();
  const ghp = c.createBiquadFilter(); ghp.type = 'highpass'; ghp.frequency.value = 90;
  const gsh = c.createWaveShaper(); gsh.curve = curve(6); gsh.oversample = '2x';
  const gcab = c.createBiquadFilter(); gcab.type = 'lowpass'; gcab.frequency.value = 3400; gcab.Q.value = 1.1;
  const gout = c.createGain(); gout.gain.value = 0.2;
  gtrIn.connect(ghp); ghp.connect(gsh); gsh.connect(gcab); gcab.connect(gout); gout.connect(instBus);

  // ambience beds live under the SFX bus (so the SFX slider controls them)
  ambBus = c.createGain(); ambBus.gain.value = 1; ambBus.connect(sfxBus);

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
// Ambience: per biome, one quiet continuous bed (looping shared noise buffers + a few LFOs, ~6-20
// nodes) plus sparse random one-shots scheduled by a slow timer. Layers crossfade over AMB_FADE s,
// then stop and disconnect themselves. Beds sit ~30-40 dB below full scale, well under music & SFX.
// ---------------------------------------------------------------------------------------------
let ambBus = null, ambCur = null, ambTimer = null, wantAmb = null;
const ambOld = [];
const AMB_FADE = 2, AMB_TICK_MS = 250;

function aNode(L, n) { L.nodes.push(n); return n; }
function aGain(L, v, dest) { const g = ctx.createGain(); g.gain.value = v; g.connect(dest); return aNode(L, g); }
function aFilt(L, type, f, q, dest) {
  const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = fq(f); n.Q.value = q; n.connect(dest);
  return aNode(L, n);
}
function aPan(L, v, dest) { const p = panNode(v); p.connect(dest); return aNode(L, p); }
function aOsc(L, type, f, dest) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest);
  o.start(L.t); L.srcs.push(o);
  return aNode(L, o);
}
function aNoise(L, pink, rate, dest) {
  const s = ctx.createBufferSource(); s.buffer = pink ? noiseP : noiseW; s.loop = true;
  s.playbackRate.value = rate; s.connect(dest);
  s.start(L.t, Math.random() * s.buffer.duration * 0.9); L.srcs.push(s);
  return aNode(L, s);
}
function aLfo(L, param, rate, depth, type) { const g = aGain(L, depth, param); aOsc(L, type || 'sine', rate, g); return g; }

// --- one-shot ambience events (V is a normal voice routed into the layer) ---
function evBirds(V) {
  const n = 2 + Math.floor(Math.random() * 4), f = rand(2400, 4200), up = Math.random() < 0.5, gap = rand(0.08, 0.14);
  for (let i = 0; i < n; i++) T(V, { at: i * gap, f: f * (up ? 0.8 : 1.2), f2: f * (up ? 1.25 : 0.85), g: 0.05, a: 0.006, d: 0.06, v: 0.026 });
  if (Math.random() < 0.4) T(V, { at: n * gap + 0.05, f: f * 1.1, f2: f * 0.7, g: 0.25, a: 0.01, d: 0.25, v: 0.018 });
}
function evCreak(V) { // ice under stress: a slow click train ringing through a drifting resonance
  const d = rand(0.35, 0.9), f = rand(650, 1500);
  const bp = Flt(V, 'bandpass', f, 11);
  bp.frequency.setValueAtTime(fq(f), V.t);
  bp.frequency.linearRampToValueAtTime(fq(f * rand(0.75, 1.3)), V.t + d);
  T(V, { type: 'sawtooth', f: rand(22, 40), f2: rand(30, 70), g: d, lin: 1, a: 0.06, hold: d * 0.5, d: d * 0.5, v: 0.45, to: bp });
}
function evIcePing(V) { // the frozen-lake "pew"
  const f = rand(1800, 3000);
  T(V, { f, f2: f * 0.28, g: 0.4, a: 0.002, d: 0.45, v: 0.02 });
  T(V, { at: 0.04, f: f * 0.83, f2: f * 0.25, g: 0.45, a: 0.002, d: 0.5, v: 0.011 });
  Nz(V, { d: 0.015, v: 0.035, ft: 'highpass', ff: 3500 });
  send(V, sfxVerb, 0.4);
}
function evHawk(V) { // distant raspy descending "kee-eeer"
  const f = rand(2500, 3200), t = V.t;
  const lp = Flt(V, 'lowpass', 4200, 0.7);
  const rasp = Gn(V, 0.65, lp);
  lfo(V, rasp.gain, rand(45, 62), 0.35, t, t + 1.37);
  const o = T(V, { f: f * 0.85, f2: f, g: 0.1, a: 0.05, hold: 0.25, d: 0.95, v: 0.028, to: rasp });
  o.osc.frequency.exponentialRampToValueAtTime(fq(f * 0.6), t + 1.24);
  const o2 = T(V, { type: 'triangle', f: f * 0.425, f2: f * 0.5, g: 0.1, a: 0.05, hold: 0.25, d: 0.95, v: 0.011, to: rasp });
  o2.osc.frequency.exponentialRampToValueAtTime(fq(f * 0.3), t + 1.24);
  send(V, sfxVerb, 0.5);
}
function evOwl(V) { // hoo, hoo ... hoooo
  const f = rand(330, 400);
  const lp = Flt(V, 'lowpass', 1000, 0.7);
  for (const [at, d, pv] of [[0, 0.2, 0.8], [0.34, 0.16, 0.65], [0.62, 0.5, 1]]) T(V, { at, f: f * 1.03, f2: f * 0.95, g: d, a: 0.05, hold: d * 0.35, d: d * 0.65, v: 0.045 * pv, to: lp });
  Nz(V, { a: 0.05, d: 0.9, v: 0.012, ft: 'bandpass', ff: f * 2, q: 3, pink: 1 });
  send(V, sfxVerb, 0.5);
}
function evBubble(V) { // lava bloops, sometimes in clusters, sometimes a steam hiss
  const n = Math.random() < 0.3 ? 3 : 1;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const f = rand(70, 150);
    T(V, { at, f, f2: f * rand(2.2, 3.4), g: 0.06, a: 0.004, d: 0.07, v: 0.055 });
    Nz(V, { at: at + 0.055, d: 0.012, v: 0.028, ft: 'bandpass', ff: rand(900, 2000), q: 2 });
    at += rand(0.08, 0.22);
  }
  if (Math.random() < 0.35) Nz(V, { at, a: 0.06, d: 0.45, v: 0.011, ft: 'highpass', ff: 4000 });
}

// build(L) wires the continuous bed into L.g; ev = [[mean seconds between events, fn], ...]
const AMB = {
  tropical: { // soft surf: pink noise swelling and brightening on a ~9 s wave cycle + birds
    build(L) {
      const g = aGain(L, 0.13, L.g);
      aLfo(L, g.gain, 0.11, 0.08);
      aLfo(L, g.gain, 0.047, 0.035);
      const lp = aFilt(L, 'lowpass', 650, 0.6, g);
      aLfo(L, lp.frequency, 0.11, 380);
      aNoise(L, true, 0.93, lp);
    },
    ev: [[5.5, evBirds]],
  },
  frost: { // howling resonant wind in gusts over a low body + ice creaks and pings
    build(L) {
      const g = aGain(L, 0.3, L.g);
      aLfo(L, g.gain, 0.071, 0.22);
      aLfo(L, g.gain, 0.19, 0.06);
      const bp = aFilt(L, 'bandpass', 620, 5, g);
      aLfo(L, bp.frequency, 0.13, 240);
      aNoise(L, false, 0.7, bp);
      const g2 = aGain(L, 0.07, L.g);
      aLfo(L, g2.gain, 0.071, 0.05);
      aNoise(L, true, 0.85, aFilt(L, 'lowpass', 320, 0.7, g2));
    },
    ev: [[6.5, evCreak], [12, evIcePing]],
  },
  desert: { // dry sand hiss + a soft wind body + distant hawk cries
    build(L) {
      const g = aGain(L, 0.02, L.g);
      aLfo(L, g.gain, 0.09, 0.012);
      const hp = aFilt(L, 'highpass', 2600, 0.5, g);
      aLfo(L, hp.frequency, 0.13, 900);
      aNoise(L, false, 1, hp);
      const g2 = aGain(L, 0.12, L.g);
      aLfo(L, g2.gain, 0.057, 0.08);
      const bp = aFilt(L, 'bandpass', 380, 0.9, g2);
      aLfo(L, bp.frequency, 0.08, 120);
      aNoise(L, true, 0.8, bp);
    },
    ev: [[15, evHawk]],
  },
  grave: { // two trilling crickets (L/R) + a low beating drone + owl hoots
    build(L) {
      for (const [f, pr, cr, pan, lv] of [[4400, 38, 1.7, -0.5, 0.022], [4900, 45, 2.35, 0.45, 0.016]]) {
        const bp = aFilt(L, 'bandpass', f, 6, aGain(L, lv, aPan(L, pan, L.g)));
        const g2 = aGain(L, 0.5, bp); aLfo(L, g2.gain, cr, 0.5, 'square');
        const g1 = aGain(L, 0.5, g2); aLfo(L, g1.gain, pr, 0.5, 'square');
        aOsc(L, 'sine', f, g1);
      }
      const dg = aGain(L, 0.014, L.g);
      aLfo(L, dg.gain, 0.06, 0.008);
      const lp = aFilt(L, 'lowpass', 240, 0.7, dg);
      aOsc(L, 'triangle', 55, lp); aOsc(L, 'triangle', 55.4, lp); aOsc(L, 'sine', 82.6, lp);
    },
    ev: [[17, evOwl]],
  },
  volcano: { // deep churning rumble + faint steam hiss + lava bubbles
    build(L) {
      const g = aGain(L, 0.3, L.g);
      aLfo(L, g.gain, 0.09, 0.12);
      aLfo(L, g.gain, 0.23, 0.05);
      aNoise(L, true, 0.7, aFilt(L, 'lowpass', 115, 0.9, g));
      const g2 = aGain(L, 0.009, L.g);
      aLfo(L, g2.gain, 0.17, 0.006);
      aNoise(L, false, 1, aFilt(L, 'highpass', 5000, 0.5, g2));
    },
    ev: [[1.6, evBubble]],
  },
};

function ambKill(L) { // disconnect everything now
  const nodes = L.nodes;
  for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (e) { /* gone */ } }
  nodes.length = 0;
}
function ambRelease(L, now) { // fade out, stop the sources, disconnect when they end
  if (L.dead) return;
  L.dead = true;
  try {
    holdParam(L.g.gain, now);
    L.g.gain.linearRampToValueAtTime(0, now + AMB_FADE);
  } catch (e) { /* ignore */ }
  const end = now + AMB_FADE + 0.05;
  let last = null;
  for (let i = 0; i < L.srcs.length; i++) { try { L.srcs[i].stop(end); last = L.srcs[i]; } catch (e) { /* ignore */ } }
  if (last) last.onended = () => ambKill(L); else ambKill(L);
}
function ambTick() {
  const L = ambCur;
  if (!ctx || !L || L.dead) return;
  try {
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime, E = AMB[L.biome].ev;
    for (let i = 0; i < E.length; i++) {
      const every = E[i][0];
      let nt = L.next[i];
      if (nt == null || nt < now - 0.5) nt = now + every * rand(0.25, 1); // first run / after a stall: no backlog
      let guard = 0;
      while (nt < now + 0.3 && guard++ < 3) {
        const V = voice(L.g, Math.max(nt, now + 0.01), 1, rand(-0.7, 0.7), 1, 1);
        try { E[i][1](V); } finally { finish(V); }
        nt += every * rand(0.5, 1.5);
      }
      L.next[i] = nt;
    }
  } catch (e) { /* never throw from the timer */ }
}

// Start / switch to a track key ('run', 'frost:boss', ...). Switches land on the next bar line.
function startKey(key) {
  if (!key) return;
  if (!ctx) { wantMode = key; return; }
  try {
    if (curMode && timer) {
      if (curMode === key) { pendMode = null; return; } // idempotent; also cancels a pending switch
      pendMode = key; // switch musically on the next bar
      return;
    }
    stopToken++;
    const now = ctx.currentTime;
    pendMode = null;
    nextT = now + 0.06;
    applyMode(key, now);
    holdParam(fadeG.gain, now);
    fadeG.gain.setTargetAtTime(1, now, 0.05);
    if (!timer) timer = setInterval(tick, TICK_MS);
    tick();
  } catch (e) { /* ignore */ }
}

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
      if (wantMode) { const m = wantMode; wantMode = null; startKey(m); }
      if (wantAmb) { const b = wantAmb; wantAmb = null; audio.setAmbience(b); }
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
      const def = has(SFX, name) ? SFX[name] : null;
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

  startMusic(mode, biome) {
    try { startKey(trackKey(mode, biome)); } catch (e) { /* ignore */ }
  },

  setAmbience(biome) {
    try {
      const b = has(AMB, biome) ? biome : null;
      if (!ctx) { wantAmb = b; return; }
      if (!ambBus || (ambCur ? ambCur.biome : null) === b) return;
      const now = ctx.currentTime;
      if (ambCur) { ambRelease(ambCur, now); ambOld.push(ambCur); ambCur = null; }
      while (ambOld.length && !ambOld[0].nodes.length) ambOld.shift();  // already cleaned up
      while (ambOld.length > 3) ambKill(ambOld.shift());                // rapid toggling: hard-cut the oldest
      if (b) {
        const L = { biome: b, t: now, nodes: [], srcs: [], next: [], g: null, dead: false };
        L.g = aGain(L, 0, ambBus);
        ambCur = L;
        try { AMB[b].build(L); } catch (e) { ambRelease(L, now); ambCur = null; return; }
        L.g.gain.setValueAtTime(0, now);
        L.g.gain.linearRampToValueAtTime(1, now + AMB_FADE);
        if (!ambTimer) ambTimer = setInterval(ambTick, AMB_TICK_MS);
        ambTick();
      } else if (ambTimer) { clearInterval(ambTimer); ambTimer = null; }
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
