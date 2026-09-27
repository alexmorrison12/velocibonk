// VELOCIBONK: fx.js
// Pooled, allocation-free VFX (particles, damage numbers, rings, telegraphs, lightning,
// beams, text popups, speed trail, fire) and the post-processing stack (bloom + SpeedFX).
//
// Design notes
//  - Most effects are "fire and forget" GPU-animated: spawn writes a few floats into a ring
//    buffer (uploaded with addUpdateRange), the vertex shader derives everything else from
//    (uTime - spawnTime). Zero per-frame CPU cost per live effect.
//  - Shard particles are CPU-simulated (gravity, drag, spin, floor bounce) in packed SoA
//    arrays (swap-remove), one InstancedMesh draw.
//  - Damage numbers + pop texts live in `fx.overlay` (a separate THREE.Scene, registered on
//    scene.userData.fxOverlay). PostFX renders it after tone mapping, so the text stays crisp,
//    true white, and is not bloomed or distorted by chromatic aberration.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});
const rand = Math.random;
const CULL = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const bigSphere = () => new THREE.Sphere(new THREE.Vector3(), 1e6);

// ---------------------------------------------------------------------------------------------
// Color cache: hex strings / numbers are parsed once (Color.setStyle allocates).
const _colorCache = new Map();
function colorOf(c, fallback) {
  if (c === undefined || c === null) c = fallback;
  if (c && c.isColor) return c;
  let col = _colorCache.get(c);
  if (col === undefined) {
    col = new THREE.Color(0xffffff);
    if (typeof c === 'number' || typeof c === 'string') col.set(c);
    if (_colorCache.size > 256) _colorCache.clear();
    _colorCache.set(c, col);
  }
  return col;
}

// ---------------------------------------------------------------------------------------------
// Ring buffer of instance records in one interleaved Float32Array; O(1) alloc, dirty-range upload.
class GpuRing {
  constructor(cap, stride, instanced = true) {
    this.cap = cap;
    this.stride = stride;
    this.array = new Float32Array(cap * stride);
    this.buffer = instanced
      ? new THREE.InstancedInterleavedBuffer(this.array, stride, 1)
      : new THREE.InterleavedBuffer(this.array, stride);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.cursor = 0;
    this.used = 0; // high-water mark -> instanceCount / drawRange
    this.a0 = -1; this.a1 = -1; this.b0 = -1; this.b1 = -1; // up to two dirty segments per frame
    this.until = -1e9; // clock time when the last live record expires (then the family stops drawing)
  }
  touch(t) { if (t > this.until) this.until = t; }
  attr(size, offset) { return new THREE.InterleavedBufferAttribute(this.buffer, size, offset); }
  alloc(n) { // n contiguous records; wraps to 0 (never splits a record group)
    if (this.cursor + n > this.cap) this.cursor = 0;
    const s = this.cursor, e = s + n;
    this.cursor = e;
    if (e > this.used) this.used = e;
    if (this.a0 < 0) { this.a0 = s; this.a1 = e; }
    else if (s === this.a1) this.a1 = e;
    else if (this.b0 < 0) { this.b0 = s; this.b1 = e; }
    else if (s === this.b1) this.b1 = e;
    else { this.a0 = Math.min(this.a0, this.b0, s); this.a1 = Math.max(this.a1, this.b1, e); this.b0 = this.b1 = -1; }
    return s;
  }
  flush() {
    if (this.a0 < 0) return;
    const b = this.buffer, st = this.stride;
    if (b.updateRanges.length > 8) { // not rendered for a while: collapse to one range
      b.clearUpdateRanges();
      b.addUpdateRange(0, this.used * st);
    } else {
      b.addUpdateRange(this.a0 * st, (this.a1 - this.a0) * st);
      if (this.b0 >= 0) b.addUpdateRange(this.b0 * st, (this.b1 - this.b0) * st);
    }
    b.needsUpdate = true;
    this.a0 = this.a1 = this.b0 = this.b1 = -1;
  }
  reset() { this.cursor = 0; this.used = 0; this.a0 = this.a1 = this.b0 = this.b1 = -1; this.until = -1e9; }
}

function fxMaterial(vertexShader, fragmentShader, uniforms, additive, depthTest = true) {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms,
    transparent: true, depthWrite: false, depthTest,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

function instancedQuad(half = 1, xz = false) {
  const g = new THREE.InstancedBufferGeometry();
  const h = half;
  const pos = xz ? [-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h] : [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  g.boundingSphere = bigSphere();
  return g;
}

function ringMesh(parent, geo, mat, ring, layout, renderOrder) {
  let off = 0;
  for (const [name, size] of layout) { geo.setAttribute(name, ring.attr(size, off)); off += size; }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  parent.add(mesh);
  return mesh;
}

function syncRing(ring, mesh, now) {
  ring.flush();
  if (ring.used > 0 && now > ring.until) ring.reset(); // everything expired: stop drawing, restart at slot 0
  mesh.geometry.instanceCount = ring.used;
  mesh.visible = ring.used > 0;
}

// =============================================================================================
// Shards: CPU-simulated flat-shaded tetrahedra, one InstancedMesh, packed live set.
class Shards {
  constructor(parent, cap = 5000) {
    this.cap = cap;
    this.n = 0;
    this.over = 0;
    const geo = new THREE.TetrahedronGeometry(1, 0);
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
    mat.onBeforeCompile = (sh) => {
      // Partially self-lit so shards pop in shadow / sunset light; colors > 1 (glow) will bloom.
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.45;'
      );
    };
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    parent.add(mesh);
    this.mesh = mesh;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.kx = f(); this.ky = f(); this.kz = f(); // spin axis
    this.ang = f(); this.w = f();
    this.size = f(); this.flat = f();
    this.life = f(); this.maxLife = f();
    this.drag = f(); this.grav = f(); this.floor = f();
    this.cLo = cap; this.cHi = -1;
  }

  spawn(x, y, z, vx, vy, vz, size, life, grav, drag, floor, flat, r, g, b) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else { i = this.over; this.over = (this.over + 1) % this.cap; } // full: steal (O(1))
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    const u = rand() * 2 - 1, th = rand() * TAU, sr = Math.sqrt(1 - u * u);
    this.kx[i] = sr * Math.cos(th); this.ky[i] = u; this.kz[i] = sr * Math.sin(th);
    this.ang[i] = rand() * TAU;
    this.w[i] = (rand() * 2 - 1) * 16;
    this.size[i] = size; this.flat[i] = flat;
    this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = grav; this.drag[i] = drag; this.floor[i] = floor;
    const c = this.mesh.instanceColor.array, o = i * 3;
    c[o] = r; c[o + 1] = g; c[o + 2] = b;
    if (i < this.cLo) this.cLo = i;
    if (i > this.cHi) this.cHi = i;
  }

  _move(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.kx[to] = this.kx[from]; this.ky[to] = this.ky[from]; this.kz[to] = this.kz[from];
    this.ang[to] = this.ang[from]; this.w[to] = this.w[from];
    this.size[to] = this.size[from]; this.flat[to] = this.flat[from];
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from]; this.floor[to] = this.floor[from];
    const c = this.mesh.instanceColor.array, a = from * 3, b = to * 3;
    c[b] = c[a]; c[b + 1] = c[a + 1]; c[b + 2] = c[a + 2];
    if (to < this.cLo) this.cLo = to;
    if (to > this.cHi) this.cHi = to;
  }

  update(dt) {
    let n = this.n;
    const mesh = this.mesh;
    if (n === 0) { mesh.visible = false; mesh.count = 0; this.cLo = this.cap; this.cHi = -1; return; }
    const m = mesh.instanceMatrix.array;
    const { px, py, pz, vx, vy, vz, kx, ky, kz, ang, w, size, flat, life, maxLife, drag, grav, floor } = this;
    let i = 0;
    while (i < n) {
      const l = life[i] - dt;
      if (l <= 0) {
        n--;
        if (i !== n) this._move(n, i);
        if (this.over >= n) this.over = 0;
        continue; // process the moved-in particle at index i
      }
      life[i] = l;
      const dr = 1 / (1 + drag[i] * dt);
      let nvx = vx[i] * dr, nvy = (vy[i] - grav[i] * dt) * dr, nvz = vz[i] * dr;
      const x = px[i] + nvx * dt, z = pz[i] + nvz * dt;
      let y = py[i] + nvy * dt;
      let wi = w[i];
      const fl = floor[i];
      if (y < fl) {
        y = fl;
        if (nvy < 0) { nvy = -nvy * 0.32; nvx *= 0.6; nvz *= 0.6; wi *= 0.6; w[i] = wi; }
      }
      px[i] = x; py[i] = y; pz[i] = z; vx[i] = nvx; vy[i] = nvy; vz[i] = nvz;
      const a = ang[i] + wi * dt;
      ang[i] = a;
      // pop-in then shrink-out over the last 40% of life
      const ml = maxLife[i], age = ml - l, lf = l / ml;
      const fin = age < 0.06 ? 0.35 + age * (0.65 / 0.06) : 1;
      let fo = lf < 0.4 ? lf / 0.4 : 1;
      fo = fo * fo * (3 - 2 * fo);
      const s = size[i] * fin * fo, sy = s * flat[i];
      const c = Math.cos(a), sn = Math.sin(a), t = 1 - c;
      const ax = kx[i], ay = ky[i], az = kz[i];
      const o = i * 16;
      m[o] = (c + ax * ax * t) * s; m[o + 1] = (ay * ax * t + az * sn) * s; m[o + 2] = (az * ax * t - ay * sn) * s; m[o + 3] = 0;
      m[o + 4] = (ax * ay * t - az * sn) * sy; m[o + 5] = (c + ay * ay * t) * sy; m[o + 6] = (az * ay * t + ax * sn) * sy; m[o + 7] = 0;
      m[o + 8] = (ax * az * t + ay * sn) * s; m[o + 9] = (ay * az * t - ax * sn) * s; m[o + 10] = (c + az * az * t) * s; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
      i++;
    }
    this.n = n;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      const im = mesh.instanceMatrix;
      im.clearUpdateRanges(); // every live matrix is rewritten each frame
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      let lo = this.cLo, hi = Math.min(this.cHi, n - 1);
      if (lo <= hi) {
        const ic = mesh.instanceColor;
        if (ic.updateRanges.length > 8) { ic.clearUpdateRanges(); lo = 0; hi = n - 1; }
        ic.addUpdateRange(lo * 3, (hi - lo + 1) * 3);
        ic.needsUpdate = true;
      }
    }
    this.cLo = this.cap; this.cHi = -1;
  }

  clear() { this.n = 0; this.over = 0; this.mesh.count = 0; this.mesh.visible = false; this.cLo = this.cap; this.cHi = -1; }
}

// =============================================================================================
// Shaders (GPU-animated families). Every family shares the same uTime uniform object.
const DUST_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // origin.xyz, spawn
attribute vec4 aB; // velocity.xyz, life
attribute vec4 aC; // color.rgb, size
varying vec3 vWorld;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aA.w;
  float life = aB.w;
  if (age < 0.0 || age >= life) { ${CULL} }
  float t = age / life;
  vec3 c = aA.xyz + aB.xyz * ((1.0 - exp(-3.2 * age)) / 3.2) + vec3(0.0, 0.3 * age, 0.0);
  float s = aC.w * (0.35 + 0.65 * (1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t)));
  float h = fract(sin(dot(aA.xyz + aA.w, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float an = h * 6.2831853 + age * (h - 0.5) * 3.0;
  float cs = cos(an);
  float sn = sin(an);
  vec3 p = position * s;
  p = vec3(cs * p.x - sn * p.z, p.y * 0.8, sn * p.x + cs * p.z);
  vec3 wp = c + p;
  vWorld = wp;
  vColor = aC.rgb;
  vAlpha = 0.75 * smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.25, 1.0, t));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const DUST_FS = /* glsl */`
varying vec3 vWorld;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float l = 0.66 + 0.34 * max(dot(n, vec3(0.37, 0.84, 0.4)), 0.0);
  gl_FragColor = vec4(vColor * l, vAlpha);
  #include <colorspace_fragment>
}`;

const NUM_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // origin.xyz, spawn
attribute vec4 aB; // glyph, x offset (em), size (m/em), drift (m)
attribute vec4 aC; // color.rgb, life
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aA.w;
  float life = aC.w;
  if (age < 0.0 || age >= life) { ${CULL} }
  float t = age / life;
  float p = clamp(age / 0.12, 0.0, 1.0);
  float q = 1.0 - 2.0 * p;
  float pop = p < 0.5 ? 1.35 * (1.0 - q * q) : mix(1.35, 1.0, smoothstep(0.0, 1.0, p * 2.0 - 1.0));
  float dist = length(aA.xyz - cameraPosition);
  float df = mix(1.0, dist / 12.0, 0.5);
  float it = 1.0 - t;
  float rise = 1.2 * (1.0 - it * it * it);
  vec4 mv = viewMatrix * vec4(aA.xyz + vec3(0.0, rise * df, 0.0), 1.0);
  float size = aB.z * df * pop;
  mv.xy += vec2((position.x + aB.y) * size + aB.w * df * (1.0 - it * it), position.y * size);
  gl_Position = projectionMatrix * mv;
  float col = mod(aB.x, 8.0);
  float row = floor(aB.x / 8.0 + 0.001);
  vUv = vec2((col + position.x + 0.5) / 8.0, 1.0 - (row + 0.5 - position.y) / 2.0);
  vColor = aC.rgb;
  vAlpha = 1.0 - smoothstep(0.7, 1.0, t);
}`;
const NUM_FS = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 tx = texture2D(uAtlas, vUv);
  float a = tx.a * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(tx.rgb * vColor, a);
  #include <colorspace_fragment>
}`;

const RING_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // center.xyz, spawn
attribute vec4 aB; // color.rgb, duration
attribute vec4 aC; // radius, thickness
varying float vSide;
varying float vFade;
varying vec3 vColor;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur) { ${CULL} }
  float t = age / dur;
  float it = 1.0 - t;
  float R = aC.x * (1.0 - it * it * it);
  float th = aC.y * mix(1.0, 0.3, t);
  float rr = mix(max(R - th, 0.0), R, position.y);
  vec3 wp = aA.xyz + vec3(position.x * rr, 0.08, position.z * rr);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vSide = position.y;
  vFade = it * (1.0 - 0.5 * t);
  vColor = aB.rgb;
}`;
const RING_FS = /* glsl */`
varying float vSide;
varying float vFade;
varying vec3 vColor;
void main() {
  float prof = 0.1 + 0.9 * vSide * vSide;
  float edge = 1.0 - 0.6 * smoothstep(0.9, 1.0, vSide);
  gl_FragColor = vec4(vColor * (vFade * prof * edge * 2.2), 1.0);
  #include <colorspace_fragment>
}`;

const TELE_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // center.xyz, spawn
attribute vec4 aB; // color.rgb, duration
attribute vec4 aC; // radius
varying vec2 vUv;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vR;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur + 0.14) { ${CULL} }
  float pin = clamp(age / 0.16, 0.0, 1.0);
  float q = pin - 1.0;
  float ob = 1.0 + 2.70158 * q * q * q + 1.70158 * q * q;
  float R = aC.x * ob;
  vec3 wp = aA.xyz + vec3(position.x * R, 0.07, position.z * R);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vUv = position.xz;
  vColor = aB.rgb;
  vT = clamp(age / dur, 0.0, 1.0);
  vEnd = max(age - dur, 0.0) / 0.14;
  vR = aC.x;
}`;
const TELE_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vR;
void main() {
  float d = length(vUv);
  float aa = fwidth(d) * 1.5;
  if (d > 1.0) discard;
  float rimW = clamp(0.16 / max(vR, 0.1), 0.02, 0.2);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  float rim = smoothstep(1.0 - rimW - aa, 1.0 - rimW, d) * disc;
  float prog = 1.0 - smoothstep(vT - aa, vT, d);
  float lead = smoothstep(vT - rimW * 0.7 - aa, vT - rimW * 0.7, d) * prog;
  float pulse = 0.5 + 0.5 * sin(uTime * mix(9.0, 30.0, vT));
  float a = disc * (0.16 + 0.22 * prog) + rim * (0.55 + 0.45 * pulse) + lead * 0.4;
  vec3 c = vColor * (1.0 + rim * (0.8 + 1.4 * vT) + lead * 0.8);
  if (vEnd > 0.0) {
    c = mix(c, vec3(2.6, 2.3, 2.1), 0.7);
    a = disc * (1.0 - vEnd) * 0.85;
  }
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

const ZAP_VS = /* glsl */`
uniform float uTime;
uniform float uLife;
attribute vec3 aPrev;
attribute vec3 aNext;
attribute vec3 aD; // side, width, seed
attribute vec4 aE; // color.rgb, spawn
varying vec3 vColor;
varying float vSide;
varying float vI;
void main() {
  float age = uTime - aE.w;
  if (age < 0.0 || age >= uLife) { ${CULL} } // whole bolt culls together (padded verts have width 0)
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 pv = (modelViewMatrix * vec4(aPrev, 1.0)).xyz;
  vec3 nv = (modelViewMatrix * vec4(aNext, 1.0)).xyz;
  vec3 tg = nv - pv;
  tg = dot(tg, tg) > 1e-10 ? normalize(tg) : vec3(1.0, 0.0, 0.0);
  vec3 sd = cross(tg, normalize(mv.xyz));
  sd = dot(sd, sd) > 1e-10 ? normalize(sd) : vec3(0.0, 1.0, 0.0);
  float t = age / uLife;
  float fl = fract(sin(floor(age * 45.0) * 7.13 + aD.z * 91.7) * 43758.5453);
  float w = aD.y * (1.0 - 0.45 * t) * (0.75 + 0.5 * fl);
  mv.xyz += sd * (aD.x * w * 0.5);
  gl_Position = projectionMatrix * mv;
  vColor = aE.rgb;
  vSide = aD.x;
  vI = (1.0 - t) * (1.0 - 0.4 * t) * (0.55 + 0.45 * fl);
}`;
const ZAP_FS = /* glsl */`
varying vec3 vColor;
varying float vSide;
varying float vI;
void main() {
  float d = abs(vSide);
  float core = 1.0 - smoothstep(0.0, 0.32, d);
  float glow = 1.0 - d;
  glow *= glow;
  vec3 c = vColor * glow * 1.7 + vec3(1.0) * core * 2.4;
  gl_FragColor = vec4(c * vI, 1.0);
  #include <colorspace_fragment>
}`;

const BEAM_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // from.xyz, spawn
attribute vec4 aB; // to.xyz, duration
attribute vec4 aC; // color.rgb, width
varying vec2 vP;
varying float vLen;
varying float vHW;
varying vec3 vColor;
varying float vI;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur) { ${CULL} }
  float t = age / dur;
  vec3 a = (viewMatrix * vec4(aA.xyz, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(aB.xyz, 1.0)).xyz;
  vec3 ab = b - a;
  float len = length(ab);
  vec3 tg = len > 1e-5 ? ab / len : vec3(1.0, 0.0, 0.0);
  float hw = 0.5 * aC.w * (1.0 - t * t) * (1.0 + 0.12 * sin(uTime * 70.0 + aA.w * 13.0));
  hw = max(hw, 1e-4);
  vec3 base = mix(a, b, position.x);
  vec3 sd = cross(tg, normalize(base));
  sd = dot(sd, sd) > 1e-10 ? normalize(sd) : vec3(0.0, 1.0, 0.0);
  float ext = (position.x * 2.0 - 1.0) * hw;
  vec3 p = base + tg * ext + sd * (position.y * hw);
  gl_Position = projectionMatrix * vec4(p, 1.0);
  vP = vec2(position.x * len + ext, position.y);
  vLen = len;
  vHW = hw;
  vColor = aC.rgb;
  vI = 1.0 - t;
}`;
const BEAM_FS = /* glsl */`
uniform float uTime;
varying vec2 vP;
varying float vLen;
varying float vHW;
varying vec3 vColor;
varying float vI;
void main() {
  float u = vP.x;
  float ex = max(max(-u, u - vLen), 0.0) / vHW;
  float d = length(vec2(ex, vP.y));
  if (d >= 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.3, d);
  float glow = 1.0 - d;
  glow *= glow;
  float stripes = 0.8 + 0.2 * sin(u * 5.0 - uTime * 45.0);
  vec3 c = vColor * glow * 1.8 * stripes + vec3(1.0) * core * 2.4;
  gl_FragColor = vec4(c * vI, 1.0);
  #include <colorspace_fragment>
}`;

const FIRE_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // pos.xyz, spawn
attribute vec4 aB; // duration, size, seed, type (0 flame, 1 ground glow)
varying vec2 vUv;
varying float vHeat;
varying float vType;
varying float vA;
void main() {
  float age = uTime - aA.w;
  float dur = aB.x;
  if (age < 0.0 || age >= dur) { ${CULL} }
  float env = smoothstep(0.0, 0.18, age) * (1.0 - smoothstep(dur - 0.35, dur, age));
  float sz = aB.y;
  float sd = aB.z;
  vUv = position.xy;
  vType = aB.w;
  if (aB.w > 0.5) {
    float fl = 0.85 + 0.15 * sin(uTime * 17.0 + sd * 40.0) * sin(uTime * 7.3 + sd * 11.0);
    vec3 wp = aA.xyz + vec3(position.x * sz, 0.06, position.y * sz);
    vA = env * fl;
    vHeat = 0.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  } else {
    float period = mix(0.42, 0.75, fract(sd * 7.31));
    float cyc = fract(age / period + sd);
    float grow = sin(3.14159265 * sqrt(cyc));
    float s = sz * grow * env * (0.85 + 0.15 * sin(age * 29.0 + sd * 50.0));
    vec3 c = aA.xyz + vec3(sin(age * 4.0 + sd * 20.0) * 0.12 * sz, sz * 0.35 + cyc * sz * 1.9, cos(age * 3.3 + sd * 9.0) * 0.12 * sz);
    vec4 mv = viewMatrix * vec4(c, 1.0);
    mv.xy += position.xy * vec2(0.62, 1.0) * s;
    gl_Position = projectionMatrix * mv;
    vA = 1.0;
    vHeat = 1.0 - cyc;
  }
}`;
const FIRE_FS = /* glsl */`
varying vec2 vUv;
varying float vHeat;
varying float vType;
varying float vA;
void main() {
  vec2 p = vUv;
  p.x *= 1.0 + max(p.y, 0.0) * 1.1;
  p.y += 0.12;
  float df = length(p);
  float aa = fwidth(df) * 1.2;
  float dg = length(vUv);
  vec3 col;
  if (vType > 0.5) {
    if (dg >= 1.0) discard;
    float g = 1.0 - dg;
    col = vec3(1.0, 0.35, 0.06) * (g * g * 0.9 * vA);
  } else {
    if (df >= 1.0) discard;
    float outer = 1.0 - smoothstep(1.0 - aa, 1.0, df);
    float mid = 1.0 - smoothstep(0.64 - aa, 0.64, df);
    float inr = 0.18 + 0.2 * vHeat;
    float inner = 1.0 - smoothstep(inr - aa, inr, df);
    col = mix(vec3(1.0, 0.16, 0.03), vec3(1.0, 0.48, 0.05), mid);
    col = mix(col, vec3(1.0, 0.9, 0.45), inner);
    col *= outer * (0.5 + 1.3 * vHeat) * 1.4;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const TRAIL_VS = /* glsl */`
