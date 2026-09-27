// Boss brains. Each boss is an entity in the horde arrays driven by a small attack state machine
// built from the hazard kit. Final bosses enrage at 50% HP (faster, meaner combos).
import * as THREE from 'three';
import * as M from './models.js';
import { clamp, lerp } from './rng.js';

export const BOSSES = {
  chonk:   { type: 'boss', hp: 3800, speed: 4.2, dmg: 30, scale: 1, attacks: ['slam', 'charge', 'summon'], gap: [3.0, 4.6] },
  warlord: { type: 'brute', hp: 5200, speed: 4.8, dmg: 32, scale: 2.4, attacks: ['leap', 'slam', 'charge', 'leap'], gap: [2.8, 4.0] },
  tiki:    { type: 'tiki', hp: 15000, speed: 3.8, dmg: 34, attacks: ['eyeLaser', 'coconutRain', 'slam', 'summon'], p2: ['eyeLaser', 'coconutRain', 'slam', 'charge', 'eyeLaser'], gap: [2.4, 3.4] },
  yeti:    { type: 'yeti', hp: 17000, speed: 4.3, dmg: 38, attacks: ['iceSpikes', 'snowballs', 'frostBreath', 'slam', 'charge'], p2: ['iceSpikes', 'snowballs', 'frostBreath', 'leap', 'iceSpikes'], gap: [2.3, 3.3] },
  worm:    { type: 'worm', hp: 19000, speed: 7.5, dmg: 40, attacks: ['burrow', 'scarabs', 'tornadoes', 'burrow', 'charge'], p2: ['burrow', 'scarabs', 'tornadoes', 'burrow'], gap: [2.0, 3.0] },
  lich:    { type: 'lich', hp: 20000, speed: 3.6, dmg: 42, attacks: ['skullSpiral', 'teleportSlash', 'soulNova', 'summonGhouls'], p2: ['skullSpiral', 'teleportSlash', 'soulNova', 'teleportSlash'], gap: [2.1, 3.0] },
  dragon:  { type: 'dragon', hp: 28000, speed: 4.5, dmg: 48, attacks: ['fireBreath', 'meteorRain', 'wingGust', 'flyover', 'fireballs'], p2: ['fireBreath', 'meteorRain', 'flyover', 'fireballs', 'wingGust'], gap: [1.9, 2.8] },
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);

export class Boss {
  constructor(game, i, id, opts = {}) {
    this.g = game; this.E = game.enemies; this.H = game.hazards;
    this.i = i; this.id = id; this.def = BOSSES[id];
    this.name = opts.name || id.toUpperCase(); this.title = opts.title || '';
    this.isFinal = !!opts.final; this.phase = 1;
    this.mode = 'enter'; this.t = 1.0; this.cool = 1.6; this.run = null; this.last = '';
    this.float = id === 'lich' ? 1.6 : 0; this.yoCtl = 0;
    this.trail = []; this.segs = null;
    this.clock = 0;
    this.dmg = this.E.dmg[i];
  }

  get alive() { const s = this.E.state[this.i]; return s === 1 || s === 3; }
  get x() { return this.E.x[this.i]; }
  get z() { return this.E.z[this.i]; }
  get gy() { return this.E.y[this.i]; }
  stop() { this.E.vx[this.i] = 0; this.E.vz[this.i] = 0; }
  toPlayer() { const P = this.g.player.pos; const dx = P.x - this.x, dz = P.z - this.z, d = Math.hypot(dx, dz) + 1e-4; return { dx: dx / d, dz: dz / d, d, a: Math.atan2(dx, dz) }; }
  hide(on) { this.E.state[this.i] = on ? 3 : 1; }

