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
  }
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
  reset() { this.cursor = 0; this.used = 0; this.a0 = this.a1 = this.b0 = this.b1 = -1; }
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

function syncRing(ring, mesh) {
  ring.flush();
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
  }

  // -------------------------------------------------------------------------------------------
  update(dt, time, camera) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this._clock += dt;
    this._uTime.value = this._clock;
    if (camera) this._camera = camera;
    this.shards.update(dt);
    syncRing(this.dustRing, this.dustMesh);
    syncRing(this.numRing, this.numMesh);
    syncRing(this.ringRing, this.ringMesh);
    syncRing(this.teleRing, this.teleMesh);
    syncRing(this.beamRing, this.beamMesh);
    syncRing(this.fireRing, this.fireMesh);
    this.zapRing.flush();
    this.zapMesh.geometry.setDrawRange(0, (this.zapRing.used / 22) * 60);
    this.zapMesh.visible = this.zapRing.used > 0;
    this.pops.update(dt, this._camera);
    this.trailFx.update(dt, this._clock);
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
  }

  // -------------------------------------------------------------------------------------------
  ring(pos, radius, color = '#ffffff', duration = 0.45, thickness = 0.35) {
    const c = colorOf(color, 0xffffff), r = this.ringRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = this._clock;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = Math.max(0.02, duration);
    A[o + 8] = Math.max(0.01, radius); A[o + 9] = Math.max(0.01, thickness); A[o + 10] = 0; A[o + 11] = 0;
  }

  telegraph(pos, radius, duration, color = '#ff2a2a') {
    const c = colorOf(color, 0xff2a2a), r = this.teleRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = pos.x; A[o + 1] = pos.y; A[o + 2] = pos.z; A[o + 3] = this._clock;
    A[o + 4] = c.r; A[o + 5] = c.g; A[o + 6] = c.b; A[o + 7] = Math.max(0.05, duration || 0);
    A[o + 8] = Math.max(0.05, radius || 0); A[o + 9] = 0; A[o + 10] = 0; A[o + 11] = 0;
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
  }

  beam(from, to, width = 0.6, color = '#7df9ff', duration = 0.25) {
    const c = colorOf(color, 0x7df9ff), r = this.beamRing, A = r.array;
    const o = r.alloc(1) * 12;
    A[o] = from.x; A[o + 1] = from.y; A[o + 2] = from.z; A[o + 3] = this._clock;
    A[o + 4] = to.x; A[o + 5] = to.y; A[o + 6] = to.z; A[o + 7] = Math.max(0.02, duration);
    A[o + 8] = c.r; A[o + 9] = c.g; A[o + 10] = c.b; A[o + 11] = Math.max(0.01, width);
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

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float re = length(d * 2.0);
  float k = smoothstep(0.35, 1.0, uSpeed);

  // chromatic aberration (radial, spectral) + radial zoom blur at speed, shared taps
  float ca = (uSpeed * 0.6 + clamp(uDamage, 0.0, 1.0)) * 0.012 * re;
  float blur = k * 0.035 * smoothstep(0.25, 1.1, re);
  vec3 col;
  if (ca + blur < 0.0004) {
    col = texture2D(tDiffuse, uv).rgb;
  } else {
    vec3 acc = vec3(0.0);
    vec3 wsum = vec3(0.0);
    for (int i = 0; i < 7; i++) {
      float t = float(i) / 6.0;
      vec2 off = d * ((t - 0.5) * 2.0 * ca + t * blur);
      vec3 w = vec3(t, 1.0 - abs(t - 0.5) * 2.0, 1.0 - t) + 0.08;
      acc += texture2D(tDiffuse, uv - off).rgb * w;
      wsum += w;
    }
    col = acc / wsum;
  }

  // punchy grade (linear HDR, before tone mapping)
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, 1.14), 0.0);
  col = pow(col * (1.0 / 0.18), vec3(1.06)) * 0.18;

  // vignette: subtle always, tunnel vision at speed
  float vig = smoothstep(mix(0.55, 0.3, k), 1.45, re);
  col *= 1.0 - vig * mix(0.28, 0.6, k);

  // low HP: slow red pulse at the edges
  float pulse = 0.5 + 0.5 * sin(uTime * 5.5);
  col = mix(col, vec3(0.45, 0.0, 0.02), smoothstep(0.45, 1.35, re) * clamp(uLowHp, 0.0, 1.0) * (0.3 + 0.4 * pulse));

  // hit: red edge flash
  col = mix(col, vec3(1.6, 0.05, 0.03), smoothstep(0.5, 1.3, re) * clamp(uDamage, 0.0, 1.0) * 0.7);

  // speed lines
  col += vec3(1.0, 0.97, 0.92) * (speedLines(uv, k) * k * 1.3);

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

  render(dt, opts = EMPTY) {
    if (!(dt > 0)) dt = 0;
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