attribute vec3 aCol;
attribute float aSide;
varying vec3 vCol;
varying float vSide;
void main() {
  vCol = aCol;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const TRAIL_FS = /* glsl */`
varying vec3 vCol;
varying float vSide;
void main() {
  float s = abs(vSide);
  float prof = mix(0.3, 1.0, s * s) * (1.0 - smoothstep(0.82, 1.0, s));
  gl_FragColor = vec4(vCol * prof, 1.0);
  #include <colorspace_fragment>
}`;

// =============================================================================================
// THE ARCHIPELAGO: biome ambience, portals, boss attacks, new weapons.
// Same rules as above: GPU-animated from spawn records (or tiny persistent slot buffers for
// handle-driven effects), one draw call per family, O(1) spawns, zero per-frame allocations.
const fin = (x, d) => (typeof x === 'number' && x - x === 0 ? x : d);
const clampN = (x, d, lo, hi) => { x = fin(x, d); return x < lo ? lo : x > hi ? hi : x; };
const badV = (v) => !v || !(v.x - v.x === 0 && v.y - v.y === 0 && v.z - v.z === 0);

const NOISE_GLSL = /* glsl */`
float fxHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float fxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fxHash(i);
  float b = fxHash(i + vec2(1.0, 0.0));
  float c = fxHash(i + vec2(0.0, 1.0));
  float d = fxHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fxFbm(vec2 p) {
  float s = 0.5 * fxNoise(p);
  s += 0.25 * fxNoise(p * 2.03 + 17.1);
  s += 0.125 * fxNoise(p * 4.07 + 31.7);
  return s / 0.875;
}
`;

// ---- ambient volume: world-anchored particles wrapped into nested boxes around the camera.
// kinds: 0 none, 1 tropical, 2 snow, 3 sand, 4 wisps, 5 embers. Crossfade = per-particle dissolve.
const AMB_VS = /* glsl */`
uniform float uTime;
uniform float uKindA;
uniform float uKindB;
uniform float uMix;
uniform float uDensity;
attribute vec4 aS; // random box position.xyz, density key
attribute vec4 aR; // tier, sub-type, variation, crossfade key
varying vec2 vQ;
varying vec4 vCol;
varying float vShape;
varying float vAdd;
void main() {
  float m = uMix * 1.25 - 0.125;
  float isB = step(aR.w, m);
  float kind = floor(mix(uKindA, uKindB, isB) + 0.5);
  float fadeX = isB > 0.5 ? smoothstep(0.0, 0.125, m - aR.w) : smoothstep(0.0, 0.125, aR.w - m);
  float dens = kind < 0.5 ? 0.0 : kind < 1.5 ? 0.22 : kind < 2.5 ? 0.85 : kind < 3.5 ? 0.8 : kind < 4.5 ? 0.34 : 0.7;
  dens *= uDensity;
  if (aS.w >= dens || fadeX <= 0.0) { ${CULL} }
  float v01 = aS.w / dens;
  float t = uTime;
  float tier = aR.x < 0.5 ? 1.0 : (aR.x < 0.85 ? 1.9 : 2.8);
  vec3 box = vec3(26.0, 16.0, 26.0) * tier;
  float sub = aR.y;
  float ph = aR.z * 6.2831853;
  float h3 = fract(aR.z * 7.13);
  float h4 = fract(aR.z * 3.71);
  float h5 = fract(aR.z * 5.31);
  vec3 vel = vec3(0.0);
  vec3 disp = vec3(0.0);
  vec3 col = vec3(1.0);
  vec2 size = vec2(0.1);
  float alpha = 1.0;
  float add = 0.0;
  float shape = 0.0;
  float stretch = 0.0;
  float rot = 0.0;
  if (kind < 1.5) {
    if (sub < 0.35) { // drifting petals / leaves, tumbling
      vel = vec3(0.8, -0.5 - 0.4 * v01, 0.45);
      disp = vec3(sin(t * 1.1 + ph) * 0.9, sin(t * 2.3 + ph * 1.7) * 0.2, cos(t * 0.9 + ph) * 0.7);
      col = h3 > 0.62 ? mix(vec3(0.16, 0.45, 0.07), vec3(0.42, 0.7, 0.1), h4) : mix(vec3(1.0, 0.42, 0.6), vec3(1.0, 0.88, 0.84), h4);
      size = vec2(0.085, 0.14) * (0.85 + 0.5 * h5);
      size.x *= 0.3 + 0.7 * abs(cos(t * (1.3 + 1.8 * h4) + ph));
      rot = t * (0.8 + 1.6 * h5) + ph;
      shape = 1.0;
      alpha = 0.95;
    } else { // tiny twinkling sparkles
      vel = vec3(0.15, 0.06 + 0.1 * v01, 0.1);
      disp = vec3(sin(t * 0.7 + ph), sin(t * 0.9 + ph * 1.3) * 0.6, cos(t * 0.6 + ph * 0.7)) * 0.6;
      float tw = pow(max(sin(t * (1.4 + 2.0 * h5) + ph * 3.0), 0.0), 10.0);
      col = mix(vec3(1.0, 0.85, 0.45), vec3(0.9, 1.0, 1.0), h4) * (0.2 + 2.6 * tw);
      size = vec2(0.07 + 0.11 * tw);
      rot = ph;
      shape = 4.0;
      add = 1.0;
    }
  } else if (kind < 2.5) { // steady snowfall, flutter + occasional gusts
    float g = t * 0.11 + aR.z * 0.05;
    float gust = floor(g) + smoothstep(0.3, 0.7, fract(g));
    vel = vec3(0.45, -1.5 - 1.1 * v01, 0.2);
    disp = vec3(1.0, 0.0, 0.35) * gust * (7.0 + 5.0 * v01) + vec3(sin(t * 1.7 + ph), 0.0, cos(t * 1.3 + ph)) * 0.35;
    col = vec3(0.93, 0.96, 1.0);
    size = vec2(0.045 + 0.05 * h5);
    alpha = 0.92;
  } else if (kind < 3.5) {
    vec3 wind = vec3(0.9578, 0.0, 0.2873);
    if (sub < 0.55) { // fast blowing streaks
      vel = wind * (20.0 + 12.0 * v01) + vec3(0.0, sin(ph) * 0.8, 0.0);
      disp = vec3(0.0, sin(t * 3.0 + ph) * 0.25, 0.0);
      col = mix(vec3(0.93, 0.78, 0.55), vec3(0.98, 0.88, 0.7), h4);
      size = vec2(0.045 + 0.03 * h3, 0.6 + 0.8 * h5);
      alpha = 0.34;
      stretch = 1.0;
      shape = 2.0;
    } else { // big soft dust puffs
      vel = wind * (5.0 + 3.0 * v01) + vec3(0.0, 0.2, 0.0);
      disp = vec3(sin(t * 0.5 + ph), sin(t * 0.7 + ph) * 0.4, cos(t * 0.4 + ph)) * 1.5;
      col = vec3(0.88, 0.7, 0.47);
      size = vec2(0.9 + 1.2 * h4);
      alpha = 0.13;
      shape = 5.0;
    }
  } else if (kind < 4.5) {
    if (sub < 0.6) { // blinking fireflies
      vel = vec3(0.0, 0.05, 0.0);
      disp = vec3(sin(t * 0.63 + ph) + 0.5 * sin(t * 1.7 + ph * 2.1), 0.6 * sin(t * 0.83 + ph * 1.3), cos(t * 0.57 + ph) + 0.5 * cos(t * 1.9 + ph * 1.6)) * 1.2;
      float blink = smoothstep(0.2, 0.9, sin(t * (0.8 + 0.9 * h5) + ph * 5.0));
      col = mix(vec3(0.65, 1.0, 0.25), vec3(0.3, 1.0, 0.85), h4) * (0.06 + 2.8 * blink);
      size = vec2(0.07 + 0.06 * blink);
      shape = 6.0;
      add = 1.0;
    } else { // slow rising wisps with a soft tail
      vel = vec3(0.1, 0.35 + 0.5 * v01, 0.05);
      disp = vec3(sin(t * 0.45 + ph) * 1.3, 0.0, cos(t * 0.38 + ph * 1.4) * 1.3);
      col = mix(vec3(0.2, 1.0, 0.75), vec3(0.45, 0.8, 1.0), h4) * (0.5 + 0.3 * sin(t * 1.3 + ph));
      size = vec2(0.15, 0.42) * (0.8 + 0.6 * h5);
      stretch = 1.0;
      shape = 6.0;
      add = 1.0;
    }
  } else {
    if (sub < 0.55) { // rising embers
      vel = vec3(0.5, 1.6 + 2.2 * v01, 0.2);
      disp = vec3(sin(t * 1.3 + ph) * 0.9 + sin(t * 3.1 + ph * 2.0) * 0.25, 0.0, cos(t * 1.1 + ph) * 0.9);
      float fl = 0.6 + 0.4 * sin(t * (9.0 + 8.0 * h3) + ph * 4.0);
      col = mix(vec3(1.0, 0.24, 0.02), vec3(1.0, 0.42, 0.06), h4) * (1.1 + 1.1 * fl);
      size = vec2(0.07, 0.2) * (0.8 + 0.6 * h5);
      stretch = 1.0;
      shape = 2.0;
      add = 1.0;
    } else { // falling ash flakes, tumbling
      vel = vec3(0.35, -0.45 - 0.45 * v01, 0.15);
      disp = vec3(sin(t * 0.9 + ph), 0.0, cos(t * 0.7 + ph)) * 0.8;
      col = mix(vec3(0.16, 0.15, 0.15), vec3(0.42, 0.4, 0.38), h4);
      size = vec2(0.065, 0.055) * (0.8 + 0.7 * h5);
      size.y *= 0.3 + 0.7 * abs(cos(t * 2.1 + ph));
      rot = t * (1.5 + 2.0 * h3) + ph;
      shape = 3.0;
      alpha = 0.85;
    }
  }
  vec3 p = aS.xyz * box + vel * t + disp;
  vec3 rel = mod(p - cameraPosition + 0.5 * box, box) - 0.5 * box;
  vec3 e = abs(rel) / (0.5 * box);
  alpha *= fadeX * (1.0 - smoothstep(0.7, 1.0, max(max(e.x, e.y), e.z))) * smoothstep(0.8, 3.0, length(rel));
  if (alpha <= 0.002) { ${CULL} }
  vec4 mv = viewMatrix * vec4(cameraPosition + rel, 1.0);
  vec2 q = position.xy;
  if (stretch > 0.5) {
    vec3 vv = mat3(viewMatrix) * vel;
    float vl = length(vv);
    float dl = length(vv.xy);
    vec2 dir = dl > 1e-4 ? vv.xy / dl : vec2(0.0, 1.0);
    float fore = vl > 1e-4 ? clamp(dl / vl, 0.25, 1.0) : 1.0;
    mv.xy += dir * (q.y * size.y * fore) + vec2(dir.y, -dir.x) * (q.x * size.x); // proper rotation (keeps CCW winding)
  } else {
    float cr = cos(rot);
    float sr = sin(rot);
    vec2 o = q * size;
    mv.xy += vec2(cr * o.x - sr * o.y, sr * o.x + cr * o.y);
  }
  gl_Position = projectionMatrix * mv;
  vQ = q;
  vCol = vec4(col, alpha);
  vShape = shape;
  vAdd = add;
}`;
const AMB_FS = /* glsl */`
varying vec2 vQ;
varying vec4 vCol;
varying float vShape;
varying float vAdd;
void main() {
  vec2 q = vQ;
  float r = length(q);
  vec2 aq = abs(q);
  float a;
  if (vShape < 0.5) { // flake
    a = 1.0 - smoothstep(0.45, 1.0, r);
  } else if (vShape < 1.5) { // petal / leaf (pointed ellipse)
    a = 1.0 - smoothstep(0.75, 1.0, length(vec2(q.x * (1.0 + 0.35 * abs(q.y)), q.y)));
  } else if (vShape < 2.5) { // streak: bright head, fading tail
    a = (1.0 - smoothstep(0.3, 1.0, aq.x)) * smoothstep(-1.0, 0.5, q.y) * (1.0 - smoothstep(0.7, 1.0, q.y));
  } else if (vShape < 3.5) { // ash flake
    a = 1.0 - smoothstep(0.55, 0.95, max(aq.x, aq.y) + 0.2 * min(aq.x, aq.y));
  } else if (vShape < 4.5) { // sparkle star
    a = clamp(exp(-aq.x * 10.0) * (1.0 - aq.y) + exp(-aq.y * 10.0) * (1.0 - aq.x) + exp(-r * r * 9.0), 0.0, 1.0);
  } else if (vShape < 5.5) { // big soft puff
    a = 1.0 - smoothstep(0.0, 1.0, r);
    a *= a;
  } else { // glow blob
    a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.75, 1.0, r));
  }
  a *= vCol.a;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * a, a * (1.0 - vAdd));
  #include <colorspace_fragment>
}`;

// ---- portal vortex (material for the game's own disc meshes; UV 0..1 across the disc)
const VORTEX_VS = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const VORTEX_FS = /* glsl */`
uniform float uTime;
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r >= 1.0) discard;
  float aa = fwidth(r) * 1.5 + 1e-4;
  float I = max(uIntensity, 0.0);
  float t = uTime;
  float ang = atan(p.y, p.x);
  float lr = log(r + 0.001);
  float sa = ang + 2.4 * lr - t * 1.7;
  float arms = 0.5 + 0.5 * sin(sa * 3.0);
  vec2 nq = vec2(cos(sa), sin(sa)) * (0.9 + 1.4 * r) + vec2(lr * 1.6 + t * 0.35, t * 0.21);
  float n = fxFbm(nq * 1.8);
  float sw = clamp(arms * 0.65 + n * 0.9 - 0.35, 0.0, 1.2);
  float depth = smoothstep(0.02, 0.8, r);
  float z = 0.6 / (r + 0.06);
  float rings = pow(0.5 + 0.5 * sin(z * 3.0 + t * 5.0 + n * 2.0), 6.0) * (1.0 - depth) * smoothstep(0.03, 0.2, r);
  vec3 col = mix(uColorA * 0.12, uColorA * 1.1, depth) * (0.35 + sw * 1.4);
  col += uColorB * (sw * sw * sw) * (0.4 + 1.3 * depth);
  col += mix(uColorA, uColorB, 0.5) * rings * 0.9;
  float rd = (r - 0.925) / 0.05;
  float rim = exp(-rd * rd);
  float flick = 0.75 + 0.25 * sin(ang * 7.0 - t * 5.0) * sin(ang * 3.0 + t * 3.1);
  col += uColorB * rim * flick * 2.6 + vec3(1.0) * (rim * rim * rim * rim) * 0.8;
  float edge = 1.0 - smoothstep(1.0 - aa * 2.0, 1.0, r);
  float alpha = mix(0.96, 0.55, depth) * edge;
  gl_FragColor = vec4(col * edge * I, alpha * clamp(I, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

// ---- persistent sweep beams (boss eye lasers, fire breath). Slot buffer, set() every frame.
const SWEEP_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // from.xyz, width
attribute vec4 aB; // to.xyz, intensity (0 = hidden)
attribute vec4 aC; // color.rgb, style (0 laser, 1 fire)
attribute vec4 aD; // seed
varying vec2 vP;
varying float vLen;
varying float vHW;
varying vec3 vColor;
varying float vI;
varying float vPart;
varying float vStyle;
varying float vSeed;
void main() {
  float I = aB.w;
  if (I <= 0.001) { ${CULL} }
  vec3 a = (viewMatrix * vec4(aA.xyz, 1.0)).xyz;
  vec3 b = (viewMatrix * vec4(aB.xyz, 1.0)).xyz;
  float hw0 = 0.5 * max(aA.w, 0.02);
  float fire = aC.w;
  vColor = aC.rgb;
  vI = I;
  vPart = position.z;
  vStyle = fire;
  vSeed = aD.x;
  vLen = 0.0;
  vHW = hw0;
  if (position.z < 0.5) {
    vec3 ab = b - a;
    float len = length(ab);
    vec3 tg = len > 1e-5 ? ab / len : vec3(1.0, 0.0, 0.0);
    float widen = mix(1.0, mix(0.35, 1.25, position.x), fire);
    float hw = hw0 * widen * (1.0 + 0.07 * sin(uTime * 60.0 + aD.x * 20.0));
    vec3 base = mix(a, b, position.x);
    vec3 sd = cross(tg, normalize(base));
    sd = dot(sd, sd) > 1e-10 ? normalize(sd) : vec3(0.0, 1.0, 0.0);
    float ext = (position.x * 2.0 - 1.0) * hw;
    vec3 p = base + tg * ext + sd * (position.y * hw);
    gl_Position = projectionMatrix * vec4(p, 1.0);
    vP = vec2(position.x * len + ext, position.y);
    vLen = len;
    vHW = hw;
  } else {
    bool atEnd = position.z < 1.5;
    vec3 c = atEnd ? b : a;
    float s = hw0 * (atEnd ? mix(3.0, 1.9, fire) : mix(2.2, 1.0, fire));
    vec3 toCam = -normalize(c);
    vec3 p = c + toCam * min(s, 1.5) * 0.5 + vec3(position.xy * s, 0.0);
    gl_Position = projectionMatrix * vec4(p, 1.0);
    vP = position.xy;
  }
}`;
const SWEEP_FS = /* glsl */`
uniform float uTime;
varying vec2 vP;
varying float vLen;
varying float vHW;
varying vec3 vColor;
varying float vI;
varying float vPart;
varying float vStyle;
varying float vSeed;
${NOISE_GLSL}
vec3 fireCol(float h, vec3 c) {
  vec3 col = mix(c * vec3(0.55, 0.25, 0.2), c, smoothstep(0.05, 0.45, h));
  col = mix(col, mix(c, vec3(1.0, 0.85, 0.45), 0.65), smoothstep(0.45, 0.8, h));
  return mix(col, vec3(1.7, 1.5, 1.2), smoothstep(0.85, 1.15, h));
}
void main() {
  vec3 col;
  if (vPart < 0.5) {
    float u = vP.x;
    float ex = max(max(-u, u - vLen), 0.0) / vHW;
    float d = length(vec2(ex, vP.y));
    if (d >= 1.0) discard;
    if (vStyle < 0.5) {
      float core = 1.0 - smoothstep(0.0, 0.42, d);
      float glow = pow(1.0 - d, 1.6);
      float flow = 0.7 + 0.3 * sin(u * 1.7 - uTime * 42.0 + vSeed * 6.0);
      float en = fxNoise(vec2(u * 0.9 - uTime * 26.0, vP.y * 1.5 + vSeed * 13.0));
      col = vColor * glow * (1.1 * flow + 0.8 * en * glow) + vColor * core * 1.6 + vec3(1.0, 0.96, 0.92) * (core * core * 2.6);
    } else {
      float along = clamp(u / max(vLen, 0.001), 0.0, 1.0);
      vec2 fq = vec2(u * 0.55 - uTime * 9.0, vP.y * 1.2 + vSeed * 5.0);
      float n = fxFbm(fq);
      float n2 = fxNoise(fq * 2.7 + vec2(uTime * 4.0, vSeed * 3.0));
      float edgeN = d + (n - 0.5) * 0.6 + (n2 - 0.5) * 0.25;
      float body = 1.0 - smoothstep(0.45, 0.9, edgeN);
      float heat = clamp(1.05 - edgeN * 1.2 - along * 0.45 + (n - 0.5) * 0.35, 0.0, 1.1);
      col = fireCol(heat, vColor) * body * 1.05;
    }
  } else {
    float r = length(vP);
    if (r >= 1.0) discard;
    float fall = 1.0 - r;
    if (vStyle < 0.5) {
      float ang = atan(vP.y, vP.x);
      float rays = pow(abs(sin(ang * 4.0 + uTime * 4.0 + vSeed * 6.0)), 16.0) + pow(abs(sin(ang * 3.0 - uTime * 2.7 + vSeed)), 24.0);
      float core = exp(-r * r * 22.0);
      float flick = 0.8 + 0.2 * fxNoise(vec2(uTime * 25.0, vSeed * 10.0));
      float k = vPart < 1.5 ? 1.0 : 0.6;
      col = (vColor * (fall * fall * 1.1 + rays * fall * 1.6 * k) * flick + vec3(1.0, 0.95, 0.9) * core * 3.0) * k;
    } else {
      float n = fxFbm(vP * 2.2 + vec2(vSeed * 3.0, -uTime * 3.5));
      float body = 1.0 - smoothstep(0.3, 0.95, r + (n - 0.5) * 0.55);
      col = fireCol(body * (0.7 + 0.4 * n), vColor) * body * 0.9;
    }
  }
  gl_FragColor = vec4(col * vI, 1.0);
  #include <colorspace_fragment>
}`;

// ---- ground warning strip (fills along its length), heights sampled along the line
const TLINE_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // from.xyz, spawn
attribute vec4 aB; // to.xyz, duration
attribute vec4 aC; // color.rgb, width
attribute vec4 aH0; // ground height at t = 0/7 .. 3/7
attribute vec4 aH1; // ground height at t = 4/7 .. 7/7
varying vec2 vUv;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vLen;
varying float vW;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur + 0.16) { ${CULL} }
  vec2 dxz = aB.xz - aA.xz;
  float len = length(dxz);
  vec2 dir = len > 1e-4 ? dxz / len : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float pin = clamp(age / 0.14, 0.0, 1.0);
  pin = 1.0 - (1.0 - pin) * (1.0 - pin);
  float w = aC.w * mix(0.25, 1.0, pin);
  float tt = position.x * 7.0;
  float h = dot(aH0, max(1.0 - abs(tt - vec4(0.0, 1.0, 2.0, 3.0)), 0.0)) + dot(aH1, max(1.0 - abs(tt - vec4(4.0, 5.0, 6.0, 7.0)), 0.0));
  vec2 xz = aA.xz + dxz * position.x + nrm * (position.y * 0.5 * w);
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, h + 0.09, xz.y, 1.0);
  vUv = position.xy;
  vColor = aC.rgb;
  vT = clamp(age / dur, 0.0, 1.0);
  vEnd = max(age - dur, 0.0) / 0.16;
  vLen = len;
  vW = w;
}`;
const TLINE_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vLen;
varying float vW;
void main() {
  float x = vUv.x;
  float s = abs(vUv.y);
  float aaS = fwidth(s) * 1.5 + 1e-4;
  float aaX = fwidth(x) * 1.5 + 1e-4;
  float bw = clamp(0.2 / max(vW * 0.5, 0.05), 0.05, 0.35);
  float bx = clamp(0.2 / max(vLen, 0.05), 0.0, 0.2);
  float border = max(smoothstep(1.0 - bw - aaS, 1.0 - bw, s), max(1.0 - smoothstep(bx, bx + aaX, x), smoothstep(1.0 - bx - aaX, 1.0 - bx, x)));
  float fill = 1.0 - smoothstep(vT - aaX, vT, x);
  float lw = clamp(0.6 / max(vLen, 0.05), 0.01, 0.3);
  float lead = smoothstep(vT - lw - aaX, vT - lw, x) * fill;
  float chev = fract(x * vLen * 0.45 - s * vW * 0.2 - uTime * 1.8);
  float chevM = smoothstep(0.0, 0.1, chev) * (1.0 - smoothstep(0.3, 0.4, chev)) * (1.0 - border);
  float pulse = 0.5 + 0.5 * sin(uTime * mix(9.0, 30.0, vT));
  float a = 0.14 + 0.2 * fill + border * (0.55 + 0.45 * pulse) + lead * 0.4 + chevM * (0.12 + 0.15 * fill);
  vec3 c = vColor * (1.0 + border * (0.8 + 1.4 * vT) + lead * 0.8 + chevM * 0.5);
  if (vEnd > 0.0) {
    c = mix(c, vec3(2.6, 2.3, 2.1), 0.7);
    a = (1.0 - vEnd) * 0.85;
  }
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

// ---- ground warning cone (breath attacks), fills outward from the apex
const TCONE_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // apex.xyz, spawn
attribute vec4 aB; // color.rgb, duration
attribute vec4 aC; // yaw, halfAngle, range
varying vec2 vL;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vR;
varying float vHA;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur + 0.16) { ${CULL} }
  float ha = clamp(aC.y, 0.02, 3.14159265);
  float pin = clamp(age / 0.16, 0.0, 1.0);
  float q = pin - 1.0;
  float R = max(aC.z, 0.1) * (1.0 + 2.70158 * q * q * q + 1.70158 * q * q);
  float xm = (ha >= 1.5707963 ? 1.0 : sin(ha)) * R + 0.4;
  float zmin = min(cos(ha) * R, 0.0) - 0.4;
  vec2 loc = vec2(position.x * xm, mix(zmin, R + 0.4, position.z * 0.5 + 0.5));
  float sy = sin(aC.x);
  float cy = cos(aC.x);
  vec2 w = vec2(loc.x * cy + loc.y * sy, -loc.x * sy + loc.y * cy);
  gl_Position = projectionMatrix * viewMatrix * vec4(aA.x + w.x, aA.y + 0.08, aA.z + w.y, 1.0);
  vL = loc;
  vColor = aB.rgb;
  vT = clamp(age / dur, 0.0, 1.0);
  vEnd = max(age - dur, 0.0) / 0.16;
  vR = R;
  vHA = ha;
}`;
const TCONE_FS = /* glsl */`
uniform float uTime;
varying vec2 vL;
varying vec3 vColor;
varying float vT;
varying float vEnd;
varying float vR;
varying float vHA;
void main() {
  float r = length(vL);
  float ang = abs(atan(vL.x, vL.y));
  float aaR = fwidth(r) * 1.5 + 1e-4;
  float inR = 1.0 - smoothstep(vR - aaR, vR, r);
  float sideD = vHA >= 3.1 ? 1000.0 : r * sin(clamp(vHA - ang, -1.5707963, 1.5707963));
  float mask = inR * smoothstep(-aaR, 0.0, sideD);
  if (mask <= 0.001) discard;
  float bw = clamp(vR * 0.035, 0.12, 0.35);
  float border = max(1.0 - smoothstep(bw - aaR, bw, vR - r), 1.0 - smoothstep(bw - aaR, bw, sideD));
  float fr = vT * vR;
  float fill = 1.0 - smoothstep(fr - aaR, fr, r);
  float lead = smoothstep(fr - 0.45 - aaR, fr - 0.45, r) * fill;
  float sp = fract(r * 0.6 - uTime * 1.5);
  float stripes = smoothstep(0.55, 0.6, sp) * (1.0 - smoothstep(0.85, 0.9, sp)) * (1.0 - border);
  float pulse = 0.5 + 0.5 * sin(uTime * mix(9.0, 30.0, vT));
  float a = 0.14 + 0.2 * fill + border * (0.55 + 0.45 * pulse) + lead * 0.4 + stripes * (0.08 + 0.1 * fill);
  vec3 c = vColor * (1.0 + border * (0.8 + 1.4 * vT) + lead * 0.8);
  if (vEnd > 0.0) {
    c = mix(c, vec3(2.6, 2.3, 2.1), 0.7);
    a = (1.0 - vEnd) * 0.85;
  }
  gl_FragColor = vec4(c, clamp(a, 0.0, 1.0) * mask);
  #include <colorspace_fragment>
}`;