  // called every frame by the horde update (also while hidden)
  update(dt, t) {
    const E = this.E, i = this.i, g = this.g;
    this.clock += dt;
    if (this.isFinal && this.phase === 1 && E.hp[i] < E.maxHp[i] * 0.5) {
      this.phase = 2;
      g.onBossPhase?.(this);
    }
    const spd = this.def.speed * (this.phase === 2 ? 1.25 : 1);
    if (this.mode === 'enter') {
      this.stop();
      this.t -= dt;
      if (this.t <= 0) this.mode = 'chase';
    } else if (this.mode === 'chase') {
      const p = this.toPlayer();
      if (this.id === 'worm') {
        const weave = Math.sin(this.clock * 1.6) * 0.7;
        E.vx[i] = (p.dx * Math.cos(weave) - p.dz * Math.sin(weave)) * spd;
        E.vz[i] = (p.dz * Math.cos(weave) + p.dx * Math.sin(weave)) * spd;
      } else if (p.d > 5) { E.vx[i] = p.dx * spd; E.vz[i] = p.dz * spd; }
      else this.stop();
      this.cool -= dt;
      if (this.cool <= 0) this.startAttack();
    } else if (this.mode === 'attack') {
      if (!this.run || this.run(dt)) {
        this.run = null; this.mode = 'chase';
        const [a, b] = this.def.gap;
        this.cool = rnd(a, b) * (this.phase === 2 ? 0.65 : 1);
      }
    }
    // vertical control (bosses own their y offset)
    if (this.id === 'lich') E.yo[i] = this.float + Math.sin(this.clock * 1.5) * 0.4 + this.yoCtl;
    else if (this.id === 'worm') { if (E.state[i] === 1 && !this.burrowing) E.yo[i] = 0.9 + Math.sin(this.clock * 2.2) * 0.9 + this.yoCtl; }
    else if (!this.flying) E.yo[i] = this.yoCtl;
    if (this.id === 'worm') this.updateTrail();
  }

  startAttack() {
    const list = (this.phase === 2 && this.def.p2) ? this.def.p2 : this.def.attacks;
    let name = list[(Math.random() * list.length) | 0];
    if (name === this.last && list.length > 1) name = list[(list.indexOf(name) + 1) % list.length];
    this.last = name;
    const fn = this['a_' + name];
    if (!fn) return;
    this.run = fn.call(this);
    this.mode = 'attack';
  }

  // ---------------------------------------------------------------- shared attacks
  a_slam() {
    const g = this.g, n = this.phase === 2 ? 2 : 1, sc = this.E.scale[this.i];
    let t = 1.0, done = 0;
    g.fx.telegraph(_v.set(this.x, this.gy + 0.1, this.z), 5.5 * sc, 1.0);
    g.audio.play('warning', { volume: 0.4 });
    return (dt) => {
      this.stop(); this.squash = Math.max(0, 1 - t) * 0.25;
      t -= dt;
      if (t <= 0) {
        this.H.shock(this.x, this.z, 30, 17 + this.phase * 2, this.dmg * 0.85);
        g.fx.burst(_v.set(this.x, this.gy + 0.5, this.z), '#b08a6a', 36, { speed: 14, size: 0.35, up: 8 });
        g.shake(0.9); g.audio.play('bossslam');
        this.squash = 0;
        if (++done >= n) return true;
        t = 0.55;
      }
      return false;
    };
  }

  a_charge() {
    const g = this.g;
    const p = this.toPlayer();
    let t = 0.85, dashing = false;
    const dx = p.dx, dz = p.dz;
    if (g.fx.telegraphLine) g.fx.telegraphLine(_v.set(this.x, this.gy + 0.1, this.z), _v2.set(this.x + dx * 30, this.gy + 0.1, this.z + dz * 30), 3.2, 0.85);
    else g.fx.beam(_v.set(this.x, this.gy + 1, this.z), _v2.set(this.x + dx * 30, this.gy + 1, this.z + dz * 30), 2.2, '#ff2a2a', 0.85);
    g.audio.play('bossroar', { volume: 0.5, pitch: 1.3 });
    return (dt) => {
      t -= dt;
      if (!dashing) { this.stop(); if (t <= 0) { dashing = true; t = 1.0; } return false; }
      this.E.vx[this.i] = dx * 28; this.E.vz[this.i] = dz * 28;
      if (Math.random() < 0.5) g.fx.dust(_v.set(this.x, this.gy, this.z), 2);
      return t <= 0;
    };
  }

  a_summon() {
    const g = this.g, E = this.E;
    let t = 1.1;
    g.audio.play('bossroar', { volume: 0.7 });
    return (dt) => {
      this.stop(); t -= dt;
      if (t > 0) return false;
      const n = 10 + g.islandN * 2;
      for (let k = 0; k < n; k++) {
        const a = k / n * TAU, sx = this.x + Math.cos(a) * 7, sz = this.z + Math.sin(a) * 7;
        const j = E.spawn(Math.random() < 0.5 ? E.T.goon : E.T.zippy, sx, sz, { hpMult: g.hpMult, dmgMult: g.dmgMult });
        if (j >= 0) g.fx.burst(_v.set(sx, g.world.heightAt(sx, sz) + 0.5, sz), '#B45CFF', 6);
      }
      return true;
    };
  }

