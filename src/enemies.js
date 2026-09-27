// The horde: data-oriented enemy simulation (typed arrays + spatial hash) rendered as GPU-animated
// instanced meshes. Limbs swing in the vertex shader, so thousands of critters cost a few draw calls.
import * as THREE from 'three';
import { buildEnemyGeometry, buildProjectileGeometry, makeToonMaterial } from './models.js';
import { clamp } from './rng.js';
import { PLAY_R } from './world.js';

export const TYPES = ['blob', 'goon', 'zippy', 'bat', 'spitter', 'brute', 'boss'];
export const T = Object.fromEntries(TYPES.map((t, i) => [t, i]));
export const TDEF = [
  /* blob    */ { hp: 14, speed: 3.5, dmg: 6, xp: 1, pts: 10, gold: 0.05, cap: 1800, anim: 7, color: '#FF4FA3', mass: 1 },
  /* goon    */ { hp: 28, speed: 4.4, dmg: 8, xp: 2, pts: 20, gold: 0.07, cap: 1400, anim: 9, color: '#8B5CF6', mass: 1.2 },
  /* zippy   */ { hp: 10, speed: 8.2, dmg: 5, xp: 1, pts: 12, gold: 0.05, cap: 900, anim: 18, color: '#FF5A36', mass: 0.6 },
  /* bat     */ { hp: 16, speed: 6.4, dmg: 8, xp: 2, pts: 20, gold: 0.07, cap: 600, anim: 6, color: '#6B4A9C', mass: 0.7, fly: true },
  /* spitter */ { hp: 36, speed: 2.9, dmg: 12, xp: 3, pts: 30, gold: 0.12, cap: 300, anim: 7, color: '#FF8A1F', mass: 1.5 },
  /* brute   */ { hp: 170, speed: 2.8, dmg: 22, xp: 8, pts: 80, gold: 0.35, cap: 300, anim: 4, color: '#5B6C9A', mass: 6 },
  /* boss    */ { hp: 3800, speed: 4.2, dmg: 30, xp: 160, pts: 5000, gold: 1, cap: 4, anim: 3, color: '#7B2FF7', mass: 1e9 },
];
const MAX = 3000;
const G = 128, GC = 4, GH = G / 2; // spatial hash grid: 128x128 cells of 4 m

const _m4 = new THREE.Matrix4();

