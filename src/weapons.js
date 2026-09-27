// Auto-weapons. Every hit is multiplied by the player's live momentum — speed is damage.
import * as THREE from 'three';
import { buildProjectileGeometry, makeToonMaterial } from './models.js';
import { clamp } from './rng.js';

export const WEAPONS = {
  bat:     { name: 'The Bonker',    desc: 'A full-circle bat swing that yeets everything nearby.', max: 7 },
  pebble:  { name: 'Magic Pebbles', desc: 'Homing pebbles seek the nearest critters.', max: 7 },
  saw:     { name: 'Saw Buddies',   desc: 'Buzzsaws orbit you and shred on contact.', max: 7 },
  zap:     { name: 'Zeus Juice',    desc: 'Lightning that chains between enemies.', max: 7 },
  hotfeet: { name: 'Hot Feet',      desc: 'Leave a trail of fire. Faster = more fire.', max: 7 },
  banana:  { name: 'Bananarang',    desc: 'Piercing boomerang that comes back.', max: 7 },
  meteor:  { name: 'Sky Bonk',      desc: 'Calls meteors down on the horde.', max: 7 },
  aura:    { name: 'Stink Aura',    desc: 'A damaging cloud that slows enemies.', max: 7 },
  quake:   { name: 'Quake Boots',   desc: 'Landings unleash shockwaves. Higher falls hit harder.', max: 7 },
  lance:   { name: 'Sonic Lance',   desc: 'Piercing beam fired where you run. Scales with speed.', max: 7 },
};

// per-level scaling (L = 1..max)
export function weaponStats(id, L, s) {
  const lv = L - 1, area = s.area, ms = s.multishot;
  switch (id) {
    case 'bat': return { dmg: 26 * (1 + 0.32 * lv), cd: 1.15 * Math.pow(0.9, lv), r: (3.5 + 0.35 * lv) * area, knock: 16 + lv * 2 };
    case 'pebble': return { dmg: 14 * (1 + 0.26 * lv), cd: 0.85 * Math.pow(0.92, lv), n: 1 + Math.floor(L / 2) + ms, pierce: L >= 6 ? 2 : L >= 3 ? 1 : 0 };
    case 'saw': return { dmg: 10 * (1 + 0.26 * lv), n: 1 + L + ms, r: (2.9 + 0.2 * lv) * area, spin: 3.3 + 0.2 * lv, size: area };
    case 'zap': return { dmg: 24 * (1 + 0.28 * lv), cd: 1.45 * Math.pow(0.92, lv), chain: 2 + L, n: 1 + Math.floor(lv / 3) + ms, hop: 7 * area };
    case 'hotfeet': return { dmg: 8 * (1 + 0.3 * lv), r: 1.55 * area * (1 + 0.07 * lv), dur: 2.2 + 0.4 * lv };
    case 'banana': return { dmg: 18 * (1 + 0.27 * lv), cd: 1.7 * Math.pow(0.93, lv), n: 1 + Math.floor(L / 3) + ms, range: 13 + L };
    case 'meteor': return { dmg: 60 * (1 + 0.3 * lv), cd: 2.8 * Math.pow(0.92, lv), n: 1 + Math.floor(lv / 2) + ms, r: 3.8 * area * (1 + 0.07 * lv) };
    case 'aura': return { dmg: 6 * (1 + 0.28 * lv), r: (3.0 + 0.35 * lv) * area };
    case 'quake': return { dmg: 34 * (1 + 0.3 * lv), r: (4.8 + 0.6 * lv) * area };
    case 'lance': return { dmg: 10 * (1 + 0.25 * lv), cd: 1.25 * Math.pow(0.93, lv), len: 22 + 2 * L, w: 1.4 * area, n: 1 + ms };
  }
}

