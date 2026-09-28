// XP gems, gold coins and hearts: instanced, magnetized, chain-collected.
import * as THREE from 'three';
import { buildPickupGeometry, makeToonMaterial } from './models.js';

const KINDS = ['gem', 'coin', 'heart'];
const CAP = [2600, 500, 60];
const GEM_COLORS = [new THREE.Color('#38E8FF'), new THREE.Color('#6BFF6B'), new THREE.Color('#FF4FD8'), new THREE.Color('#FFC23D')];

export class Pickups {
  constructor(scene, world, game) {
    this.world = world; this.game = game;
    this.meshes = []; this.pools = [];
    KINDS.forEach((k, ki) => {
      const cap = CAP[ki];
      const geo = buildPickupGeometry(k);
      const mat = makeToonMaterial({ emissive: new THREE.Color(k === 'gem' ? '#1a6a80' : k === 'coin' ? '#7a5200' : '#800020'), emissiveIntensity: k === 'gem' ? 1.4 : 0.6 });
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.count = 0; mesh.frustumCulled = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.pools.push({
        cap, n: 0,
        x: new Float32Array(cap), y: new Float32Array(cap), z: new Float32Array(cap), vx: new Float32Array(cap), vy: new Float32Array(cap), vz: new Float32Array(cap),
        val: new Float32Array(cap), mag: new Uint8Array(cap), age: new Float32Array(cap),
      });
    });
    // XP gems get a glowing ground ring so they read against grass, snow and sand
    const ring = new THREE.RingGeometry(0.42, 0.7, 20).rotateX(-Math.PI / 2);
    this.halo = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0.85 }), CAP[0]);
    this.halo.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP[0] * 3).fill(1), 3);
    this.halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.halo.count = 0; this.halo.frustumCulled = false; this.halo.renderOrder = 1;
    scene.add(this.halo);
    this.combo = 0; this.comboT = 0;
  }

  reset() { for (const p of this.pools) p.n = 0; for (const m of this.meshes) m.count = 0; this.halo.count = 0; }

  _add(ki, x, y, z, val, burst = 3) {
    const p = this.pools[ki];
    if (p.n >= p.cap) {
      // pool full: fold the value into a random existing pickup (gems grow instead of vanishing)
      const j = (Math.random() * p.n) | 0; p.val[j] += val; return;
    }
    const i = p.n++;
    p.x[i] = x; p.y[i] = y; p.z[i] = z; p.val[i] = val; p.mag[i] = 0; p.age[i] = 0;
    const a = Math.random() * Math.PI * 2, s = Math.random() * burst;
    p.vx[i] = Math.cos(a) * s; p.vz[i] = Math.sin(a) * s; p.vy[i] = 4 + Math.random() * 3;
  }
  gem(x, y, z, val) { this._add(0, x, y, z, val); }
  coin(x, y, z, val = 1, burst = 3) { this._add(1, x, y, z, val, burst); }
  heart(x, y, z) { this._add(2, x, y, z, 25); }
  vacuum() { for (const p of this.pools) for (let i = 0; i < p.n; i++) p.mag[i] = 1; }

  update(dt, t) {
    const g = this.game, P = g.player.pos, w = this.world;
    const magR = (4.6 + Math.min(g.player.hSpeed, 40) * 0.06) * g.stats.magnet;
    this.comboT -= dt; if (this.comboT <= 0) this.combo = 0;
    for (let ki = 0; ki < 3; ki++) {
      const p = this.pools[ki], mesh = this.meshes[ki], te = mesh.instanceMatrix.array, cl = mesh.instanceColor.array;
      const ht = this.halo.instanceMatrix.array, hc = this.halo.instanceColor.array;
      let i = 0;
      while (i < p.n) {
        let gy = NaN;
        p.age[i] += dt;
        const dx = P.x - p.x[i], dy = (P.y + 0.8) - p.y[i], dz = P.z - p.z[i];
        const d2 = dx * dx + dz * dz;
        if (!p.mag[i] && d2 < magR * magR && p.age[i] > 0.25) p.mag[i] = 1;
        if (p.mag[i]) {
          const d = Math.sqrt(d2 + dy * dy) + 1e-4;
          const sp = 14 + p.age[i] * 10 + g.player.hSpeed;
          p.x[i] += dx / d * sp * dt; p.y[i] += dy / d * sp * dt; p.z[i] += dz / d * sp * dt;
          if (d < 1.1) {
            this._collect(ki, p.val[i]);
            // swap-remove
            const l = --p.n;
            p.x[i] = p.x[l]; p.y[i] = p.y[l]; p.z[i] = p.z[l]; p.vx[i] = p.vx[l]; p.vy[i] = p.vy[l]; p.vz[i] = p.vz[l];
            p.val[i] = p.val[l]; p.mag[i] = p.mag[l]; p.age[i] = p.age[l];
            continue;
          }
        } else {
          // settle on the ground after the pop
          const gh = w.heightAt(p.x[i], p.z[i]) + 0.45;
          gy = gh - 0.36;
          if (p.y[i] > gh || p.vy[i] > 0) {
            p.vy[i] -= 22 * dt;
            p.x[i] += p.vx[i] * dt; p.y[i] += p.vy[i] * dt; p.z[i] += p.vz[i] * dt;
            if (p.y[i] < gh) { p.y[i] = gh; p.vy[i] = 0; p.vx[i] *= 0.3; p.vz[i] *= 0.3; }
          } else p.y[i] = gh;
        }
        // render
        const v = p.val[i];
        const s = ki === 0 ? (v < 2 ? 1.3 : v < 5 ? 1.5 : v < 20 ? 1.75 : 2.2) : 1;
        const rot = t * (ki === 1 ? 3 : 1.6) + i;
        const c = Math.cos(rot) * s, sn = Math.sin(rot) * s;
        const bob = Math.sin(t * 3 + i) * 0.12;
        const o = i * 16;
        te[o] = c; te[o + 1] = 0; te[o + 2] = -sn; te[o + 3] = 0;
        te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
        te[o + 8] = sn; te[o + 9] = 0; te[o + 10] = c; te[o + 11] = 0;
        te[o + 12] = p.x[i]; te[o + 13] = p.y[i] + bob; te[o + 14] = p.z[i]; te[o + 15] = 1;
        if (ki === 0) {
          const gc = GEM_COLORS[v < 2 ? 0 : v < 5 ? 1 : v < 20 ? 2 : 3];
          cl[i * 3] = gc.r * 2.2; cl[i * 3 + 1] = gc.g * 2.2; cl[i * 3 + 2] = gc.b * 2.2;
          // halo: pulses, hidden while the gem is flying to you
          const hs = gy === gy ? s * (1 + 0.18 * Math.sin(t * 4 + i)) : 0;
          ht[o] = hs; ht[o + 1] = 0; ht[o + 2] = 0; ht[o + 3] = 0;
          ht[o + 4] = 0; ht[o + 5] = hs ? 1 : 0; ht[o + 6] = 0; ht[o + 7] = 0;
          ht[o + 8] = 0; ht[o + 9] = 0; ht[o + 10] = hs; ht[o + 11] = 0;
          ht[o + 12] = p.x[i]; ht[o + 13] = hs ? gy : -999; ht[o + 14] = p.z[i]; ht[o + 15] = 1;
          hc[i * 3] = gc.r * 0.9; hc[i * 3 + 1] = gc.g * 0.9; hc[i * 3 + 2] = gc.b * 0.9;
        }
        i++;
      }
      mesh.count = p.n;
      mesh.instanceMatrix.needsUpdate = true;
      if (ki === 0) {
        mesh.instanceColor.needsUpdate = true;
        this.halo.count = p.n; this.halo.instanceMatrix.needsUpdate = true; this.halo.instanceColor.needsUpdate = true;
      }
    }
  }

  _collect(ki, val) {
    const g = this.game;
    if (ki === 0) {
      g.addXp(val);
      this.combo++; this.comboT = 0.6;
      g.audio.play('gem', { combo: this.combo, volume: 0.5 });
    } else if (ki === 1) {
      g.addGold(val);
      g.audio.play('coin', { volume: 0.45 });
    } else {
      g.heal(val);
    }
  }

  // for the minimap / debugging
  get gemCount() { return this.pools[0].n; }
}