function patchMaterial(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLimb; attribute vec3 aPivot; attribute vec4 aAnim; varying float vFlash;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        mat3 lr = mat3(1.0);
        if (aLimb > 0.5) {
          float ph = aAnim.x, amp = aAnim.y, s = 0.0; int ax = 0;
          if (aLimb < 1.5) s = sin(ph) * 0.85 * amp;
          else if (aLimb < 2.5) s = -sin(ph) * 0.85 * amp;
          else if (aLimb < 3.5) s = -sin(ph) * 0.7 * amp;
          else if (aLimb < 4.5) s = sin(ph) * 0.7 * amp;
          else if (aLimb < 5.5) { s = sin(ph * 2.0) * 0.8; ax = 2; }
          else if (aLimb < 6.5) { s = -sin(ph * 2.0) * 0.8; ax = 2; }
          else if (aLimb < 7.5) s = sin(ph * 2.0) * 0.1;
          else { s = sin(ph) * 0.45; ax = 1; }
          float c = cos(s), sn = sin(s);
          if (ax == 0) lr = mat3(1.0,0.0,0.0, 0.0,c,sn, 0.0,-sn,c);
          else if (ax == 1) lr = mat3(c,0.0,-sn, 0.0,1.0,0.0, sn,0.0,c);
          else lr = mat3(c,sn,0.0, -sn,c,0.0, 0.0,0.0,1.0);
        }
        objectNormal = lr * objectNormal;`)
      .replace('#include <begin_vertex>', `vec3 transformed = lr * (position - aPivot) + aPivot;
        float sq = aAnim.z; transformed.y *= (1.0 + sq); transformed.xz *= (1.0 - sq * 0.45);
        vFlash = aAnim.w;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vFlash;`)
      .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, vec3(1.5, 1.45, 1.4), clamp(vFlash, 0.0, 1.0));
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'horde';
  return mat;
}

export class Enemies {
  constructor(scene, world, game) {
    this.scene = scene; this.world = world; this.game = game;
    const f = () => new Float32Array(MAX);
    this.x = f(); this.y = f(); this.z = f(); this.vx = f(); this.vz = f(); this.kx = f(); this.kz = f(); this.yo = f(); this.vy = f();
    this.hp = f(); this.maxHp = f(); this.spd = f(); this.dmg = f(); this.rad = f(); this.scale = f(); this.flash = f();
    this.ph = f(); this.rot = f(); this.deathT = f(); this.spin = f(); this.atk = f(); this.hitCd = f(); this.sawCd = f(); this.ramCd = f(); this.slow = f();
    this.type = new Uint8Array(MAX); this.state = new Uint8Array(MAX); this.elite = new Uint8Array(MAX);
    this.lastBang = new Int32Array(MAX); // boomerang id that last hit (prevents multi-hits per pass)
    this.free = []; for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.active = new Int32Array(MAX); this.activeCount = 0;
    this.aliveCount = 0; this.countByType = new Int32Array(TYPES.length);
    // spatial hash
    this.cellCount = new Int32Array(G * G); this.cellStart = new Int32Array(G * G + 1); this.cellItems = new Int32Array(MAX); this.cellOf = new Int32Array(MAX);
    this.tmp = new Int32Array(G * G);
    // meshes
    this.meshes = []; this.animAttr = []; this.colAttr = [];
    const mat = patchMaterial(makeToonMaterial());
    this.material = mat;
    this.geos = [];
    TYPES.forEach((t, ti) => {
      const geo = buildEnemyGeometry(t);
      this.geos.push(geo);
      const cap = TDEF[ti].cap;
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); anim.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = false;
      scene.add(mesh);
      this.meshes.push(mesh); this.animAttr.push(anim); this.colAttr.push(mesh.instanceColor);
      TDEF[ti].radius = (geo.userData.radius || 0.5);
      TDEF[ti].height = (geo.userData.height || 1);
    });
    // spitter projectiles
    this.PMAX = 300;
    this.px = new Float32Array(this.PMAX); this.py = new Float32Array(this.PMAX); this.pz = new Float32Array(this.PMAX);
    this.pvx = new Float32Array(this.PMAX); this.pvy = new Float32Array(this.PMAX); this.pvz = new Float32Array(this.PMAX);
    this.plife = new Float32Array(this.PMAX); this.pdmg = new Float32Array(this.PMAX); this.pNext = 0;
    const spitMat = makeToonMaterial({ emissive: new THREE.Color('#FF6A00'), emissiveIntensity: 0.9 });
    this.spitMesh = new THREE.InstancedMesh(buildProjectileGeometry('spit'), spitMat, this.PMAX);
    this.spitMesh.count = 0; this.spitMesh.frustumCulled = false; this.spitMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.spitMesh);
    this.shocks = []; // boss shockwaves
    this.boss = null;
  }

  reset() {
    this.free.length = 0; for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.state.fill(0); this.activeCount = 0; this.aliveCount = 0; this.countByType.fill(0);
    this.plife.fill(0); this.shocks.length = 0; this.boss = null;
    for (const m of this.meshes) m.count = 0;
    this.spitMesh.count = 0;
  }

  spawn(ti, x, z, o = {}) {
    if (this.free.length === 0) return -1;
    const d = TDEF[ti];
    if (this.countByType[ti] >= d.cap) return -1;
    const i = this.free.pop();
    const elite = o.elite ? 1 : 0;
    this.type[i] = ti; this.state[i] = 1; this.elite[i] = elite;
    this.x[i] = x; this.z[i] = z; this.y[i] = this.world.heightAt(x, z);
    this.vx[i] = this.vz[i] = this.kx[i] = this.kz[i] = 0;
    this.vy[i] = d.fly || ti === T.boss ? 0 : 9 + Math.random() * 2;
    // ground critters burst up out of the dirt instead of popping into existence
    this.yo[i] = d.fly ? 2.5 + Math.random() * 2 : (ti === T.boss ? 0 : -1.4);
    const hpm = (o.hpMult || 1) * (elite ? 11 : 1);
    this.hp[i] = this.maxHp[i] = d.hp * hpm;
    this.spd[i] = d.speed * (o.speedMult || 1) * (elite ? 1.08 : 1) * (0.9 + Math.random() * 0.2);
    this.dmg[i] = d.dmg * (o.dmgMult || 1) * (elite ? 1.6 : 1);
    this.scale[i] = (o.scale || 1) * (elite ? 1.75 : 1) * (ti === T.boss ? 1 : 0.92 + Math.random() * 0.16);
    this.rad[i] = d.radius * this.scale[i];
    this.flash[i] = 0; this.ph[i] = Math.random() * 10; this.rot[i] = 0; this.atk[i] = 1 + Math.random() * 2;
    this.hitCd[i] = 0; this.sawCd[i] = 0; this.ramCd[i] = 0; this.slow[i] = 0; this.lastBang[i] = -1;
    this.active[this.activeCount++] = i;
    this.aliveCount++; this.countByType[ti]++;
    return i;
  }

  // ---------------------------------------------------------------- damage
  damage(i, amount, crit, dirX, dirZ, knock, source) {
    if (this.state[i] !== 1) return 0;
    const ti = this.type[i];
    const dealt = Math.min(amount, this.hp[i]);
    this.hp[i] -= amount;
    this.flash[i] = 1;
    const g = this.game;
    g.onDamage(i, amount, crit, source, dealt);
    const mass = TDEF[ti].mass * (this.elite[i] ? 4 : 1);
    if (knock > 0 && ti !== T.boss) {
      const k = knock / mass;
      this.kx[i] += dirX * k; this.kz[i] += dirZ * k;
      if (k > 6 && !TDEF[ti].fly) this.vy[i] = Math.max(this.vy[i], Math.min(k * 0.6, 9));
    }
    if (this.hp[i] <= 0) this.kill(i, dirX, dirZ, knock);
    return dealt;
  }

  kill(i, dirX, dirZ, force) {
    if (this.state[i] !== 1) return;
    this.state[i] = 2; this.deathT[i] = 0;
    this.aliveCount--; this.countByType[this.type[i]]--;
    const ti = this.type[i];
    const f = clamp(6 + force * 0.6, 6, 38) / Math.sqrt(TDEF[ti].mass);
    // YEET: fling the corpse away from the hit, spinning
    this.kx[i] = dirX * f; this.kz[i] = dirZ * f; this.vy[i] = 6 + Math.random() * 6 + Math.min(force * 0.25, 10);
    this.spin[i] = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
    this.game.onKill(i, ti, this.x[i], this.y[i] + this.yo[i], this.z[i], this.elite[i]);
  }

  // ---------------------------------------------------------------- queries
  cellIndex(x, z) {
    let cx = Math.floor(x / GC) + GH, cz = Math.floor(z / GC) + GH;
    if (cx < 0) cx = 0; else if (cx >= G) cx = G - 1;
    if (cz < 0) cz = 0; else if (cz >= G) cz = G - 1;
    return cx * G + cz;
  }

  _buildGrid() {
    const cc = this.cellCount; cc.fill(0);
    const n = this.activeCount, A = this.active;
    for (let k = 0; k < n; k++) {
      const i = A[k]; if (this.state[i] !== 1) continue;
      const c = this.cellIndex(this.x[i], this.z[i]); this.cellOf[i] = c; cc[c]++;
    }
    const cs = this.cellStart; let s = 0;
    for (let c = 0; c < G * G; c++) { cs[c] = s; s += cc[c]; }
    cs[G * G] = s;
    const fill = this.tmp; fill.set(cs.subarray(0, G * G));
    for (let k = 0; k < n; k++) {
      const i = A[k]; if (this.state[i] !== 1) continue;
      this.cellItems[fill[this.cellOf[i]]++] = i;
    }
  }

  // fills `out` with alive enemy indices within r of (x,z); returns count
  query(x, z, r, out, max = out.length) {
    let n = 0;
    const x0 = Math.max(0, Math.floor((x - r) / GC) + GH), x1 = Math.min(G - 1, Math.floor((x + r) / GC) + GH);
    const z0 = Math.max(0, Math.floor((z - r) / GC) + GH), z1 = Math.min(G - 1, Math.floor((z + r) / GC) + GH);
    const cs = this.cellStart, items = this.cellItems;
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const c = cx * G + cz;
      for (let k = cs[c], e = cs[c + 1]; k < e; k++) {
        const i = items[k];
        if (this.state[i] !== 1) continue;
        const dx = this.x[i] - x, dz = this.z[i] - z, rr = r + this.rad[i];
        if (dx * dx + dz * dz <= rr * rr) { out[n++] = i; if (n >= max) return n; }
      }
    }
    return n;
  }

  nearest(x, z, maxR, exclude = -1) {
    let best = -1, bd = maxR * maxR;
    for (let r = 8; ; r *= 2) {
      const rr = Math.min(r, maxR);
      const x0 = Math.max(0, Math.floor((x - rr) / GC) + GH), x1 = Math.min(G - 1, Math.floor((x + rr) / GC) + GH);
      const z0 = Math.max(0, Math.floor((z - rr) / GC) + GH), z1 = Math.min(G - 1, Math.floor((z + rr) / GC) + GH);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const c = cx * G + cz;
        for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
          const i = this.cellItems[k]; if (i === exclude || this.state[i] !== 1) continue;
          const dx = this.x[i] - x, dz = this.z[i] - z, d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 || rr >= maxR) return best;
    }
  }

  // ---------------------------------------------------------------- update
  update(dt, t) {
    const g = this.game, P = g.player.pos, w = this.world;
    const n = this.activeCount, A = this.active;
    this._buildGrid();
    const px = P.x, pz = P.z, py = P.y;
    const ram = g.ramming;
    const kdecay = Math.exp(-5 * dt);
    let write = 0;
    for (let k = 0; k < n; k++) {
      const i = A[k];
      const st = this.state[i];
      if (st === 2) {
        // dying: ballistic tumble, then pop
        this.deathT[i] += dt;
        this.x[i] += this.kx[i] * dt; this.z[i] += this.kz[i] * dt;
        this.vy[i] -= 30 * dt; this.yo[i] += this.vy[i] * dt;
        this.rot[i] += this.spin[i] * dt;
        const gh = w.heightAt(this.x[i], this.z[i]);
        const wy = this.y[i] + this.yo[i];
        if (this.deathT[i] > 0.62 || (this.deathT[i] > 0.15 && wy < gh)) {
          g.onCorpsePop(i, this.type[i], this.x[i], Math.max(wy, gh) + 0.5, this.z[i]);
          this.state[i] = 0; this.free.push(i);
          continue;
        }
        A[write++] = i;
        continue;
      }
      if (st !== 1) continue;
      A[write++] = i;
      const ti = this.type[i];
      const def = TDEF[ti];
      let dx = px - this.x[i], dz = pz - this.z[i];
      const dist = Math.hypot(dx, dz) + 1e-5;
      dx /= dist; dz /= dist;
      let sp = this.spd[i] * (this.slow[i] > 0 ? 0.55 : 1);
      if (this.slow[i] > 0) this.slow[i] -= dt;
      this.ph[i] += dt * def.anim * (0.6 + sp * 0.12);
      if (this.flash[i] > 0) this.flash[i] -= dt * 7;
      if (this.hitCd[i] > 0) this.hitCd[i] -= dt;
      if (this.sawCd[i] > 0) this.sawCd[i] -= dt;
      if (this.ramCd[i] > 0) this.ramCd[i] -= dt;

      let mx = dx * sp, mz = dz * sp;
      if (ti === T.blob) { const hop = Math.max(0, Math.sin(this.ph[i])); mx *= 0.35 + hop * 1.3; mz *= 0.35 + hop * 1.3; }
      else if (ti === T.zippy) { const wig = Math.sin(this.ph[i] * 0.23 + i) * 0.6; mx += -dz * wig * sp; mz += dx * wig * sp; }
      else if (ti === T.spitter) {
        if (dist < 15) { mx *= -0.3; mz *= -0.3; }
        this.atk[i] -= dt;
        if (this.atk[i] <= 0 && dist < 26) { this.atk[i] = 2.6 + Math.random() * 1.2; this._spit(i, dist); }
      } else if (ti === T.boss) {
        this._bossAI(i, dt, t, dist, dx, dz);
        mx = this.vx[i]; mz = this.vz[i];
      }
      this.rot[i] = Math.atan2(dx, dz);

      // knockback impulse
      this.kx[i] *= kdecay; this.kz[i] *= kdecay;
      let nx = this.x[i] + (mx + this.kx[i]) * dt, nz = this.z[i] + (mz + this.kz[i]) * dt;

      // separation from neighbours (the horde "crowd" feel)
      const r = this.rad[i];
      const c = this.cellOf[i], ccx = (c / G) | 0, ccz = c % G;
      let sx = 0, sz = 0, cnt = 0;
      for (let ox = -1; ox <= 1 && cnt < 12; ox++) {
        const cx = ccx + ox; if (cx < 0 || cx >= G) continue;
        for (let oz = -1; oz <= 1 && cnt < 12; oz++) {
          const cz = ccz + oz; if (cz < 0 || cz >= G) continue;
          const cell = cx * G + cz;
          for (let q = this.cellStart[cell], e = this.cellStart[cell + 1]; q < e; q++) {
            const j = this.cellItems[q]; if (j === i) continue;
            const ex = this.x[i] - this.x[j], ez = this.z[i] - this.z[j];
            const rr = r + this.rad[j];
            const d2 = ex * ex + ez * ez;
            if (d2 < rr * rr) {
              const d = Math.sqrt(d2) + 1e-4, push = (rr - d) / d;
              const wgt = TDEF[this.type[j]].mass / (TDEF[this.type[j]].mass + def.mass);
              sx += ex * push * wgt; sz += ez * push * wgt; cnt++;
            }
          }
        }
      }
      if (cnt) { nx += sx * 0.5; nz += sz * 0.5; }

      // keep out of the player's body; handle contact
      const ex = nx - px, ez = nz - pz, ed = Math.hypot(ex, ez), minD = r + 0.55;
      const ey = (this.y[i] + this.yo[i]) - py;
      if (ed < minD + 0.25 && ey > -1.5 - (def.fly ? 1 : 0) && ey < 1.6 + r) {
        if (ram) {
          if (this.ramCd[i] <= 0) { this.ramCd[i] = 0.35; g.onRam(i, ex / (ed + 1e-4), ez / (ed + 1e-4)); }
        } else if (this.hitCd[i] <= 0) {
          this.hitCd[i] = 0.8; g.hurtPlayer(this.dmg[i], this.x[i], this.z[i]);
        }
      }
      if (ed < minD) { nx = px + ex / (ed + 1e-4) * minD; nz = pz + ez / (ed + 1e-4) * minD; }

      const rr0 = Math.hypot(nx, nz);
      if (rr0 > PLAY_R + 6) { nx *= (PLAY_R + 6) / rr0; nz *= (PLAY_R + 6) / rr0; }
      this.x[i] = nx; this.z[i] = nz;
      const gh = w.heightAt(nx, nz);
      if (def.fly) {
        const target = 2.2 + Math.sin(this.ph[i] * 0.3) * 0.8 + (dist < 5 ? -1.2 : 0);
        this.yo[i] += (target - this.yo[i]) * Math.min(1, dt * 3);
        this.y[i] = Math.max(gh, 0);
      } else {
        this.y[i] = gh;
        if (this.vy[i] !== 0 || this.yo[i] > 0) {
          this.vy[i] -= 30 * dt; this.yo[i] += this.vy[i] * dt;
          if (this.yo[i] <= 0 && this.vy[i] <= 0) { this.yo[i] = 0; this.vy[i] = 0; }
        }
      }
    }
    // keep anything spawned mid-update (boss summons) that was appended past n
    const extra = this.activeCount - n;
    for (let e = 0; e < extra; e++) A[write + e] = A[n + e];
    this.activeCount = write + extra;
    this._updateSpit(dt);
    this._updateShocks(dt);
  }

  _spit(i, dist) {
    const g = this.game, P = g.player.pos, V = g.player.vel;
    const k = this.pNext = (this.pNext + 1) % this.PMAX;
    const sx = this.x[i], sy = this.y[i] + 1.3 * this.scale[i], sz = this.z[i];
    const tt = clamp(dist / 14, 0.6, 1.6);
    const tx = P.x + V.x * tt * 0.5, tz = P.z + V.z * tt * 0.5, ty = P.y + 0.8;
    this.px[k] = sx; this.py[k] = sy; this.pz[k] = sz;
    this.pvx[k] = (tx - sx) / tt; this.pvz[k] = (tz - sz) / tt;
    this.pvy[k] = (ty - sy + 0.5 * 16 * tt * tt) / tt;
    this.plife[k] = 4; this.pdmg[k] = this.dmg[i];
    g.audio.play('shoot', { pitch: 0.5, volume: 0.35 });
  }

  _updateSpit(dt) {
    const g = this.game, P = g.player.pos;
    let c = 0;
    const te = this.spitMesh.instanceMatrix.array;
    for (let k = 0; k < this.PMAX; k++) {
      if (this.plife[k] <= 0) continue;
      this.plife[k] -= dt;
      this.pvy[k] -= 16 * dt;
      this.px[k] += this.pvx[k] * dt; this.py[k] += this.pvy[k] * dt; this.pz[k] += this.pvz[k] * dt;
      const dx = this.px[k] - P.x, dy = this.py[k] - (P.y + 0.9), dz = this.pz[k] - P.z;
      if (dx * dx + dy * dy + dz * dz < 1.1) { g.hurtPlayer(this.pdmg[k], this.px[k], this.pz[k]); this.plife[k] = 0; g.fx.burst(_v(this.px[k], this.py[k], this.pz[k]), '#FF8A1F', 8, { speed: 5 }); continue; }
      if (this.py[k] < this.world.heightAt(this.px[k], this.pz[k])) { this.plife[k] = 0; g.fx.burst(_v(this.px[k], this.py[k] + 0.2, this.pz[k]), '#FF8A1F', 6, { speed: 3 }); continue; }
      // orient the glob along its flight direction (droplets trail behind)
      const o = c * 16, s = 1.2, yaw = Math.atan2(this.pvx[k], this.pvz[k]), cy = Math.cos(yaw) * s, sy = Math.sin(yaw) * s;
      te[o] = cy; te[o + 1] = 0; te[o + 2] = -sy; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
      te[o + 8] = sy; te[o + 9] = 0; te[o + 10] = cy; te[o + 11] = 0; te[o + 12] = this.px[k]; te[o + 13] = this.py[k]; te[o + 14] = this.pz[k]; te[o + 15] = 1;
      c++;
    }
    this.spitMesh.count = c;
    this.spitMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- boss
  spawnBoss(x, z, num, hpMult) {
    const i = this.spawn(T.boss, x, z, { hpMult: hpMult, dmgMult: 1 + num * 0.3, scale: 1 + num * 0.15 });
    if (i < 0) return -1;
    this.boss = { i, num, mode: 'chase', t: 3, target: { x: 0, z: 0 }, name: ['KING CHONK', 'KING CHONK II: CHONKIER', 'EMPEROR MEGACHONK'][Math.min(num - 1, 2)] };
    return i;
  }

  _bossAI(i, dt, t, dist, dx, dz) {
    const b = this.boss; if (!b || b.i !== i) { this.vx[i] = dx * this.spd[i]; this.vz[i] = dz * this.spd[i]; return; }
    const g = this.game;
    b.t -= dt;
    const sp = this.spd[i] * (1 + b.num * 0.12);
    if (b.mode === 'chase') {
      this.vx[i] = dx * sp; this.vz[i] = dz * sp;
      if (b.t <= 0) {
        const r = Math.random();
        if (r < 0.45 || dist < 14) {
          b.mode = 'slamwind'; b.t = 1.1;
          g.fx.telegraph(_v(this.x[i], this.y[i] + 0.1, this.z[i]), 5.5 * this.scale[i], 1.1);
          g.audio.play('warning', { volume: 0.5 });
        } else if (r < 0.8) {
          b.mode = 'chargewind'; b.t = 0.9;
          b.target.x = dx; b.target.z = dz;
          const from = _v(this.x[i], this.y[i] + 1, this.z[i]);
          g.fx.beam(from, _v2(this.x[i] + dx * 30, this.y[i] + 1, this.z[i] + dz * 30), 2.2, '#ff2a2a', 0.9);
          g.audio.play('bossroar', { volume: 0.6, pitch: 1.3 });
        } else {
          b.mode = 'summon'; b.t = 1.2;
          g.audio.play('bossroar', { volume: 0.8 });
        }
      }
    } else if (b.mode === 'slamwind') {
      this.vx[i] = this.vz[i] = 0;
      this.scaleBump = 1;
      if (b.t <= 0) {
        this.shocks.push({ x: this.x[i], z: this.z[i], r: 2, speed: 17 + b.num * 2, max: 30, hit: false, dmg: this.dmg[i] * 0.9 });
        g.fx.ring(_v(this.x[i], this.y[i] + 0.3, this.z[i]), 30, '#ff5a2a', 30 / (17 + b.num * 2), 1.2);
        g.fx.burst(_v(this.x[i], this.y[i] + 0.5, this.z[i]), '#b08a6a', 40, { speed: 14, size: 0.35, up: 8 });
        g.shake(0.9); g.audio.play('bossslam');
        b.mode = 'chase'; b.t = 3.2 + Math.random() * 1.5;
      }
    } else if (b.mode === 'chargewind') {
      this.vx[i] = this.vz[i] = 0;
      if (b.t <= 0) { b.mode = 'charge'; b.t = 1.0; }
    } else if (b.mode === 'charge') {
      this.vx[i] = b.target.x * 27; this.vz[i] = b.target.z * 27;
      if ((t * 20 | 0) % 2 === 0) g.fx.dust(_v(this.x[i], this.y[i], this.z[i]), 2);
      if (b.t <= 0) { b.mode = 'chase'; b.t = 3 + Math.random() * 2; }
    } else if (b.mode === 'summon') {
      this.vx[i] = this.vz[i] = 0;
      if (b.t <= 0) {
        const n = 10 + b.num * 4;
        for (let k = 0; k < n; k++) {
          const a = k / n * Math.PI * 2;
          const sx = this.x[i] + Math.cos(a) * 7, sz = this.z[i] + Math.sin(a) * 7;
          const j = this.spawn(Math.random() < 0.5 ? T.goon : T.zippy, sx, sz, { hpMult: g.hpMult, dmgMult: g.dmgMult });
          if (j >= 0) g.fx.burst(_v(sx, this.world.heightAt(sx, sz) + 0.5, sz), '#B45CFF', 6);
        }
        b.mode = 'chase'; b.t = 3.5;
      }
    }
  }

  _updateShocks(dt) {
    const g = this.game, P = g.player.pos;
    for (let k = this.shocks.length - 1; k >= 0; k--) {
      const s = this.shocks[k];
      s.r += s.speed * dt;
      const d = Math.hypot(P.x - s.x, P.z - s.z);
      const grounded = g.player.onGround || (P.y - this.world.heightAt(P.x, P.z)) < 0.6;
      if (!s.hit && Math.abs(d - s.r) < 1.3 && grounded) { s.hit = true; g.hurtPlayer(s.dmg, s.x, s.z, true); }
      if (s.r > s.max) this.shocks.splice(k, 1);
    }
  }

  // ---------------------------------------------------------------- render
  render(t) {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    const mats = this.meshes.map(m => m.instanceMatrix.array);
    const anims = this.animAttr.map(a => a.array);
    const cols = this.colAttr.map(a => a.array);
    const n = this.activeCount, A = this.active;
    for (let k = 0; k < n; k++) {
      const i = A[k];
      const ti = this.type[i];
      const c = counts[ti]; if (c >= TDEF[ti].cap) continue;
      counts[ti] = c + 1;
      const dying = this.state[i] === 2;
      let s = this.scale[i];
      if (dying) s *= Math.max(0.2, 1 - this.deathT[i] * 0.8);
      const th = this.rot[i], cth = Math.cos(th), sth = Math.sin(th);
      const phi = dying ? this.rot[i] * 0 + this.deathT[i] * this.spin[i] : 0;
      const cph = Math.cos(phi), sph = Math.sin(phi);
      const te = mats[ti], o = c * 16;
      te[o] = cth * s; te[o + 1] = 0; te[o + 2] = -sth * s; te[o + 3] = 0;
      te[o + 4] = sth * sph * s; te[o + 5] = cph * s; te[o + 6] = cth * sph * s; te[o + 7] = 0;
      te[o + 8] = sth * cph * s; te[o + 9] = -sph * s; te[o + 10] = cth * cph * s; te[o + 11] = 0;
      te[o + 12] = this.x[i]; te[o + 13] = this.y[i] + this.yo[i]; te[o + 14] = this.z[i]; te[o + 15] = 1;
      const an = anims[ti], a = c * 4;
      an[a] = this.ph[i];
      an[a + 1] = dying ? 2.2 : 1;
      let sq = 0;
      if (ti === T.blob) sq = Math.sin(this.ph[i] * 2) * 0.16;
      else if (ti === T.boss) sq = Math.sin(t * 3) * 0.04 + (this.boss && this.boss.mode === 'slamwind' ? (1.1 - this.boss.t) * 0.25 : 0);
      an[a + 2] = sq;
      an[a + 3] = dying ? 0.6 : Math.max(0, this.flash[i]);
      const cl = cols[ti], ci = c * 3;
      if (this.elite[i]) { cl[ci] = 1.5; cl[ci + 1] = 1.2; cl[ci + 2] = 0.45; }
      else if (ti === T.boss && this.boss && this.boss.num > 1) { cl[ci] = this.boss.num === 2 ? 1.3 : 0.5; cl[ci + 1] = 0.7; cl[ci + 2] = this.boss.num === 2 ? 0.5 : 1.3; }
      else { cl[ci] = 1; cl[ci + 1] = 1; cl[ci + 2] = 1; }
    }
    for (let ti = 0; ti < this.meshes.length; ti++) {
      const m = this.meshes[ti];
      m.count = counts[ti];
      if (counts[ti]) {
        m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, counts[ti] * 16); m.instanceMatrix.needsUpdate = true;
        const an = this.animAttr[ti]; an.clearUpdateRanges(); an.addUpdateRange(0, counts[ti] * 4); an.needsUpdate = true;
        const cl = this.colAttr[ti]; cl.clearUpdateRanges(); cl.addUpdateRange(0, counts[ti] * 3); cl.needsUpdate = true;
      }
    }
  }
}

const _tv = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
let _ti = 0;
function _v(x, y, z) { _ti = (_ti + 1) & 3; return _tv[_ti].set(x, y, z); }
const _tv2 = new THREE.Vector3();
function _v2(x, y, z) { return _tv2.set(x, y, z); }
