// Boss & enemy attack primitives: projectiles, telegraphed impacts, expanding shockwaves, sweeping
// beams, breath cones, spike lines, tornadoes and burning ground. Each checks the player itself.
import * as THREE from 'three';
import * as M from './models.js';
import { clamp } from './rng.js';

export const PKINDS = ['spit', 'snowball', 'skull', 'fireball', 'coconut', 'scarab', 'icicle', 'bone'];
const PK = Object.fromEntries(PKINDS.map((k, i) => [k, i]));
const PMAX = 700;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

export class Hazards {
  constructor(scene, game) {
    this.game = game; this.scene = scene;
    const f = () => new Float32Array(PMAX);
    this.x = f(); this.y = f(); this.z = f(); this.vx = f(); this.vy = f(); this.vz = f(); this.life = f(); this.dmg = f();
    this.grav = f(); this.rad = f(); this.home = f(); this.splash = f(); this.spin = f();
    this.kind = new Uint8Array(PMAX); this.vis = new Uint8Array(PMAX); this.alive = new Uint8Array(PMAX);
    this.next = 0;
    this.meshes = PKINDS.map((k) => {
      let geo;
      try { geo = M.buildProjectileGeometry(k); } catch { geo = M.buildProjectileGeometry('spit'); }
      const glow = k === 'skull' || k === 'fireball' || k === 'spit';
      const mat = M.makeToonMaterial(glow ? { emissive: new THREE.Color(k === 'skull' ? '#2aff7a' : '#ff6a00'), emissiveIntensity: k === 'skull' ? 1.2 : 1.0 } : {});
      const m = new THREE.InstancedMesh(geo, mat, 260);
      m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    });
    this.counts = new Int32Array(PKINDS.length);
    this.impacts = []; this.shocks = []; this.beams = []; this.cones = []; this.tornadoes = []; this.patches = [];
  }

  clear() {
    this.alive.fill(0);
    for (const b of this.beams) { b.handle?.setVisible?.(false); b.handle?.dispose?.(); }
    for (const t of this.tornadoes) t.handle?.dispose?.();
    this.impacts.length = 0; this.shocks.length = 0; this.beams.length = 0; this.cones.length = 0; this.tornadoes.length = 0; this.patches.length = 0;
    for (const m of this.meshes) m.count = 0;
  }

  // ---------------------------------------------------------------- projectiles
  // opts: grav (m/s²), life (s), rad (hit radius), home (turn rate toward the player), splash (radius on ground hit), visualOnly
  projectile(kind, x, y, z, vx, vy, vz, dmg, opts = {}) {
    let k = -1;
    for (let tries = 0; tries < PMAX; tries++) { const c = this.next; this.next = (this.next + 1) % PMAX; if (!this.alive[c]) { k = c; break; } }
    if (k < 0) return -1;
    this.alive[k] = 1; this.kind[k] = PK[kind] ?? 0;
    this.x[k] = x; this.y[k] = y; this.z[k] = z; this.vx[k] = vx; this.vy[k] = vy; this.vz[k] = vz;
    this.life[k] = opts.life ?? 5; this.dmg[k] = dmg; this.grav[k] = opts.grav ?? 0; this.rad[k] = opts.rad ?? 0.8;
    this.home[k] = opts.home ?? 0; this.splash[k] = opts.splash ?? 0; this.vis[k] = opts.visualOnly ? 1 : 0; this.spin[k] = Math.random() * 6;
    return k;
  }

  // lob a ballistic projectile from (x,y,z) to land at (tx,ty,tz) after `time` seconds
  lob(kind, x, y, z, tx, ty, tz, time, dmg, opts = {}) {
    const g = opts.grav ?? 18;
    return this.projectile(kind, x, y, z, (tx - x) / time, (ty - y + 0.5 * g * time * time) / time, (tz - z) / time, dmg, { ...opts, grav: g, life: time + 2 });
  }

  // ---------------------------------------------------------------- area attacks
  // telegraphed hit after `delay`; kind drives the visual ('meteor','coconut','spike-ice','spike-sand','spike-bone','spike-lava','erupt','blast')
  impact(x, z, r, delay, dmg, kind = 'blast', opts = {}) {
    const g = this.game, y = g.world.heightAt(x, z);
    g.fx.telegraph(_v.set(x, y + 0.08, z), r, delay, opts.color || '#ff2a2a');
    if (kind === 'meteor' || kind === 'coconut' || kind === 'fireball') {
      const pk = kind === 'meteor' ? 'fireball' : kind;
      const h = 28;
      // falls on a straight diagonal path that lands exactly when the telegraph completes
      this.projectile(pk, x + 6, y + h, z - 4, -6 / delay, -h / delay, 4 / delay, 0, { visualOnly: true, life: delay, grav: 0 });
    }
    this.impacts.push({ x, z, y, r, t: delay, dmg, kind, patch: opts.patch || 0, knock: opts.knock || 0, air: opts.air ?? 2.2 });
  }