// ---- eruption spikes: scene-lit MeshLambertMaterial (flat shaded) + GPU pop/hold/sink injection
const SPK_HEAD = /* glsl */`
uniform float uTime;
attribute vec4 aSA; // base.xyz, spawn
attribute vec4 aSB; // tilt.xz (shear per m), height, radius
attribute vec4 aSC; // color.rgb, kind
attribute vec4 aSD; // duration, 0, seed, yaw
varying float vSpkH;
varying float vSpkKind;
varying float vSpkGlow;
varying vec3 vSpkCol;
`;
const SPK_VERT = /* glsl */`
float sAge = uTime - aSA.w;
float sDur = aSD.x;
vec3 transformed = vec3(0.0, -10000.0, 0.0);
vSpkH = 0.0;
vSpkCol = aSC.rgb;
vSpkKind = aSC.w;
vSpkGlow = 0.0;
if (sAge >= 0.0 && sAge < sDur) {
  float rise = clamp(sAge / 0.12, 0.0, 1.0);
  float q = rise - 1.0;
  float pop = 1.0 + 2.6 * q * q * q + 1.6 * q * q;
  float sink = smoothstep(sDur - 0.3, sDur, sAge);
  float H = aSB.z;
  float cy = cos(aSD.w);
  float sy = sin(aSD.w);
  vec3 lp = position;
  lp.xz = vec2(lp.x * cy - lp.z * sy, lp.x * sy + lp.z * cy) * aSB.w * (0.75 + 0.25 * pop);
  float yy = lp.y * H * pop;
  lp.xz += aSB.xy * yy;
  lp.y = yy - sink * H * 1.1;
  transformed = aSA.xyz + lp;
  vSpkH = position.y;
  vSpkGlow = 1.0 + 1.6 * (1.0 - smoothstep(0.0, 0.35, sAge));
}
`;
const SPK_FRAG_HEAD = /* glsl */`
varying float vSpkH;
varying float vSpkKind;
varying float vSpkGlow;
varying vec3 vSpkCol;
`;
const SPK_FRAG_EMIS = /* glsl */`
{
  float spkTip = smoothstep(0.3, 1.0, vSpkH);
  if (vSpkKind < 0.5) totalEmissiveRadiance += vSpkCol * (0.35 + 0.6 * spkTip) * vSpkGlow;
  else if (vSpkKind < 2.5) totalEmissiveRadiance += vSpkCol * 0.22;
  else totalEmissiveRadiance += vec3(3.0, 0.75, 0.1) * (spkTip * spkTip * vSpkGlow) + vec3(1.2, 0.26, 0.04) * (1.0 - smoothstep(-0.3, 0.12, vSpkH));
}
`;

// ---- black hole: lensing halo, dark core impostor, spiralling accretion disc, in-falling sparks
const BH_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // center.xyz, spawn
attribute vec4 aB; // radius, duration, seed
attribute float aK; // spark index
varying vec2 vQ;
varying float vPart;
varying float vEnv;
varying float vFl;
varying float vRing;
varying float vHot;
varying float vFront;
void main() {
  float age = uTime - aA.w;
  float dur = aB.y;
  if (age < 0.0 || age >= dur + 0.32) { ${CULL} }
  float R = aB.x;
  float g = clamp(age / 0.4, 0.0, 1.0) - 1.0;
  float grow = 1.0 + 2.2 * g * g * g + 1.2 * g * g;
  float coll = smoothstep(dur - 0.3, dur, age);
  float env = max(grow * (1.0 - coll * coll), 0.0);
  float fl = clamp((age - dur) / 0.32, 0.0, 1.0);
  float part = position.z;
  vec3 C = aA.xyz;
  float coreR = R * 0.28 * env;
  vPart = part;
  vEnv = env;
  vFl = fl;
  vQ = position.xy;
  vRing = 0.0;
  vHot = 0.0;
  vFront = 0.0;
  vec4 mv;
  if (part < 0.5) {
    float hs = age >= dur ? R * (0.35 + 1.4 * fl) : R * 0.62 * env;
    mv = viewMatrix * vec4(C, 1.0);
    mv.xy += position.xy * hs;
    vRing = hs > 1e-4 ? coreR * 1.06 / hs : 0.0;
  } else if (part < 1.5) {
    mv = viewMatrix * vec4(C, 1.0);
    mv.xy += position.xy * coreR;
  } else if (part < 2.5 || part > 3.5) {
    float dr = R * 0.95 * env;
    mv = viewMatrix * vec4(C + vec3(position.x * dr, 0.0, position.y * dr), 1.0);
    vRing = dr > 1e-4 ? coreR * 1.3 / dr : 0.0;
    vFront = mv.z - (viewMatrix * vec4(C, 1.0)).z;
  } else {
    float h1 = fract(sin(aK * 12.9898 + aB.z * 78.233) * 43758.5453);
    float h2 = fract(sin(aK * 39.3468 + aB.z * 11.135) * 24634.6345);
    float c = fract(uTime / mix(0.7, 1.3, h2) + h1);
    float rr = mix(R * 1.2, coreR * 1.05, c * c);
    float an = h1 * 6.2831853 + c * 4.5 + uTime * 0.6;
    vec3 wp = C + vec3(cos(an) * rr, (h2 - 0.5) * R * 0.5 * (1.0 - c), sin(an) * rr);
    mv = viewMatrix * vec4(wp, 1.0);
    mv.xy += position.xy * (R * (0.03 + 0.03 * h2) * (0.6 + 0.8 * c) * step(0.001, env));
    vHot = c * smoothstep(0.0, 0.15, c);
  }
  gl_Position = projectionMatrix * mv;
}`;
const BH_FS = /* glsl */`
uniform float uTime;
varying vec2 vQ;
varying float vPart;
varying float vEnv;
varying float vFl;
varying float vRing;
varying float vHot;
varying float vFront;
${NOISE_GLSL}
void main() {
  float r = length(vQ);
  if (r >= 1.0) discard;
  bool disc = (vPart > 1.5 && vPart < 2.5) || vPart > 3.5;
  if (disc && ((vPart < 2.5 && vFront > 0.0) || (vPart > 3.5 && vFront <= 0.0))) discard; // back half, core, front half
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (vPart < 0.5) {
    float rd = (r - vRing) / 0.06;
    float ring = exp(-rd * rd) * step(0.0001, vRing);
    float glow = 1.0 - r;
    glow *= glow;
    col = (vec3(0.75, 0.25, 1.0) * glow * 0.5 + vec3(1.0, 0.7, 1.0) * ring * 1.3) * vEnv;
    float fb = 1.0 - vFl;
    col += vec3(2.2, 1.6, 2.8) * glow * fb * fb * step(0.0001, vFl) * 1.5;
  } else if (vPart < 1.5) {
    float inside = 1.0 - smoothstep(1.0 - fwidth(r) * 1.5, 1.0, r);
    col = vec3(0.6, 0.18, 1.0) * (pow(r, 5.0) * 1.8 * inside);
    a = inside;
  } else if (disc) {
    float inner = vRing;
    float x = clamp((r - inner) / max(1.0 - inner, 1e-3), 0.0, 1.0);
    float ang = atan(vQ.y, vQ.x);
    float sa = ang + 3.2 * log(r + 0.01) + uTime * 3.5;
    float arms = 0.5 + 0.5 * sin(sa * 2.0);
    float n = fxNoise(vec2(cos(sa), sin(sa)) * 2.0 + vec2(x * 3.0 - uTime * 0.8, 0.0));
    float band = step(inner, r) * smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.45, 1.0, x));
    float hot = 1.0 - smoothstep(0.0, 0.25, x);
    float I = band * (0.35 + 0.65 * arms * (0.6 + 0.8 * n));
    col = (mix(vec3(0.3, 0.06, 0.8), vec3(0.95, 0.22, 0.8), 1.0 - x) * I * 0.95 + vec3(1.0, 0.75, 1.0) * (hot * band * 1.25)) * vEnv;
  } else {
    float g = exp(-r * r * 5.0) * (1.0 - r);
    col = mix(vec3(0.7, 0.3, 1.0), vec3(1.0, 0.8, 1.0), vHot) * g * (0.5 + 0.9 * vHot);
  }
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