  a_leap() {
    const g = this.g, E = this.E, i = this.i, P = g.player.pos;
    const sx = this.x, sz = this.z, tx = P.x + g.player.vel.x * 0.5, tz = P.z + g.player.vel.z * 0.5;
    const T = 1.15; let t = 0;
    g.fx.telegraph(_v.set(tx, g.world.heightAt(tx, tz) + 0.1, tz), 5.5, T);
    g.audio.play('bossroar', { volume: 0.5, pitch: 1.15 });
    return (dt) => {
      t += dt; this.stop();
      const u = Math.min(1, t / T);
      E.x[i] = lerp(sx, tx, u); E.z[i] = lerp(sz, tz, u);
      this.yoCtl = Math.sin(u * Math.PI) * 11;
      if (u < 1) return false;
      this.yoCtl = 0;
      this.H.impact(tx, tz, 5.5, 0.01, this.dmg * 1.1, 'blast', { color: '#ff5a2a' });
      this.H.shock(tx, tz, 18, 15, this.dmg * 0.6);
      g.shake(0.8); g.audio.play('bossslam');
      return true;
    };
  }

  // generic rain of telegraphed impacts around the player
  rain(kind, count, radius, r, dmgK, spread, patch = 0) {
    const g = this.g, P = g.player.pos, V = g.player.vel;
    for (let k = 0; k < count; k++) {
      const a = Math.random() * TAU, rr = k === 0 ? 0 : Math.sqrt(Math.random()) * radius;
      const x = P.x + V.x * 0.5 + Math.cos(a) * rr, z = P.z + V.z * 0.5 + Math.sin(a) * rr;
      this.H.impact(x, z, r, rnd(spread[0], spread[1]), this.dmg * dmgK, kind, { patch, color: kind === 'coconut' ? '#FFB020' : '#FF4A1A' });
    }
  }

  // ---------------------------------------------------------------- TIKI TITAN
  a_eyeLaser() {
    const g = this.g, two = this.phase === 2;
    const p = this.toPlayer();
    const a0 = p.a, dir = Math.random() < 0.5 ? -1 : 1;
    const beams = [this.H.beam({ ox: this.x, oz: this.z, angle: a0, len: 30, width: 1.4, height: 0.9, dmg: this.dmg * 0.7, t: 7, charging: true, color: '#FF3B2F' })];
    if (two) beams.push(this.H.beam({ ox: this.x, oz: this.z, angle: a0 + Math.PI, len: 30, width: 1.4, height: 0.9, dmg: this.dmg * 0.7, t: 7, charging: true, color: '#FF3B2F' }));
    g.audio.play('beamcharge');
    g.ui.toast?.('JUMP THE LASER!', { color: '#FF3D8B', duration: 1.4 });
    let t = 1.1, firing = false, spin = 0, hum = 0;
    const speed = two ? 2.1 : 1.7;
    return (dt) => {
      this.stop();
      for (let k = 0; k < beams.length; k++) { beams[k].ox = this.x; beams[k].oz = this.z; }
      if (!firing) {
        t -= dt;
        for (let k = 0; k < beams.length; k++) beams[k].angle = a0 + k * Math.PI;
        if (t <= 0) { firing = true; t = TAU * 1.15 / speed; for (const b of beams) b.charging = false; g.shake(0.3); }
        return false;
      }
      t -= dt; hum -= dt; spin += dir * speed * dt;
      if (hum <= 0) { hum = 0.45; g.audio.play('beam', { volume: 0.4 }); }
      for (let k = 0; k < beams.length; k++) beams[k].angle = a0 + spin + k * Math.PI;
      if (t <= 0) { for (const b of beams) b.live = false; return true; }
      return false;
    };
  }

  a_coconutRain() {
    this.rain('coconut', this.phase === 2 ? 22 : 15, 13, 2.3, 0.75, [0.8, 1.9]);
    this.g.audio.play('bossroar', { volume: 0.4, pitch: 1.4 });
    let t = 1.4;
    return (dt) => { this.stop(); t -= dt; return t <= 0; };
  }

