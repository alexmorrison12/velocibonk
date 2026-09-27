// The raptor: momentum-first character controller (bhop, slide, slam, pads) + procedural animation.
import * as THREE from 'three';
import { buildPlayer } from './models.js';
import { clamp, lerp } from './rng.js';
import { PLAY_R } from './world.js';

const GRAV = 36;
const BASE_RUN = 9.5;
const JUMP_V = 13.2;
const _n = new THREE.Vector3();
const _col = { x: 0, z: 0, hit: false, nx: 0, nz: 0 };

function rotateToward(vx, vz, tx, tz, maxAngle) {
  // rotate vector (vx,vz) toward direction (tx,tz) by at most maxAngle, preserving length
  const len = Math.hypot(vx, vz); if (len < 1e-4) return [vx, vz];
  const a = Math.atan2(vx, vz), b = Math.atan2(tx, tz);
  let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
  const na = a + clamp(d, -maxAngle, maxAngle);
  return [Math.sin(na) * len, Math.cos(na) * len];
}

export class Player {
  constructor(scene, world) {
    this.world = world;
    const built = buildPlayer();
    this.model = built.root; this.parts = built.parts;
    this.model.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    scene.add(this.model);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.events = {};
    this.reset(0, 0);
  }

  reset(x, z) {
    this.pos.set(x, this.world.heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.onGround = true; this.coyote = 0; this.jumpBuffer = 0;
    this.jumpsUsed = 0; this.sliding = false; this.slamming = false;
    this.slideCd = 0; this.groundTime = 0; this.airTime = 0; this.bhopChain = 0;
    this.slamBounce = 0; this.lastVy = 0; this.facing = 0; this.animPhase = 0;
    this.maxFallSpeed = 0; this.dead = false; this.swingT = 1; this.lean = 0; this.squash = 0;
    this.stunT = 0;
  }

  get hSpeed() { return Math.hypot(this.vel.x, this.vel.z); }

  emit(name, a, b, c) { const f = this.events[name]; if (f) f(a, b, c); }

  update(dt, input, yaw, stats) {
    const w = this.world;
    const p = this.pos, v = this.vel;
    const runMax = BASE_RUN * stats.moveSpeed;
    // wish direction relative to camera yaw
    let ix = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let iz = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
    let wx = 0, wz = 0;
    if (ix || iz) {
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const rx = -Math.cos(yaw), rz = Math.sin(yaw);
      wx = fx * iz + rx * ix; wz = fz * iz + rz * ix;
      const l = Math.hypot(wx, wz); wx /= l; wz /= l;
    }
    const hasInput = !!(ix || iz);
    if (this.dead) { wx = wz = 0; }

    // tap OR hold space: holding auto-hops on landing (bhop is accessible; speed from it is soft-capped)
    if (input.jumpPressed || (input.jumpHeld && this.onGround)) this.jumpBuffer = 0.14;
    else this.jumpBuffer -= dt;
    this.slideCd -= dt; this.slamBounce -= dt; this.stunT -= dt;

    let hs = Math.hypot(v.x, v.z);
    if (this.onGround) {
      this.groundTime += dt;
      if (this.groundTime > 0.3) this.bhopChain = 0;
      // start / stop sliding
      const wantSlide = input.slide && !this.dead;
      if (wantSlide && !this.sliding) {
        this.sliding = true;
        if (this.slideCd <= 0 && hs > 5) { const k = (hs + 4.5) / hs; v.x *= k; v.z *= k; this.slideCd = 0.9; }
        if (hs < 1 && hasInput) { v.x = wx * 6; v.z = wz * 6; }
        this.emit('slide');
      } else if (!wantSlide) this.sliding = false;

      if (this.sliding) {
        w.normalAt(p.x, p.z, _n);
        // gravity along the slope: downhill acceleration
        const g = GRAV * 1.35;
        v.x += g * _n.y * _n.x * dt; v.z += g * _n.y * _n.z * dt;
        hs = Math.hypot(v.x, v.z);
        const fr = (2.2 + Math.max(0, hs - 45) * 0.6) * dt; // low friction, soft cap at silly speeds
        if (hs > fr) { v.x -= v.x / hs * fr; v.z -= v.z / hs * fr; } else { v.x = v.z = 0; }
        if (hasInput) { const r = rotateToward(v.x, v.z, wx, wz, 2.4 * dt); v.x = r[0]; v.z = r[1]; }
        if (Math.hypot(v.x, v.z) < 1.2 && !hasInput) this.sliding = false;
      } else {
        hs = Math.hypot(v.x, v.z);
        if (hs <= runMax + 0.01) {
          // normal running: accelerate toward the wish velocity
          const tx = wx * runMax, tz = wz * runMax;
          const accel = hasInput ? 75 : 45;
          const dx = tx - v.x, dz = tz - v.z, dl = Math.hypot(dx, dz), step = accel * dt;
          if (dl <= step) { v.x = tx; v.z = tz; } else { v.x += dx / dl * step; v.z += dz / dl * step; }
        } else {
          // overspeed: keep momentum but steer, and bleed speed unless you bhop/slide
          if (hasInput) { const r = rotateToward(v.x, v.z, wx, wz, 5.5 * dt); v.x = r[0]; v.z = r[1]; }
          const decay = (hasInput ? 7 : 22) * dt;
          const ns = Math.max(runMax, hs - decay);
          v.x *= ns / hs; v.z *= ns / hs;
        }
      }
    } else {
      this.airTime += dt;
      hs = Math.hypot(v.x, v.z);
      if (hasInput) {
        if (hs < runMax) {
          const step = 30 * dt; v.x += wx * step; v.z += wz * step;
          const n2 = Math.hypot(v.x, v.z); if (n2 > runMax) { v.x *= runMax / n2; v.z *= runMax / n2; }
        } else {
          const r = rotateToward(v.x, v.z, wx, wz, 2.6 * dt); v.x = r[0]; v.z = r[1];
        }
      }
      // air drag only at silly speeds
      if (hs > 60) { const k = 1 - 0.4 * dt; v.x *= k; v.z *= k; }
    }

    // ---- jumping
    const canGroundJump = this.onGround || this.coyote > 0;
    if (this.jumpBuffer > 0 && !this.dead) {
      if (canGroundJump) {
        this.jumpBuffer = 0;
        const bhop = this.groundTime < 0.12;
        let jv = JUMP_V * stats.jumpMult;
        if (this.slamBounce > 0) { jv *= 1.75; this.emit('superbounce'); this.slamBounce = 0; }
        v.y = Math.max(v.y, 0) * 0.3 + jv;
        if (bhop && hs > runMax * 0.8) {
          this.bhopChain++;
          // additive gain that fades out toward ~26 m/s: bhopping alone gets you to RAM speed,
          // going beyond that takes slopes, slams and pads
          const cap = 26 * Math.sqrt(stats.moveSpeed);
          const gain = Math.max(0, cap - hs) * (0.07 + Math.min(this.bhopChain, 10) * 0.004);
          if (gain > 0) { const k = (hs + gain) / hs; v.x *= k; v.z *= k; }
          this.emit('bhop', this.bhopChain);
        }
        this.onGround = false; this.coyote = 0; this.sliding = false;
        this.jumpsUsed = 0; this.airTime = 0.0001;
        this.emit('jump');
      } else if (this.jumpsUsed < stats.extraJumps) {
        this.jumpBuffer = 0;
        this.jumpsUsed++;
        v.y = JUMP_V * 0.92 * stats.jumpMult;
        // redirect horizontal momentum toward input (keeps speed) — lets you carve in the air
        if (hasInput) { const r = rotateToward(v.x, v.z, wx, wz, 1.2); v.x = r[0]; v.z = r[1]; if (Math.hypot(v.x, v.z) < 1) { v.x = wx * runMax; v.z = wz * runMax; } }
        this.slamming = false;
        this.emit('doublejump');
      }
    }

    // ---- slam
    if (!this.onGround && input.slidePressed && !this.slamming && !this.dead) {
      const hAbove = p.y - w.heightAt(p.x, p.z);
      if (hAbove > 1.2) { this.slamming = true; v.y = -52; this.emit('slamstart'); }
    }

    // ---- vertical integration with honest ground-following (lets you launch off crests)
    const oldGroundH = w.heightAt(p.x, p.z);
    if (this.onGround) {
      const nx = p.x + v.x * dt, nz = p.z + v.z * dt;
      const required = (w.heightAt(nx, nz) - oldGroundH) / dt;
      const allowed = this.lastVy - GRAV * dt * 1.15;
      if (required < allowed && Math.hypot(v.x, v.z) > 11) {
        // the ground falls away faster than gravity can pull us: airborne!
        this.onGround = false; this.coyote = 0.1; this.airTime = 0.0001; this.jumpsUsed = 0;
        v.y = allowed;
      } else {
        v.y = required;
      }
    } else if (!this.onGround) {
      v.y -= GRAV * dt * (v.y < 0 ? 1.15 : 1);
      if (v.y < -70) v.y = -70;
    }
    this.lastVy = v.y;
    if (!this.onGround) { this.coyote -= dt; this.maxFallSpeed = Math.max(this.maxFallSpeed, -v.y); }

    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;

    // ---- obstacles + boundary
    w.collide(p.x, p.z, 0.45, _col);
    if (_col.hit) {
      p.x = _col.x; p.z = _col.z;
      const dot = v.x * _col.nx + v.z * _col.nz;
      if (dot < 0) { v.x -= dot * _col.nx * 1.0; v.z -= dot * _col.nz * 1.0; }
    }
    const r = Math.hypot(p.x, p.z);
    if (r > PLAY_R) {
      const nx = p.x / r, nz = p.z / r;
      p.x = nx * PLAY_R; p.z = nz * PLAY_R;
      const dot = v.x * nx + v.z * nz; if (dot > 0) { v.x -= dot * nx * 1.6; v.z -= dot * nz * 1.6; }
    }

    // ---- ground contact
    const gh = w.heightAt(p.x, p.z);
    if (p.y <= gh) {
      p.y = gh;
      if (!this.onGround) {
        const fall = Math.max(-v.y, 0);
        const wasSlam = this.slamming;
        this.onGround = true; this.groundTime = 0; this.jumpsUsed = 0;
        if (wasSlam) {
          this.slamBounce = 0.3;
          // convert some slam energy into forward speed on slopes (slam + slide tech)
          w.normalAt(p.x, p.z, _n);
          const k = Math.min(fall, 60) * 0.35;
          v.x += _n.x * k; v.z += _n.z * k;
        }
        this.emit('land', fall, wasSlam, this.airTime);
        this.slamming = false; this.airTime = 0; this.maxFallSpeed = 0;
        this.squash = clamp(fall / 40, 0.1, 0.5);
        v.y = 0; this.lastVy = 0;
      }
    } else if (this.onGround && p.y > gh + 0.05) {
      p.y = gh; // tiny gaps: stay grounded
    }
    this.coyote = this.onGround ? 0.1 : this.coyote;

    // ---- pads
    for (const pad of w.pads) {
      if (pad.cd > 0) continue;
      const dx = p.x - pad.x, dz = p.z - pad.z;
      if (pad.kind === 'jump') {
        if (dx * dx + dz * dz < 1.7 * 1.7 && p.y - pad.y < 1.2) {
          v.y = 30; this.onGround = false; this.airTime = 0.0001; this.jumpsUsed = 0; this.slamming = false; this.sliding = false;
          const hs2 = Math.hypot(v.x, v.z);
          if (hs2 > 1) { const k = (hs2 + 7) / hs2; v.x *= k; v.z *= k; }
          pad.cd = 0.6; this.emit('pad', 'jump', pad);
        }
      } else {
        const along = dx * pad.dir.x + dz * pad.dir.z, side = -dx * pad.dir.z + dz * pad.dir.x;
        if (Math.abs(along) < 1.8 && Math.abs(side) < 1.2 && p.y - pad.y < 1.5) {
          const cur = v.x * pad.dir.x + v.z * pad.dir.z;
          const add = Math.max(0, Math.max(34, cur + 16) - cur);
          v.x += pad.dir.x * add; v.z += pad.dir.z * add;
          pad.cd = 0.8; this.emit('pad', 'boost', pad);
        }
      }
    }
  }

  // procedural animation of the model
  animate(dt, t, yaw) {
    const P = this.parts, m = this.model, v = this.vel;
    const hs = this.hSpeed;
    m.position.copy(this.pos);
    if (hs > 0.5) {
      const target = Math.atan2(v.x, v.z);
      let d = target - this.facing; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      this.lean = lerp(this.lean, clamp(d * 2.5, -0.5, 0.5), 1 - Math.exp(-8 * dt));
      this.facing += d * (1 - Math.exp(-14 * dt));
    } else this.lean = lerp(this.lean, 0, 1 - Math.exp(-6 * dt));
    m.rotation.y = this.facing;
    this.squash = Math.max(0, this.squash - dt * 2.5);
    const sq = this.squash;
    m.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);

    const run = this.onGround && !this.sliding ? Math.min(hs / 9, 1.6) : 0;
    this.animPhase += dt * (4 + hs * 0.9) * (this.onGround ? 1 : 0.3);
    const ph = this.animPhase;
    if (P.body) {
      P.body.rotation.z = -this.lean * 0.6;
      P.body.rotation.x = this.sliding ? -0.35 : this.onGround ? 0.12 * run + Math.sin(ph * 2) * 0.04 * run : (this.slamming ? 0.6 : -0.1);
      P.body.position.y = (P.body.userData.baseY ??= P.body.position.y) + (this.sliding ? -0.35 : Math.abs(Math.sin(ph)) * 0.08 * run);
    }
    const legSwing = this.onGround ? (this.sliding ? 0 : Math.sin(ph) * 0.9 * run) : 0;
    if (P.legL) P.legL.rotation.x = this.sliding ? -1.1 : this.onGround ? legSwing : (this.slamming ? 0.3 : -0.7);
    if (P.legR) P.legR.rotation.x = this.sliding ? -0.9 : this.onGround ? -legSwing : (this.slamming ? 0.3 : 0.4);
    if (P.armL) P.armL.rotation.x = this.onGround ? -legSwing * 0.6 : -1.2;
    if (P.armR) P.armR.rotation.x = this.onGround ? legSwing * 0.6 : -1.2;
    if (P.tail) { P.tail.rotation.y = Math.sin(ph) * 0.25 * run + this.lean * 0.6; P.tail.rotation.x = this.onGround ? -0.05 : 0.3; }
    if (P.head) P.head.rotation.x = Math.sin(ph * 2) * 0.05 * run + (this.slamming ? 0.4 : 0);
    // bat: rests on the shoulder, whips around in a full circle when the Bonker fires
    if (P.batPivot) {
      this.swingT = Math.min(1, this.swingT + dt / 0.26);
      if (this.swingT < 1) {
        const e = 1 - Math.pow(1 - this.swingT, 3);
        P.batPivot.rotation.set(0, -e * Math.PI * 2 + Math.PI * 0.5, 0);
      } else {
        P.batPivot.rotation.set(0, 0.6, 1.15);
      }
    }
  }

  swing() { this.swingT = 0; }
}