// ---- sand tornado: two swirling funnel shells, base dust ring, orbiting debris
const TORN_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // base.xyz, intensity
attribute vec4 aB; // seed, height, radius scale
attribute float aK;
varying vec2 vUv;
varying float vPart;
varying float vI;
varying vec3 vN;
varying vec3 vV;
varying float vSeed;
void main() {
  float I = aA.w;
  if (I <= 0.002) { ${CULL} }
  float t = uTime + aB.x * 50.0;
  float H = aB.y;
  float RS = aB.z;
  float part = position.z;
  vec3 C = aA.xyz;
  vPart = part;
  vI = I;
  vSeed = aB.x;
  vUv = position.xy;
  vN = vec3(0.0, 0.0, 1.0);
  vV = vec3(0.0, 0.0, 1.0);
  vec4 mv;
  if (part < 1.5) {
    float h = position.y;
    float ang = position.x * 6.2831853;
    float r = RS * mix(0.55, 3.6, pow(h, 1.35)) * mix(1.0, 0.62, part) * (0.75 + 0.25 * I);
    r *= 1.0 + 0.08 * sin(h * 11.0 - t * 4.0 + ang * 2.0);
    vec2 sway = vec2(sin(t * 0.9 + h * 2.4), cos(t * 0.73 + h * 1.9)) * (h * h * 1.4 * RS);
    mv = viewMatrix * vec4(C + vec3(cos(ang) * r + sway.x, h * H, sin(ang) * r + sway.y), 1.0);
    vN = mat3(viewMatrix) * vec3(cos(ang), -0.15, sin(ang));
    vV = -mv.xyz;
  } else if (part < 2.5) {
    float s = RS * 5.5;
    mv = viewMatrix * vec4(C + vec3(position.x * s, 0.08, position.y * s), 1.0);
  } else {
    float h1 = fract(sin(aK * 12.9898 + aB.x * 78.233) * 43758.5453);
    float h2 = fract(sin(aK * 39.3468 + aB.x * 11.135) * 24634.6345);
    float c = fract(t * (0.12 + 0.1 * h2) + h1);
    float r = RS * mix(0.55, 3.6, pow(c, 1.35)) * (1.05 + 0.25 * h2);
    float an = h1 * 6.2831853 + t * (3.0 + 2.5 * (1.0 - c));
    vec2 sway = vec2(sin(t * 0.9 + c * 2.4), cos(t * 0.73 + c * 1.9)) * (c * c * 1.4 * RS);
    mv = viewMatrix * vec4(C + vec3(cos(an) * r + sway.x, c * H, sin(an) * r + sway.y), 1.0);
    float s = (0.1 + 0.16 * h2) * RS * smoothstep(0.0, 0.1, c) * (1.0 - smoothstep(0.85, 1.0, c));
    float ra = t * (3.0 + 4.0 * h2) + h1 * 6.28;
    vec2 o = position.xy * s;
    mv.xy += vec2(cos(ra) * o.x - sin(ra) * o.y, sin(ra) * o.x + cos(ra) * o.y);
  }
  gl_Position = projectionMatrix * mv;
}`;
const TORN_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vPart;
varying float vI;
varying vec3 vN;
varying vec3 vV;
varying float vSeed;
${NOISE_GLSL}
void main() {
  float t = uTime + vSeed * 50.0;
  vec3 col;
  float a;
  if (vPart < 1.5) {
    float h = vUv.y;
    float sa = vUv.x * 6.2831853 - t * mix(4.5, 6.5, vPart) + h * 3.5;
    float n = fxFbm(vec2(cos(sa), sin(sa)) * 1.4 + vec2(h * 4.5 - t * 1.4, h * 2.0 + vSeed * 7.0));
    float streak = 0.5 + 0.5 * sin(sa * 6.0 + n * 5.0);
    float dens = smoothstep(0.18, 0.7, n * 0.75 + streak * 0.45);
    vec3 nn = normalize(vN);
    float sil = 1.0 - abs(dot(nn, normalize(vV)));
    float vert = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.8, 1.0, h));
    a = dens * vert * mix(0.55, 1.0, sil) * mix(0.92, 0.75, vPart);
    col = mix(vec3(0.33, 0.2, 0.09), vec3(0.8, 0.6, 0.36), clamp(h * 0.55 + n * 0.55 - 0.25 * vPart, 0.0, 1.0));
    col *= 0.8 + 0.3 * nn.x + 0.15 * nn.y;
  } else if (vPart < 2.5) {
    float r = length(vUv);
    if (r >= 1.0) discard;
    float sa = atan(vUv.y, vUv.x) - t * 3.0 + r * 4.0;
    float n = fxNoise(vec2(cos(sa), sin(sa)) * 2.5 + vec2(r * 5.0 - t * 1.5, vSeed * 3.0));
    a = smoothstep(0.08, 0.3, r) * (1.0 - smoothstep(0.45, 1.0, r)) * (0.25 + 0.6 * n) * 0.8;
    col = vec3(0.62, 0.45, 0.25);
  } else {
    vec2 aq = abs(vUv);
    a = 1.0 - smoothstep(0.55, 0.9, max(aq.x, aq.y));
    col = vec3(0.45, 0.3, 0.16);
  }
  a *= clamp(vI, 0.0, 1.0);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(col * a, a);
  #include <colorspace_fragment>
}`;

// ---- light pillar: soft outer shell + hot core shell + base glow + rising motes
const PILLAR_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // base.xyz, spawn
attribute vec4 aB; // color.rgb, duration
attribute vec4 aC; // radius, seed
attribute float aK;
varying vec2 vUv;
varying float vPart;
varying vec3 vColor;
varying float vI;
varying vec3 vN;
varying vec3 vV;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur) { ${CULL} }
  float t = age / dur;
  float op = 1.0 - clamp(age / 0.12, 0.0, 1.0);
  float open = 1.0 - op * op * op;
  float R = aC.x;
  float part = position.z;
  float H = 24.0;
  vec3 C = aA.xyz;
  vPart = part;
  vUv = position.xy;
  vColor = aB.rgb;
  vI = (1.0 - smoothstep(0.3, 1.0, t)) * (1.0 + 0.8 * (1.0 - smoothstep(0.0, 0.25, age)));
  vN = vec3(0.0, 0.0, 1.0);
  vV = vec3(0.0, 0.0, 1.0);
  vec4 mv;
  if (part < 1.5) {
    float ang = position.x * 6.2831853;
    float w = R * open * mix(1.0, 0.3, smoothstep(0.25, 1.0, t)) * mix(1.0, 0.35, part);
    vec3 n = vec3(cos(ang), 0.0, sin(ang));
    mv = viewMatrix * vec4(C + n * w + vec3(0.0, position.y * H * (0.35 + 0.65 * open) - 0.3, 0.0), 1.0);
    vN = mat3(viewMatrix) * n;
    vV = -mv.xyz;
  } else if (part < 2.5) {
    float s = R * 2.2 * (0.5 + 0.5 * open);
    mv = viewMatrix * vec4(C + vec3(position.x * s, 0.06, position.y * s), 1.0);
  } else {
    float h1 = fract(sin(aK * 12.9898 + aC.y * 78.233) * 43758.5453);
    float h2 = fract(sin(aK * 39.3468 + aC.y * 11.135) * 24634.6345);
    float c = fract(age * (0.5 + 0.6 * h2) + h1);
    float an = h1 * 6.2831853 + age * 2.0;
    float rr = R * 0.9 * sqrt(h2) * open;
    mv = viewMatrix * vec4(C + vec3(cos(an) * rr, c * H * 0.45, sin(an) * rr), 1.0);
    mv.xy += position.xy * (0.07 + 0.08 * h1) * (1.0 - c) * (0.5 + 0.5 * sqrt(R));
  }
  gl_Position = projectionMatrix * mv;
}`;
const PILLAR_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vPart;
varying vec3 vColor;
varying float vI;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 col;
  if (vPart < 1.5) {
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float v = vUv.y;
    float prof = pow(facing, mix(1.6, 1.2, vPart));
    float vert = (1.0 - v) * (1.0 - v) * smoothstep(0.0, 0.02, v);
    float bands = 0.75 + 0.25 * sin(v * 60.0 - uTime * 14.0 + vUv.x * 18.849556);
    vec3 c = mix(vColor, mix(vColor, vec3(1.0), 0.65), vPart);
    col = c * prof * vert * bands * mix(1.0, 2.2, vPart);
  } else if (vPart < 2.5) {
    float r = length(vUv);
    if (r >= 1.0) discard;
    float g = 1.0 - r;
    float rd = (r - 0.45) / 0.08;
    col = vColor * (g * g * 1.3 + exp(-rd * rd) * 0.9);
  } else {
    float r = length(vUv);
    if (r >= 1.0) discard;
    col = mix(vColor, vec3(1.0), 0.5) * exp(-r * r * 5.0) * (1.0 - r) * 2.5;
  }
  gl_FragColor = vec4(col * vI, 1.0);
  #include <colorspace_fragment>
}`;

// ---- frost nova: expanding icy ground ring + crystals riding the edge + frosty mist
const FROST_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // center.xyz, spawn
attribute vec4 aB; // radius, duration, seed
attribute float aK;
varying vec2 vUv;
varying vec2 vLoc;
varying float vPart;
varying float vR;
varying float vE;
varying float vFade;
varying float vSeed;
void main() {
  float age = uTime - aA.w;
  float dur = aB.y;
  float L = dur + 0.5;
  if (age < 0.0 || age >= L) { ${CULL} }
  float e = clamp(age / dur, 0.0, 1.0);
  float ie = 1.0 - e;
  float R = aB.x;
  float Rt = R * (1.0 - ie * ie * ie);
  float fade = 1.0 - smoothstep(dur * 0.7, L, age);
  float part = position.z;
  vec3 C = aA.xyz;
  float sc = clamp(R / 6.0, 0.6, 1.6);
  vPart = part;
  vUv = position.xy;
  vLoc = vec2(0.0);
  vR = Rt;
  vE = e;
  vFade = fade;
  vSeed = aB.z;
  vec4 mv;
  if (part < 0.5) {
    float s = R * 1.05 + 0.6;
    vLoc = position.xy * s;
    mv = viewMatrix * vec4(C + vec3(vLoc.x, 0.07, vLoc.y), 1.0);
  } else if (part < 1.5) {
    float h1 = fract(sin(aK * 12.9898 + aB.z * 78.233) * 43758.5453);
    float h2 = fract(sin(aK * 39.3468 + aB.z * 11.135) * 24634.6345);
    float th = (aK + h1 * 0.6) / 28.0 * 6.2831853;
    vec3 od = vec3(cos(th), 0.0, sin(th));
    vec3 base = C + od * (Rt * (0.93 + 0.08 * h2));
    float grow = smoothstep(0.0, 0.2, e) * (1.0 - smoothstep(0.75, 1.0, age / L));
    float hgt = (0.45 + 0.6 * h2) * sc * grow;
    vec3 toCam = cameraPosition - base;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
    vec3 up = normalize(vec3(0.0, 1.0, 0.0) + od * (0.25 + 0.3 * h1));
    mv = viewMatrix * vec4(base + right * (position.x * hgt * 0.32) + up * ((position.y * 0.5 + 0.5) * hgt - 0.05), 1.0);
  } else {
    float h1 = fract(sin(aK * 12.9898 + aB.z * 78.233) * 43758.5453);
    float h2 = fract(sin(aK * 39.3468 + aB.z * 11.135) * 24634.6345);
    float th = (aK + h1) / 14.0 * 6.2831853;
    vec3 base = C + vec3(cos(th), 0.0, sin(th)) * (Rt * (0.82 + 0.15 * h2)) + vec3(0.0, 0.35 + age * 0.8, 0.0);
    mv = viewMatrix * vec4(base, 1.0);
    mv.xy += position.xy * ((0.9 + 0.8 * h2) * sc * (0.6 + 0.6 * e));
    vFade = fade * smoothstep(0.0, 0.15, age);
  }
  gl_Position = projectionMatrix * mv;
}`;
const FROST_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec2 vLoc;
varying float vPart;
varying float vR;
varying float vE;
varying float vFade;
varying float vSeed;
${NOISE_GLSL}
void main() {
  vec3 col;
  float a;
  if (vPart < 0.5) {
    float r = length(vLoc);
    float dE = vR - r;
    float aaE = fwidth(r) * 1.5 + 0.02;
    float inside = smoothstep(-aaE, 0.0, dE);
    if (inside <= 0.0) discard;
    float band = exp(-max(dE, 0.0) * 2.8);
    float n = fxNoise(vLoc * 1.3 + vSeed * 17.0);
    float cr = 1.0 - abs(fxNoise(vLoc * 0.9 + vSeed * 5.0 + 3.0) * 2.0 - 1.0);
    cr = cr * cr * cr * cr * cr * cr * cr * cr;
    float fill = inside * (0.25 + 0.35 * n + 0.6 * cr) * (1.0 - 0.5 * vE);
    a = fill * 0.42 * vFade;
    col = vec3(0.8, 0.93, 1.0) * a + vec3(0.6, 0.95, 1.4) * (band * inside * (1.1 - vE * 0.6) * vFade);
  } else if (vPart < 1.5) {
    float y = vUv.y * 0.5 + 0.5;
    float halfW = 1.0 - smoothstep(0.55, 1.0, y);
    float x = abs(vUv.x);
    if (x > halfW) discard;
    float facet = vUv.x < 0.0 ? 0.62 : 1.0;
    float hi = smoothstep(halfW - 0.2, halfW, x) + (1.0 - smoothstep(0.0, 0.08, x)) * 0.6;
    a = 0.82 * vFade;
    col = (mix(vec3(0.3, 0.7, 1.0), vec3(0.85, 0.97, 1.0), y) * facet * 1.1 + vec3(1.2, 1.5, 1.7) * hi * 0.8) * a;
  } else {
    float r = length(vUv);
    if (r >= 1.0) discard;
    float s = 1.0 - r;
    a = s * s * 0.3 * vFade;
    col = vec3(0.85, 0.95, 1.0) * a;
  }
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

// ---- soft additive ground glow (lava pools, burning aftermath, freeze zones)
const GLOW_VS = /* glsl */`
uniform float uTime;
attribute vec4 aA; // center.xyz, spawn
attribute vec4 aB; // color.rgb, duration
attribute vec4 aC; // radius, seed
varying vec2 vUv;
varying vec3 vColor;
varying float vI;
varying float vSeed;
void main() {
  float age = uTime - aA.w;
  float dur = aB.w;
  if (age < 0.0 || age >= dur) { ${CULL} }
  float fin = smoothstep(0.0, 0.18, age);
  float fout = 1.0 - smoothstep(max(dur - 0.5, dur * 0.6), dur, age);
  float R = aC.x * (0.7 + 0.3 * fin);
  gl_Position = projectionMatrix * viewMatrix * vec4(aA.xyz + vec3(position.x * R, 0.05, position.z * R), 1.0);
  vUv = position.xz;
  vColor = aB.rgb;
  vI = fin * fout;
  vSeed = aC.y;
}`;
const GLOW_FS = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vI;
varying float vSeed;
${NOISE_GLSL}
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float n = fxNoise(vec2(cos(ang), sin(ang)) * 1.5 + vec2(r * 3.0 - uTime * 0.6, vSeed * 9.0));
  float g = 1.0 - r;
  g = g * g * (0.75 + 0.5 * n);
  float pulse = 0.9 + 0.1 * sin(uTime * 4.0 + vSeed * 20.0);
  gl_FragColor = vec4(vColor * (g * vI * pulse * 1.3), 1.0);
  #include <colorspace_fragment>
}`;

// ---- geometry helpers
/** InstancedBufferGeometry built from quads ([-1,1]^2) and grids ([0,1]^2); position.z = part id, aK = index. */
function partsGeometry(build) {
  const pos = [], kk = [], idx = [];
  build({
    quad(part, k = 0) {
      const b = pos.length / 3;
      pos.push(-1, -1, part, 1, -1, part, 1, 1, part, -1, 1, part);
      kk.push(k, k, k, k);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    },
    grid(part, nu, nv) {
      const b = pos.length / 3;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { pos.push(i / nu, j / nv, part); kk.push(0); }
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = b + j * (nu + 1) + i, c = a + nu + 1;
        idx.push(a, a + 1, c + 1, a, c + 1, c);
      }
    },
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aK', new THREE.Float32BufferAttribute(kk, 1));
  g.setIndex(idx);
  g.instanceCount = 0;
  g.boundingSphere = bigSphere();
  return g;
}

/** Jagged 5-sided unit spike: base buried at y = -0.3, tip at y = 1, base radius ~1 (outward CCW winding). */
function spikeGeometry() {
  const S = 5, rings = [[-0.3, 1.0], [0.05, 0.9], [0.42, 0.56], [0.74, 0.24]];
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const RV = rings.map(([y, r]) => {
    const vs = [];
    for (let i = 0; i < S; i++) {
      const a = (i / S) * TAU + (rnd() - 0.5) * 0.5, rr = r * (0.8 + 0.4 * rnd());
      vs.push([Math.cos(a) * rr + (y > 0.3 ? 0.05 : 0), y + (rnd() - 0.5) * 0.06, Math.sin(a) * rr]);
    }
    return vs;
  });
  const pos = [], tri = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let j = 0; j < RV.length - 1; j++) {
    const A = RV[j], B = RV[j + 1];
    for (let i = 0; i < S; i++) { const i2 = (i + 1) % S; tri(A[i], B[i2], A[i2]); tri(A[i], B[i], B[i2]); }
  }
  const T = RV[RV.length - 1], tip = [0.1, 1.0, -0.04];
  for (let i = 0; i < S; i++) tri(T[i], tip, T[(i + 1) % S]);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  g.instanceCount = 0;
  g.boundingSphere = bigSphere();
  return g;
}