  // ---------------------------------------------------------------- YETI KING
  a_iceSpikes() {
    const g = this.g, p = this.toPlayer();
    const lines = this.phase === 2 ? 5 : 3;
    for (let k = 0; k < lines; k++) {
      const a = p.a + (k - (lines - 1) / 2) * 0.32;
      this.H.spikeLine(this.x, this.z, Math.sin(a), Math.cos(a), 12, 2.5, 0.75, 0.07, this.dmg * 0.7, 'ice');
    }
    g.audio.play('bossroar', { volume: 0.5, pitch: 0.9 });
    this.squash = 0.2;
    let t = 1.5;
    return (dt) => { this.stop(); t -= dt; if (t < 1.2) this.squash = 0; return t <= 0; };
  }

  a_snowballs() {
    const g = this.g, P = g.player.pos, V = g.player.vel;
    const n = this.phase === 2 ? 8 : 5;
    let t = 0, thrown = 0;
    return (dt) => {
      this.stop(); t -= dt;
      if (t <= 0 && thrown < n) {
        t = 0.28;
        const lead = 1.2, tx = P.x + V.x * lead + (Math.random() - 0.5) * 6, tz = P.z + V.z * lead + (Math.random() - 0.5) * 6;
        const time = rnd(1.1, 1.5);
        this.H.lob('snowball', this.x, this.gy + 6, this.z, tx, g.world.heightAt(tx, tz), tz, time, this.dmg * 0.6, { splash: 2.8, rad: 1.1, grav: 20 });
        g.fx.telegraph(_v.set(tx, g.world.heightAt(tx, tz) + 0.1, tz), 2.8, time, '#9FDFFF');
        g.audio.play('snowball', { volume: 0.5 });
        thrown++;
      }
      return thrown >= n && t <= -0.4;
    };
  }

  a_frostBreath() { return this.breath('#BFEFFF', 16, 0.45, 1.9, 0.26, 1.2, 0); }

  breath(color, range, half, dur, dmgK, slow, patch) {
    const g = this.g;
    let p = this.toPlayer();
    let yaw = p.a, t = 0.85, firing = false, cone = null;
    if (g.fx.telegraphCone) g.fx.telegraphCone(_v.set(this.x, this.gy + 0.1, this.z), yaw, half, range, 0.85, color === '#BFEFFF' ? '#7fdcff' : '#ff5a1a');
    else g.fx.telegraph(_v.set(this.x + Math.sin(yaw) * range * 0.5, this.gy + 0.1, this.z + Math.cos(yaw) * range * 0.5), range * 0.5, 0.85);
    g.audio.play('bossroar', { volume: 0.5, pitch: color === '#BFEFFF' ? 1.2 : 0.8 });
    const beam = this.H.beam({ ox: this.x, oz: this.z, angle: yaw, len: range, width: 2.2, height: 1.6, dmg: 0, t: dur + 1, charging: true, color, style: 'fire' });
    return (dt) => {
      this.stop();
      beam.ox = this.x; beam.oz = this.z;
      if (!firing) {
        t -= dt; beam.angle = yaw;
        if (t <= 0) { firing = true; t = dur; beam.charging = false; cone = this.H.cone({ x: this.x, z: this.z, yaw, half, range, t: dur, dmg: this.dmg * dmgK, slow, patch, color }); g.audio.play('breath', { pitch: color === '#BFEFFF' ? 1.3 : 1 }); }
        return false;
      }
      t -= dt;
      p = this.toPlayer();
      let d = p.a - yaw; while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
      yaw += clamp(d, -0.7 * dt, 0.7 * dt);
      beam.angle = yaw; cone.yaw = yaw; cone.x = this.x; cone.z = this.z;
      this.E.rot[this.i] = yaw;
      if (t <= 0) { beam.live = false; cone.live = false; return true; }
      return false;
    };
  }

