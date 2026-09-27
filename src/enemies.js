// The horde: data-oriented enemy simulation (typed arrays + spatial hash) rendered as GPU-animated
// instanced meshes. Limbs swing in the vertex shader, so thousands of critters cost a few draw calls.
// Enemies are re-skinned per biome; bosses are entities in the same arrays driven by bosses.js.
import * as THREE from 'three';
import * as M from './models.js';
import { clamp } from './rng.js';
import { PLAY_R } from './world.js';
import { Boss, BOSSES, WormBody } from './bosses.js';

export const TYPES = ['blob', 'goon', 'zippy', 'bat', 'spitter', 'brute', 'ghost', 'boss', 'tiki', 'yeti', 'worm', 'lich', 'dragon'];
export const T = Object.fromEntries(TYPES.map((t, i) => [t, i]));
const BIOME_SKINNED = new Set(['blob', 'goon', 'zippy', 'bat', 'spitter', 'brute', 'boss']);
export const TDEF = [
  /* blob    */ { hp: 14, speed: 3.5, dmg: 6, xp: 1, pts: 10, gold: 0.05, cap: 1800, anim: 7, color: '#FF4FA3', mass: 1 },
  /* goon    */ { hp: 28, speed: 4.4, dmg: 8, xp: 2, pts: 20, gold: 0.07, cap: 1400, anim: 9, color: '#8B5CF6', mass: 1.2 },
  /* zippy   */ { hp: 10, speed: 8.2, dmg: 5, xp: 1, pts: 12, gold: 0.05, cap: 900, anim: 18, color: '#FF5A36', mass: 0.6 },
  /* bat     */ { hp: 16, speed: 6.4, dmg: 8, xp: 2, pts: 20, gold: 0.07, cap: 600, anim: 6, color: '#6B4A9C', mass: 0.7, fly: true },
  /* spitter */ { hp: 36, speed: 2.9, dmg: 12, xp: 3, pts: 30, gold: 0.12, cap: 300, anim: 7, color: '#FF8A1F', mass: 1.5 },
  /* brute   */ { hp: 170, speed: 2.8, dmg: 22, xp: 8, pts: 80, gold: 0.35, cap: 300, anim: 4, color: '#5B6C9A', mass: 6 },
  /* ghost   */ { hp: 90, speed: 10.5, dmg: 18, xp: 0, pts: 60, gold: 0, cap: 600, anim: 5, color: '#9FEFFF', mass: 0.8, fly: true, ghost: true },
  /* boss    */ { hp: 3800, speed: 4.2, dmg: 30, xp: 160, pts: 5000, gold: 1, cap: 3, anim: 3, color: '#7B2FF7', mass: 1e9, boss: true },
  /* tiki    */ { hp: 15000, speed: 3.8, dmg: 34, xp: 450, pts: 25000, gold: 1, cap: 2, anim: 3, color: '#C98B4B', mass: 1e9, boss: true },
  /* yeti    */ { hp: 17000, speed: 4.3, dmg: 38, xp: 500, pts: 30000, gold: 1, cap: 2, anim: 3, color: '#CFE3F7', mass: 1e9, boss: true },
  /* worm    */ { hp: 19000, speed: 7.5, dmg: 40, xp: 550, pts: 35000, gold: 1, cap: 2, anim: 3, color: '#D9A05B', mass: 1e9, boss: true },
  /* lich    */ { hp: 20000, speed: 3.6, dmg: 42, xp: 600, pts: 40000, gold: 1, cap: 2, anim: 3, color: '#6BFF9A', mass: 1e9, boss: true, fly: true },
  /* dragon  */ { hp: 28000, speed: 4.5, dmg: 48, xp: 800, pts: 60000, gold: 1, cap: 2, anim: 3, color: '#FF5A1F', mass: 1e9, boss: true },
];
const MAX = 3200;
const G = 128, GC = 4, GH = G / 2; // spatial hash grid: 128x128 cells of 4 m