function pmaMaterial(vertexShader, fragmentShader, uniforms) { // premultiplied: rgb added, alpha occludes
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader, uniforms,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
  });
}

function fxMesh(parent, geo, mat, renderOrder) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = renderOrder;
  mesh.matrixAutoUpdate = false;
  parent.add(mesh);
  return mesh;
}

// Persistent handle slots (sweep beams, tornadoes): tiny buffer, fully re-uploaded when touched.
class SlotBuffer {
  constructor(cap, stride) {
    this.cap = cap; this.stride = stride;
    this.array = new Float32Array(cap * stride);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.array, stride, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.gen = new Uint32Array(cap);
    this.state = new Uint8Array(cap); // 0 free, 1 live, 2 fading out after dispose
    this.stamp = new Float64Array(cap); // fx clock when the slot was last shown (leak reclaim)
    this.now = 0;
    this.live = 0;
  }
  attr(size, offset) { return new THREE.InterleavedBufferAttribute(this.buffer, size, offset); }
  /** steal = true: when full, reclaim the live slot not shown for the longest time (> 1 s); its old handle goes inert. */
  alloc(steal = false) {
    for (let i = 0; i < this.cap; i++) {
      if (this.state[i] === 0) { this.state[i] = 1; this.gen[i]++; this.live++; this.stamp[i] = this.now; return i; }
    }
    if (!steal) return -1;
    let best = -1, bt = this.now - 1;
    for (let i = 0; i < this.cap; i++) if (this.state[i] === 1 && this.stamp[i] < bt) { bt = this.stamp[i]; best = i; }
    if (best >= 0) { this.gen[best]++; this.stamp[best] = this.now; }
    return best;
  }
  release(i) { // slot becomes reusable; any handle to it goes inert
    if (this.state[i] === 0) return;
    this.state[i] = 0; this.gen[i]++; this.live--;
    this.array.fill(0, i * this.stride, (i + 1) * this.stride);
    this.buffer.needsUpdate = true;
  }
}

const _hsl = { h: 0, s: 0, l: 0 };
function isFireColor(c) { c.getHSL(_hsl, THREE.SRGBColorSpace); return _hsl.h > 0.025 && _hsl.h < 0.12 && _hsl.s > 0.5; }

/** Handle returned by fx.sweepBeam(). All methods are no-ops after dispose() (or if the pool was full). */
class SweepBeamHandle {
  constructor(sb, i) { this._sb = sb; this._i = i; this._gen = i >= 0 ? sb.gen[i] : 0; this._vis = true; this._int = 1; this._placed = false; }
  get alive() { return this._i >= 0 && this._sb.gen[this._i] === this._gen; }
  /** from/to: world Vector3-likes; width: full beam width in m (kept if omitted). */
  set(from, to, width) {
    if (!this.alive || badV(from) || badV(to)) return this;
    const A = this._sb.array, o = this._i * 16;
    A[o] = from.x; A[o + 1] = from.y; A[o + 2] = from.z;
    if (width !== undefined) A[o + 3] = clampN(width, A[o + 3], 0.02, 50);
    A[o + 4] = to.x; A[o + 5] = to.y; A[o + 6] = to.z;
    this._placed = true;
    return this._write();
  }
  setVisible(v) { this._vis = !!v; return this._write(); }
  setIntensity(x) { this._int = clampN(x, 0, 0, 20); return this._write(); }
  _write() {
    if (!this.alive) return this;
    const sb = this._sb, v = this._vis && this._placed ? this._int : 0;
    sb.array[this._i * 16 + 7] = v;
    if (v > 0) sb.stamp[this._i] = sb.now;
    sb.buffer.needsUpdate = true;
    return this;
  }
  dispose() { if (this.alive) this._sb.release(this._i); this._i = -1; }
}

/** Handle returned by fx.tornado(). Intensity eases toward its target; dispose() fades out, then frees the slot. */
class TornadoHandle {
  constructor(fx, i) { this._fx = fx; this._sb = fx._tornSlots; this._i = i; this._gen = i >= 0 ? this._sb.gen[i] : 0; }
  get alive() { return this._i >= 0 && this._sb.gen[this._i] === this._gen && this._sb.state[this._i] === 1; }
  setPosition(v) {
    if (!this.alive || badV(v)) return this;
    const A = this._sb.array, o = this._i * 8;
    A[o] = v.x; A[o + 1] = v.y; A[o + 2] = v.z;
    this._fx._tornPlaced[this._i] = 1;
    this._sb.buffer.needsUpdate = true;
    return this;
  }
  setIntensity(x) { if (this.alive) this._fx._tornTarget[this._i] = clampN(x, 0, 0, 3); return this; }
  dispose() {
    if (!this.alive) { this._i = -1; return; }
    const i = this._i, sb = this._sb;
    sb.state[i] = 2; sb.gen[i]++; // inert handle; slot fades out in fx.update, then frees
    this._fx._tornTarget[i] = 0;
    this._i = -1;
  }
}

const AMB_KINDS = Object.assign(Object.create(null), {
  none: 0, off: 0, tropical: 1, snow: 2, frost: 2, sand: 3, desert: 3, wisps: 4, grave: 4, embers: 5, volcano: 5,
});
const SPIKE_KINDS = Object.assign(Object.create(null), { ice: 0, sand: 1, bone: 2, lava: 3 });
const SPIKE_COLORS = ['#8fe3ff', '#d8a868', '#eee4c8', '#3a2620'].map((c) => new THREE.Color(c));
const SPIKE_FX = [ // shard color, shard glow, dust color
  ['#c8f6ff', 1.7, '#e6f7ff'], ['#d9a86a', 1, '#d8b27a'], ['#efe6cf', 1, '#9c9486'], ['#ff7a1a', 2.4, '#3b3230'],
];

// =============================================================================================
// Damage-number glyph atlas: 16 glyphs in an 8x2 grid of 128px cells, white fill + dark outline.
const GLYPHS = '0123456789.KMB!+';
const G_DOT = 10, G_K = 11, G_M = 12, G_B = 13, G_BANG = 14, G_PLUS = 15;