  // ---------------------------------------------------------------- DUNE DEVOURER
  a_burrow() {
    const g = this.g, E = this.E, i = this.i, P = g.player.pos;
    const reps = this.phase === 2 ? 2 : 1;
    let stage = 'dive', t = 0.6, done = 0, dustT = 0;
    this.burrowing = true;
    g.audio.play('burrow');
    return (dt) => {
      this.stop();
      if (stage === 'dive') {
        t -= dt; E.yo[i] = lerp(E.yo[i], -9, Math.min(1, dt * 6));
        if (t <= 0) { this.hide(true); stage = 'hunt'; t = 2.2; }
      } else if (stage === 'hunt') {
        t -= dt; dustT -= dt;
        const dx = P.x - E.x[i], dz = P.z - E.z[i], d = Math.hypot(dx, dz) + 1e-4;
        const sp = Math.min(d / dt, 13);
        E.x[i] += dx / d * sp * dt; E.z[i] += dz / d * sp * dt;
        E.yo[i] = -9;
        if (dustT <= 0) { dustT = 0.08; g.fx.dust(_v.set(E.x[i], g.world.heightAt(E.x[i], E.z[i]) + 0.2, E.z[i]), 3); if (Math.random() < 0.3) g.shake(0.06); }
        if (t <= 0) { stage = 'warn'; t = 0.8; g.fx.telegraph(_v.set(E.x[i], g.world.heightAt(E.x[i], E.z[i]) + 0.1, E.z[i]), 5.8, 0.8, '#FFB020'); g.audio.play('burrow', { pitch: 1.3 }); }
      } else if (stage === 'warn') {
        t -= dt;
        if (t <= 0) {
          this.hide(false);
          this.H.impact(E.x[i], E.z[i], 5.8, 0.01, this.dmg * 1.15, 'erupt', { knock: 15, air: 3 });
          stage = 'up'; t = 0.9;
        }
      } else if (stage === 'up') {
        t -= dt;
        const u = 1 - t / 0.9;
        E.yo[i] = -9 + Math.sin(Math.min(1, u) * Math.PI * 0.5) * 16 - Math.max(0, u - 0.6) * 18;
        if (t <= 0) {
          if (++done >= reps) { this.burrowing = false; return true; }
          stage = 'dive'; t = 0.5; g.audio.play('burrow');
        }
      }
      return false;
    };
  }

  a_scarabs() {
    const g = this.g, p = this.toPlayer();
    const n = this.phase === 2 ? 15 : 9;
    for (let k = 0; k < n; k++) {
      const a = p.a + (k - (n - 1) / 2) * 0.14;
      this.H.projectile('scarab', this.x + Math.sin(a) * 2.5, this.gy + 2.2, this.z + Math.cos(a) * 2.5, Math.sin(a) * 13, -1, Math.cos(a) * 13, this.dmg * 0.45, { life: 4.5, rad: 0.6, home: 0.9 });
    }
    g.audio.play('scarab');
    let t = 1.0;
    return (dt) => { this.stop(); t -= dt; return t <= 0; };
  }

  a_tornadoes() {
    const g = this.g, n = this.phase === 2 ? 3 : 2;
    for (let k = 0; k < n; k++) { const a = Math.random() * TAU; this.H.tornado(this.x + Math.cos(a) * 9, this.z + Math.sin(a) * 9, 9, this.dmg * 0.5); }
    g.audio.play('tornado');
    let t = 1.0;
    return (dt) => { this.stop(); t -= dt; return t <= 0; };
  }

  // worm body: segments follow the head's path
  updateTrail() {
    const E = this.E, i = this.i;
    const hx = E.x[i], hy = E.y[i] + E.yo[i], hz = E.z[i];
    const tr = this.trail, last = tr[tr.length - 1];
    if (!last || (last.x - hx) ** 2 + (last.y - hy) ** 2 + (last.z - hz) ** 2 > 0.16) {
      tr.push({ x: hx, y: hy, z: hz });
      if (tr.length > 260) tr.shift();
    }
  }

  // ---------------------------------------------------------------- THE GRAVELORD
  a_skullSpiral() {
    const g = this.g;
    const arms = this.phase === 2 ? 3 : 2;
    let t = 3.0, emit = 0, a = Math.random() * TAU;
    g.audio.play('bossroar', { volume: 0.4, pitch: 1.6 });
    return (dt) => {
      this.stop(); t -= dt; emit -= dt;
      while (emit <= 0) {
        emit += 0.085;
        a += 0.33;
        for (let k = 0; k < arms; k++) {
          const aa = a + k * TAU / arms;
          this.H.projectile('skull', this.x + Math.sin(aa) * 1.5, this.gy + 1.2, this.z + Math.cos(aa) * 1.5, Math.sin(aa) * 9.5, 0, Math.cos(aa) * 9.5, this.dmg * 0.4, { life: 4.2, rad: 0.65 });
        }
        if (Math.random() < 0.25) g.audio.play('skull', { volume: 0.3 });
      }
      return t <= 0;
    };
  }