function patchMaterial(mat, key) {
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
          else if (aLimb < 5.5) { s = sin(ph * 2.0) * 0.8 * min(amp, 1.2); ax = 2; }
          else if (aLimb < 6.5) { s = -sin(ph * 2.0) * 0.8 * min(amp, 1.2); ax = 2; }
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
  mat.customProgramCacheKey = () => key;
  return mat;
}

function enemyGeo(type, biome) {
  try { return BIOME_SKINNED.has(type) ? M.buildEnemyGeometry(type, biome) : M.buildEnemyGeometry(type); }
  catch { return M.buildEnemyGeometry(type === 'ghost' ? 'bat' : BIOME_SKINNED.has(type) ? type : 'boss'); }
}

export class Enemies {
  constructor(scene, world, game) {
    this.scene = scene; this.world = world; this.game = game;
    this.T = T;
    const f = () => new Float32Array(MAX);
    this.x = f(); this.y = f(); this.z = f(); this.vx = f(); this.vz = f(); this.kx = f(); this.kz = f(); this.yo = f(); this.vy = f();
    this.hp = f(); this.maxHp = f(); this.spd = f(); this.dmg = f(); this.rad = f(); this.scale = f(); this.flash = f();
    this.ph = f(); this.rot = f(); this.deathT = f(); this.spin = f(); this.atk = f(); this.hitCd = f(); this.sawCd = f(); this.ramCd = f(); this.slow = f(); this.frz = f();
    this.type = new Uint8Array(MAX); this.state = new Uint8Array(MAX); this.elite = new Uint8Array(MAX);
    this.lastBang = new Int32Array(MAX);
    this.free = []; for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.active = new Int32Array(MAX); this.activeCount = 0;
    this.aliveCount = 0; this.countByType = new Int32Array(TYPES.length);
    this.cellCount = new Int32Array(G * G); this.cellStart = new Int32Array(G * G + 1); this.cellItems = new Int32Array(MAX); this.cellOf = new Int32Array(MAX);
    this.tmp = new Int32Array(G * G);
    this.meshes = []; this.animAttr = []; this.colAttr = [];
    this.material = patchMaterial(M.makeToonMaterial(), 'horde');
    this.ghostMaterial = patchMaterial(M.makeToonMaterial({ transparent: true, opacity: 0.72, depthWrite: false, blending: THREE.AdditiveBlending, emissive: new THREE.Color('#58D8FF'), emissiveIntensity: 0.7 }), 'horde-ghost');
    this.biome = 'tropical';
    TYPES.forEach((t, ti) => {
      const geo = enemyGeo(t, this.biome);
      const cap = TDEF[ti].cap;
      const mesh = new THREE.InstancedMesh(geo, t === 'ghost' ? this.ghostMaterial : this.material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); anim.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAnim', anim);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = t !== 'ghost'; mesh.receiveShadow = false;
      if (t === 'ghost') mesh.renderOrder = 3;
      scene.add(mesh);
      this.meshes.push(mesh); this.animAttr.push(anim); this.colAttr.push(mesh.instanceColor);
      TDEF[ti].radius = (geo.userData.radius || 0.5);
      TDEF[ti].height = (geo.userData.height || 1);
    });
    this.bosses = [];
    this.wormBody = new WormBody(scene);
  }

  // re-skin the horde for a biome (geometry swap; instance buffers are kept)
  setBiome(biome) {
    if (biome === this.biome) return;
    this.biome = biome;
    TYPES.forEach((t, ti) => {
      if (!BIOME_SKINNED.has(t)) return;
      const mesh = this.meshes[ti], old = mesh.geometry;
      const geo = enemyGeo(t, biome);
      geo.setAttribute('aAnim', this.animAttr[ti]);
      mesh.geometry = geo;
      old.dispose();
    });
  }