export function weaponUpgradeLines(id, L) {
  // text shown on the card when going from L to L+1
  const lines = {
    bat: ['+32% damage', '+0.35 m reach', '-10% cooldown'],
    pebble: L % 2 === 1 ? ['+1 pebble', '+26% damage'] : L === 2 || L === 5 ? ['+1 pierce', '+26% damage'] : ['+26% damage', '-8% cooldown'],
    saw: ['+1 saw', '+26% damage', 'faster spin'],
    zap: L % 3 === 0 ? ['+1 bolt', '+1 chain', '+28% damage'] : ['+1 chain', '+28% damage', '-8% cooldown'],
    hotfeet: ['+30% burn damage', 'bigger, longer fires'],
    banana: (L + 1) % 3 === 0 ? ['+1 bananarang', '+27% damage'] : ['+27% damage', '+1 m range', '-7% cooldown'],
    meteor: L % 2 === 0 ? ['+1 meteor', '+30% damage'] : ['+30% damage', 'bigger blast', '-8% cooldown'],
    aura: ['+28% damage', '+0.35 m radius'],
    quake: ['+30% damage', '+0.6 m shockwave'],
    lance: ['+25% damage', 'longer beam', '-7% cooldown'],
  };
  return lines[id];
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const hits = new Int32Array(4096);

export class Arsenal {
  constructor(scene, game) {
    this.game = game; this.scene = scene;
    this.list = [];
    // projectile pools
    const mk = (kind, cap, emissive, ei) => {
      const m = new THREE.InstancedMesh(buildProjectileGeometry(kind), makeToonMaterial({ emissive: new THREE.Color(emissive), emissiveIntensity: ei }), cap);
      m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(m); return m;
    };
    this.pebMesh = mk('pebble', 400, '#38E8FF', 2.2);
    this.banMesh = mk('banana', 60, '#6a5200', 0.4);
    this.sawMesh = mk('saw', 24, '#300', 0.2);
    this.metMesh = mk('meteor', 40, '#FF5A00', 1.2);
    this.peb = []; this.ban = []; this.met = []; this.fires = [];
    this.bangId = 1;
    // stink aura disc
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const grd = x.createRadialGradient(64, 64, 8, 64, 64, 64);
    grd.addColorStop(0, 'rgba(170,255,120,0.0)'); grd.addColorStop(0.55, 'rgba(150,255,90,0.35)'); grd.addColorStop(0.92, 'rgba(210,255,120,0.9)'); grd.addColorStop(1, 'rgba(210,255,120,0)');
    x.fillStyle = grd; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 9; i++) { x.fillStyle = 'rgba(120,200,60,0.25)'; x.beginPath(); x.arc(64 + Math.cos(i) * 34, 64 + Math.sin(i * 1.7) * 34, 10 + (i % 3) * 5, 0, 7); x.fill(); }
    const tex = new THREE.CanvasTexture(c);
    this.auraMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.7 }));
    this.auraMesh.visible = false; this.auraMesh.renderOrder = 2;
    scene.add(this.auraMesh);
    this.dmgBy = {};
  }

  reset() {
    this.list.length = 0; this.peb.length = 0; this.ban.length = 0; this.met.length = 0; this.fires.length = 0;
    this.pebMesh.count = this.banMesh.count = this.sawMesh.count = this.metMesh.count = 0;
    this.auraMesh.visible = false; this.distAcc = 0; this.auraT = 0; this.fireT = 0; this.sawAngle = 0;
    this.dmgBy = {};
  }

  get(id) { return this.list.find(w => w.id === id); }
  add(id, bonus = 0) { const w = { id, level: 1, bonus, t: 0.3 }; this.list.push(w); return w; }

  // helper: final damage for a weapon hit
  dmg(w, base) {
    const g = this.game;
    const crit = Math.random() < g.stats.crit;
    return [base * (1 + w.bonus) * g.stats.might * g.momentum * (crit ? 2 : 1), crit];
  }

  hit(i, w, base, dirX, dirZ, knock) {
    const [d, crit] = this.dmg(w, base);
    return this.game.enemies.damage(i, d, crit, dirX, dirZ, knock, w.id);
  }

  update(dt, t) {
    const g = this.game, E = g.enemies, P = g.player.pos, s = g.stats;
    const haste = s.haste;
    for (const w of this.list) {
      const st = weaponStats(w.id, w.level, s);
      if (st.cd) {
        w.t -= dt * haste;
        if (w.t > 0) continue;
      }
      switch (w.id) {
        case 'bat': {
          w.t = st.cd;
          const n = E.query(P.x, P.z, st.r, hits, 400);
          g.player.swing();
          g.fx.ring(_v.set(P.x, P.y + 0.6, P.z), st.r, '#FFE14D', 0.25, 0.5);
          g.audio.play('swing', { volume: 0.5 });
          let any = 0;
          for (let k = 0; k < n; k++) {
            const i = hits[k];
            const dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4;
            this.hit(i, w, st.dmg, dx / d, dz / d, st.knock * (0.6 + g.momentum * 0.4) * 2);
            any++;
          }
          if (any) { g.audio.play('bonk', { pitch: 0.9 + Math.random() * 0.25, volume: Math.min(1, 0.5 + any * 0.05) }); if (any > 6) g.shake(0.15); }
          break;
        }
        case 'pebble': {
          w.t = st.cd;
          let fired = 0;
          for (let k = 0; k < st.n; k++) {
            const tgt = E.nearest(P.x, P.z, 30, -1);
            if (tgt < 0) break;
            if (this.peb.length >= 380) break;
            const a = (k / st.n) * Math.PI * 2 + t;
            this.peb.push({ x: P.x, y: P.y + 1.4, z: P.z, vx: Math.cos(a) * 10, vy: 6, vz: Math.sin(a) * 10, tgt, life: 3, pierce: st.pierce, w, dmg: st.dmg, last: -1 });
            fired++;
          }
          if (fired) g.audio.play('shoot', { volume: 0.35, pitch: 1 + Math.random() * 0.2 });
          break;
        }
        case 'zap': {
          w.t = st.cd;
          let fired = 0;
          for (let b = 0; b < st.n; b++) {
            let cur = E.nearest(P.x, P.z, 20, -1);
            if (cur < 0) break;
            if (b > 0) { const n = E.query(P.x, P.z, 20, hits, 200); if (n) cur = hits[(Math.random() * n) | 0]; }
            _v.set(P.x, P.y + 1.6, P.z);
            const seen = new Set();
            for (let c = 0; c <= st.chain && cur >= 0; c++) {
              seen.add(cur);
              _v2.set(E.x[cur], E.y[cur] + E.yo[cur] + 0.7, E.z[cur]);
              g.fx.zap(_v, _v2);
              const dx = _v2.x - _v.x, dz = _v2.z - _v.z, d = Math.hypot(dx, dz) + 1e-4;
              this.hit(cur, w, st.dmg, dx / d, dz / d, 3);
              _v.copy(_v2);
              // next hop: nearest unseen enemy within hop radius
              const n = E.query(_v.x, _v.z, st.hop, hits, 64);
              let best = -1, bd = 1e9;
              for (let k = 0; k < n; k++) { const j = hits[k]; if (seen.has(j)) continue; const ddx = E.x[j] - _v.x, ddz = E.z[j] - _v.z, dd = ddx * ddx + ddz * ddz; if (dd < bd) { bd = dd; best = j; } }
              cur = best;
            }
            fired++;
          }
          if (fired) g.audio.play('zap', { volume: 0.45 });
          break;
        }
        case 'banana': {
          w.t = st.cd;
          const tgt = E.nearest(P.x, P.z, 26, -1);
          let ax, az;
          if (tgt >= 0) { ax = E.x[tgt] - P.x; az = E.z[tgt] - P.z; } else { ax = Math.sin(g.player.facing); az = Math.cos(g.player.facing); }
          const base = Math.atan2(ax, az);
          for (let k = 0; k < st.n; k++) {
            const a = base + (k - (st.n - 1) / 2) * 0.45;
            this.ban.push({ x: P.x, y: P.y + 1.1, z: P.z, dx: Math.sin(a), dz: Math.cos(a), d: 0, range: st.range, back: false, id: this.bangId++, w, dmg: st.dmg, spin: 0 });
          }
          g.audio.play('boomerang', { volume: 0.4 });
          break;
        }
        case 'meteor': {
          w.t = st.cd;
          const n = E.query(P.x, P.z, 26, hits, 800);
          if (!n) { w.t = 0.4; break; }
          for (let k = 0; k < st.n; k++) {
            const i = hits[(Math.random() * n) | 0];
            const x = E.x[i] + E.vx[i] * 0.3, z = E.z[i] + E.vz[i] * 0.3, y = g.world.heightAt(x, z);
            g.fx.telegraph(_v.set(x, y + 0.08, z), st.r, 0.55, '#FF7A1A');
            this.met.push({ x, y, z, t: 0.55, r: st.r, dmg: st.dmg, w });
          }
          break;
        }
        case 'lance': {
          w.t = st.cd;
          const v = g.player.vel;
          let dx = v.x, dz = v.z, l = Math.hypot(dx, dz);
          if (l < 2) { const tgt = E.nearest(P.x, P.z, 26, -1); if (tgt >= 0) { dx = E.x[tgt] - P.x; dz = E.z[tgt] - P.z; } else { dx = Math.sin(g.player.facing); dz = Math.cos(g.player.facing); } l = Math.hypot(dx, dz); }
          dx /= l; dz /= l;
          const speedBonus = g.player.hSpeed * 2.4;
          for (let k = 0; k < st.n; k++) {
            const a = Math.atan2(dx, dz) + (k - (st.n - 1) / 2) * 0.22;
            const ux = Math.sin(a), uz = Math.cos(a);
            _v.set(P.x, P.y + 1.1, P.z); _v2.set(P.x + ux * st.len, P.y + 1.1, P.z + uz * st.len);
            g.fx.beam(_v, _v2, st.w * 0.9, '#7df9ff', 0.28);
            const mx = P.x + ux * st.len / 2, mz = P.z + uz * st.len / 2;
            const n = E.query(mx, mz, st.len / 2 + st.w, hits, 600);
            for (let q = 0; q < n; q++) {
              const i = hits[q];
              const rx = E.x[i] - P.x, rz = E.z[i] - P.z;
              const along = rx * ux + rz * uz; if (along < 0 || along > st.len) continue;
              const perp = Math.abs(-rx * uz + rz * ux); if (perp > st.w + E.rad[i]) continue;
              this.hit(i, w, st.dmg + speedBonus, ux, uz, 8);
            }
          }
          g.audio.play('lance', { volume: 0.45 });
          break;
        }
        case 'saw': case 'aura': case 'hotfeet': case 'quake': break;
      }
    }
    this._updateSaws(dt, t);
    this._updateAura(dt, t);
    this._updateHotFeet(dt, t);
    this._updatePebbles(dt, t);
    this._updateBananas(dt, t);
    this._updateMeteors(dt, t);
  }

  _updateSaws(dt, t) {
    const w = this.get('saw'); const m = this.sawMesh;
    if (!w) { m.count = 0; return; }
    const g = this.game, E = g.enemies, P = g.player.pos;
    const st = weaponStats('saw', w.level, g.stats);
    this.sawAngle += dt * st.spin;
    const te = m.instanceMatrix.array;
    const n = Math.min(st.n, 24);
    for (let k = 0; k < n; k++) {
      const a = this.sawAngle + k / n * Math.PI * 2;
      const x = P.x + Math.cos(a) * st.r, z = P.z + Math.sin(a) * st.r, y = P.y + 0.9 + Math.sin(t * 4 + k) * 0.15;
      const s = st.size, spin = t * 18;
      const c = Math.cos(spin) * s, sn = Math.sin(spin) * s, o = k * 16;
      te[o] = c; te[o + 1] = 0; te[o + 2] = -sn; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
      te[o + 8] = sn; te[o + 9] = 0; te[o + 10] = c; te[o + 11] = 0; te[o + 12] = x; te[o + 13] = y; te[o + 14] = z; te[o + 15] = 1;
      const hn = E.query(x, z, 0.55 * s, hits, 32);
      for (let q = 0; q < hn; q++) {
        const i = hits[q]; if (E.sawCd[i] > 0) continue;
        E.sawCd[i] = 0.38;
        const tx = -Math.sin(a), tz = Math.cos(a);
        this.hit(i, w, st.dmg, tx, tz, 5);
        if (Math.random() < 0.3) g.audio.play('saw', { volume: 0.25 });
      }
    }
    m.count = n; m.instanceMatrix.needsUpdate = true;
  }

  _updateAura(dt, t) {
    const w = this.get('aura'); const m = this.auraMesh;
    if (!w) { m.visible = false; return; }
    const g = this.game, E = g.enemies, P = g.player.pos;
    const st = weaponStats('aura', w.level, g.stats);
    m.visible = true; m.position.set(P.x, P.y + 0.25, P.z); m.scale.setScalar(st.r); m.rotation.y = t * 0.8;
    m.material.opacity = 0.55 + Math.sin(t * 5) * 0.1;
    this.auraT -= dt;
    if (this.auraT > 0) return;
    this.auraT = 0.3 / g.stats.haste;
    const n = E.query(P.x, P.z, st.r, hits, 800);
    for (let k = 0; k < n; k++) {
      const i = hits[k]; E.slow[i] = 0.4;
      const dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4;
      this.hit(i, w, st.dmg, dx / d, dz / d, 0.5);
    }
  }

  _updateHotFeet(dt, t) {
    const w = this.get('hotfeet');
    const g = this.game, E = g.enemies, P = g.player.pos;
    if (w) {
      const st = weaponStats('hotfeet', w.level, g.stats);
      this.distAcc += g.player.hSpeed * dt;
      const spacing = 1.5;
      if (this.distAcc > spacing && P.y - g.world.heightAt(P.x, P.z) < 2.5) {
        this.distAcc = 0;
        const y = g.world.heightAt(P.x, P.z);
        if (this.fires.length > 160) this.fires.shift();
        this.fires.push({ x: P.x, y, z: P.z, t: st.dur, r: st.r, dmg: st.dmg, w });
        g.fx.fire(_v.set(P.x, y, P.z), st.r, st.dur);
      }
    }
    this.fireT -= dt;
    const tick = this.fireT <= 0;
    if (tick) this.fireT = 0.35;
    for (let k = this.fires.length - 1; k >= 0; k--) {
      const f = this.fires[k];
      f.t -= dt;
      if (f.t <= 0) { this.fires.splice(k, 1); continue; }
      if (!tick) continue;
      const n = E.query(f.x, f.z, f.r, hits, 64);
      for (let q = 0; q < n; q++) { const i = hits[q]; this.hit(i, f.w, f.dmg, 0, 0, 0); E.slow[i] = 0.3; }
    }
  }

  _updatePebbles(dt, t) {
    const g = this.game, E = g.enemies, m = this.pebMesh, te = m.instanceMatrix.array;
    let c = 0;
    for (let k = this.peb.length - 1; k >= 0; k--) {
      const p = this.peb[k];
      p.life -= dt;
      if (p.life <= 0) { this.peb[k] = this.peb[this.peb.length - 1]; this.peb.pop(); continue; }
      if (p.tgt < 0 || E.state[p.tgt] !== 1) p.tgt = E.nearest(p.x, p.z, 24, p.last);
      if (p.tgt >= 0) {
        const tx = E.x[p.tgt] - p.x, ty = (E.y[p.tgt] + E.yo[p.tgt] + 0.6) - p.y, tz = E.z[p.tgt] - p.z;
        const d = Math.hypot(tx, ty, tz) + 1e-4;
        const sp = 26;
        const steer = Math.min(1, dt * 7);
        p.vx += (tx / d * sp - p.vx) * steer; p.vy += (ty / d * sp - p.vy) * steer; p.vz += (tz / d * sp - p.vz) * steer;
        if (d < 0.6 + E.rad[p.tgt]) {
          this.hit(p.tgt, p.w, p.dmg, tx / d, tz / d, 4);
          g.fx.burst(_v.set(p.x, p.y, p.z), '#38E8FF', 4, { speed: 4, size: 0.1, life: 0.3 });
          p.last = p.tgt;
          if (p.pierce-- <= 0) { this.peb[k] = this.peb[this.peb.length - 1]; this.peb.pop(); continue; }
          p.tgt = -1;
        }
      } else { p.vy -= 10 * dt; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const o = c * 16, s = 1;
      te[o] = s; te[o + 1] = 0; te[o + 2] = 0; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
      te[o + 8] = 0; te[o + 9] = 0; te[o + 10] = s; te[o + 11] = 0; te[o + 12] = p.x; te[o + 13] = p.y; te[o + 14] = p.z; te[o + 15] = 1;
      c++;
    }
    m.count = c; m.instanceMatrix.needsUpdate = true;
  }

  _updateBananas(dt, t) {
    const g = this.game, E = g.enemies, P = g.player.pos, m = this.banMesh, te = m.instanceMatrix.array;
    let c = 0;
    for (let k = this.ban.length - 1; k >= 0; k--) {
      const b = this.ban[k];
      const sp = 24;
      if (!b.back) {
        b.x += b.dx * sp * dt; b.z += b.dz * sp * dt; b.d += sp * dt;
        if (b.d >= b.range) { b.back = true; b.id = this.bangId++; }
      } else {
        const tx = P.x - b.x, tz = P.z - b.z, d = Math.hypot(tx, tz) + 1e-4;
        const s2 = sp + g.player.hSpeed;
        b.x += tx / d * s2 * dt; b.z += tz / d * s2 * dt;
        if (d < 1.2) { this.ban[k] = this.ban[this.ban.length - 1]; this.ban.pop(); continue; }
      }
      b.y = g.world.heightAt(b.x, b.z) + 1.1;
      b.spin += dt * 20;
      const n = E.query(b.x, b.z, 0.9, hits, 64);
      for (let q = 0; q < n; q++) {
        const i = hits[q]; if (E.lastBang[i] === b.id) continue;
        E.lastBang[i] = b.id;
        this.hit(i, b.w, b.dmg, b.dx, b.dz, 6);
      }
      if (c < 60) {
        const o = c * 16, cs = Math.cos(b.spin), sn = Math.sin(b.spin);
        te[o] = cs; te[o + 1] = 0; te[o + 2] = -sn; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = 1; te[o + 6] = 0; te[o + 7] = 0;
        te[o + 8] = sn; te[o + 9] = 0; te[o + 10] = cs; te[o + 11] = 0; te[o + 12] = b.x; te[o + 13] = b.y; te[o + 14] = b.z; te[o + 15] = 1;
        c++;
      }
    }
    m.count = c; m.instanceMatrix.needsUpdate = true;
  }

  _updateMeteors(dt, t) {
    const g = this.game, E = g.enemies, m = this.metMesh, te = m.instanceMatrix.array;
    let c = 0;
    for (let k = this.met.length - 1; k >= 0; k--) {
      const mt = this.met[k];
      mt.t -= dt;
      if (mt.t <= 0) {
        _v.set(mt.x, mt.y + 0.4, mt.z);
        g.fx.ring(_v, mt.r * 1.2, '#FF9E2C', 0.4, 0.8);
        g.fx.burst(_v, '#FF7A1A', 22, { speed: 11, size: 0.3, up: 7 });
        g.fx.burst(_v, '#5a4636', 10, { speed: 7, size: 0.35, up: 5 });
        g.audio.play('explosion', { volume: 0.55, pitch: 0.9 + Math.random() * 0.2 });
        g.shake(0.12);
        const n = E.query(mt.x, mt.z, mt.r, hits, 800);
        for (let q = 0; q < n; q++) {
          const i = hits[q];
          const dx = E.x[i] - mt.x, dz = E.z[i] - mt.z, d = Math.hypot(dx, dz) + 1e-4;
          this.hit(i, mt.w, mt.dmg, dx / d, dz / d, 14);
        }
        this.met[k] = this.met[this.met.length - 1]; this.met.pop();
        continue;
      }
      if (c < 40) {
        const h = mt.t / 0.55;
        const o = c * 16, s = 1.1;
        te[o] = s; te[o + 1] = 0; te[o + 2] = 0; te[o + 3] = 0; te[o + 4] = 0; te[o + 5] = s; te[o + 6] = 0; te[o + 7] = 0;
        te[o + 8] = 0; te[o + 9] = 0; te[o + 10] = s; te[o + 11] = 0;
        te[o + 12] = mt.x + h * 8; te[o + 13] = mt.y + h * h * 34; te[o + 14] = mt.z - h * 6; te[o + 15] = 1;
        c++;
      }
    }
    m.count = c; m.instanceMatrix.needsUpdate = true;
  }

  onLand(fall, slam) {
    const w = this.get('quake');
    if (!w) return;
    if (fall < 9 && !slam) return;
    const g = this.game, E = g.enemies, P = g.player.pos;
    const st = weaponStats('quake', w.level, g.stats);
    const k = 1 + Math.min(fall, 70) / 25;
    const r = st.r * (slam ? 1.3 : 1);
    g.fx.ring(_v.set(P.x, P.y + 0.3, P.z), r, '#FFD23F', 0.4, 1);
    const n = E.query(P.x, P.z, r, hits, 800);
    for (let q = 0; q < n; q++) {
      const i = hits[q];
      const dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4;
      this.hit(i, w, st.dmg * k, dx / d, dz / d, 16);
    }
  }
}