function buildNumberAtlas() {
  const CW = 128, COLS = 8, ROWS = 2, fontPx = 92;
  const cv = document.createElement('canvas');
  cv.width = CW * COLS;
  cv.height = CW * ROWS;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.font = `900 ${fontPx}px "Arial Black", "Arial Rounded MT Bold", "Helvetica Neue", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  const adv = new Float32Array(16);
  for (let i = 0; i < 16; i++) {
    const ch = GLYPHS[i];
    const cx = (i % COLS) * CW + CW / 2;
    const by = Math.floor(i / COLS) * CW + CW / 2 + fontPx * 0.36;
    ctx.lineWidth = 18;
    ctx.strokeStyle = 'rgba(12,4,20,0.55)';
    ctx.strokeText(ch, cx + 3, by + 5); // drop shadow
    ctx.strokeStyle = '#170a20';
    ctx.strokeText(ch, cx, by);
    const grd = ctx.createLinearGradient(0, by - fontPx * 0.72, 0, by);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.55, '#ffffff');
    grd.addColorStop(1, '#d2d2d2');
    ctx.fillStyle = grd;
    ctx.fillText(ch, cx, by);
    const w = ctx.measureText(ch).width;
    adv[i] = Math.min(1, Math.max(0.2, (w + 7) / CW));
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return { tex, adv };
}

// =============================================================================================
// Text popups: pooled sprites with cached canvas textures.
class PopTexts {
  constructor(parent, cap = 32) {
    this.cache = new Map();
    this.items = [];
    this.next = 0;
    const blank = document.createElement('canvas');
    blank.width = 2; blank.height = 2;
    this.blank = new THREE.CanvasTexture(blank); // so materials compile with USE_MAP from the start
    this.blank.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < cap; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.blank, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      sp.renderOrder = 20;
      sp.frustumCulled = false;
      parent.add(sp);
      this.items.push({ sp, mat, active: false, age: 0, life: 1.1, x: 0, y: 0, z: 0, size: 1, aspect: 1, rot: 0 });
    }
  }

  _tex(text) {
    let e = this.cache.get(text);
    if (e) return e;
    const fontPx = 96, H = 160, pad = 30;
    const font = `italic 900 ${fontPx}px "Arial Black", Impact, "Helvetica Neue", sans-serif`;
    const cv = document.createElement('canvas');
    let ctx = cv.getContext('2d');
    ctx.font = font;
    const tw = ctx.measureText(text).width || fontPx * 0.6 * text.length;
    cv.width = Math.max(4, Math.ceil(tw + pad * 2));
    cv.height = H;
    ctx = cv.getContext('2d');
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const cx = cv.width / 2, by = 100;
    ctx.lineWidth = 22;
    ctx.strokeStyle = 'rgba(14,5,24,0.6)';
    ctx.strokeText(text, cx + 4, by + 7);
    ctx.strokeStyle = '#1a0b24';
    ctx.strokeText(text, cx, by);
    const grd = ctx.createLinearGradient(0, by - fontPx * 0.75, 0, by);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, '#ffffff');
    grd.addColorStop(1, '#cdcdcd');
    ctx.fillStyle = grd;
    ctx.fillText(text, cx, by);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    e = { tex, aspect: cv.width / cv.height };
    if (this.cache.size >= 64) { // evict oldest (a live sprite using it just re-uploads)
      const k = this.cache.keys().next().value;
      this.cache.get(k).tex.dispose();
      this.cache.delete(k);
    }
    this.cache.set(text, e);
    return e;
  }

  spawn(pos, text, color, size) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    const e = this._tex(String(text));
    it.mat.map = e.tex;
    it.mat.color.copy(colorOf(color, 0xffffff));
    it.mat.opacity = 1;
    it.aspect = e.aspect;
    it.size = size;
    it.x = pos.x; it.y = pos.y; it.z = pos.z;
    it.age = 0;
    it.life = 1.1;
    it.rot = (rand() - 0.5) * 0.3;
    it.active = true;
    it.sp.visible = true;
    it.sp.scale.set(1e-4, 1e-4, 1);
    it.sp.position.set(pos.x, pos.y, pos.z);
  }

  update(dt, camera) {
    const cp = camera ? camera.position : null;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      it.age += dt;
      if (it.age >= it.life) { it.active = false; it.sp.visible = false; continue; }
      const t = it.age / it.life;
      const p = Math.min(1, it.age / 0.18);
      let pop;
      if (p < 0.6) { const q = p / 0.6; pop = 1.3 * (1 - (1 - q) * (1 - q)); }
      else pop = 1.3 - 0.3 * smooth(0, 1, (p - 0.6) / 0.4);
      let df = 1;
      if (cp) {
        const dx = it.x - cp.x, dy = it.y - cp.y, dz = it.z - cp.z;
        df = Math.min(3, Math.max(0.6, 0.5 + Math.sqrt(dx * dx + dy * dy + dz * dz) / 24));
      }
      const rise = 1.4 * (1 - (1 - t) * (1 - t)) * df;
      it.sp.position.set(it.x, it.y + rise, it.z);
      const h = it.size * pop * df;
      it.sp.scale.set(h * it.aspect, h, 1);
      it.mat.rotation = it.rot * (1 - p) + Math.sin(it.age * 9) * 0.03;
      it.mat.opacity = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;
    }
  }

  clear() { for (const it of this.items) { it.active = false; it.sp.visible = false; } }
}

// =============================================================================================
// Speed trail: flat ribbon (camera-agnostic, reads well from a chase cam) behind the player.
const C_CYAN = new THREE.Color('#35e8ff');
const C_YEL = new THREE.Color('#ffd23f');
const C_MAG = new THREE.Color('#ff3bd4');

class Trail {
  constructor(parent) {
    const MAX = 48;
    this.MAX = MAX;
    this.hx = new Float32Array(MAX); this.hy = new Float32Array(MAX); this.hz = new Float32Array(MAX); this.ht = new Float32Array(MAX);
    this.count = 0;
    this.X = new Float32Array(MAX + 1); this.Y = new Float32Array(MAX + 1); this.Z = new Float32Array(MAX + 1); this.A = new Float32Array(MAX + 1);
    const nv = (MAX + 1) * 2;
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const side = new Float32Array(nv);
    for (let i = 0; i < nv; i++) side[i] = (i & 1) ? -1 : 1;
    const idx = [];
    for (let i = 0; i < MAX; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.pos);
    g.setAttribute('aCol', this.col);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    g.boundingSphere = bigSphere();
    this.mesh = new THREE.Mesh(g, fxMaterial(TRAIL_VS, TRAIL_FS, {}, true));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    this.mesh.matrixAutoUpdate = false;
    parent.add(this.mesh);
    this.k = 0; this.inSpeed = 0; this.fresh = false; this.has = false;
    this.px = 0; this.py = 0; this.pz = 0;
    this.height = 0.45;  // ribbon height above playerPos
    this.width = 1.15;   // max width (m)
    this.time = 0.32;    // trail length in seconds
    this.lpx = 1; this.lpz = 0;
    this._c = new THREE.Color();
  }

  input(p, s) {
    this.px = p.x; this.py = p.y; this.pz = p.z;
    this.inSpeed = s > 0 ? (s < 1 ? s : 1) : 0;
    this.fresh = true; this.has = true;
  }

  update(dt, now) {
    const target = this.fresh ? this.inSpeed : 0;
    this.fresh = false;
    this.k += (target - this.k) * Math.min(1, dt * 8);
    const mesh = this.mesh;
    if (!this.has) { mesh.visible = false; return; }
    const { hx, hy, hz, ht, MAX } = this;
    const px = this.px, py = this.py, pz = this.pz;
    if (this.count > 0) {
      const dx = px - hx[0], dy = py - hy[0], dz = pz - hz[0];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 64) this.count = 0; // teleport / respawn
      else if (d2 > 0.04) this._push(px, py, pz, now);
    } else this._push(px, py, pz, now);
    while (this.count > 0 && now - ht[this.count - 1] > this.time) this.count--;
    const vis = smooth(0.12, 0.5, this.k);
    if (vis < 0.01 || this.count < 1) { mesh.visible = false; return; }

    const { X, Y, Z, A } = this;
    let m = 0;
    X[0] = px; Y[0] = py; Z[0] = pz; A[0] = 1; m = 1;
    for (let j = 0; j < this.count; j++) {
      const dx = hx[j] - X[m - 1], dz = hz[j] - Z[m - 1], dy = hy[j] - Y[m - 1];
      if (dx * dx + dy * dy + dz * dz < 0.0025) continue;
      X[m] = hx[j]; Y[m] = hy[j]; Z[m] = hz[j];
      A[m] = clamp01(1 - (now - ht[j]) / this.time);
      m++;
    }
    if (m < 2) { mesh.visible = false; return; }

    const s = this.k, c = this._c;
    if (s < 0.6) c.lerpColors(C_CYAN, C_YEL, smooth(0.3, 0.6, s));
    else c.lerpColors(C_YEL, C_MAG, smooth(0.6, 0.95, s));
    const P = this.pos.array, C = this.col.array;
    const hw0 = this.width * 0.5 * (0.35 + 0.65 * vis), h = this.height;
    let lx = this.lpx, lz = this.lpz;
    for (let j = 0; j < m; j++) {
      const jp = j > 0 ? j - 1 : 0, jn = j < m - 1 ? j + 1 : m - 1;
      let tx = X[jp] - X[jn], tz = Z[jp] - Z[jn];
      const L = Math.sqrt(tx * tx + tz * tz);
      if (L > 1e-4) { lx = -tz / L; lz = tx / L; }
      const a = A[j];
      const w = hw0 * Math.pow(a, 0.6);
      const o = j * 6;
      P[o] = X[j] + lx * w; P[o + 1] = Y[j] + h; P[o + 2] = Z[j] + lz * w;
      P[o + 3] = X[j] - lx * w; P[o + 4] = Y[j] + h; P[o + 5] = Z[j] - lz * w;
      const br = a * a * vis * 1.6;
      C[o] = C[o + 3] = c.r * br; C[o + 1] = C[o + 4] = c.g * br; C[o + 2] = C[o + 5] = c.b * br;
      if (j === 0) { this.lpx = lx; this.lpz = lz; }
    }
    this.pos.clearUpdateRanges(); this.pos.addUpdateRange(0, m * 6); this.pos.needsUpdate = true;
    this.col.clearUpdateRanges(); this.col.addUpdateRange(0, m * 6); this.col.needsUpdate = true;
    mesh.geometry.setDrawRange(0, (m - 1) * 6);
    mesh.visible = true;
  }

  _push(x, y, z, t) {
    const { hx, hy, hz, ht, MAX } = this;
    hx.copyWithin(1, 0, MAX - 1); hy.copyWithin(1, 0, MAX - 1); hz.copyWithin(1, 0, MAX - 1); ht.copyWithin(1, 0, MAX - 1);
    hx[0] = x; hy[0] = y; hz[0] = z; ht[0] = t;
    if (this.count < MAX) this.count++;
  }

  clear() { this.count = 0; this.k = 0; this.has = false; this.fresh = false; this.mesh.visible = false; }
}

// =============================================================================================
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'FX';
    scene.add(this.root);
    // Screen-space-ish layer (numbers, pop texts); rendered by PostFX after tone mapping.
    this.overlay = new THREE.Scene();
    this.overlay.name = 'FXOverlay';
    scene.userData.fxOverlay = this.overlay;

    this._uTime = { value: 0 };
    this._clock = 0;
    this._camera = null;
    /** Optional (x, z) => groundY. Evaluated once per burst/confetti call for particle floor bounces. */
    this.getGroundY = null;
    /** Base world height (m) of one damage-number glyph cell at 12 m camera distance. */
    this.numberSize = 0.75;

    const U = this._uTime;

    // --- particles
    this.shards = new Shards(this.root, 5000);

    // --- dust (GPU animated icosahedra, normal blending)
    this.dustRing = new GpuRing(1536, 12);
    {
      const base = new THREE.IcosahedronGeometry(1, 0);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', base.getAttribute('position'));
      g.instanceCount = 0;
      g.boundingSphere = bigSphere();
      this.dustMesh = ringMesh(this.root, g, fxMaterial(DUST_VS, DUST_FS, { uTime: U }, false), this.dustRing, [['aA', 4], ['aB', 4], ['aC', 4]], 2);
    }

    // --- damage numbers (overlay, one draw call)
    this.atlas = buildNumberAtlas();
    this.numRing = new GpuRing(6144, 12);
    {
      const g = instancedQuad(0.5);
      const mat = fxMaterial(NUM_VS, NUM_FS, { uTime: U, uAtlas: { value: this.atlas.tex } }, false, false);
      this.numMesh = ringMesh(this.overlay, g, mat, this.numRing, [['aA', 4], ['aB', 4], ['aC', 4]], 10);
    }
    this._gbuf = new Uint8Array(24);
    this._dbuf = new Uint8Array(12);

    // --- shockwave rings
    this.ringRing = new GpuRing(64, 12);
    {
      const SEG = 64, pos = [], idx = [];
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * TAU, c = Math.cos(a), s = Math.sin(a);
        pos.push(c, 0, s, c, 1, s); // (cos, side, sin): side 0 = inner, 1 = outer
      }
      for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.instanceCount = 0;
      g.boundingSphere = bigSphere();
      this.ringMesh = ringMesh(this.root, g, fxMaterial(RING_VS, RING_FS, { uTime: U }, true), this.ringRing, [['aA', 4], ['aB', 4], ['aC', 4]], 4);
    }

    // --- telegraphs
    this.teleRing = new GpuRing(48, 12);
    this.teleMesh = ringMesh(this.root, instancedQuad(1, true), fxMaterial(TELE_VS, TELE_FS, { uTime: U }, false), this.teleRing, [['aA', 4], ['aB', 4], ['aC', 4]], 1);

    // --- lightning: 96 bolts x 11 points x 2 verts, one draw call
    this.ZAP_PTS = 11;
    this.zapRing = new GpuRing(96 * 22, 16, false);
    {
      const g = new THREE.BufferGeometry();
      const r = this.zapRing;
      g.setAttribute('position', r.attr(3, 0));
      g.setAttribute('aPrev', r.attr(3, 3));
      g.setAttribute('aNext', r.attr(3, 6));
      g.setAttribute('aD', r.attr(3, 9));
      g.setAttribute('aE', r.attr(4, 12));
      const idx = new Uint16Array(96 * 10 * 6);
      let k = 0;
      for (let b = 0; b < 96; b++) {
        for (let s = 0; s < 10; s++) {
          const a = b * 22 + s * 2;
          idx[k++] = a; idx[k++] = a + 1; idx[k++] = a + 2;
          idx[k++] = a + 1; idx[k++] = a + 3; idx[k++] = a + 2;
        }
      }
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.setDrawRange(0, 0);
      g.boundingSphere = bigSphere();
      const mat = fxMaterial(ZAP_VS, ZAP_FS, { uTime: U, uLife: { value: 0.18 } }, true);
      this.zapMesh = new THREE.Mesh(g, mat);
      this.zapMesh.frustumCulled = false;
      this.zapMesh.visible = false;
      this.zapMesh.renderOrder = 6;
      this.zapMesh.matrixAutoUpdate = false;
      this.root.add(this.zapMesh);
    }
    this._zp = new Float32Array(this.ZAP_PTS * 3);

    // --- beams
    this.beamRing = new GpuRing(32, 12);
    {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.instanceCount = 0;
      g.boundingSphere = bigSphere();
      this.beamMesh = ringMesh(this.root, g, fxMaterial(BEAM_VS, BEAM_FS, { uTime: U }, true), this.beamRing, [['aA', 4], ['aB', 4], ['aC', 4]], 6);
    }

    // --- fire patches (flame licks + ground glow), 3072 blobs
    this.fireRing = new GpuRing(3072, 8);
    this.fireMesh = ringMesh(this.root, instancedQuad(1), fxMaterial(FIRE_VS, FIRE_FS, { uTime: U }, true), this.fireRing, [['aA', 4], ['aB', 4]], 3);

    // --- pop texts + trail
    this.pops = new PopTexts(this.overlay, 32);
    this.trailFx = new Trail(this.root);

    this._palette = ['#ff3b6b', '#ffd23f', '#3bf0ff', '#7dff5a', '#b36bff', '#ff8a3d', '#ffffff'].map((c) => new THREE.Color(c));
    this._dustColor = new THREE.Color('#ebe3d4');

    this._initArchipelago();
  }

  // -------------------------------------------------------------------------------------------
  update(dt, time, camera) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._clock += dt;
    this._uTime.value = this._clock;
    if (camera) this._camera = camera;
    this.shards.update(dt);
    const now = this._clock;
    syncRing(this.dustRing, this.dustMesh, now);
    syncRing(this.numRing, this.numMesh, now);
    syncRing(this.ringRing, this.ringMesh, now);
    syncRing(this.teleRing, this.teleMesh, now);
    syncRing(this.beamRing, this.beamMesh, now);
    syncRing(this.fireRing, this.fireMesh, now);
    this.zapRing.flush();
    if (this.zapRing.used > 0 && now > this.zapRing.until) this.zapRing.reset();
    this.zapMesh.geometry.setDrawRange(0, (this.zapRing.used / 22) * 60);
    this.zapMesh.visible = this.zapRing.used > 0;
    this.pops.update(dt, this._camera);
    this.trailFx.update(dt, this._clock);
    this._updateArchipelago(dt, now);
  }

  _floorY(pos, opts) {
    let f = opts.floor;
    if (f === undefined) f = this.getGroundY ? this.getGroundY(pos.x, pos.z) : -1e9;
    if (typeof f !== 'number' || f !== f) f = -1e9;
    return f < pos.y ? f : pos.y;
  }

  // -------------------------------------------------------------------------------------------
  /** Chunky shard burst. opts: { speed=6, size=0.18, life=0.6, gravity=18, up=4, spread=1,
   *  dir (Vector3, biases the spray), drag=1.2, glow=1 (>1 = HDR/bloom), floor (world y) } */
  burst(pos, color, count = 12, opts = EMPTY) {
    const speed = opts.speed ?? 6, size = opts.size ?? 0.18, life = opts.life ?? 0.6;
    const gravity = opts.gravity ?? 18, up = opts.up ?? 4, spread = opts.spread ?? 1;
    const drag = opts.drag ?? 1.2, glow = opts.glow ?? 1, dir = opts.dir;
    const col = colorOf(color, 0xffffff);
    const floor = this._floorY(pos, opts);
    count = Math.min(count | 0, 800);
    for (let k = 0; k < count; k++) {
      const u = rand() * 2 - 1, th = rand() * TAU, sr = Math.sqrt(1 - u * u);
      const dx = sr * Math.cos(th) * spread, dz = sr * Math.sin(th) * spread;
      const sp = speed * (0.35 + 0.65 * rand());
      let vx = dx * sp, vy = u * sp * 0.7 + up * (0.5 + 0.7 * rand()), vz = dz * sp;
      if (dir) { const d = speed * (0.4 + 0.6 * rand()); vx += dir.x * d; vy += dir.y * d; vz += dir.z * d; }
      const br = (0.85 + 0.3 * rand()) * glow;
      this.shards.spawn(
        pos.x + dx * 0.12, pos.y + u * 0.12, pos.z + dz * 0.12, vx, vy, vz,
        size * (0.6 + 0.8 * rand()), life * (0.7 + 0.6 * rand()), gravity, drag, floor, 1,
        col.r * br, col.g * br, col.b * br
      );
    }
  }

  /** Multicolor celebratory burst: slower, floaty paper-like chips, long life. */
  confetti(pos, count = 60) {
    const floor = this._floorY(pos, EMPTY);
    const pal = this._palette;
    count = Math.min(count | 0, 800);
    for (let k = 0; k < count; k++) {
      const th = rand() * TAU, h = 2.5 + rand() * 4.5;
      const c = pal[(rand() * pal.length) | 0];
      const br = 1.05 + 0.2 * rand();
      this.shards.spawn(
        pos.x + (rand() - 0.5) * 0.4, pos.y + rand() * 0.3, pos.z + (rand() - 0.5) * 0.4,
        Math.cos(th) * h, 6 + rand() * 6, Math.sin(th) * h,
        0.11 + rand() * 0.09, 1.6 + rand() * 1.0, 7, 2.2, floor, 0.18,
        c.r * br, c.g * br, c.b * br
      );
    }
  }

  /** Soft puffs that expand & fade (landing, sliding). opts: { color, size=0.45, life=0.65, speed=2.2, up=0.8 } */
  dust(pos, count = 6, opts = EMPTY) {
    const col = colorOf(opts.color, this._dustColor);
    const size = opts.size ?? 0.45, life = opts.life ?? 0.65, speed = opts.speed ?? 2.2, up = opts.up ?? 0.8;
    count = Math.min(count | 0, 256);
    if (count <= 0) return;
    const r = this.dustRing, A = r.array, now = this._clock;
    const s = r.alloc(count);
    for (let k = 0; k < count; k++) {
      const th = rand() * TAU, c = Math.cos(th), sn = Math.sin(th), sp = speed * (0.5 + 0.5 * rand());
      const o = (s + k) * 12;
      A[o] = pos.x + c * 0.2; A[o + 1] = pos.y + 0.1; A[o + 2] = pos.z + sn * 0.2; A[o + 3] = now;
      A[o + 4] = c * sp; A[o + 5] = up * (0.4 + 0.6 * rand()); A[o + 6] = sn * sp; A[o + 7] = life * (0.75 + 0.5 * rand());
      const br = 0.92 + 0.12 * rand();
      A[o + 8] = col.r * br; A[o + 9] = col.g * br; A[o + 10] = col.b * br; A[o + 11] = size * (0.7 + 0.6 * rand());
    }
    r.touch(now + life * 1.25);
  }

  // -------------------------------------------------------------------------------------------
  /** Writes glyph indices for a compact damage value into this._gbuf; returns glyph count. */
  _format(value, crit, plus) {
    const g = this._gbuf;
    let n = 0;
    if (plus) g[n++] = G_PLUS;
    let v = value < 0 ? -value : value;
    if (!(v < 1e15)) v = 1e15 - 1; // Infinity guard
    if (v < 999.5) n = this._int(Math.round(v), n);
    else {
      let unit = G_K, div = 1e3;
      if (v >= 999.5e6) { unit = G_B; div = 1e9; } else if (v >= 999.5e3) { unit = G_M; div = 1e6; }
      const sc = v / div;
      if (sc < 99.95) {
        const q = Math.round(sc * 10), ip = Math.floor(q / 10), dp = q - ip * 10;
        n = this._int(ip, n);
        if (dp > 0) { g[n++] = G_DOT; g[n++] = dp; }
      } else n = this._int(Math.round(sc), n);
      g[n++] = unit;
    }
    if (crit) g[n++] = G_BANG;
    return n;
  }

  _int(x, n) {
    const g = this._gbuf, d = this._dbuf;
    if (x > 9999999) x = 9999999;
    let k = 0;
    do { d[k++] = x % 10; x = Math.floor(x / 10); } while (x > 0);
    while (k > 0) g[n++] = d[--k];
    return n;
  }

  /** opts: { crit=false, color (hex|Color; default white, crit '#FFD23F'), scale=1, plus=false ('+' prefix) } */
  damageNumber(pos, value, opts = EMPTY) {
    if (typeof value !== 'number' || value !== value) return;
    const crit = !!opts.crit;
    const n = this._format(value, crit, !!opts.plus);
    const col = colorOf(opts.color, crit ? '#FFD23F' : 0xffffff);
    const size = (opts.scale ?? 1) * (crit ? 1.4 : 1) * this.numberSize;
    const life = crit ? 1.0 : 0.75;
    const adv = this.atlas.adv, g = this._gbuf;
    let total = 0;
    for (let i = 0; i < n; i++) total += adv[g[i]];
    let x = -total * 0.5;
    const drift = (rand() - 0.5) * 0.9;
    const ox = pos.x + (rand() - 0.5) * 0.35, oy = pos.y + rand() * 0.2, oz = pos.z + (rand() - 0.5) * 0.35;
    const r = this.numRing, A = r.array, now = this._clock;
    const s = r.alloc(n);
    for (let i = 0; i < n; i++) {
      const gi = g[i], a = adv[gi], o = (s + i) * 12;
      A[o] = ox; A[o + 1] = oy; A[o + 2] = oz; A[o + 3] = now;
      A[o + 4] = gi; A[o + 5] = x + a * 0.5; A[o + 6] = size; A[o + 7] = drift;
      A[o + 8] = col.r; A[o + 9] = col.g; A[o + 10] = col.b; A[o + 11] = life;
      x += a;
    }
    r.touch(now + life);
  }

  // -------------------------------------------------------------------------------------------
  ring(pos, radius, color = '#ffffff', duration = 0.45, thickness = 0.35) {
    const c = colorOf(color, 0xffffff), r = this.ringRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = this._clock;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = Math.max(0.02, duration);
    A[o + 8] = Math.max(0.01, radius); A[o + 9] = Math.max(0.01, thickness); A[o + 10] = 0; A[o + 11] = 0;
    r.touch(A[o + 3] + A[o + 7]);
  }

  telegraph(pos, radius, duration, color = '#ff2a2a') {
    const c = colorOf(color, 0xff2a2a), r = this.teleRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = this._clock;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = Math.max(0.05, duration || 0);
    A[o + 8] = Math.max(0.05, radius || 0); A[o + 9] = 0; A[o + 10] = 0; A[o + 11] = 0;
    r.touch(A[o + 3] + A[o + 7] + 0.14);
  }

  /** Jagged lightning bolt. Optional 4th arg: width (m, default 0.22). */
  zap(from, to, color = '#9fe8ff', width = 0.22) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(L > 1e-3)) return;
    const c = colorOf(color, 0x9fe8ff);
    const nseg = Math.min(10, Math.max(6, Math.round(L / 0.9)));
    // perpendicular basis (u, w) around the bolt direction
    const ix = dx / L, iy = dy / L, iz = dz / L;
    let ux = -iz, uy = 0, uz = ix; // cross(dir, up)
    let ul = Math.sqrt(ux * ux + uz * uz);
    if (ul < 1e-3) { ux = 0; uy = iz; uz = -iy; ul = Math.sqrt(uy * uy + uz * uz); } // cross(dir, x)
    ux /= ul; uy /= ul; uz /= ul;
    const wx = iy * uz - iz * uy, wy = iz * ux - ix * uz, wz = ix * uy - iy * ux;
    const amp = Math.min(0.12 * L + 0.1, 1.4);
    const P = this._zp, NP = this.ZAP_PTS;
    for (let i = 0; i < NP; i++) {
      const o = i * 3;
      if (i === 0) { P[0] = from.x; P[1] = from.y; P[2] = from.z; continue; }
      if (i >= nseg) { P[o] = to.x; P[o + 1] = to.y; P[o + 2] = to.z; continue; }
      const t = (i + (rand() - 0.5) * 0.5) / nseg;
      const env = Math.sqrt(Math.sin(Math.PI * (i / nseg)));
      const a = (rand() * 2 - 1) * amp * env, b = (rand() * 2 - 1) * amp * env;
      P[o] = from.x + dx * t + ux * a + wx * b;
      P[o + 1] = from.y + dy * t + uy * a + wy * b;
      P[o + 2] = from.z + dz * t + uz * a + wz * b;
    }
    const r = this.zapRing, A = r.array, now = this._clock, seed = rand();
    const base = r.alloc(22);
    for (let i = 0; i < NP; i++) {
      const ip = (i > 0 ? i - 1 : 0) * 3, ii = i * 3;
      const inx = (i < nseg ? i + 1 : i > nseg ? i : nseg) * 3; // padded points collapse onto 'to'
      const wd = i <= nseg ? width : 0;
      for (let sd = 0; sd < 2; sd++) {
        const o = (base + i * 2 + sd) * 16;
        A[o] = P[ii]; A[o + 1] = P[ii + 1]; A[o + 2] = P[ii + 2];
        A[o + 3] = P[ip]; A[o + 4] = P[ip + 1]; A[o + 5] = P[ip + 2];
        A[o + 6] = P[inx]; A[o + 7] = P[inx + 1]; A[o + 8] = P[inx + 2];
        A[o + 9] = sd === 0 ? -1 : 1; A[o + 10] = wd; A[o + 11] = seed;
        A[o + 12] = c.r; A[o + 13] = c.g; A[o + 14] = c.b; A[o + 15] = now;
      }
    }
    r.touch(now + this.zapMesh.material.uniforms.uLife.value);
  }

  beam(from, to, width = 0.6, color = '#7df9ff', duration = 0.25) {
    const c = colorOf(color, 0x7df9ff), r = this.beamRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = from.x; A[o + 1] = from.y; A[o + 2] = from.z; A[o + 3] = this._clock;
    A[o + 4] = to.x; A[o + 5] = to.y; A[o + 6] = to.z; A[o + 7] = Math.max(0.02, duration);
    A[o + 8] = c.r; A[o + 9] = c.g; A[o + 10] = c.b; A[o + 11] = Math.max(0.01, width);
    r.touch(A[o + 3] + A[o + 7]);
  }

  popText(pos, text, color = '#ffffff', size = 1.5) {
    this.pops.spawn(pos, text, color, size);
  }

  trail(playerPos, speed01) {
    this.trailFx.input(playerPos, speed01);
  }

  fire(pos, radius = 2, duration = 3) {
    radius = Math.max(0.2, radius || 0);
    duration = Math.max(0.1, duration || 0);
    const n = Math.min(12, Math.max(4, Math.round(3 + radius * radius * 1.6)));
    const r = this.fireRing, A = r.array, now = this._clock;
    const s = r.alloc(n + 1);
    let o = s * 8;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = duration; A[o + 5] = radius * 1.25; A[o + 6] = rand(); A[o + 7] = 1;
    for (let k = 0; k < n; k++) {
      o = (s + 1 + k) * 8;
      const rr = radius * 0.8 * Math.sqrt(rand()), th = rand() * TAU;
      A[o] = pos.x + Math.cos(th) * rr; A[o + 1] = pos.y; A[o + 2] = pos.z + Math.sin(th) * rr; A[o + 3] = now;
      A[o + 4] = duration; A[o + 5] = (0.28 + radius * 0.22) * (0.75 + 0.5 * rand()); A[o + 6] = rand(); A[o + 7] = 0;
    }
    r.touch(now + duration);
  }

  // =============================================================================================
  // THE ARCHIPELAGO
  _initArchipelago() {
    const U = this._uTime, root = this.root;
    /** 0..1 multiplier on ambient particle count (e.g. 0.5 on low quality). */
    this.ambientDensity = 1;
    this._bo = { speed: 6, up: 4, size: 0.18, life: 0.6, glow: 1 }; // reusable burst()/dust() opts (no per-spawn garbage)
    this._do = { color: '#ffffff', size: 0.45, life: 0.65, speed: 2.2, up: 0.8 };

    // --- ambient volume: 2400 world-anchored particles wrapped around the camera in the shader
    {
      const N = 2400, arr = new Float32Array(N * 8);
      for (let i = 0; i < arr.length; i++) arr[i] = rand();
      const buf = new THREE.InstancedInterleavedBuffer(arr, 8, 1);
      const g = instancedQuad(1);
      g.setAttribute('aS', new THREE.InterleavedBufferAttribute(buf, 4, 0));
      g.setAttribute('aR', new THREE.InterleavedBufferAttribute(buf, 4, 4));
      g.instanceCount = N;
      const mat = pmaMaterial(AMB_VS, AMB_FS, { uTime: U, uKindA: { value: 0 }, uKindB: { value: 0 }, uMix: { value: 1 }, uDensity: { value: 1 } });
      mat.side = THREE.FrontSide;
      this._amb = { from: 0, to: 0, mix: 1, dur: 2, u: mat.uniforms, mesh: fxMesh(root, g, mat, 8) };
    }

    // --- sweep beams (persistent handles): 16 slots x (body + end flare + start flare)
    {
      const sb = this._sb = new SlotBuffer(16, 16);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([
        0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0,
        -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
        -1, -1, 2, 1, -1, 2, 1, 1, 2, -1, 1, 2,
      ], 3));
      g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11]);
      g.setAttribute('aA', sb.attr(4, 0)); g.setAttribute('aB', sb.attr(4, 4));
      g.setAttribute('aC', sb.attr(4, 8)); g.setAttribute('aD', sb.attr(4, 12));
      g.instanceCount = 16;
      g.boundingSphere = bigSphere();
      this._sbMesh = fxMesh(root, g, fxMaterial(SWEEP_VS, SWEEP_FS, { uTime: U }, true), 7);
    }

    // --- telegraph lines (strip with 16 segments; ground heights at 8 samples)
    this.tlineRing = new GpuRing(96, 20);
    {
      const pos = [], idx = [];
      for (let i = 0; i <= 16; i++) pos.push(i / 16, -1, 0, i / 16, 1, 0);
      for (let i = 0; i < 16; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.instanceCount = 0;
      g.boundingSphere = bigSphere();
      this.tlineMesh = ringMesh(root, g, fxMaterial(TLINE_VS, TLINE_FS, { uTime: U }, false), this.tlineRing,
        [['aA', 4], ['aB', 4], ['aC', 4], ['aH0', 4], ['aH1', 4]], 1);
    }

    // --- telegraph cones
    this.tconeRing = new GpuRing(48, 12);
    this.tconeMesh = ringMesh(root, instancedQuad(1, true), fxMaterial(TCONE_VS, TCONE_FS, { uTime: U }, false), this.tconeRing,
      [['aA', 4], ['aB', 4], ['aC', 4]], 1);

    // --- eruption spikes: 384 spikes (>= 64 eruptions of up to 6), scene-lit
    this.spikeRing = new GpuRing(384, 16);
    {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = U;
        sh.vertexShader = SPK_HEAD + sh.vertexShader.replace('#include <begin_vertex>', SPK_VERT);
        sh.fragmentShader = SPK_FRAG_HEAD + sh.fragmentShader
          .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb = vSpkCol;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + SPK_FRAG_EMIS);
      };
      mat.customProgramCacheKey = () => 'fx-spikes-v1';
      const m = ringMesh(root, spikeGeometry(), mat, this.spikeRing, [['aSA', 4], ['aSB', 4], ['aSC', 4], ['aSD', 4]], 0);
      m.material.transparent = false;
      this.spikeMesh = m;
    }

    // --- black holes (8): halo, core, disc, 40 in-falling sparks each
    this.bhRing = new GpuRing(8, 8);
    {
      const g = partsGeometry((b) => { b.quad(0); b.quad(2); b.quad(1); b.quad(4); for (let k = 0; k < 40; k++) b.quad(3, k); });
      this.bhMesh = ringMesh(root, g, pmaMaterial(BH_VS, BH_FS, { uTime: U }), this.bhRing, [['aA', 4], ['aB', 4]], 5);
    }

    // --- tornadoes (persistent handles): 8 slots
    {
      const sb = this._tornSlots = new SlotBuffer(8, 8);
      this._tornCur = new Float32Array(8);
      this._tornTarget = new Float32Array(8);
      this._tornPlaced = new Uint8Array(8);
      const g = partsGeometry((b) => { b.grid(0, 24, 14); b.grid(1, 24, 14); b.quad(2); for (let k = 0; k < 36; k++) b.quad(3, k); });
      g.setAttribute('aA', sb.attr(4, 0));
      g.setAttribute('aB', sb.attr(4, 4));
      g.instanceCount = 8;
      this._tornMesh = fxMesh(root, g, pmaMaterial(TORN_VS, TORN_FS, { uTime: U }), 4);
    }

    // --- light pillars
    this.pillarRing = new GpuRing(32, 12);
    {
      const g = partsGeometry((b) => { b.grid(0, 24, 1); b.grid(1, 24, 1); b.quad(2); for (let k = 0; k < 16; k++) b.quad(3, k); });
      this.pillarMesh = ringMesh(root, g, fxMaterial(PILLAR_VS, PILLAR_FS, { uTime: U }, true), this.pillarRing, [['aA', 4], ['aB', 4], ['aC', 4]], 6);
    }

    // --- frost novas: ground ring + 28 crystals + 14 mist puffs
    this.frostRing_ = new GpuRing(24, 8);
    {
      const g = partsGeometry((b) => { b.quad(0); for (let k = 0; k < 28; k++) b.quad(1, k); for (let k = 0; k < 14; k++) b.quad(2, k); });
      this.frostMesh = ringMesh(root, g, pmaMaterial(FROST_VS, FROST_FS, { uTime: U }), this.frostRing_, [['aA', 4], ['aB', 4]], 3);
    }

    // --- ground glows
    this.glowRing = new GpuRing(64, 12);
    this.glowMesh = ringMesh(root, instancedQuad(1, true), fxMaterial(GLOW_VS, GLOW_FS, { uTime: U }, true), this.glowRing, [['aA', 4], ['aB', 4], ['aC', 4]], 1);
  }

  _updateArchipelago(dt, now) {
    // ambient crossfade
    const a = this._amb, au = a.u;
    if (a.mix < 1) {
      a.mix = a.dur > 0 ? Math.min(1, a.mix + dt / a.dur) : 1;
      if (a.mix >= 1) a.from = a.to;
    }
    au.uKindA.value = a.from; au.uKindB.value = a.to; au.uMix.value = a.mix;
    au.uDensity.value = clamp01(fin(this.ambientDensity, 1));
    a.mesh.visible = (a.from !== 0 || a.to !== 0) && au.uDensity.value > 0;

    this._sb.now = now;
    this._sbMesh.visible = this._sb.live > 0;

    // tornadoes: ease intensity toward target; slots disposed while visible fade out, then free
    const ts = this._tornSlots, cur = this._tornCur, tgt = this._tornTarget, A = ts.array;
    let any = false;
    for (let i = 0; i < ts.cap; i++) {
      const st = ts.state[i];
      if (st === 0) continue;
      const target = st === 2 ? 0 : tgt[i];
      let c = cur[i] + (target - cur[i]) * Math.min(1, dt * 4);
      if (Math.abs(target - c) < 0.002) c = target;
      cur[i] = c;
      if (st === 2 && c <= 0.002) { ts.release(i); cur[i] = 0; this._tornPlaced[i] = 0; continue; }
      const w = this._tornPlaced[i] ? c : 0;
      if (A[i * 8 + 3] !== w) { A[i * 8 + 3] = w; ts.buffer.needsUpdate = true; }
      any = true;
    }
    this._tornMesh.visible = any;

    syncRing(this.tlineRing, this.tlineMesh, now);
    syncRing(this.tconeRing, this.tconeMesh, now);
    syncRing(this.spikeRing, this.spikeMesh, now);
    syncRing(this.bhRing, this.bhMesh, now);
    syncRing(this.pillarRing, this.pillarMesh, now);
    syncRing(this.frostRing_, this.frostMesh, now);
    syncRing(this.glowRing, this.glowMesh, now);
  }

  _clearArchipelago() {
    for (const [r, m] of [[this.tlineRing, this.tlineMesh], [this.tconeRing, this.tconeMesh], [this.spikeRing, this.spikeMesh],
      [this.bhRing, this.bhMesh], [this.pillarRing, this.pillarMesh], [this.frostRing_, this.frostMesh], [this.glowRing, this.glowMesh]]) {
      r.reset(); m.geometry.instanceCount = 0; m.visible = false;
    }
    // Persistent handles stay valid (the game may own them across runs) but are hidden:
    const sb = this._sb;
    for (let i = 0; i < sb.cap; i++) if (sb.state[i]) sb.array[i * 16 + 7] = 0; // re-shown by the next set()/setIntensity()
    sb.buffer.needsUpdate = true;
    const ts = this._tornSlots;
    for (let i = 0; i < ts.cap; i++) {
      if (ts.state[i] === 2) { ts.release(i); this._tornPlaced[i] = 0; }
      this._tornCur[i] = 0; this._tornTarget[i] = 0; ts.array[i * 8 + 3] = 0;
    }
    ts.buffer.needsUpdate = true;
    this._tornMesh.visible = false;
  }

  _gy(x, z, fb) {
    const g = this.getGroundY;
    if (!g) return fb;
    const y = g(x, z);
    return typeof y === 'number' && y - y === 0 ? y : fb;
  }

  /** Camera-following ambient particles, crossfaded over `seconds`:
   *  'none' | 'tropical' | 'snow' | 'sand' | 'wisps' | 'embers' (biome ids 'frost'/'desert'/'grave'/'volcano' also work). */
  setAmbient(kind, seconds = 2) {
    const k = AMB_KINDS[kind] ?? 0, a = this._amb;
    if (k === a.to) return;
    if (a.mix >= 0.5) a.from = a.to; // the currently dominant kind dissolves out
    a.to = k;
    a.mix = 0;
    a.dur = clampN(seconds, 2, 0, 30);
    if (a.dur <= 0) { a.from = k; a.mix = 1; }
  }

  /** Swirling portal ShaderMaterial for a flat disc (UV 0..1, e.g. CircleGeometry). Animated by fx.update via the shared
   *  uTime uniform (don't .clone() it; make another). Premultiplied blending: bright swirl adds, dark center occludes. */
  makeVortexMaterial(colorA = '#8a2be2', colorB = '#ff3355') {
    return new THREE.ShaderMaterial({
      vertexShader: VORTEX_VS, fragmentShader: VORTEX_FS,
      uniforms: {
        uTime: this._uTime, uIntensity: { value: 1 },
        uColorA: { value: colorOf(colorA, '#8a2be2').clone() }, uColorB: { value: colorOf(colorB, '#ff3355').clone() },
      },
      transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, side: THREE.DoubleSide,
    });
  }

  /** 0 = invisible, 1 = normal, >1 = overdriven (activation flash). */
  setVortexIntensity(material, x) {
    const u = material && material.uniforms && material.uniforms.uIntensity;
    if (u) u.value = clampN(x, 0, 0, 20);
  }

  /** Persistent thick beam: returns { set(from, to, width), setVisible(b), setIntensity(x), dispose() }.
   *  opts.style: 'laser' | 'fire' (default: 'fire' for orange colors). Hidden until the first set(). 16 slots; when
   *  full, the slot hidden/unset for the longest time (> 1 s, i.e. a leaked handle) is reclaimed, else an inert handle
   *  is returned. Always dispose() handles you are done with. */
  sweepBeam(color = '#ff3b3b', opts = EMPTY) {
    const sb = this._sb, i = sb.alloc(true), h = new SweepBeamHandle(sb, i);
    if (i < 0) return h;
    const c = colorOf(color, 0xff3b3b);
    let style = opts && opts.style;
    if (style !== 'laser' && style !== 'fire') style = isFireColor(c) ? 'fire' : 'laser';
    const A = sb.array, o = i * 16;
    A.fill(0, o, o + 16);
    A[o + 3] = 0.8;
    A[o + 8] = c.r; A[o + 9] = c.g; A[o + 10] = c.b; A[o + 11] = style === 'fire' ? 1 : 0;
    A[o + 12] = rand();
    sb.buffer.needsUpdate = true;
    return h;
  }

  /** Ground-hugging warning strip that fills from `from` to `to` over `duration`, then flashes. */
  telegraphLine(from, to, width = 2, duration = 1, color = '#ff2a2a') {
    if (badV(from) || badV(to)) return;
    const c = colorOf(color, 0xff2a2a), r = this.tlineRing, A = r.array, now = this._clock;
    duration = clampN(duration, 1, 0.05, 30);
    const o = r.alloc(1) * 20;
    A[o] = from.x; A[o + 1] = from.y; A[o + 2] = from.z; A[o + 3] = now;
    A[o + 4] = to.x; A[o + 5] = to.y; A[o + 6] = to.z; A[o + 7] = duration;
    A[o + 8] = c.r; A[o + 9] = c.g; A[o + 10] = c.b; A[o + 11] = clampN(width, 2, 0.1, 60);
    for (let k = 0; k < 8; k++) {
      const t = k / 7, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
      A[o + 12 + k] = this._gy(x, z, from.y + (to.y - from.y) * t);
    }
    r.touch(now + duration + 0.16);
  }

  /** Ground warning cone from `pos` toward yaw (0 = +Z), total angle 2*halfAngle (rad), fills outward over `duration`. */
  telegraphCone(pos, yaw = 0, halfAngle = 0.5, range = 10, duration = 1, color = '#ff5a1a') {
    if (badV(pos)) return;
    const c = colorOf(color, 0xff5a1a), r = this.tconeRing, A = r.array, now = this._clock;
    duration = clampN(duration, 1, 0.05, 30);
    const o = r.alloc(1) * 12;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = duration;
    A[o + 8] = fin(yaw, 0) % TAU; A[o + 9] = clampN(halfAngle, 0.5, 0.02, Math.PI); A[o + 10] = clampN(range, 10, 0.2, 200); A[o + 11] = 0;
    r.touch(now + duration + 0.16);
  }

  /** Eruption of 3-6 jagged spikes (pop, hold, sink) + shard/dust burst. kind: 'ice' | 'sand' | 'bone' | 'lava'. */
  spikes(pos, kind = 'ice', scale = 1, duration = 0.9) {
    if (badV(pos)) return;
    const k = SPIKE_KINDS[kind] ?? 0;
    scale = clampN(scale, 1, 0.1, 10);
    duration = clampN(duration, 0.9, 0.35, 30);
    const n = 3 + ((rand() * 4) | 0), base = SPIKE_COLORS[k];
    const r = this.spikeRing, A = r.array, now = this._clock, s = r.alloc(n);
    for (let j = 0; j < n; j++) {
      const o = (s + j) * 16, main = j === 0;
      const th = rand() * TAU, d = main ? rand() * 0.15 * scale : (0.5 + 0.7 * rand()) * scale;
      const x = pos.x + Math.cos(th) * d, z = pos.z + Math.sin(th) * d;
      const delay = main ? 0 : 0.02 + rand() * 0.07;
      const tilt = main ? rand() * 0.1 : 0.18 + rand() * 0.32;
      const br = 0.85 + 0.3 * rand();
      A[o] = x; A[o + 1] = main ? pos.y : this._gy(x, z, pos.y); A[o + 2] = z; A[o + 3] = now + delay;
      A[o + 4] = Math.cos(th) * tilt; A[o + 5] = Math.sin(th) * tilt;
      A[o + 6] = (main ? 2.4 + rand() * 0.9 : 1.1 + rand() * 1.1) * scale; A[o + 7] = (main ? 0.5 : 0.3 + rand() * 0.14) * scale;
      A[o + 8] = base.r * br; A[o + 9] = base.g * br; A[o + 10] = base.b * br; A[o + 11] = k;
      A[o + 12] = duration - delay; A[o + 13] = 0; A[o + 14] = rand(); A[o + 15] = rand() * TAU;
    }
    r.touch(now + duration);
    const fxk = SPIKE_FX[k], m = Math.min(scale, 2.5), bo = this._bo, dop = this._do;
    bo.speed = 6 * m; bo.up = 6 * m; bo.size = 0.16 * m; bo.life = 0.7; bo.glow = fxk[1];
    this.burst(pos, fxk[0], Math.round(7 + 3 * m), bo);
    dop.color = fxk[2]; dop.size = 0.55 * m; dop.speed = 2.8 * m; dop.up = 1.2; dop.life = 0.65;
    this.dust(pos, Math.round(4 + 2 * m), dop);
  }

  /** Icy shard burst (frozen enemy dies, ice spike breaks). */
  shatter(pos, color = '#bfefff') {
    if (badV(pos)) return;
    const c = colorOf(color, 0xbfefff), floor = this._floorY(pos, EMPTY), sh = this.shards;
    for (let k = 0; k < 16; k++) {
      const u = rand() * 2 - 1, th = rand() * TAU, sr = Math.sqrt(1 - u * u), sp = 4 + 7 * rand();
      const br = 1.1 + 0.8 * rand();
      sh.spawn(pos.x, pos.y, pos.z, sr * Math.cos(th) * sp, Math.abs(u) * sp * 0.6 + 3 + 3 * rand(), sr * Math.sin(th) * sp,
        0.1 + 0.16 * rand(), 0.5 + 0.5 * rand(), 20, 1.4, floor, 1.8 + rand(), c.r * br, c.g * br, c.b * br);
    }
    const dop = this._do;
    dop.color = '#e6f7ff'; dop.size = 0.5; dop.life = 0.55; dop.speed = 2.4; dop.up = 1.4;
    this.dust(pos, 5, dop);
    this.ring(pos, 1.6, c, 0.22, 0.35);
  }

  /** Swirling black-hole vortex; grows in, spins for `duration`, collapses with a flash + shockwave ring. */
  blackHole(pos, radius = 5, duration = 3) {
    if (badV(pos)) return;
    radius = clampN(radius, 5, 0.2, 60);
    duration = clampN(duration, 3, 0.4, 60);
    const r = this.bhRing, A = r.array, now = this._clock, o = r.alloc(1) * 8;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = radius; A[o + 5] = duration; A[o + 6] = rand(); A[o + 7] = 0;
    r.touch(now + duration + 0.32);
    // collapse shockwave: a ring record whose spawn time is in the future (GPU culls it until then)
    const rr = this.ringRing, RA = rr.array, q = rr.alloc(1) * 12, when = now + duration - 0.03;
    RA[q] = pos.x; RA[q + 1] = this._gy(pos.x, pos.z, pos.y - 0.9); RA[q + 2] = pos.z; RA[q + 3] = when;
    RA[q + 4] = 0.85; RA[q + 5] = 0.35; RA[q + 6] = 1.6; RA[q + 7] = 0.5;
    RA[q + 8] = radius * 1.4; RA[q + 9] = 1.1; RA[q + 10] = 0; RA[q + 11] = 0;
    rr.touch(when + 0.5);
  }

  /** Persistent sand tornado: returns { setPosition(v), setIntensity(x), dispose() }. Hidden until setPosition().
   *  opts: { height = 12, radius = 1 (funnel scale) }. 8 slots; when exhausted an inert handle is returned. */
  tornado(opts = EMPTY) {
    const ts = this._tornSlots, i = ts.alloc();
    if (i >= 0) {
      const A = ts.array, o = i * 8;
      A.fill(0, o, o + 8);
      A[o + 4] = rand(); A[o + 5] = clampN(opts && opts.height, 12, 1, 80); A[o + 6] = clampN(opts && opts.radius, 1, 0.1, 10);
      this._tornCur[i] = 0; this._tornTarget[i] = 1; this._tornPlaced[i] = 0;
      ts.buffer.needsUpdate = true;
    }
    return new TornadoHandle(this, i);
  }

  /** Vertical light column (teleports, portal activation, shrine level-up). */
  pillar(pos, color = '#bfefff', duration = 0.6, radius = 1.5) {
    if (badV(pos)) return;
    const c = colorOf(color, 0xbfefff), r = this.pillarRing, A = r.array, now = this._clock, o = r.alloc(1) * 12;
    duration = clampN(duration, 0.6, 0.05, 30);
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = duration;
    A[o + 8] = clampN(radius, 1.5, 0.05, 50); A[o + 9] = rand(); A[o + 10] = 0; A[o + 11] = 0;
    r.touch(now + duration);
  }

  /** FROST NOVA: expanding icy ring (to `radius` over `duration`) with edge crystals and mist; lingers 0.5 s. */
  frostRing(pos, radius = 6, duration = 0.5) {
    if (badV(pos)) return;
    const r = this.frostRing_, A = r.array, now = this._clock, o = r.alloc(1) * 8;
    duration = clampN(duration, 0.5, 0.05, 30);
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = clampN(radius, 6, 0.2, 80); A[o + 5] = duration; A[o + 6] = rand(); A[o + 7] = 0;
    r.touch(now + duration + 0.5);
  }

  /** Soft additive ground glow (lava pools, scorched ground, freeze zones). */
  groundGlow(pos, radius = 3, color = '#ff6a1a', duration = 2) {
    if (badV(pos)) return;
    const c = colorOf(color, 0xff6a1a), r = this.glowRing, A = r.array, now = this._clock, o = r.alloc(1) * 12;
    duration = clampN(duration, 2, 0.05, 120);
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = now;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = duration;
    A[o + 8] = clampN(radius, 3, 0.05, 100); A[o + 9] = rand(); A[o + 10] = 0; A[o + 11] = 0;
    r.touch(now + duration);
  }

  clear() {
    this.shards.clear();
    for (const [r, m] of [[this.dustRing, this.dustMesh], [this.numRing, this.numMesh], [this.ringRing, this.ringMesh],
      [this.teleRing, this.teleMesh], [this.beamRing, this.beamMesh], [this.fireRing, this.fireMesh]]) {
      r.reset(); m.geometry.instanceCount = 0; m.visible = false;
    }
    this.zapRing.reset();
    this.zapMesh.geometry.setDrawRange(0, 0);
    this.zapMesh.visible = false;
    this.pops.clear();
    this.trailFx.clear();
    this._clearArchipelago();
  }
}

// =============================================================================================
// PostFX
const SpeedFXShader = {
  name: 'SpeedFX',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },
    uDamage: { value: 0 },
    uLowHp: { value: 0 },
    uFlash: { value: 0 },
    uAspect: { value: 1 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    // biome grade (setGrade), FINAL SWARM (setSwarm), portal travel (warp)
    uTint: { value: new THREE.Color(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVigColor: { value: new THREE.Color(0, 0, 0) },
    uHaze: { value: 0 },
    uExposure: { value: 1 },
    uSwarm: { value: 0 },
    uWarp: { value: 0 },
  },
  vertexShader: /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uSpeed;
uniform float uDamage;
uniform float uLowHp;
uniform float uFlash;
uniform float uAspect;
uniform vec2 uResolution;
uniform vec3 uTint;
uniform float uSat;
uniform float uContrast;
uniform vec3 uVigColor;
uniform float uHaze;
uniform float uExposure;
uniform float uSwarm;
uniform float uWarp;
varying vec2 vUv;

// sine-free hashes (stable for large inputs on all GPUs)
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Anime speed lines: polar cells, each with a streak that streams outward and re-rolls
// (angle offset / length / width / on-off) every time it leaves the screen.
float speedLines(vec2 uv, float k) {
  vec2 d = uv - 0.5;
  float re = length(d * 2.0);               // elliptical radius: 1 at edge midpoints
  float mask = smoothstep(0.42, 0.95, re);   // outer ~60% only
  if (mask <= 0.0 || k <= 0.0) return 0.0;
  vec2 p = d * vec2(uAspect, 1.0) * 2.0;     // aspect-correct, screen height = 2 units
  float r = length(p);
  const float N = 110.0;
  float fa = (atan(p.y, p.x) * 0.15915494 + 0.5) * N;
  float id = floor(fa);
  float f = fract(fa) - 0.5;
  float h1 = hash11(id * 1.37 + 0.11);
  float h2 = hash11(id * 2.71 + 5.3);
  float spd = mix(1.6, 3.2, h1) * mix(0.7, 1.25, k);
  float tt = uTime * spd + h2 * 7.0;
  float cyc = floor(tt);
  float ph = tt - cyc;
  float s1 = hash21(vec2(id, cyc));
  float s2 = hash21(vec2(cyc * 0.37, id + 11.0));
  float s3 = hash21(vec2(id + 3.7, cyc * 1.91));
  float on = step(s1, mix(0.18, 0.62, k));
  float c = (s2 - 0.5) * 0.4;
  float len = mix(0.35, 0.9, s3) * mix(0.55, 1.0, k);
  float head = mix(0.35, 1.55 + len, ph);
  float along = (re - (head - len)) / len;   // 0 at inner tip, 1 at outer head
  float seg = step(0.0, along) * step(along, 1.0);
  float w = mix(0.02, 0.13, clamp(along, 0.0, 1.0)) * mix(0.5, 1.0, s3);
  float aa = N / (6.2831853 * max(r * uResolution.y * 0.5, 1.0));
  float line = 1.0 - smoothstep(w, w + aa * 1.5, abs(f - c));
  float prof = smoothstep(0.0, 0.35, along) * (1.0 - smoothstep(0.9, 1.0, along));
  float fade = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.88, 1.0, ph));
  return line * seg * on * prof * fade * mask;
}

// Portal travel: twisted polar streaks rushing outward (wrapped ids: no seam).
float warpLines(vec2 d, float w) {
  vec2 p = d * vec2(uAspect, 1.0) * 2.0;
  float r = length(p);
  const float N = 72.0;
  float fa = (atan(p.y, p.x) * 0.15915494 + 0.5 + 0.09 * log(r + 0.03) + uTime * 0.04) * N;
  float id = mod(floor(fa), N);
  float f = fract(fa) - 0.5;
  float h1 = hash11(id * 1.37 + 0.11);
  float h2 = hash11(id * 2.71 + 5.3);
  float tt = uTime * mix(0.9, 1.8, h1) + h2 * 5.0;
  float ph = fract(tt);
  float on = step(hash21(vec2(id, floor(tt))), mix(0.25, 0.85, w));
  float len = mix(0.25, 0.7, h2);
  float along = (r - (mix(0.05, 1.9, ph * ph) - len)) / len;
  float seg = step(0.0, along) * step(along, 1.0);
  float wd = mix(0.03, 0.16, clamp(along, 0.0, 1.0));
  float line = 1.0 - smoothstep(wd, wd + 0.1, abs(f));
  return line * seg * on * smoothstep(0.0, 0.4, along) * (1.0 - smoothstep(0.85, 1.0, along));
}

// FINAL SWARM: faint wavy streaks creeping inward from the edges.
float ghostLines(vec2 d) {
  vec2 p = d * vec2(uAspect, 1.0) * 2.0;
  float r = length(p);
  const float N = 40.0;
  float fa = (atan(p.y, p.x) * 0.15915494 + 0.5) * N + sin(r * 3.0 - uTime * 0.7) * 0.35;
  float id = mod(floor(fa), N);
  float f = fract(fa) - 0.5;
  float h1 = hash11(id * 3.17 + 1.3);
  float ph = fract(uTime * mix(0.15, 0.35, h1) + h1 * 5.0);
  float along = (r - mix(2.0, 0.5, ph)) / 0.7;
  float seg = step(0.0, along) * step(along, 1.0) * step(0.4, h1);
  float line = 1.0 - smoothstep(0.04, 0.22, abs(f));
  return line * seg * (1.0 - along) * smoothstep(0.0, 0.15, along);
}

void main() {
  vec2 uv = vUv;
  float wp = clamp(uWarp, 0.0, 1.0);

  // heat shimmer (desert / volcano): strongest low on screen, fading out above the horizon
  if (uHaze > 0.001) {
    float hz = uHaze * (1.0 - smoothstep(0.18, 0.68, uv.y));
    float s1 = sin(uv.y * 110.0 - uTime * 6.0 + sin(uv.x * 17.0 + uTime * 1.3) * 1.7);
    float s2 = sin(uv.y * 63.0 - uTime * 3.7 + uv.x * 29.0 + sin(uv.x * 7.0 - uTime) * 1.2);
    uv += vec2(s1 * 0.65 + s2 * 0.35, s2 * 0.4) * (0.0026 * hz);
  }
  vec2 d = uv - 0.5;
  // warp: swirl + zoom into the tunnel
  if (wp > 0.0) {
    vec2 da = d * vec2(uAspect, 1.0);
    float sw = wp * wp * (1.4 + 2.0 * wp) * (1.0 - smoothstep(0.0, 1.0, length(da)));
    float cs = cos(sw);
    float sn = sin(sw);
    da = vec2(cs * da.x - sn * da.y, sn * da.x + cs * da.y) * (1.0 - 0.3 * wp * wp);
    d = da / vec2(uAspect, 1.0);
    uv = 0.5 + d;
  }
  float re = length(d * 2.0);
  float k = smoothstep(0.35, 1.0, uSpeed);

  // chromatic aberration (radial, spectral) + radial zoom blur at speed / warp, shared taps
  float ca = (uSpeed * 0.6 + clamp(uDamage, 0.0, 1.0) + wp * 2.5) * 0.012 * re;
  float blur = k * 0.035 * smoothstep(0.25, 1.1, re) + wp * 0.3 * smoothstep(0.0, 1.0, re);
  vec3 col;
  if (ca + blur < 0.0004) {
    col = texture2D(tDiffuse, uv).rgb;
  } else {
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    float jit = wp > 0.0 ? hash21(gl_FragCoord.xy + fract(uTime * 7.0) * 113.0) : 0.0;
    for (int i = 0; i < 7; i++) {
      float t = wp > 0.0 ? (float(i) + jit) / 7.0 : float(i) / 6.0;
      vec2 off = d * ((t - 0.5) * 2.0 * ca + t * blur);
      vec3 w = vec3(t, 1.0 - abs(t - 0.5) * 2.0, 1.0 - t) + 0.08;
      acc += texture2D(tDiffuse, uv - off).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }

  // punchy grade + biome grade (linear HDR, before tone mapping); defaults reproduce the base look
  col *= uExposure;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, 1.14 * uSat), 0.0);
  col = pow(col * (1.0 / 0.18), vec3(1.06 * uContrast)) * 0.18;
  col *= uTint;

  // vignette (colored): subtle always, tunnel vision at speed
  float vig = smoothstep(mix(0.55, 0.3, k), 1.45, re);
  col = mix(col, uVigColor, vig * mix(0.28, 0.6, k));

  // FINAL SWARM: pulsing dark, desaturated edges with a sickly cyan/purple tint creeping inward
  float swm = clamp(uSwarm, 0.0, 1.0);
  if (swm > 0.001) {
    float ang = atan(d.y * uAspect, d.x);
    float pz = 0.5 + 0.5 * sin(uTime * 3.2);
    float creep = mix(1.3, 0.62, swm) - 0.07 * pz * swm + 0.05 * sin(ang * 7.0 + uTime * 1.3) + 0.04 * sin(ang * 13.0 - uTime * 2.1);
    float em = smoothstep(creep, creep + 0.55, re) * sqrt(swm);
    vec3 sick = mix(vec3(0.05, 0.55, 0.5), vec3(0.4, 0.08, 0.6), 0.5 + 0.5 * sin(ang * 2.0 + uTime * 0.7));
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, vec3(lum) * 0.45 + sick * (0.06 + 0.08 * pz), em * 0.85);
    col += sick * (ghostLines(d) * em * 0.45);
  }

  // low HP: slow red pulse at the edges
  float pulse = 0.5 + 0.5 * sin(uTime * 5.5);
  col = mix(col, vec3(0.45, 0.0, 0.02), smoothstep(0.45, 1.35, re) * clamp(uLowHp, 0.0, 1.0) * (0.3 + 0.4 * pulse));

  // hit: red edge flash
  col = mix(col, vec3(1.6, 0.05, 0.03), smoothstep(0.5, 1.3, re) * clamp(uDamage, 0.0, 1.0) * 0.7);

  // speed lines
  col += vec3(1.0, 0.97, 0.92) * (speedLines(uv, k) * k * 1.3);

  // warp: chromatic swirling streaks, hot center, white-out at 1
  if (wp > 0.0) {
    float ang = atan(d.y, d.x);
    vec3 sc = mix(vec3(0.35, 0.95, 1.2), vec3(1.2, 0.4, 1.1), 0.5 + 0.5 * sin(ang * 3.0 + uTime * 2.0));
    col += sc * (warpLines(d, wp) * wp * 2.2);
    col += vec3(1.0, 0.95, 1.2) * (wp * wp * 1.6 * (1.0 - smoothstep(0.0, 1.1, re)));
    col = mix(col, vec3(10.0), smoothstep(0.6, 1.0, wp));
  }

  // white flash
  col = mix(col, vec3(2.5), clamp(uFlash, 0.0, 1.0) * 0.85);

  gl_FragColor = vec4(col, 1.0);
}`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = 'high';
    const sz = renderer.getSize(new THREE.Vector2());
    this._w = Math.max(1, sz.x || 1);
    this._h = Math.max(1, sz.y || 1);
    this._t = 0;
    this._speed = 0;
    this._swarm = 0; this._swarmTarget = 0;
    const gs = () => ({ tint: new THREE.Color(1, 1, 1), saturation: 1, contrast: 1, vignetteColor: new THREE.Color(0, 0, 0), haze: 0, exposure: 1 });
    this._grade = { cur: gs(), from: gs(), to: gs(), p: 1, dur: 1.5 };

    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.5, 0.82);
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(2, Math.round(w * 0.5)), Math.max(2, Math.round(h * 0.5))); // half-res bloom
    this.speedPass = new ShaderPass(SpeedFXShader);
    this.outputPass = new OutputPass();
    this.composer = null;
    this.setQuality('high');
  }

  _build() {
    if (this.composer) this.composer.dispose();
    const pr = this.renderer.getPixelRatio();
    const samples = this.quality === 'high' ? (pr >= 1.5 ? 2 : 4) : 0;
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    rt.texture.name = 'PostFX.rt';
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(this.renderPass);
    c.addPass(this.bloom);
    c.addPass(this.speedPass);
    c.addPass(this.outputPass);
    this.composer = c;
    this._applySize();
  }

  _applySize() {
    const pr = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this._w, this._h);
    const u = this.speedPass.uniforms;
    u.uAspect.value = this._w / this._h;
    u.uResolution.value.set(this._w * pr, this._h * pr);
  }

  setSize(width, height) {
    this._w = Math.max(1, width | 0);
    this._h = Math.max(1, height | 0);
    this.renderer.setSize(this._w, this._h);
    this._applySize();
  }

  setQuality(q) {
    this.quality = q === 'low' ? 'low' : 'high';
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.renderer.setPixelRatio(this.quality === 'high' ? Math.min(dpr, 2) : 1);
    this.bloom.enabled = this.quality === 'high';
    this._build();
  }

  /** Per-biome color grade, eased over `seconds` (default 1.5). Omitted fields reset to neutral.
   *  { tint='#ffffff' (multiply), saturation=1, contrast=1, vignetteColor='#000000', haze=0 (heat shimmer 0..1+), exposure=1 } */
  setGrade(opts = EMPTY, seconds = 1.5) {
    const g = this._grade, c = g.cur, f = g.from, t = g.to;
    if (!opts || typeof opts !== 'object') opts = EMPTY;
    f.tint.copy(c.tint); f.saturation = c.saturation; f.contrast = c.contrast;
    f.vignetteColor.copy(c.vignetteColor); f.haze = c.haze; f.exposure = c.exposure;
    t.tint.copy(colorOf(opts.tint, '#ffffff'));
    t.saturation = clampN(opts.saturation, 1, 0, 3);
    t.contrast = clampN(opts.contrast, 1, 0.2, 3);
    t.vignetteColor.copy(colorOf(opts.vignetteColor, '#000000'));
    t.haze = clampN(opts.haze, 0, 0, 3);
    t.exposure = clampN(opts.exposure, 1, 0, 8);
    g.dur = clampN(seconds, 1.5, 0, 30);
    g.p = 0;
    if (g.dur <= 0) this._stepGrade(1);
  }

  /** FINAL SWARM look, 0..1 (eased linearly over ~0.6 s so it creeps in). */
  setSwarm(x) { this._swarmTarget = clampN(x, 0, 0, 1); }

  /** Portal travel 0..1: zoom-blur tunnel + chromatic streaks; 1 = full white. Applied immediately (the game animates it). */
  warp(x) { this.speedPass.uniforms.uWarp.value = clampN(x, 0, 0, 1); }

  _stepGrade(dp) {
    const g = this._grade;
    if (g.p >= 1 && dp < 1) return;
    g.p = Math.min(1, g.p + dp);
    const c = g.cur, f = g.from, t = g.to, u = this.speedPass.uniforms;
    const s = g.p >= 1 ? 1 : g.p * g.p * (3 - 2 * g.p);
    c.tint.lerpColors(f.tint, t.tint, s);
    c.vignetteColor.lerpColors(f.vignetteColor, t.vignetteColor, s);
    const L = (a, b) => (s >= 1 ? b : a + (b - a) * s);
    c.saturation = L(f.saturation, t.saturation);
    c.contrast = L(f.contrast, t.contrast);
    c.haze = L(f.haze, t.haze);
    c.exposure = L(f.exposure, t.exposure);
    u.uTint.value.copy(c.tint); u.uVigColor.value.copy(c.vignetteColor);
    u.uSat.value = c.saturation; u.uContrast.value = c.contrast; u.uHaze.value = c.haze; u.uExposure.value = c.exposure;
  }

  render(dt, opts = EMPTY) {
    if (!(dt > 0)) dt = 0;
    if (this._grade.p < 1) this._stepGrade(this._grade.dur > 0 ? dt / this._grade.dur : 1);
    const sd = this._swarmTarget - this._swarm, sm = dt * 1.6; // linear creep: 0 -> 1 in ~0.6 s
    this._swarm = sd > sm ? this._swarm + sm : sd < -sm ? this._swarm - sm : this._swarmTarget;
    this.speedPass.uniforms.uSwarm.value = this._swarm;
    const speed01 = clamp01(opts.speed01 || 0);
    this._speed += (speed01 - this._speed) * Math.min(1, dt * 10);
    this._t = opts.time > 0 ? opts.time : this._t + dt;
    const u = this.speedPass.uniforms;
    u.uTime.value = this._t % 600;
    u.uSpeed.value = this._speed;
    u.uDamage.value = clamp01(opts.damage || 0);
    u.uLowHp.value = clamp01(opts.lowHp || 0);
    u.uFlash.value = clamp01(opts.flash || 0);
    this.renderPass.camera = this.camera;
    this.composer.render(dt);
    const ov = this.scene.userData && this.scene.userData.fxOverlay;
    if (ov && ov.children.length) {
      const r = this.renderer, ac = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(null);
      r.render(ov, this.camera);
      r.autoClear = ac;
    }
  }
}