  a_teleportSlash() {
    const g = this.g, E = this.E, i = this.i, P = g.player.pos;
    const reps = this.phase === 2 ? 3 : 1;
    let stage = 'out', t = 0.4, done = 0;
    g.fx.pillar?.(_v.set(this.x, this.gy, this.z), '#6BFF9A', 0.5, 2.2);
    g.audio.play('teleport');
    return (dt) => {
      this.stop(); t -= dt;
      if (stage === 'out') {
        this.float = lerp(this.float, 6, Math.min(1, dt * 8));
        if (t <= 0) {
          this.hide(true);
          const a = Math.random() * TAU;
          let nx = P.x + Math.sin(a) * 5, nz = P.z + Math.cos(a) * 5;
          if (g.world.heightAt(nx, nz) < 0.2) { nx = P.x; nz = P.z; }
          E.x[i] = nx; E.z[i] = nz;
          stage = 'in'; t = 0.25;
        }
      } else if (stage === 'in') {
        if (t <= 0) {
          this.hide(false); this.float = 1.6;
          g.fx.pillar?.(_v.set(this.x, this.gy, this.z), '#6BFF9A', 0.5, 2.2);
          g.fx.telegraph(_v.set(this.x, this.gy + 0.1, this.z), 5.8, 0.6, '#6BFF9A');
          stage = 'slash'; t = 0.6;
        }
      } else if (stage === 'slash') {
        if (t <= 0) {
          this.H.impact(this.x, this.z, 5.8, 0.01, this.dmg * 0.9, 'blast', { color: '#6BFF9A' });
          g.fx.ring(_v.set(this.x, this.gy + 1, this.z), 6.5, '#6BFF9A', 0.3, 0.8);
          g.audio.play('scythe');
          if (++done >= reps) return true;
          stage = 'out'; t = 0.35; g.audio.play('teleport');
        }
      }
      return false;
    };
  }

  a_soulNova() {
    const g = this.g;
    const rings = this.phase === 2 ? 2 : 1;
    let t = 0.5, fired = 0;
    g.fx.pillar?.(_v.set(this.x, this.gy, this.z), '#6BFF9A', 0.6, 3);
    return (dt) => {
      this.stop(); t -= dt;
      if (t <= 0 && fired < rings) {
        const n = 26, off = fired * Math.PI / n;
        for (let k = 0; k < n; k++) {
          const a = off + k * TAU / n;
          this.H.projectile('skull', this.x, this.gy + 1.1, this.z, Math.sin(a) * 8.5, 0, Math.cos(a) * 8.5, this.dmg * 0.45, { life: 5, rad: 0.65 });
        }
        g.audio.play('skull', { volume: 0.6, pitch: 0.8 });
        fired++; t = 0.7;
      }
      return fired >= rings && t <= 0;
    };
  }

  a_summonGhouls() {
    const g = this.g, E = this.E, P = g.player.pos;
    const n = this.phase === 2 ? 14 : 10;
    for (let k = 0; k < n; k++) {
      const a = k / n * TAU, x = P.x + Math.cos(a) * 11, z = P.z + Math.sin(a) * 11;
      if (g.world.heightAt(x, z) < 0.2) continue;
      const j = E.spawn(E.T.goon, x, z, { hpMult: g.hpMult, dmgMult: g.dmgMult });
      if (j >= 0) g.fx.pillar?.(_v.set(x, g.world.heightAt(x, z), z), '#6BFF9A', 0.5, 1);
    }
    g.audio.play('ghost', { volume: 0.6 });
    let t = 1.0;
    return (dt) => { this.stop(); t -= dt; return t <= 0; };
  }

  // ---------------------------------------------------------------- MAGMAW
  a_fireBreath() { return this.breath('#FF6A1A', 21, 0.5, 2.3, 0.3, 0, 3.5); }

  a_meteorRain() {
    this.rain('meteor', this.phase === 2 ? 26 : 18, 24, 3, 0.8, [0.8, 2.6], 3);
    this.g.audio.play('dragonroar', { volume: 0.6 });
    let t = 1.6;
    return (dt) => { this.stop(); t -= dt; return t <= 0; };
  }

  a_wingGust() {
    const g = this.g, P = g.player.pos;
    let t = 0.7, n = 0;
    g.audio.play('wing');
    return (dt) => {
      this.stop(); t -= dt;
      if (t <= 0) {
        this.H.shock(this.x, this.z, 32, 18, this.dmg * 0.7, '#FF9E2C');
        const dx = P.x - this.x, dz = P.z - this.z, d = Math.hypot(dx, dz) + 1e-4;
        if (d < 30) { g.player.vel.x += dx / d * 16; g.player.vel.z += dz / d * 16; g.player.vel.y = Math.max(g.player.vel.y, 7); g.player.onGround = false; }
        g.audio.play('wing'); g.shake(0.6);
        n++; t = 0.55;
      }
      return n >= 2;
    };
  }