  shock(x, z, maxR, speed, dmg, color = '#ff5a2a') {
    const g = this.game, y = g.world.heightAt(x, z);
    g.fx.ring(_v.set(x, y + 0.3, z), maxR, color, maxR / speed, 1.2);
    this.shocks.push({ x, z, r: 1.5, speed, max: maxR, hit: false, dmg });
  }

  // a spike line marching from (x0,z0) along (dx,dz)
  spikeLine(x0, z0, dx, dz, count, spacing, firstDelay, step, dmg, kind = 'ice') {
    for (let i = 0; i < count; i++) {
      const x = x0 + dx * spacing * (i + 1), z = z0 + dz * spacing * (i + 1);
      this.impact(x, z, 1.5, firstDelay + i * step, dmg, 'spike-' + kind, { color: kind === 'ice' ? '#7fe8ff' : kind === 'lava' ? '#ff7a1a' : '#ffcf7a', air: 1.4 });
    }
  }

  // sweeping beam: the owner updates origin/angle each frame via the returned object
  beam(opts) {
    const b = Object.assign({ ox: 0, oy: 1, oz: 0, angle: 0, len: 26, width: 1.2, height: 0.9, dmg: 20, t: 3, cd: 0, style: 'laser', jumpable: true, color: '#ff3b3b', live: true }, opts);
    b.handle = this.game.fx.sweepBeam ? this.game.fx.sweepBeam(b.color, { style: b.style }) : null;
    this.beams.push(b);
    return b;
  }

  // breath cone that ticks damage (owner aims it each frame)
  cone(opts) {
    const c = Object.assign({ x: 0, z: 0, yaw: 0, half: 0.42, range: 16, t: 2, dmg: 8, tick: 0, slow: 0, patch: 0, patchT: 0, color: '#ff6a1a', live: true }, opts);
    this.cones.push(c);
    return c;
  }

  tornado(x, z, life, dmg) {
    const tn = { x, z, vx: 0, vz: 0, t: life, dmg, cd: 0, handle: this.game.fx.tornado ? this.game.fx.tornado() : null };
    this.tornadoes.push(tn);
    return tn;
  }

  patch(x, z, r, life, dmg, color = '#ff6a1a') {
    const g = this.game, y = g.world.heightAt(x, z);
    g.fx.groundGlow?.(_v.set(x, y + 0.06, z), r, color, life);
    this.patches.push({ x, z, r, t: life, dmg, cd: 0 });
  }

  // ---------------------------------------------------------------- update
  playerHeight() { const P = this.game.player.pos; return P.y - this.game.world.heightAt(P.x, P.z); }