  reset() {
    this.free.length = 0; for (let i = MAX - 1; i >= 0; i--) this.free.push(i);
    this.state.fill(0); this.activeCount = 0; this.aliveCount = 0; this.countByType.fill(0);
    this.bosses.length = 0;
    for (const m of this.meshes) m.count = 0;
    this.wormBody.mesh.count = 0;
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
    this.vy[i] = d.fly || d.boss ? 0 : 9 + Math.random() * 2;
    // ground critters burst up out of the dirt instead of popping into existence
    this.yo[i] = d.fly ? (d.ghost ? 1.2 + Math.random() : 2.5 + Math.random() * 2) : (d.boss ? 0 : -1.4);
    const hpm = (o.hpMult || 1) * (elite ? 11 : 1);
    this.hp[i] = this.maxHp[i] = (o.hp || d.hp) * hpm;
    this.spd[i] = (o.speed || d.speed) * (o.speedMult || 1) * (elite ? 1.08 : 1) * (d.boss ? 1 : 0.9 + Math.random() * 0.2);
    this.dmg[i] = (o.dmg || d.dmg) * (o.dmgMult || 1) * (elite ? 1.6 : 1);
    this.scale[i] = (o.scale || 1) * (elite ? 1.75 : 1) * (d.boss ? 1 : 0.92 + Math.random() * 0.16);
    this.rad[i] = d.radius * this.scale[i];
    this.flash[i] = 0; this.ph[i] = Math.random() * 10; this.rot[i] = 0; this.atk[i] = 1 + Math.random() * 2;
    this.hitCd[i] = 0; this.sawCd[i] = 0; this.ramCd[i] = 0; this.slow[i] = 0; this.frz[i] = 0; this.lastBang[i] = -1;
    this.active[this.activeCount++] = i;
    this.aliveCount++; this.countByType[ti]++;
    return i;
  }

  // ---------------------------------------------------------------- bosses
  spawnBoss(id, x, z, o = {}) {
    const def = BOSSES[id];
    const ti = T[def.type];
    const i = this.spawn(ti, x, z, { hp: def.hp, dmg: def.dmg, speed: def.speed, hpMult: o.hpMult || 1, dmgMult: o.dmgMult || 1, scale: (def.scale || 1) * (o.scale || 1) });
    if (i < 0) return null;
    if (id === 'warlord') { this.elite[i] = 1; this.rad[i] = TDEF[ti].radius * this.scale[i]; }
    const b = new Boss(this.game, i, id, o);
    this.bosses.push(b);
    return b;
  }

  bossAt(i) { for (const b of this.bosses) if (b.i === i) return b; return null; }

  primaryBoss() {
    let best = null;
    for (const b of this.bosses) { if (!b.alive) continue; if (!best || (b.isFinal && !best.isFinal)) best = b; }
    return best;
  }

  // ---------------------------------------------------------------- damage
  damage(i, amount, crit, dirX, dirZ, knock, source) {
    if (this.state[i] !== 1) return 0;
    const ti = this.type[i], def = TDEF[ti];
    if (this.frz[i] > 0) amount *= 1.4;
    if (def.boss) amount *= this.game.bossDmgMult || 1;
    const dealt = Math.min(amount, this.hp[i]);
    this.hp[i] -= amount;
    this.flash[i] = 1;
    const g = this.game;
    g.onDamage(i, amount, crit, source, dealt);
    const mass = def.mass * (this.elite[i] ? 4 : 1);
    if (knock > 0 && !def.boss) {
      const k = knock / mass;
      this.kx[i] += dirX * k; this.kz[i] += dirZ * k;
      if (k > 6 && !def.fly) this.vy[i] = Math.max(this.vy[i], Math.min(k * 0.6, 9));
    }
    if (this.hp[i] <= 0) this.kill(i, dirX, dirZ, knock);
    return dealt;
  }