  a_flyover() {
    const g = this.g, E = this.E, i = this.i, P = g.player.pos;
    let stage = 'rise', t = 0.9, dropT = 0;
    let dx = 0, dz = 0;
    this.flying = true;
    g.audio.play('wing'); g.audio.play('dragonroar', { volume: 0.7 });
    return (dt) => {
      if (stage === 'rise') {
        this.stop(); t -= dt;
        E.yo[i] = lerp(E.yo[i], 15, Math.min(1, dt * 3));
        if (t <= 0) { const p = this.toPlayer(); dx = p.dx; dz = p.dz; stage = 'fly'; t = (p.d + 26) / 26; }
      } else if (stage === 'fly') {
        t -= dt; dropT -= dt;
        E.vx[i] = dx * 26; E.vz[i] = dz * 26; E.rot[i] = Math.atan2(dx, dz);
        E.yo[i] = 15;
        if (dropT <= 0) { dropT = 0.18; this.H.impact(E.x[i], E.z[i], 3.2, 0.55, this.dmg * 0.7, 'meteor', { patch: 3 }); }
        if (t <= 0) { stage = 'land'; t = 0.7; }
      } else {
        this.stop(); t -= dt;
        E.yo[i] = lerp(E.yo[i], 0, Math.min(1, dt * 7));
        if (t <= 0) {
          E.yo[i] = 0; this.flying = false;
          this.H.shock(this.x, this.z, 26, 16, this.dmg * 0.7);
          g.shake(0.9); g.audio.play('bossslam');
          return true;
        }
      }
      return false;
    };
  }

  a_fireballs() {
    const g = this.g, P = g.player.pos;
    const n = this.phase === 2 ? 8 : 5;
    let t = 0.3, shot = 0;
    return (dt) => {
      this.stop(); t -= dt;
      if (t <= 0 && shot < n) {
        t = 0.22;
        const hx = this.x, hy = this.gy + 5, hz = this.z;
        const dx = P.x - hx, dy = P.y + 0.8 - hy, dz = P.z - hz, d = Math.hypot(dx, dy, dz) + 1e-4;
        const s = 19, a = (Math.random() - 0.5) * 0.2;
        this.H.projectile('fireball', hx, hy, hz, (dx / d * Math.cos(a) - dz / d * Math.sin(a)) * s, dy / d * s, (dz / d * Math.cos(a) + dx / d * Math.sin(a)) * s, this.dmg * 0.55, { life: 5, rad: 0.9, home: 0.35, splash: 3.2 });
        g.audio.play('breath', { volume: 0.35, pitch: 1.6 });
        shot++;
      }
      return shot >= n && t <= -0.3;
    };
  }
}

// Renders the sandworm's trailing body segments.
export class WormBody {
  constructor(scene) {
    let geo;
    try { geo = M.buildEnemyGeometry('wormseg'); } catch { geo = new THREE.IcosahedronGeometry(1.6, 1); }
    this.mesh = new THREE.InstancedMesh(geo, M.makeToonMaterial(), 16);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.p = new THREE.Vector3(); this.e = new THREE.Euler();
  }
  render(boss) {
    if (!boss || !boss.alive || boss.id !== 'worm') { this.mesh.count = 0; return; }
    const tr = boss.trail, n = 14, spacing = 2.5;
    let idx = tr.length - 1, acc = 0, c = 0;
    const sc = boss.E.scale[boss.i];
    for (let k = 1; k <= n && idx > 0; k++) {
      const want = k * spacing * sc;
      while (idx > 0 && acc < want) { const a = tr[idx], b = tr[idx - 1]; acc += Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); idx--; }
      if (acc < want) break;
      const a = tr[idx], b = tr[Math.min(tr.length - 1, idx + 1)];
      this.p.set(a.x, a.y, a.z);
      this.e.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0);
      this.e.x = -Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z) + 1e-4);
      this.q.setFromEuler(this.e);
      const s = sc * (1 - k / (n + 4));
      this.s.set(s, s, s);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(c++, this.m);
    }
    this.mesh.count = c;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