  update(dt) {
    const g = this.game, P = g.player.pos, w = g.world, fx = g.fx;
    const py = P.y + 0.9;
    this.counts.fill(0);
    // projectiles
    for (let k = 0; k < PMAX; k++) {
      if (!this.alive[k]) continue;
      this.life[k] -= dt;
      if (this.life[k] <= 0) { this.alive[k] = 0; continue; }
      if (this.home[k] > 0) {
        const dx = P.x - this.x[k], dy = py - this.y[k], dz = P.z - this.z[k], d = Math.hypot(dx, dy, dz) + 1e-4;
        const sp = Math.hypot(this.vx[k], this.vy[k], this.vz[k]);
        const s = Math.min(1, this.home[k] * dt);
        this.vx[k] += (dx / d * sp - this.vx[k]) * s; this.vy[k] += (dy / d * sp - this.vy[k]) * s * 0.5; this.vz[k] += (dz / d * sp - this.vz[k]) * s;
      }
      this.vy[k] -= this.grav[k] * dt;
      this.x[k] += this.vx[k] * dt; this.y[k] += this.vy[k] * dt; this.z[k] += this.vz[k] * dt;
      this.spin[k] += dt * 8;
      if (!this.vis[k]) {
        const dx = this.x[k] - P.x, dy = this.y[k] - py, dz = this.z[k] - P.z, rr = this.rad[k] + 0.45;
        if (dx * dx + dy * dy + dz * dz < rr * rr) {
          g.hurtPlayer(this.dmg[k], this.x[k], this.z[k]);
          fx.burst(_v.set(this.x[k], this.y[k], this.z[k]), this.kind[k] === PK.skull ? '#6BFF9A' : this.kind[k] === PK.snowball ? '#EAF6FF' : '#FF8A1F', 8, { speed: 5 });
          this.alive[k] = 0; continue;
        }
        const gh = w.heightAt(this.x[k], this.z[k]);
        if (this.y[k] < gh && (this.grav[k] > 0 || this.vy[k] < 0)) {
          this.alive[k] = 0;
          _v.set(this.x[k], gh + 0.2, this.z[k]);
          const kk = this.kind[k];
          fx.burst(_v, kk === PK.snowball ? '#EAF6FF' : kk === PK.skull ? '#6BFF9A' : kk === PK.scarab ? '#2FD4B0' : '#FF8A1F', 10, { speed: 6 });
          if (this.splash[k] > 0) {
            fx.ring(_v, this.splash[k], kk === PK.snowball ? '#DFF4FF' : '#FF9E2C', 0.3, 0.6);
            if (Math.hypot(P.x - this.x[k], P.z - this.z[k]) < this.splash[k] + 0.4 && this.playerHeight() < 2) g.hurtPlayer(this.dmg[k], this.x[k], this.z[k]);
            if (kk === PK.snowball) g.audio.play('snowimpact', { volume: 0.5 });
          }
          continue;
        }
      } else if (this.y[k] < w.heightAt(this.x[k], this.z[k]) - 0.5) { this.alive[k] = 0; continue; }
      // render
      const kk = this.kind[k], mesh = this.meshes[kk], c = this.counts[kk];
      if (c >= 260) continue;
      this.counts[kk] = c + 1;
      const te = mesh.instanceMatrix.array, o = c * 16;
      const yaw = Math.atan2(this.vx[k], this.vz[k]);
      const spinY = kk === PK.bone || kk === PK.coconut ? this.spin[k] : yaw;
      const cy = Math.cos(spinY), sy = Math.sin(spinY);
      const s = kk === PK.snowball ? 1.25 : 1;
      te[o] = cy * s; te[o + 1] = 0; te[o + 2] = -sy * s; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
      te[o + 8] = sy * s; te[o + 9] = 0; te[o + 10] = cy * s; te[o + 11] = 0; te[o + 12] = this.x[k]; te[o + 13] = this.y[k]; te[o + 14] = this.z[k]; te[o + 15] = 1;
    }
    for (let i = 0; i < this.meshes.length; i++) { const m = this.meshes[i]; m.count = this.counts[i]; m.instanceMatrix.needsUpdate = true; }

    const ph = this.playerHeight();
    // telegraphed impacts
    for (let i = this.impacts.length - 1; i >= 0; i--) {
      const im = this.impacts[i];
      im.t -= dt;
      if (im.t > 0) continue;
      this.impacts.splice(i, 1);
      _v.set(im.x, im.y + 0.2, im.z);
      if (im.kind.startsWith('spike-')) {
        const sk = im.kind.slice(6);
        if (fx.spikes) fx.spikes(_v, sk, im.r / 1.5, 0.9); else fx.burst(_v, sk === 'ice' ? '#9FEFFF' : '#D9B27A', 10, { speed: 6, up: 8 });
        g.audio.play(sk === 'ice' ? 'icespike' : 'erupt', { volume: 0.35 });
      } else if (im.kind === 'erupt') {
        fx.spikes?.(_v, 'sand', 2.2, 1.1);
        fx.burst(_v, '#E8B878', 40, { speed: 14, up: 12, size: 0.35 });
        fx.ring(_v, im.r * 1.6, '#FFD49A', 0.5, 1.2);
        g.audio.play('erupt'); g.shake(0.9);
      } else {
        fx.burst(_v, im.kind === 'coconut' ? '#8B5A2B' : '#FF7A1A', 18, { speed: 9, up: 6, size: 0.3 });
        fx.ring(_v, im.r * 1.3, im.kind === 'coconut' ? '#FFE8B0' : '#FF9E2C', 0.35, 0.7);
        g.audio.play(im.kind === 'coconut' ? 'coconut' : 'explosion', { volume: 0.45, pitch: 0.9 + Math.random() * 0.2 });
        g.shake(0.08);
      }
      if (im.patch) this.patch(im.x, im.z, im.r * 0.9, im.patch, im.dmg * 0.2);
      if (Math.hypot(P.x - im.x, P.z - im.z) < im.r + 0.4 && ph < im.air) {
        g.hurtPlayer(im.dmg, im.x, im.z, im.kind === 'erupt');
        if (im.knock) { g.player.vel.y = Math.max(g.player.vel.y, im.knock); g.player.onGround = false; }
      }
    }
    // shock rings: jump over them
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.r += s.speed * dt;
      const d = Math.hypot(P.x - s.x, P.z - s.z);
      if (!s.hit && Math.abs(d - s.r) < 1.3 && ph < 0.6) { s.hit = true; g.hurtPlayer(s.dmg, s.x, s.z, true); }
      if (s.r > s.max) this.shocks.splice(i, 1);
    }
    // sweeping beams: player must be out of the line or above it
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t -= dt; b.cd -= dt;
      const ux = Math.sin(b.angle), uz = Math.cos(b.angle);
      const gy = w.heightAt(b.ox, b.oz);
      _v.set(b.ox + ux * 1.5, gy + b.height, b.oz + uz * 1.5); _v2.set(b.ox + ux * b.len, gy + b.height, b.oz + uz * b.len);
      if (b.handle) { b.handle.set(_v, _v2, b.width * (b.charging ? 0.25 : 1)); b.handle.setVisible(true); b.handle.setIntensity?.(b.charging ? 0.35 : 1); }
      if (!b.charging && b.cd <= 0 && b.dmg > 0) {
        const rx = P.x - b.ox, rz = P.z - b.oz;
        const along = rx * ux + rz * uz, perp = Math.abs(-rx * uz + rz * ux);
        if (along > 0 && along < b.len && perp < b.width * 0.5 + 0.45 && (!b.jumpable || ph < b.height + 0.6)) { b.cd = 0.6; g.hurtPlayer(b.dmg, P.x - ux, P.z - uz); }
      }
      if (b.t <= 0 || !b.live) { b.handle?.setVisible(false); b.handle?.dispose?.(); this.beams.splice(i, 1); }
    }
    // breath cones
    for (let i = this.cones.length - 1; i >= 0; i--) {
      const c = this.cones[i];
      c.t -= dt; c.tick -= dt; c.patchT -= dt;
      const ux = Math.sin(c.yaw), uz = Math.cos(c.yaw);
      const gy = w.heightAt(c.x, c.z);
      if (Math.random() < 0.9) {
        const a = c.yaw + (Math.random() - 0.5) * c.half * 2, rr = Math.random() * c.range;
        _v.set(c.x + Math.sin(a) * rr * 0.3, gy + 1.5, c.z + Math.cos(a) * rr * 0.3);
        _v2.set(Math.sin(a), 0.05, Math.cos(a));
        fx.burst(_v, c.color, 3, { speed: 16, dir: _v2, up: 0.5, gravity: -1, life: 0.5, size: 0.35, spread: 0.25, glow: 2 });
      }
      if (c.patch && c.patchT <= 0) { c.patchT = 0.18; const rr = 4 + Math.random() * (c.range - 4), a = c.yaw + (Math.random() - 0.5) * c.half * 1.6; this.patch(c.x + Math.sin(a) * rr, c.z + Math.cos(a) * rr, 2.2, c.patch, c.dmg * 0.6, c.color); }
      if (c.tick <= 0) {
        c.tick = 0.25;
        const rx = P.x - c.x, rz = P.z - c.z, d = Math.hypot(rx, rz);
        if (d < c.range && d > 0.5) {
          const dot = (rx * ux + rz * uz) / d;
          if (dot > Math.cos(c.half)) { g.hurtPlayer(c.dmg, c.x, c.z); if (c.slow) g.slowPlayer?.(c.slow); }
        }
      }
      if (c.t <= 0 || !c.live) this.cones.splice(i, 1);
    }
    // tornadoes drift toward the player, pull and damage
    for (let i = this.tornadoes.length - 1; i >= 0; i--) {
      const tn = this.tornadoes[i];
      tn.t -= dt; tn.cd -= dt;
      const dx = P.x - tn.x, dz = P.z - tn.z, d = Math.hypot(dx, dz) + 1e-4;
      tn.vx += (dx / d * 5.5 - tn.vx) * Math.min(1, dt * 0.8) + (Math.random() - 0.5) * 6 * dt;
      tn.vz += (dz / d * 5.5 - tn.vz) * Math.min(1, dt * 0.8) + (Math.random() - 0.5) * 6 * dt;
      tn.x += tn.vx * dt; tn.z += tn.vz * dt;
      tn.handle?.setPosition(_v.set(tn.x, w.heightAt(tn.x, tn.z), tn.z));
      if (d < 9) { const pull = (1 - d / 9) * 9 * dt; g.player.vel.x -= dx / d * pull * 2; g.player.vel.z -= dz / d * pull * 2; }
      if (d < 2.6 && tn.cd <= 0) { tn.cd = 0.5; g.hurtPlayer(tn.dmg, tn.x, tn.z); g.player.vel.y = Math.max(g.player.vel.y, 9); g.player.onGround = false; }
      if (tn.t <= 0) { tn.handle?.dispose?.(); this.tornadoes.splice(i, 1); }
    }
    // burning ground
    for (let i = this.patches.length - 1; i >= 0; i--) {
      const pa = this.patches[i];
      pa.t -= dt; pa.cd -= dt;
      if (pa.cd <= 0 && ph < 0.5 && Math.hypot(P.x - pa.x, P.z - pa.z) < pa.r) { pa.cd = 0.4; g.hurtPlayer(pa.dmg, pa.x, pa.z); }
      if (pa.t <= 0) this.patches.splice(i, 1);
    }
  }
}