  kill(i, dirX, dirZ, force) {
    if (this.state[i] !== 1) return;
    this.state[i] = 2; this.deathT[i] = 0;
    this.aliveCount--; this.countByType[this.type[i]]--;
    const ti = this.type[i];
    const f = clamp(6 + force * 0.6, 6, 38) / Math.sqrt(Math.min(TDEF[ti].mass, 50));
    this.kx[i] = dirX * f; this.kz[i] = dirZ * f; this.vy[i] = 6 + Math.random() * 6 + Math.min(force * 0.25, 10);
    this.spin[i] = (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 10);
    if (TDEF[ti].boss) { this.kx[i] *= 0.1; this.kz[i] *= 0.1; this.vy[i] = 10; this.spin[i] *= 0.2; }
    const boss = TDEF[ti].boss || this.elite[i] ? this.bossAt(i) : null;
    this.game.onKill(i, ti, this.x[i], this.y[i] + this.yo[i], this.z[i], this.elite[i], boss);
    if (boss) this.bosses.splice(this.bosses.indexOf(boss), 1);
  }

  // kill everything in view in a satisfying chain (final boss defeated)
  purge() {
    let n = 0;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k];
      if (this.state[i] !== 1 || TDEF[this.type[i]].boss) continue;
      this.game.purgeKill?.(i);
      this.state[i] = 2; this.deathT[i] = -Math.random() * 0.9; this.aliveCount--; this.countByType[this.type[i]]--;
      this.kx[i] = (Math.random() - 0.5) * 8; this.kz[i] = (Math.random() - 0.5) * 8; this.vy[i] = 8 + Math.random() * 8; this.spin[i] = 10;
      n++;
    }
    return n;
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

  query(x, z, r, out, max = out.length) {
    let n = 0;
    const rb = r + 4; // big bosses: widen the cell scan
    const x0 = Math.max(0, Math.floor((x - rb) / GC) + GH), x1 = Math.min(G - 1, Math.floor((x + rb) / GC) + GH);
    const z0 = Math.max(0, Math.floor((z - rb) / GC) + GH), z1 = Math.min(G - 1, Math.floor((z + rb) / GC) + GH);
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
    for (const b of this.bosses) if (b.alive) b.update(dt, t);
    const px = P.x, pz = P.z, py = P.y;
    const ram = g.ramming;
    const kdecay = Math.exp(-5 * dt);
    let write = 0;
    for (let k = 0; k < n; k++) {
      const i = A[k];
      const st = this.state[i];
      if (st === 2) {
        this.deathT[i] += dt;
        if (this.deathT[i] < 0) { A[write++] = i; continue; } // purge stagger
        this.x[i] += this.kx[i] * dt; this.z[i] += this.kz[i] * dt;
        this.vy[i] -= 30 * dt; this.yo[i] += this.vy[i] * dt;
        this.rot[i] += this.spin[i] * dt;
        const gh = w.heightAt(this.x[i], this.z[i]);
        const wy = this.y[i] + this.yo[i];
        const life = TDEF[this.type[i]].boss ? 1.4 : 0.62;
        if (this.deathT[i] > life || (this.deathT[i] > 0.15 && wy < gh - 2)) {
          g.onCorpsePop(i, this.type[i], this.x[i], Math.max(wy, gh) + 0.5, this.z[i]);
          this.state[i] = 0; this.free.push(i);
          continue;
        }
        A[write++] = i;
        continue;
      }
      if (st === 3) { A[write++] = i; continue; } // hidden boss (burrowed / teleporting)
      if (st !== 1) continue;
      A[write++] = i;
      const ti = this.type[i];
      const def = TDEF[ti];
      let dx = px - this.x[i], dz = pz - this.z[i];
      const dist = Math.hypot(dx, dz) + 1e-5;
      dx /= dist; dz /= dist;
      if (this.flash[i] > 0) this.flash[i] -= dt * 7;
      if (this.hitCd[i] > 0) this.hitCd[i] -= dt;
      if (this.sawCd[i] > 0) this.sawCd[i] -= dt;
      if (this.ramCd[i] > 0) this.ramCd[i] -= dt;
      const frozen = this.frz[i] > 0;
      if (frozen) this.frz[i] -= dt;
      let sp = this.spd[i] * (this.slow[i] > 0 ? 0.55 : 1) * (def.ghost ? g.swarmSpeed || 1 : 1);
      if (frozen) sp = 0;
      if (this.slow[i] > 0) this.slow[i] -= dt;
      if (!frozen) this.ph[i] += dt * def.anim * (0.6 + sp * 0.12);

      let mx = dx * sp, mz = dz * sp;
      if (def.boss) {
        mx = this.vx[i]; mz = this.vz[i];
        if (Math.abs(mx) + Math.abs(mz) > 0.1) this.rot[i] = Math.atan2(mx, mz); else this.rot[i] = Math.atan2(dx, dz);
      } else {
        if (ti === T.blob) { const hop = Math.max(0, Math.sin(this.ph[i])); mx *= 0.35 + hop * 1.3; mz *= 0.35 + hop * 1.3; }
        else if (ti === T.zippy) { const wig = Math.sin(this.ph[i] * 0.23 + i) * 0.6; mx += -dz * wig * sp; mz += dx * wig * sp; }
        else if (ti === T.spitter) {
          if (dist < 15) { mx *= -0.3; mz *= -0.3; }
          this.atk[i] -= dt;
          if (this.atk[i] <= 0 && dist < 26 && !frozen) { this.atk[i] = 2.6 + Math.random() * 1.2; this._spit(i, dist); }
        } else if (ti === T.brute && this.elite[i] && this.bossAt(i)) { mx = this.vx[i]; mz = this.vz[i]; }
        this.rot[i] = Math.atan2(dx, dz);
      }

      this.kx[i] *= kdecay; this.kz[i] *= kdecay;
      let nx = this.x[i] + (mx + this.kx[i]) * dt, nz = this.z[i] + (mz + this.kz[i]) * dt;

      // separation from neighbours (ghosts drift through everything)
      const r = this.rad[i];
      if (!def.ghost) {
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
                const mj = Math.min(TDEF[this.type[j]].mass, 1e4), mi = Math.min(def.mass, 1e4);
                const wgt = mj / (mj + mi);
                sx += ex * push * wgt; sz += ez * push * wgt; cnt++;
              }
            }
          }
        }
        if (cnt) { nx += sx * 0.5; nz += sz * 0.5; }
      }

      // keep out of the player's body; handle contact
      const ex = nx - px, ez = nz - pz, ed = Math.hypot(ex, ez), minD = r + 0.55;
      const ey = (this.y[i] + this.yo[i]) - py;
      const vert = def.boss ? (ey > -2 && ey < TDEF[ti].height * this.scale[i]) : (ey > -1.5 - (def.fly ? 1 : 0) && ey < 1.6 + r);
      if (ed < minD + 0.25 && vert) {
        if (ram && !def.boss) {
          if (this.ramCd[i] <= 0) { this.ramCd[i] = 0.35; g.onRam(i, ex / (ed + 1e-4), ez / (ed + 1e-4)); }
        } else if (this.hitCd[i] <= 0 && !frozen) {
          this.hitCd[i] = 0.8; g.hurtPlayer(this.dmg[i], this.x[i], this.z[i]);
          if (ram && def.boss && this.ramCd[i] <= 0) { this.ramCd[i] = 0.5; g.onRam(i, ex / (ed + 1e-4), ez / (ed + 1e-4)); }
        }
      }
      if (ed < minD && !def.boss && !def.ghost) { nx = px + ex / (ed + 1e-4) * minD; nz = pz + ez / (ed + 1e-4) * minD; }

      const rr0 = Math.hypot(nx, nz);
      if (rr0 > PLAY_R + 6) { nx *= (PLAY_R + 6) / rr0; nz *= (PLAY_R + 6) / rr0; }
      this.x[i] = nx; this.z[i] = nz;
      const gh = w.heightAt(nx, nz);
      if (def.boss) this.y[i] = Math.max(gh, def.fly ? 0 : -50);
      else if (def.fly) {
        const target = def.ghost ? 1.3 + Math.sin(this.ph[i] * 0.4) * 0.6 : 2.2 + Math.sin(this.ph[i] * 0.3) * 0.8 + (dist < 5 ? -1.2 : 0);
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
    const extra = this.activeCount - n;
    for (let e = 0; e < extra; e++) A[write + e] = A[n + e];
    this.activeCount = write + extra;
  }

  _spit(i, dist) {
    const g = this.game, P = g.player.pos, V = g.player.vel;
    const sx = this.x[i], sy = this.y[i] + 1.3 * this.scale[i], sz = this.z[i];
    const tt = clamp(dist / 14, 0.6, 1.6);
    const tx = P.x + V.x * tt * 0.5, tz = P.z + V.z * tt * 0.5, ty = P.y + 0.8;
    g.hazards.lob('spit', sx, sy, sz, tx, ty, tz, tt, this.dmg[i], { grav: 16, rad: 0.55 });
    g.audio.play('shoot', { pitch: 0.5, volume: 0.35 });
  }

  // ---------------------------------------------------------------- render
  render(t) {
    const counts = this._counts || (this._counts = new Int32Array(TYPES.length));
    counts.fill(0);
    const n = this.activeCount, A = this.active;
    for (let k = 0; k < n; k++) {
      const i = A[k];
      const st = this.state[i];
      if (st === 3) continue;
      const ti = this.type[i];
      const c = counts[ti]; if (c >= TDEF[ti].cap) continue;
      counts[ti] = c + 1;
      const waiting = st === 2 && this.deathT[i] < 0; // purge stagger: flash in place, then pop
      const dying = st === 2 && !waiting;
      const def = TDEF[ti];
      let s = this.scale[i];
      if (dying) s *= Math.max(0.2, 1 - this.deathT[i] * (def.boss ? 0.5 : 0.8));
      const th = this.rot[i], cth = Math.cos(th), sth = Math.sin(th);
      const phi = dying ? this.deathT[i] * this.spin[i] : 0;
      const cph = Math.cos(phi), sph = Math.sin(phi);
      const te = this.meshes[ti].instanceMatrix.array, o = c * 16;
      te[o] = cth * s; te[o + 1] = 0; te[o + 2] = -sth * s; te[o + 3] = 0;
      te[o + 4] = sth * sph * s; te[o + 5] = cph * s; te[o + 6] = cth * sph * s; te[o + 7] = 0;
      te[o + 8] = sth * cph * s; te[o + 9] = -sph * s; te[o + 10] = cth * cph * s; te[o + 11] = 0;
      te[o + 12] = this.x[i]; te[o + 13] = this.y[i] + this.yo[i]; te[o + 14] = this.z[i]; te[o + 15] = 1;
      const an = this.animAttr[ti].array, a = c * 4;
      an[a] = this.ph[i];
      an[a + 1] = dying ? 2.2 : ti === T.dragon ? 0.42 : def.boss ? 0.7 : 1; // big bodies move with weight
      let sq = 0;
      if (ti === T.blob) sq = Math.sin(this.ph[i] * 2) * 0.16;
      else if (def.boss) { const b = this.bossAt(i); sq = Math.sin(t * 3) * 0.035 + (b ? b.squash || 0 : 0); }
      an[a + 2] = sq;
      an[a + 3] = waiting ? 0.5 + 0.5 * Math.sin(t * 30 + i) : dying ? 0.6 : Math.max(0, this.flash[i]);
      const cl = this.colAttr[ti].array, ci = c * 3;
      if (this.frz[i] > 0) { cl[ci] = 0.55; cl[ci + 1] = 0.95; cl[ci + 2] = 1.7; }
      else if (this.elite[i]) { cl[ci] = 1.5; cl[ci + 1] = 1.2; cl[ci + 2] = 0.45; }
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
    let worm = null;
    for (const b of this.bosses) if (b.id === 'worm' && b.alive) worm = b;
    this.wormBody.render(worm);
  }
}
