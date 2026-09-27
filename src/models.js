// VELOCIBONK — procedural low-poly models. Everything is built from primitives in code.
// Conventions: Y-up, meters, characters face +Z (their LEFT is +X), feet at y=0 (bat: origin at body center).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const V = (a) => (a && a.isVector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));
const qUp = (dir) => new THREE.Quaternion().setFromUnitVectors(UP, V(dir).normalize());

// ---------------------------------------------------------------------------
// Shared toon material
// ---------------------------------------------------------------------------
const SHARED_GRADIENT = (() => {
  const d = new Uint8Array([90, 90, 90, 255, 150, 150, 150, 255, 210, 210, 210, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(d, 4, 1, THREE.RGBAFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

export function makeToonMaterial(opts = {}) {
  return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: SHARED_GRADIENT, ...opts });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic hash of a (rounded) position, so coincident vertices of separate faces get the same value.
function hash3(x, y, z, seed = 0) {
  let h = (Math.round(x * 1000) * 73856093) ^ (Math.round(y * 1000) * 19349663) ^ (Math.round(z * 1000) * 83492791) ^ Math.imul(seed + 1, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Radially jitter vertices (consistently for shared positions) — lumpy rocks/blobs. Returns non-indexed geo.
function lumpy(geo, amt, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const s = 1 + (hash3(x, y, z, seed) - 0.5) * 2 * amt;
    p.setXYZ(i, x * s, y * s, z * s);
  }
  return g;
}

const _colCache = new Map();
function col(c) {
  if (c && c.isColor) return c;
  let out = _colCache.get(c);
  if (!out) { out = new THREE.Color(c); _colCache.set(c, out); }
  return out;
}

// Swap vertices 1 and 2 of every triangle (reverses winding).
function flipArr(arr, size) {
  for (let t = 0; t < arr.length; t += size * 3) {
    for (let j = 0; j < size; j++) {
      const a = t + size + j, b = t + size * 2 + j;
      const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp;
    }
  }
}

// Remove zero-area triangles (cone tips, lathe poles) from a non-indexed geometry.
function dropDegenerate(g) {
  const p = g.attributes.position.array;
  const n = p.length / 9;
  const keep = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < n; t++) {
    a.fromArray(p, t * 9); b.fromArray(p, t * 9 + 3); c.fromArray(p, t * 9 + 6);
    b.sub(a); c.sub(a);
    if (b.cross(c).lengthSq() > 1e-14) keep.push(t);
  }
  if (keep.length === n) return g;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const s = attr.itemSize;
    const arr = new Float32Array(keep.length * 3 * s);
    keep.forEach((t, i) => arr.set(attr.array.subarray(t * 3 * s, (t + 1) * 3 * s), i * 3 * s));
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  out.userData = g.userData;
  return out;
}

// Geometry from a flat list of triangles [[x,y,z],[x,y,z],[x,y,z], ...]
function triGeo(verts) {
  const arr = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { arr[i * 3] = v[0] ?? v.x; arr[i * 3 + 1] = v[1] ?? v.y; arr[i * 3 + 2] = v[2] ?? v.z; });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  return g;
}

// Tube along a polyline with per-point radius (0 = pointed end). Faces are forced outward.
function sweepGeo(path, radii, radial, flat = 1) {
  const P = path.map(V);
  const rings = [];
  let prevN = null;
  for (let i = 0; i < P.length; i++) {
    const T = (i === 0 ? P[1].clone().sub(P[0]) : i === P.length - 1 ? P[i].clone().sub(P[i - 1]) : P[i + 1].clone().sub(P[i - 1])).normalize();
    let N;
    if (prevN) N = prevN.clone().addScaledVector(T, -prevN.dot(T)).normalize();
    else N = new THREE.Vector3().crossVectors(Math.abs(T.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0), T).normalize();
    prevN = N;
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    const ring = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU;
      ring.push(P[i].clone().addScaledVector(N, Math.cos(a) * radii[i]).addScaledVector(B, Math.sin(a) * radii[i] * flat));
    }
    rings.push(ring);
  }
  const verts = [];
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), m = new THREE.Vector3();
  const push = (a, b, c, ctr) => {
    e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2);
    m.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(ctr);
    if (nrm.dot(m) < 0) verts.push(a, c, b); else verts.push(a, b, c);
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const ctr = P[i].clone().add(P[i + 1]).multiplyScalar(0.5);
    for (let j = 0; j < radial; j++) {
      const j2 = (j + 1) % radial;
      push(rings[i][j], rings[i][j2], rings[i + 1][j2], ctr);
      push(rings[i][j], rings[i + 1][j2], rings[i + 1][j], ctr);
    }
  }
  return triGeo(verts);
}

// Kit: accumulates tagged, transformed, vertex-coloured pieces and merges them into one flat-shaded geometry.
class Kit {
  constructor(limbs = false, seed = 1) {
    this.parts = [];
    this.limbs = limbs;
    this.rng = mulberry32(seed);
  }

  // o: { p:[x,y,z], r:[rx,ry,rz] | q:Quaternion, s:number|[sx,sy,sz], order, limb, pivot, jitter, inv, perVertex }
  // color: hex/Color, or fn(localCentroid, worldCentroid, faceIndex) -> hex/Color (evaluated per face)
  add(geo, color, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.morphAttributes = {};
    g.clearGroups();
    const local = g.attributes.position.array.slice();
    const q = o.q ? o.q : new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r || [0, 0, 0]), o.order || 'XYZ'));
    const s = o.s === undefined ? [1, 1, 1] : typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s;
    const m = new THREE.Matrix4().compose(V(o.p || [0, 0, 0]), q, V(s));
    g.applyMatrix4(m);
    const pos = g.attributes.position.array;
    let flip = m.determinant() < 0;
    if (o.inv) flip = !flip;
    if (flip) { flipArr(pos, 3); flipArr(local, 3); }
    const n = pos.length / 3;
    const colArr = new Float32Array(n * 3);
    const jit = o.jitter ?? 0.05;
    const fixed = typeof color === 'function' ? null : col(color);
    const L = new THREE.Vector3(), W = new THREE.Vector3();
    for (let v = 0; v < n; v += 3) {
      const k = 1 + (this.rng() * 2 - 1) * jit;
      for (let j = 0; j < 3; j++) {
        let c = fixed;
        if (!c) {
          if (o.perVertex) {
            L.fromArray(local, (v + j) * 3); W.fromArray(pos, (v + j) * 3);
            c = col(color(L, W, v / 3));
          } else {
            if (j === 0) {
              L.set(0, 0, 0); W.set(0, 0, 0);
              for (let t = 0; t < 3; t++) {
                L.x += local[(v + t) * 3] / 3; L.y += local[(v + t) * 3 + 1] / 3; L.z += local[(v + t) * 3 + 2] / 3;
                W.x += pos[(v + t) * 3] / 3; W.y += pos[(v + t) * 3 + 1] / 3; W.z += pos[(v + t) * 3 + 2] / 3;
              }
              this._fc = col(color(L, W, v / 3));
            }
            c = this._fc;
          }
        }
        const i = (v + j) * 3;
        // LDR colours clamp at 1 exactly as before; HDR (glow) colours may exceed 1 so they bloom.
        colArr[i] = Math.min(Math.max(1, c.r), c.r * k); colArr[i + 1] = Math.min(Math.max(1, c.g), c.g * k); colArr[i + 2] = Math.min(Math.max(1, c.b), c.b * k);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    if (this.limbs) {
      const limb = o.limb || 0;
      const pv = limb ? o.pivot || [0, 0, 0] : [0, 0, 0];
      g.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(n).fill(limb), 1));
      const pa = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pa[i * 3] = pv[0]; pa[i * 3 + 1] = pv[1]; pa[i * 3 + 2] = pv[2]; }
      g.setAttribute('aPivot', new THREE.BufferAttribute(pa, 3));
    }
    this.parts.push(g);
    return this;
  }

  // Cylinder/cone from point a (radius ra) to point b (radius rb).
  seg(a, b, ra, rb, radial, color, o = {}) {
    const A = V(a), B = V(b);
    const d = B.clone().sub(A);
    const geo = new THREE.CylinderGeometry(rb, ra, d.length(), radial, 1, !!o.open);
    return this.add(geo, color, { ...o, p: A.add(B).multiplyScalar(0.5).toArray(), q: qUp(d) });
  }

  // Cartoon eye: white dome + glossy pupil + sparkle, facing `dir`.
  eye(c, r, o = {}) {
    const dir = V(o.dir || [0, 0, 1]).normalize();
    const pdir = dir.clone().add(V(o.look || [0, 0, 0])).normalize();
    const depth = o.depth || 1;
    const b = { limb: o.limb, pivot: o.pivot, jitter: 0 };
    const C = V(c);
    this.add(o.full ? new THREE.SphereGeometry(r, o.seg || 8, o.full) : new THREE.SphereGeometry(r, o.seg || 8, o.hs || 3, 0, TAU, 0, Math.PI / 2), o.white || '#FFFFFF', { ...b, p: c, q: qUp(dir), s: [1, depth, 1] });
    const rp = r * (o.pupil || 0.55);
    const ax = pdir.dot(dir), perp = Math.sqrt(Math.max(0, 1 - ax * ax));
    const t = 1 / Math.sqrt((perp * perp) / (r * r) + (ax * ax) / (r * depth * r * depth));
    const pb = C.clone().addScaledVector(pdir, t - rp * 0.35);
    this.add(new THREE.SphereGeometry(rp, o.pseg || 7, 2, 0, TAU, 0, Math.PI / 2), o.black || '#1A1030', { ...b, p: pb.toArray(), q: qUp(pdir), s: [o.px || 1, 0.5, o.pz || 1] });
    if (o.hl !== false) {
      const upT = UP.clone().addScaledVector(pdir, -pdir.y).normalize();
      const side = new THREE.Vector3().crossVectors(upT, pdir).normalize();
      const hp = pb.clone().addScaledVector(pdir, rp * 0.45).addScaledVector(upT, rp * 0.38).addScaledVector(side, -rp * 0.3);
      this.add(new THREE.OctahedronGeometry(rp * 0.26, 0), '#FFFFFF', { ...b, p: hp.toArray() });
    }
    return this;
  }

  build(userData) {
    let g = mergeGeometries(this.parts, false);
    if (!g) throw new Error('models.js: mergeGeometries failed');
    g = dropDegenerate(g);
    g.computeVertexNormals(); // non-indexed -> flat per-face normals
    g.computeBoundingBox();
    g.computeBoundingSphere();
    if (userData) g.userData = userData;
    return g;
  }
}

const lathe = (prof, seg) => new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), seg);
const dome = (r, seg, hs) => new THREE.SphereGeometry(r, seg, hs, 0, TAU, 0, Math.PI / 2);
function profR(prof, y) {
  for (let i = 1; i < prof.length; i++) {
    if (y <= prof[i][1] && prof[i][1] > prof[i - 1][1]) {
      const [x0, y0] = prof[i - 1], [x1, y1] = prof[i];
      return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    }
  }
  return 0;
}
const sides = [1, -1];
// Downward-facing (slightly concave) underside fan whose rim matches dome(r, seg, ...) exactly.
function underside(r, seg, rise) {
  const v = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * TAU, a1 = ((i + 1) / seg) * TAU;
    v.push([0, rise, 0], [-r * Math.cos(a1), 0, r * Math.sin(a1)], [-r * Math.cos(a0), 0, r * Math.sin(a0)]);
  }
  return triGeo(v);
}

// ---------------------------------------------------------------------------
// Enemies  (aLimb: 0 body, 1/2 legs L/R, 3/4 arms L/R, 5/6 wings L/R, 7 head, 8 tail)
// Every regular type takes a biome. 'tropical' reproduces the original models exactly: biome palettes
// only swap colours, and biome accessories are appended AFTER the original parts (RNG stream untouched).
// ---------------------------------------------------------------------------
export const BIOMES = ['tropical', 'frost', 'desert', 'grave', 'volcano'];
// HDR colour (linear, may exceed 1 so it blooms)
const hdr = (c, m) => new THREE.Color(c).multiplyScalar(m);
// point on a lathe surface: angle a (0 = +Z), height y, pushed out by `out`
const onLathe = (prof, a, y, out = 0) => { const r = profR(prof, y) + out; return [Math.sin(a) * r, y, Math.cos(a) * r]; };
const ribs = (a, b, n) => (l) => (Math.floor((Math.atan2(l.x, l.z) + Math.PI) / (TAU / n)) % 2 ? a : b);
const cracks = (base, glow, p = 0.2, seed = 5) => (l) => (hash3(l.x, l.y, l.z, seed) < p ? glow : base);

const BLOB_PAL = {
  tropical: { B: '#FF4FA3', D: '#C2185B', S: '#FFA3D2', M: '#5A0B2E' },
  frost: { B: '#2C5BEA', D: '#132E94', S: '#9CC2FF', M: '#0A1450' },
  desert: { B: '#8FD32A', D: '#4C9A1A', S: '#D8F79A', M: '#1E4A0C' },
  grave: { B: hdr('#3DFF8A', 1.3), D: '#12A04A', S: hdr('#D2FFE0', 1.6), M: '#062A14' },
  volcano: { B: hdr('#FF6A00', 1.15), D: '#A81E00', S: hdr('#FFD23D', 1.9), M: '#2A0600' },
};
function enemyBlob(b = 'tropical') {
  const P = BLOB_PAL[b];
  const k = new Kit(true, 11);
  const prof = [[0, 0], [0.5, 0], [0.575, 0.1], [0.565, 0.28], [0.48, 0.5], [0.33, 0.7], [0.16, 0.86], [0.05, 0.96], [0, 1.0]];
  k.add(lathe(prof, 10), (l, w) => (w.y < 0.12 ? P.D : w.y > 0.5 && w.x < -0.1 && w.z > 0.05 ? P.S : P.B));
  for (const s of sides) {
    k.eye([0.15 * s, 0.5, 0.385], 0.16, { dir: [0.38 * s, 0.3, 1], look: [-0.06 * s, -0.06, 0], limb: 7, pivot: [0, 0.5, 0.3] });
  }
  k.add(dome(0.07, 7, 2), P.M, { p: [0, 0.3, 0.525], q: qUp([0, 0.2, 1]), s: [1.5, 0.5, 1.0], jitter: 0 });
  if (b === 'frost') {
    // frozen shards poking out of the top
    [[0.02, 1.0, -0.05, 0.1, 0], [-0.2, 0.86, -0.12, 0.55, -0.2], [0.21, 0.84, -0.1, -0.55, -0.25]].forEach(([x, y, z, rz, rx]) =>
      k.add(new THREE.OctahedronGeometry(0.1, 0), hdr('#A8F6FF', 1.45), { p: [x, y, z], r: [rx, 0.4, rz], s: [0.75, 2.3, 0.75], jitter: 0.05 }));
  } else if (b === 'desert') {
    // cactus spines + a pink flower on top
    [[1.4, 0.4], [2.6, 0.62], [3.7, 0.36], [4.9, 0.6]].forEach(([a, y]) => {
      const p = onLathe(prof, a, y, -0.01), n = [Math.sin(a), 0.35, Math.cos(a)];
      k.seg(p, [p[0] + n[0] * 0.15, p[1] + n[1] * 0.15, p[2] + n[2] * 0.15], 0.035, 0, 3, '#FFF3D0', { jitter: 0, open: true });
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      k.add(new THREE.OctahedronGeometry(0.08, 0), '#FF5FA2', { p: [Math.sin(a) * 0.09, 1.02, Math.cos(a) * 0.09], r: [0, a + Math.PI / 2, 0], s: [0.8, 0.45, 1.5] });
    }
    k.add(new THREE.OctahedronGeometry(0.05, 0), '#FFD23D', { p: [0, 1.06, 0] });
  } else if (b === 'grave') {
    // ecto drips + floating bubbles
    [[1.9, 0.18], [3.3, 0.22], [4.6, 0.16]].forEach(([a, y], i) =>
      k.add(new THREE.OctahedronGeometry(0.1, 0), hdr('#7CFFAE', 1.5), { p: onLathe(prof, a, y, 0.02), s: [0.8, 1.5, 0.8], r: [0, i, 0] }));
    [[0.16, 1.12, -0.1, 0.07], [-0.1, 1.24, -0.05, 0.05]].forEach(([x, y, z, r]) =>
      k.add(new THREE.OctahedronGeometry(r * 1.2, 0), hdr('#C8FFD9', 1.7), { p: [x, y, z] }));
  } else if (b === 'volcano') {
    // cooled black crust plates floating on the molten body
    [[1.6, 0.42], [2.6, 0.2], [3.3, 0.6], [4.2, 0.3], [5.0, 0.55], [0.0, 0.85], [2.2, 0.78]].forEach(([a, y], i) => {
      const n = [Math.sin(a), 0.5 + y * 0.6, Math.cos(a)];
      k.add(new THREE.OctahedronGeometry(0.13, 0), '#2A1410', { p: onLathe(prof, a, y, -0.01), q: qUp(n), s: [1 + (i % 2) * 0.3, 0.22, 0.9], jitter: 0.1 });
    });
  }
  return k.build({ height: 1.0, radius: 0.55 });
}

const bandage = (a, b2) => (l, w) => (Math.floor((w.y + w.x * 0.35 + w.z * 0.2) / 0.075) % 2 ? a : b2);
const GOON_PAL = {
  tropical: { SKIN: '#8B5CF6', SKIN_D: '#6A3FD8', CLOTH: '#3B2A5C', BELLY: '#B79BFF', TUSK: '#F2E6C9', CLUB: '#F2E6C9', KNOB: '#F2E6C9', NOSE: '#6A3FD8' },
  frost: { SKIN: '#2B3F8F', SKIN_D: '#1B2A66', CLOTH: '#101B45', BELLY: '#5872CC', TUSK: '#FFFFFF', CLUB: hdr('#9FF4FF', 1.15), KNOB: hdr('#C8FAFF', 1.3), NOSE: '#E53935' },
  desert: { SKIN: bandage('#F2EBDA', '#CFC4A6'), SKIN_D: '#B9AD8E', CLOTH: '#7A6848', BELLY: bandage('#F2EBDA', '#CFC4A6'), TUSK: '#FFFFFF', CLUB: '#D9B25A', KNOB: '#FFC23D', NOSE: '#CFC4A6',
    EW: '#150A1E', EB: hdr('#C45CFF', 2.6), EP: 0.66, HL: false },
  grave: { SKIN: '#F1EDE0', SKIN_D: '#C4BBA2', CLOTH: '#2E2A40', BELLY: '#2A2438', TUSK: '#FFFFFF', CLUB: '#E8E0CC', KNOB: '#E8E0CC', NOSE: '#1A1422',
    EW: '#120C1A', EB: hdr('#6CFFB0', 2.4), EP: 0.62, HL: false },
  volcano: { SKIN: '#E8352B', SKIN_D: '#A81E1E', CLOTH: '#241414', BELLY: '#FF9A6B', TUSK: '#FFE9C4', CLUB: '#2A1C1C', KNOB: hdr('#FF9A1A', 2.3), NOSE: '#A81E1E',
    EW: hdr('#FFE14D', 1.4), EB: '#1A0A00' },
};
function enemyGoon(b = 'tropical') {
  const P = GOON_PAL[b], lite = b !== 'tropical'; // non-tropical variants spend their triangles on accessories
  const k = new Kit(true, 22);
  const SKIN = P.SKIN, SKIN_D = P.SKIN_D, CLOTH = P.CLOTH, BELLY = P.BELLY;
  for (const s of sides) {
    const limb = s > 0 ? 1 : 2, hip = [0.13 * s, 0.38, 0];
    k.seg(hip, [0.14 * s, 0.08, 0.01], 0.085, 0.075, 5, SKIN, { limb, pivot: hip, open: true });
    k.add(new THREE.BoxGeometry(0.16, 0.09, 0.25), SKIN_D, { limb, pivot: hip, p: [0.14 * s, 0.045, 0.05] });
  }
  k.add(new THREE.CylinderGeometry(0.24, 0.29, 0.2, 7), CLOTH, { p: [0, 0.4, 0] });
  k.add(new THREE.IcosahedronGeometry(0.27, 0), (l, w) => (l.z > 0.1 && l.y < 0.12 ? (typeof BELLY === 'function' ? BELLY(l, w) : BELLY) : (typeof SKIN === 'function' ? SKIN(l, w) : SKIN)), { p: [0, 0.62, 0], s: [1.08, 1.0, 0.92] });
  // head group (limb 7)
  const H = { limb: 7, pivot: [0, 0.84, 0] };
  k.add(new THREE.DodecahedronGeometry(0.33, 0), SKIN, { ...H, p: [0, 1.07, 0.05], s: [1.12, 0.92, 1.0] });
  for (const s of sides) {
    k.seg([0.29 * s, 1.1, 0.0], [0.6 * s, 1.25, -0.07], 0.1, 0, 3, SKIN, H);
    k.eye([0.13 * s, 1.14, 0.29], 0.11, { ...H, dir: [0.3 * s, 0.1, 1], seg: lite ? 6 : 7, hs: lite ? 2 : 3, pseg: 5, look: [-0.05 * s, -0.04, 0], white: P.EW, black: P.EB, pupil: P.EP, hl: P.HL });
    k.seg([0.075 * s, 0.92, 0.3], [0.085 * s, 1.0, 0.34], 0.026, 0, 3, P.TUSK, H);
  }
  k.seg([0, 1.04, 0.3], [0, 0.97, 0.49], 0.075, 0, 4, P.NOSE, H);
  // arms (3 = left/+X, 4 = right/-X) + club in right hand
  for (const s of sides) {
    const limb = s > 0 ? 3 : 4, sh = [0.3 * s, 0.78, 0];
    k.seg(sh, [0.37 * s, 0.5, 0.06], 0.065, 0.055, 4, SKIN, { limb, pivot: sh });
    k.add(new THREE.OctahedronGeometry(0.09, 0), SKIN, { limb, pivot: sh, p: [0.38 * s, 0.46, 0.07], s: [1, 0.9, 1.1] });
  }
  const R = { limb: 4, pivot: [-0.3, 0.78, 0] };
  k.seg([-0.38, 0.38, 0.0], [-0.38, 0.66, 0.3], 0.03, 0.045, 4, P.CLUB, { ...R, open: true });
  k.add(new THREE.OctahedronGeometry(0.055, 0), P.KNOB, { ...R, p: [-0.34, 0.68, 0.33] });
  k.add(new THREE.OctahedronGeometry(0.055, 0), P.KNOB, { ...R, p: [-0.42, 0.68, 0.33] });
  if (b === 'frost') {
    // red scarf (with a dangling end) + red earmuffs on a headband
    const RED = '#E53935', RED_D = '#B71C1C';
    k.add(new THREE.CylinderGeometry(0.25, 0.28, 0.13, 8, 1, true), (l) => (l.y > 0 ? RED : RED_D), { p: [0, 0.84, 0.02] });
    k.add(new THREE.BoxGeometry(0.12, 0.3, 0.05), (l) => (l.y < -0.08 ? RED_D : RED), { p: [0.14, 0.72, 0.25], r: [0.25, 0, 0.2] });
    for (const s of sides) k.add(new THREE.OctahedronGeometry(0.12, 0), RED, { ...H, p: [0.33 * s, 1.1, 0.03], s: [0.75, 1, 1] });
  } else if (b === 'desert') {
    // loose bandage strips
    k.add(new THREE.BoxGeometry(0.07, 0.34, 0.02), '#E6DDC6', { p: [0.2, 0.5, 0.2], r: [0.2, 0.3, 0.35] });
    k.add(new THREE.BoxGeometry(0.06, 0.26, 0.02), '#E6DDC6', { limb: 3, pivot: [0.3, 0.78, 0], p: [0.43, 0.46, 0.02], r: [0, 0, -0.3] });
    k.add(new THREE.BoxGeometry(0.06, 0.22, 0.02), '#E6DDC6', { ...H, p: [-0.2, 0.92, -0.2], r: [0.3, 0.4, 0.2] });
  } else if (b === 'grave') {
    // ribs across the dark chest
    [[0.55, 0.3], [0.63, 0.34], [0.71, 0.3]].forEach(([y, w]) => k.add(new THREE.BoxGeometry(w, 0.035, 0.06), '#F1EDE0', { p: [0, y, 0.235], jitter: 0 }));
    k.add(new THREE.BoxGeometry(0.05, 0.22, 0.05), '#F1EDE0', { p: [0, 0.62, 0.24], jitter: 0 });
  } else if (b === 'volcano') {
    // curled horns + pointed tail tip on the club end (a pitchfork-ish ember club)
    for (const s of sides) {
      k.seg([0.14 * s, 1.3, 0.05], [0.24 * s, 1.52, -0.02], 0.07, 0.045, 4, '#2A1A1A', { ...H, open: true });
      k.seg([0.24 * s, 1.52, -0.02], [0.2 * s, 1.66, -0.14], 0.045, 0, 4, '#FFE9C4', H);
    }
  }
  return k.build({ height: 1.4, radius: 0.45 });
}

const ZIPPY_PAL = {
  tropical: { SHELL: '#FF5A36', SHELL_D: '#DB3F1F', BELLY: '#FFD166', LEG: '#7A1E12', HEAD: '#C7351F', ANT: '#FFD166', STALK: '#7A1E12', MAND: '#FFD166', TAIL: '#FF8FA3' },
  frost: { SHELL: '#1A1A26', SHELL_D: '#D32F2F', BELLY: '#E53935', LEG: '#FF9800', HEAD: '#1A1A26', ANT: '#FFFFFF', STALK: '#1A1A26', MAND: '#FF9800', TAIL: '#1A1A26' },
  desert: { SHELL: '#14BDAC', SHELL_D: '#0B7F76', BELLY: '#08403C', LEG: '#062A28', HEAD: '#0E8F86', ANT: '#FFC23D', STALK: '#062A28', MAND: '#FFC23D', TAIL: '#0B7F76' },
  grave: { SHELL: '#FF7F11', SHELL_D: '#D65A00', RIB: true, BELLY: '#3A1E08', LEG: '#15151C', HEAD: '#15151C', ANT: hdr('#FFD23D', 2.2), STALK: '#15151C', MAND: '#F2E6C9', TAIL: '#2E7D32' },
  volcano: { SHELL: '#FFC400', SHELL_D: hdr('#FF7A00', 1.35), BELLY: hdr('#FF6A00', 1.6), LEG: '#2A1206', HEAD: '#E65100', ANT: hdr('#FFD23D', 2.2), STALK: '#2A1206', MAND: '#2A1206', TAIL: hdr('#FF7A00', 1.6) },
};
function enemyZippy(b = 'tropical') {
  const P = ZIPPY_PAL[b], lite = b !== 'tropical';
  const k = new Kit(true, 33);
  const SHELL = P.SHELL, SHELL_D = P.SHELL_D, BELLY = P.BELLY, LEG = P.LEG, HEAD = P.HEAD;
  k.add(dome(0.3, 8, 3), P.RIB ? ribs(SHELL, SHELL_D, 8) : (l) => (Math.floor((l.z + 0.3) / 0.15) % 2 ? SHELL : SHELL_D), { p: [0, 0.14, -0.04], s: [1, 0.95, 1.3] });
  k.add(new THREE.CylinderGeometry(0.29, 0.25, 0.09, 7), BELLY, { p: [0, 0.12, -0.04], s: [1, 1, 1.3] });
  const H = { limb: 7, pivot: [0, 0.2, 0.3] };
  k.add(new THREE.IcosahedronGeometry(0.15, 0), HEAD, { ...H, p: [0, 0.21, 0.38], s: [1.1, 0.9, 1.0] });
  for (const s of sides) {
    k.eye([0.075 * s, 0.29, 0.43], 0.085, { ...H, dir: [0.4 * s, 0.5, 1], seg: 6, full: 3, pseg: lite ? 5 : 6 });
    k.seg([0.05 * s, 0.3, 0.42], [0.15 * s, 0.56, 0.56], 0.013, 0.01, 3, P.STALK, { ...H, open: true });
    k.add(new THREE.OctahedronGeometry(0.035, 0), P.ANT, { ...H, p: [0.15 * s, 0.57, 0.565] });
    k.seg([0.05 * s, 0.15, 0.5], [0.025 * s, 0.1, 0.58], 0.025, 0, 3, P.MAND, H);
  }
  // 6 legs, tripod gait: limb 1 = L-front, R-mid, L-back; limb 2 = R-front, L-mid, R-back
  [0.18, -0.03, -0.24].forEach((z, i) => {
    for (const s of sides) {
      const limb = (s > 0) === (i !== 1) ? 1 : 2;
      const hip = [0.22 * s, 0.13, z], knee = [0.36 * s, 0.2, z + 0.02], foot = [0.42 * s, 0.0, z + 0.04];
      k.seg(hip, knee, 0.028, 0.024, lite ? 3 : 4, LEG, { limb, pivot: hip, open: true });
      k.seg(knee, foot, 0.024, 0.018, lite ? 3 : 4, LEG, { limb, pivot: hip, open: true });
    }
  });
  k.add(sweepGeo([[0, 0.14, -0.38], [0, 0.16, -0.55], [0, 0.24, -0.68], [0, 0.36, -0.7]], [0.03, 0.025, 0.018, 0], 4), P.TAIL, { limb: 8, pivot: [0, 0.14, -0.4] });
  if (b === 'frost') {
    // penguin-ish: orange beak + white face patch
    k.seg([0, 0.21, 0.5], [0, 0.19, 0.64], 0.05, 0, 4, '#FF9800', H);
    k.add(dome(0.1, 6, 2), '#FFFFFF', { ...H, p: [0, 0.19, 0.46], q: qUp([0, -0.2, 1]), s: [1.1, 0.35, 0.9], jitter: 0 });
  } else if (b === 'desert') {
    // scarab horn + metallic sheen line down the shell split
    k.seg([0, 0.27, 0.47], [0, 0.42, 0.56], 0.045, 0, 4, '#FFC23D', H);
    k.add(new THREE.BoxGeometry(0.025, 0.02, 0.62), '#7FFFF0', { p: [0, 0.425, -0.06], jitter: 0 });
  } else if (b === 'grave') {
    // pumpkin stem + glowing carved eyes on the shell
    k.seg([0, 0.4, -0.05], [0.04, 0.53, -0.12], 0.035, 0.025, 4, '#3E8E3E', { jitter: 0 });
    for (const s of sides) k.add(new THREE.OctahedronGeometry(0.055, 0), hdr('#FFC23D', 2.2), { p: [0.1 * s, 0.34, 0.235], q: qUp([0, 0.6, 0.8]), s: [1.1, 0.3, 0.8], jitter: 0 });
  } else if (b === 'volcano') {
    // glowing ember spots on the shell
    [[0.12, 0.34, 0.05], [-0.13, 0.33, -0.1], [0.05, 0.4, -0.2], [-0.05, 0.37, 0.12]].forEach((p) =>
      k.add(new THREE.OctahedronGeometry(0.045, 0), hdr('#FF5A00', 2.2), { p, s: [1, 0.5, 1], jitter: 0 }));
  }
  return k.build({ height: 0.6, radius: 0.4 });
}

const BRUTE_PAL = {
  tropical: { SLATE: '#5B6C9A', SLATE_D: '#46557D', FOOT: '#8FA3D1', BACK: '#8FA3D1', SH: '#8FA3D1', FIST: '#8FA3D1', GLOW: '#FF9E2C' },
  frost: { SLATE: '#1F3C8F', SLATE_D: '#152A6B', FOOT: '#2E5BC2', BACK: hdr('#6FF6FF', 1.7), SH: hdr('#5FE8FF', 1.25), FIST: '#2E5BC2', GLOW: hdr('#6FF6FF', 2.4) },
  desert: { SLATE: '#1E4FB0', SLATE_D: '#15377E', FOOT: '#FFC23D', BACK: '#FFC23D', SH: '#FFC23D', FIST: '#FFC23D', GLOW: hdr('#3DF2FF', 2.2) },
  grave: { SLATE: cracks('#7E9470', '#8A56A8', 0.2, 7), SLATE_D: '#5F7454', FOOT: '#6E5A48', BACK: '#E6DFC8', SH: '#8A56A8', FIST: '#7E9470', GLOW: hdr('#D8FF3D', 2.2) },
  volcano: { SLATE: cracks('#1E1A24', hdr('#FF7A1A', 2.0), 0.28, 5), SLATE_D: cracks('#15121A', hdr('#FF5A00', 1.8), 0.15, 6), FOOT: '#2A2530', BACK: hdr('#FF6A00', 1.9), SH: cracks('#2A2530', hdr('#FF8A1A', 2.0), 0.25, 8), FIST: cracks('#2A2530', hdr('#FF7A1A', 2.0), 0.2, 9), GLOW: hdr('#FFD23D', 2.6) },
};
function enemyBrute(b = 'tropical') {
  const P = BRUTE_PAL[b], lite = b !== 'tropical';
  const k = new Kit(true, 44);
  const SLATE = P.SLATE, SLATE_D = P.SLATE_D;
  for (const s of sides) {
    const limb = s > 0 ? 1 : 2, hip = [0.42 * s, 0.9, -0.1];
    k.seg(lite ? [0.42 * s, 1.12, -0.12] : hip, [0.46 * s, 0.22, -0.02], 0.25, 0.21, 5, SLATE_D, { limb, pivot: hip, open: lite });
    k.add(new THREE.BoxGeometry(0.44, 0.26, 0.58), P.FOOT, { limb, pivot: hip, p: [0.47 * s, 0.13, 0.06] });
  }
  k.add(lumpy(new THREE.DodecahedronGeometry(0.8, 0), 0.08, 4), SLATE, { p: [0, 1.58, -0.05], s: [1.28, 0.98, 0.95], r: [0.3, 0, 0], jitter: 0.1 });
  [[0.35, 2.2, -0.45, 0.4], [-0.3, 2.28, -0.35, -0.5], [0.0, 1.95, -0.78, 1.1]].forEach(([x, y, z, a]) =>
    k.add(new THREE.OctahedronGeometry(0.28, 0), P.BACK, { p: [x, y, z], r: [a * 0.5, a, -0.6 * a], s: [1, 1.4, 1] }));
  const H = { limb: 7, pivot: [0, 2.12, 0.35] };
  k.add(new THREE.IcosahedronGeometry(0.26, 0), SLATE, { ...H, p: [0, 2.28, 0.5], s: [1.1, 0.9, 1] });
  k.add(new THREE.BoxGeometry(0.5, 0.11, 0.18), SLATE_D, { ...H, p: [0, 2.39, 0.68], r: [0.2, 0, 0] });
  k.add(new THREE.BoxGeometry(0.38, 0.13, 0.22), SLATE_D, { ...H, p: [0, 2.13, 0.62] });
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.065, 0), P.GLOW, { ...H, p: [0.11 * s, 2.3, 0.72], s: [1.5, 0.8, 0.6], jitter: 0 });
  }
  for (const s of sides) {
    const limb = s > 0 ? 3 : 4, sh = [0.95 * s, 2.02, 0.05], A = { limb, pivot: sh };
    k.add(lumpy(new THREE.IcosahedronGeometry(0.44, 0), 0.1, 5 + s), P.SH, { ...A, p: [1.0 * s, 2.14, 0.0] });
    k.seg([0.98 * s, 2.0, 0.05], [1.12 * s, 1.25, 0.22], 0.27, 0.22, 5, SLATE, { ...A, open: true });
    k.add(lite ? new THREE.OctahedronGeometry(0.29, 0) : new THREE.IcosahedronGeometry(0.25, 0), SLATE_D, { ...A, p: [1.12 * s, 1.25, 0.22] });
    k.seg([1.12 * s, 1.25, 0.22], [1.12 * s, 0.46, 0.33], 0.24, 0.33, 5, SLATE, { ...A, open: true });
    k.add(lumpy(new THREE.IcosahedronGeometry(0.37, 0), 0.1, 9 + s), P.FIST, { ...A, p: [1.12 * s, 0.4, 0.34] });
  }
  if (b === 'frost') {
    // extra ice crystals growing out of the shoulders
    for (const s of sides) {
      k.add(new THREE.OctahedronGeometry(0.16, 0), hdr('#9FF8FF', 1.6), { limb: s > 0 ? 3 : 4, pivot: [0.95 * s, 2.02, 0.05], p: [1.15 * s, 2.55, -0.1], r: [0.3, 0, -0.5 * s], s: [0.8, 2.2, 0.8] });
    }
  } else if (b === 'desert') {
    // jackal head: tall ears, long snout, gold-and-lapis collar
    const JK = '#0F1F52';
    for (const s of sides) {
      k.seg([0.13 * s, 2.4, 0.45], [0.22 * s, 2.98, 0.34], 0.11, 0, 4, (l) => (l.z > 0.02 ? '#FFC23D' : JK), H);
    }
    k.add(new THREE.BoxGeometry(0.2, 0.16, 0.36), JK, { ...H, p: [0, 2.22, 0.86], r: [0.12, 0, 0] });
    k.add(new THREE.OctahedronGeometry(0.06, 0), '#05050A', { ...H, p: [0, 2.22, 1.05] });
    k.add(new THREE.CylinderGeometry(0.52, 0.62, 0.2, 10, 1, true), ribs('#FFC23D', '#1E4FB0', 10), { p: [0, 2.04, 0.22], r: [0.3, 0, 0] });
  } else if (b === 'grave') {
    // stitched-on purple patch + bone spike through the shoulder
    k.add(new THREE.BoxGeometry(0.34, 0.3, 0.06), '#8A56A8', { p: [-0.35, 1.55, 0.72], r: [-0.1, -0.35, 0.2] });
    k.seg([0.75, 1.9, 0.1], [0.95, 2.45, -0.35], 0.07, 0, 4, '#E6DFC8', { jitter: 0 });
  } else if (b === 'volcano') {
    // lava drips from the cracks
    [[0.6, 1.3, 0.55], [-0.7, 1.55, 0.45], [0.2, 1.1, 0.7]].forEach((p, i) =>
      k.add(new THREE.OctahedronGeometry(0.07, 0), hdr('#FF8A1A', 2.1), { p, s: [0.8, 1.8, 0.8], r: [0, i, 0], jitter: 0 }));
  }
  return k.build({ height: 2.6, radius: 1.1 });
}

const SPIT_PAL = {
  tropical: { CAP: '#FF8A1F', CAP_D: '#E0660F', SPOT: '#FFF1D6', STEM: '#F5E6C8', STEM_D: '#DCC49A', GILL: '#E8C79A', LIP: '#FFB057', DARK: '#3A1206' },
  frost: { CAP: '#0E7078', CAP_D: '#0A4D57', SPOT: '#FFFFFF', STEM: '#5A7DB5', STEM_D: '#40609A', GILL: '#0A4D57', LIP: hdr('#6FF6FF', 1.3), DARK: '#03141A' },
  desert: { CAP: ribs('#3FA34D', '#2F8A3E', 9), CAP_D: '#2E7D32', SPOT: '#FFF6D8', STEM: '#5BAE4C', STEM_D: '#3E8E3E', GILL: '#2A6A2A', LIP: '#FF5FA2', DARK: '#1A3A12' },
  grave: { CAP: hdr('#FF36D6', 1.35), CAP_D: '#7A0E66', SPOT: hdr('#FFD9F7', 1.8), STEM: '#5B3F8A', STEM_D: '#422A6B', GILL: hdr('#B84DFF', 1.2), LIP: hdr('#FF7AE8', 1.4), DARK: '#12031A' },
  volcano: { CAP: '#C62828', CAP_D: '#6E1010', SPOT: hdr('#FFB300', 2.3), STEM: '#8A4A2E', STEM_D: '#5E2E1C', GILL: hdr('#FF6A00', 1.5), LIP: hdr('#FF8F00', 1.7), DARK: hdr('#FF4A00', 2.0) },
};
function enemySpitter(b = 'tropical') {
  const P = SPIT_PAL[b], lite = b !== 'tropical';
  const k = new Kit(true, 55);
  const CAP = P.CAP, CAP_D = P.CAP_D, SPOT = P.SPOT, STEM = P.STEM, STEM_D = P.STEM_D, GILL = P.GILL, LIP = P.LIP, DARK = P.DARK;
  for (const s of sides) {
    const limb = s > 0 ? 1 : 2, hip = [0.17 * s, 0.3, 0];
    k.seg(hip, [0.19 * s, 0.08, 0.02], 0.1, 0.09, 5, STEM_D, { limb, pivot: hip, open: true });
    k.add(new THREE.BoxGeometry(0.2, 0.1, 0.27), STEM_D, { limb, pivot: hip, p: [0.19 * s, 0.05, 0.06] });
  }
  k.add(new THREE.CylinderGeometry(0.3, 0.36, 0.9, 7, 1, true), STEM, { p: [0, 0.67, 0] });
  // cap (limb 7 — wobbles on the stem)
  const H = { limb: 7, pivot: [0, 1.0, 0] };
  const CR = 0.68, CH = 0.6;
  k.add(dome(CR, 9, 4), CAP, { ...H, p: [0, 1.0, 0], s: [1, CH / CR, 1] });
  k.add(underside(CR, 9, 0.1), GILL, { ...H, p: [0, 1.0, 0] });
  const spots = [[0, 0]];
  for (let i = 0; i < 5; i++) spots.push([0.95, (i / 5) * TAU + 0.35]);
  for (const [th, ph] of spots) {
    const x = CR * Math.sin(th) * Math.sin(ph), y = CH * Math.cos(th), z = CR * Math.sin(th) * Math.cos(ph);
    const n = [x / (CR * CR), y / (CH * CH), z / (CR * CR)];
    k.add(new THREE.OctahedronGeometry(0.13, 0), SPOT, { ...H, p: [x, 1.0 + y, z], q: qUp(n), s: [1, 0.3, 1], jitter: 0.02 });
  }
  // spit tube (+Z) — muzzle at its mouth
  k.seg([0, 0.6, 0.2], [0, 0.62, 0.58], 0.13, 0.16, 7, CAP_D, { open: true });
  k.seg([0, 0.62, 0.55], [0, 0.625, 0.66], 0.19, 0.19, 7, LIP, { open: true });
  k.seg([0, 0.62, 0.55], [0, 0.625, 0.66], 0.185, 0.185, 7, CAP_D, { open: true, inv: true });
  k.add(new THREE.CircleGeometry(0.17, 7), DARK, { p: [0, 0.62, 0.58], jitter: 0 });
  for (const s of sides) {
    k.eye([0.13 * s, 0.88, 0.27], 0.1, { dir: [0.35 * s, 0.05, 1], seg: lite ? 6 : 7, hs: lite ? 2 : 3, pseg: lite ? 5 : 6, look: [-0.05 * s, 0.02, 0] });
  }
  if (b === 'frost') {
    // icicles hanging off the cap rim
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + 0.5, r = CR * 0.93, len = 0.18 + (i % 3) * 0.06;
      k.seg([Math.sin(a) * r, 1.02, Math.cos(a) * r], [Math.sin(a) * r * 0.97, 1.02 - len, Math.cos(a) * r * 0.97], 0.05, 0, 3, hdr('#C8FAFF', 1.25), { ...H, open: true });
    }
  } else if (b === 'desert') {
    // pink flower blooming on top of the cactus cap
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      k.add(new THREE.OctahedronGeometry(0.12, 0), i % 2 ? '#FF5FA2' : '#FF7AB8', { ...H, p: [Math.sin(a) * 0.13, 1.62, Math.cos(a) * 0.13], r: [0, a + Math.PI / 2, 0.35], s: [0.7, 0.4, 1.5] });
    }
    k.add(new THREE.OctahedronGeometry(0.07, 0), '#FFD23D', { ...H, p: [0, 1.66, 0] });
  } else if (b === 'grave') {
    // floating wisps above the cap
    [[0.25, 1.85, -0.1, 0.07], [-0.2, 1.95, 0.05, 0.05], [0.05, 2.08, -0.15, 0.04]].forEach(([x, y, z, r]) =>
      k.add(new THREE.OctahedronGeometry(r, 0), hdr('#FFB8F4', 2.0), { ...H, p: [x, y, z] }));
  } else if (b === 'volcano') {
    // smoking vent on top of the cap
    k.seg([0.1, 1.5, -0.1], [0.12, 1.68, -0.12], 0.12, 0.08, 6, '#1E1414', { ...H, open: true });
    k.add(new THREE.CircleGeometry(0.08, 6), hdr('#FFB300', 2.4), { ...H, p: [0.12, 1.675, -0.12], r: [-Math.PI / 2, 0, 0], jitter: 0 });
  }
  return k.build({ height: 1.6, radius: 0.6, muzzle: { x: 0, y: 0.62, z: 0.68 } });
}

const BAT_PAL = {
  tropical: { BODY: '#3A2A5C', BELLY: '#56427F', BONE: '#2A1D45', MEM: '#FF3D8B', MEM_D: '#C92A6E', EYE: '#FFD166', FANG: '#FFD166', CLAW: '#FFD166' },
  frost: { BODY: '#16225E', BELLY: '#27408C', BONE: '#0B1240', MEM: hdr('#45E8FF', 1.2), MEM_D: '#1A7FB0', EYE: hdr('#BFFBFF', 1.3), FANG: '#FFFFFF', CLAW: hdr('#9FF6FF', 1.5) },
  desert: { BODY: '#43175C', BELLY: '#6A2F85', BONE: '#250A33', MEM: '#8A45A8', MEM_D: '#55206E', EYE: '#FFD166', FANG: '#F5E6C8', CLAW: '#F5E6C8' },
  grave: { BODY: '#A0142C', BELLY: '#D23A52', BONE: '#46060F', MEM: '#E8243F', MEM_D: '#8C0F24', EYE: hdr('#FFE14D', 1.7), FANG: '#FFFFFF', CLAW: '#F2E6C9' },
  volcano: { BODY: '#E65A08', BELLY: '#FFA622', BONE: '#3E1600', MEM: hdr('#FF6A10', 1.5), MEM_D: '#B83A00', EYE: hdr('#FFF06A', 1.8), FANG: '#FFF3D6', CLAW: hdr('#FFD23D', 2.0) },
};
function enemyBat(b = 'tropical') {
  const P = BAT_PAL[b], lite = b !== 'tropical';
  const k = new Kit(true, 66);
  const BODY = P.BODY, BELLY = P.BELLY, BONE = P.BONE, MEM = P.MEM, MEM_D = P.MEM_D;
  k.add(new THREE.IcosahedronGeometry(0.3, 1), (l) => (l.z > 0.1 && l.y < -0.05 ? BELLY : BODY));
  for (const s of sides) {
    k.seg([0.12 * s, 0.2, -0.02], [0.21 * s, 0.47, -0.05], 0.1, 0, 4, BODY);
    k.eye([0.11 * s, 0.07, 0.235], 0.085, { dir: [0.35 * s, 0.15, 1], white: P.EYE, seg: lite ? 6 : 7, hs: lite ? 2 : 3, pseg: lite ? 5 : 6, pupil: 0.5, px: 0.45 });
    k.seg([0.05 * s, -0.1, 0.27], [0.045 * s, -0.2, 0.26], 0.03, 0, 3, P.FANG, { jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.05, 0), BONE, { p: [0.08 * s, -0.31, -0.04] });
  }
  // wings: spread horizontally along ±X at rest; flap = rotate about Z through the shoulder pivot
  const S0 = [0.2, 0.08, 0.08], S1 = [0.2, 0.0, -0.16], E = [0.52, 0.13, 0.1], T = [0.82, 0.07, -0.06];
  const F1 = [0.7, 0.01, -0.32], F2 = [0.46, 0.0, -0.36], M0 = [0.7, 0.05, -0.16], M1 = [0.56, 0.03, -0.25], M2 = [0.33, 0.02, -0.23];
  const fan = [[T, M0], [M0, F1], [F1, M1], [M1, F2], [F2, M2], [M2, S1], [S1, S0]];
  const top = [];
  for (const [a, c] of fan) {
    const n = new THREE.Vector3().crossVectors(V(a).sub(V(E)), V(c).sub(V(E)));
    if (n.y >= 0) top.push(E, a, c); else top.push(E, c, a);
  }
  const memTop = triGeo(top);
  for (const s of sides) {
    const W = { limb: s > 0 ? 5 : 6, pivot: [0.2 * s, 0.06, 0] };
    const m = (p) => [p[0] * s, p[1], p[2]];
    k.add(memTop, MEM, { ...W, s: [s, 1, 1], jitter: 0.03 });
    k.add(memTop, MEM_D, { ...W, s: [s, 1, 1], inv: true, jitter: 0.03 });
    k.seg(m([0.18, 0.08, 0.06]), m(E), 0.03, 0.022, 3, BONE, { ...W, open: true });
    k.seg(m(E), m(T), 0.02, 0.01, 3, BONE, { ...W, open: true });
    k.seg(m(E), m(F1), 0.018, 0.009, 3, BONE, { ...W, open: true });
    k.seg(m(E), m(F2), 0.018, 0.009, 3, BONE, { ...W, open: true });
    k.seg(m(E), m([0.54, 0.2, 0.15]), 0.022, 0, 3, P.CLAW, W);
  }
  if (b === 'frost') {
    // crystal tips on the wings + frosty tuft
    for (const s of sides) k.add(new THREE.OctahedronGeometry(0.06, 0), hdr('#C8FAFF', 1.7), { limb: s > 0 ? 5 : 6, pivot: [0.2 * s, 0.06, 0], p: [0.84 * s, 0.08, -0.06], s: [1.6, 0.7, 0.7] });
    k.add(new THREE.OctahedronGeometry(0.07, 0), hdr('#9FF6FF', 1.4), { p: [0, 0.31, -0.02], s: [0.7, 1.6, 0.7] });
  } else if (b === 'desert') {
    // vulture: hooked beak + a pale feather ruff
    k.seg([0, 0.0, 0.26], [0, -0.14, 0.4], 0.055, 0, 4, '#E8A33D');
    for (let i = 0; i < 4; i++) {
      const a = Math.PI * 0.62 + (i / 3) * Math.PI * 0.76;
      k.add(new THREE.OctahedronGeometry(0.09, 0), '#EFE3C8', { p: [Math.sin(a) * 0.27, 0.18, Math.cos(a) * 0.27], r: [0, a, 0.4], s: [0.8, 1.4, 0.5] });
    }
  } else if (b === 'grave') {
    // pointy vampire collar
    for (const s of sides) k.add(new THREE.OctahedronGeometry(0.1, 0), '#2A0610', { p: [0.14 * s, 0.24, -0.16], r: [0.5, 0, -0.5 * s], s: [0.5, 1.6, 0.25] });
  } else if (b === 'volcano') {
    // flame tuft on the head
    [[0, 0.33, -0.02, 0.09, 2.0], [0.08, 0.3, -0.06, 0.06, 1.7], [-0.08, 0.3, -0.06, 0.06, 1.7]].forEach(([x, y, z, r, m]) =>
      k.add(new THREE.OctahedronGeometry(r, 0), hdr('#FFB300', m), { p: [x, y, z], s: [0.7, 2.0, 0.7] }));
  }
  const g = k.build({ height: 0.6, radius: 0.45 });
  return g;
}

const BOSS_PAL = {
  tropical: { PURP: '#7B2FF7', DARKP: '#4B1A9E', SHINE: '#A874FF', GOO: '#8E4BFF', STONE: '#3E2A6B', GOLD: '#FFC23D', GOLD_D: '#D9961A', BLACK: '#1A0A2E', MOUTH: '#2A0845', TEETH: '#FFFFFF', TONGUE: '#FF5FA8', SG: '#FF3D8B', GEMS: ['#FF2E63', '#3DF2FF', '#FF4FD8', '#4F7BFF'] },
  frost: { PURP: '#2046C8', DARKP: '#132C85', SHINE: '#6F9BFF', GOO: '#3FA0FF', STONE: '#BFE6FF', GOLD: hdr('#A8F4FF', 1.25), GOLD_D: '#4FB8E0', BLACK: '#0A1438', MOUTH: '#08123A', TEETH: '#FFFFFF', TONGUE: '#FF6FA8', SG: hdr('#3DF2FF', 2.0), GEMS: [hdr('#3DF2FF', 2.0), hdr('#FFFFFF', 1.6), hdr('#7FD8FF', 2.0), hdr('#B8FBFF', 1.8)] },
  desert: { PURP: '#12A596', DARKP: '#0A6E64', SHINE: '#62E6D6', GOO: '#1FC4B2', STONE: '#D9B77E', GOLD: '#FFC23D', GOLD_D: '#D9961A', BLACK: '#0A2E2A', MOUTH: '#062A26', TEETH: '#FFFFFF', TONGUE: '#FF5FA8', SG: '#1E4FB0', GEMS: ['#1E4FB0', '#FF2E63', '#1E4FB0', '#3DF2FF'], NEMES: true },
  grave: { PURP: '#5A2A96', DARKP: '#321460', SHINE: '#8C5CD0', GOO: hdr('#3DFF8A', 1.4), STONE: '#3A3A4A', GOLD: hdr('#3DFF8A', 1.5), GOLD_D: '#1E9E50', BLACK: '#12051F', MOUTH: '#0E0418', TEETH: '#E8F5E0', TONGUE: '#3DFF8A', SG: hdr('#B6FF3D', 2.2), GEMS: [hdr('#B6FF3D', 2.0), hdr('#3DFF8A', 2.0), hdr('#E0FFE8', 1.6), hdr('#3DFF8A', 2.0)], EW: hdr('#8CFFB0', 1.9), EB: '#0A1A10' },
  volcano: { PURP: '#D8431A', DARKP: '#7A1C08', SHINE: hdr('#FFB020', 1.6), GOO: hdr('#FF7A00', 1.9), STONE: '#1A1418', GOLD: '#2A2230', GOLD_D: '#17121C', BLACK: '#1A0A04', MOUTH: hdr('#FF5A00', 1.6), TEETH: '#FFF3D6', TONGUE: hdr('#FFD23D', 1.8), SG: hdr('#FFB300', 2.4), GEMS: [hdr('#FF7A00', 2.2), hdr('#FFD23D', 2.2), hdr('#FF4A00', 2.2), hdr('#FFB300', 2.2)] },
};
function enemyBoss(b = 'tropical') {
  const P = BOSS_PAL[b];
  const k = new Kit(true, 77);
  const PURP = P.PURP, DARKP = P.DARKP, SHINE = P.SHINE, GOO = P.GOO, STONE = P.STONE;
  const GOLD = P.GOLD, GOLD_D = P.GOLD_D, BLACK = P.BLACK;
  const prof = [[0, 0], [2.7, 0], [3.05, 0.28], [3.12, 0.85], [2.98, 1.65], [2.68, 2.55], [2.22, 3.45], [1.62, 4.22], [0.95, 4.75], [0.35, 5.02], [0, 5.08]];
  k.add(lathe(prof, 18), (l, w) => (w.y < 0.5 ? DARKP : w.y > 3.3 && w.x < -0.5 && w.z > 0.3 ? SHINE : PURP));
  // goo drips + embedded golem stones (kept off the face)
  [[70, 1.0], [120, 2.2], [165, 0.6], [200, 1.6], [245, 2.4], [290, 0.9]].forEach(([a, y], i) => {
    const r = profR(prof, y) - 0.08, t = (a * Math.PI) / 180;
    k.add(new THREE.IcosahedronGeometry(0.32, 0), GOO, { p: [Math.sin(t) * r, y, Math.cos(t) * r], s: [0.75, 1.5, 0.75], r: [0, i, 0] });
  });
  [[100, 2.8], [150, 1.4], [215, 3.1], [260, 1.8]].forEach(([a, y], i) => {
    const r = profR(prof, y) - 0.12, t = (a * Math.PI) / 180;
    k.add(lumpy(new THREE.DodecahedronGeometry(0.5, 0), 0.12, 20 + i), STONE, { p: [Math.sin(t) * r, y, Math.cos(t) * r], r: [i, i * 2, 0], jitter: 0.1 });
  });
  // angry face
  for (const s of sides) {
    k.eye([0.7 * s, 3.2, 2.04], 0.62, { dir: [0.33 * s, 0.3, 1], seg: 10, hs: 4, pseg: 8, pupil: 0.5, look: [-0.12 * s, -0.05, 0], white: P.EW, black: P.EB });
    k.add(new THREE.BoxGeometry(1.05, 0.24, 0.32), BLACK, { p: [0.74 * s, 3.9, 1.95], r: [-0.45, 0, 0.38 * s] });
  }
  k.add(dome(0.85, 12, 3), P.MOUTH, { p: [0, 2.05, 2.6], q: qUp([0, 0.1, 1]), s: [1.65, 0.45, 0.72], jitter: 0 });
  const mz = (x, y) => 2.6 + 0.38 * Math.sqrt(Math.max(0, 1 - (x / 1.4) ** 2 - ((y - 2.05) / 0.61) ** 2)) + 0.05;
  for (const x of [-0.75, -0.25, 0.25, 0.75]) k.seg([x, 2.58, mz(x, 2.42)], [x, 2.22, mz(x, 2.42) + 0.03], 0.13, 0, 4, P.TEETH, { s: [1, 1, 0.6], jitter: 0 });
  for (const s of sides) k.seg([0.55 * s, 1.52, mz(0.55, 1.7)], [0.55 * s, 1.92, mz(0.55, 1.7) + 0.03], 0.15, 0, 4, P.TEETH, { s: [1, 1, 0.6], jitter: 0 });
  k.add(new THREE.IcosahedronGeometry(0.3, 0), P.TONGUE, { p: [0, 1.72, 2.82], s: [1.3, 0.45, 0.8] });
  // crown (limb 7 — wobbles)
  const C = { limb: 7, pivot: [0, 4.8, 0] };
  if (!P.NEMES) {
    k.add(new THREE.CylinderGeometry(1.3, 1.18, 0.6, 14, 1, true), GOLD, { ...C, p: [0, 4.72, 0] });
    k.add(new THREE.CylinderGeometry(1.3, 1.18, 0.6, 14, 1, true), GOLD_D, { ...C, p: [0, 4.72, 0], inv: true });
    const GEMS = P.GEMS;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU, a2 = a + TAU / 14;
      const tipY = i === 0 ? 5.95 : 5.72;
      k.seg([Math.sin(a) * 1.22, 4.95, Math.cos(a) * 1.22], [Math.sin(a) * 1.34, tipY, Math.cos(a) * 1.34], 0.24, 0, 4, GOLD, C);
      k.add(new THREE.OctahedronGeometry(0.15, 0), GEMS[i % 4], { ...C, p: [Math.sin(a) * 1.34, tipY + 0.08, Math.cos(a) * 1.34], jitter: 0 });
      k.add(new THREE.OctahedronGeometry(0.13, 0), GEMS[(i + 2) % 4], { ...C, p: [Math.sin(a2) * 1.27, 4.72, Math.cos(a2) * 1.27], r: [0, a2, 0], s: [1, 1, 0.5], jitter: 0 });
    }
  }
  // stubby arms (3 = +X, 4 = -X) with cuffs; scepter in the right (-X) fist
  for (const s of sides) {
    const A = { limb: s > 0 ? 3 : 4, pivot: [2.45 * s, 2.7, 0.3] };
    k.seg([2.45 * s, 2.7, 0.3], [3.35 * s, 2.0, 0.7], 0.55, 0.48, 8, PURP, { ...A, open: true });
    k.seg([3.2 * s, 2.12, 0.64], [3.36 * s, 1.99, 0.71], 0.56, 0.56, 10, GOLD, { ...A, open: true });
    k.add(lumpy(new THREE.IcosahedronGeometry(0.68, 1), 0.06, 30 + s), GOO, { ...A, p: [3.5 * s, 1.8, 0.8] });
    k.add(new THREE.DodecahedronGeometry(0.62, 0), DARKP, { limb: s > 0 ? 1 : 2, pivot: [1.3 * s, 0.9, 2.2], p: [1.3 * s, 0.3, 2.85], s: [1.1, 0.55, 1.35] });
  }
  const SC = { limb: 4, pivot: [-2.45, 2.7, 0.3] };
  k.seg([-3.5, 0.75, 1.05], [-3.5, 4.0, 0.55], 0.1, 0.1, 6, GOLD, SC);
  k.add(new THREE.OctahedronGeometry(0.15, 0), GOLD, { ...SC, p: [-3.5, 0.72, 1.06] });
  k.add(new THREE.OctahedronGeometry(0.22, 0), GOLD, { ...SC, p: [-3.5, 4.05, 0.54] });
  k.add(new THREE.IcosahedronGeometry(0.38, 0), P.SG, { ...SC, p: [-3.5, 4.45, 0.48], jitter: 0.08 });
  if (P.NEMES) {
    // DUNE CHONK: striped gold/lapis pharaoh headdress with lappets and a cobra
    const LAP = '#1E4FB0';
    k.add(dome(1.78, 14, 4), ribs(GOLD, LAP, 14), { ...C, p: [0, 4.15, -0.05], s: [1, 0.64, 1] });
    k.add(new THREE.CylinderGeometry(1.8, 1.8, 0.26, 14, 1, true), GOLD, { ...C, p: [0, 4.2, -0.05] });
    for (const s of sides) {
      k.add(new THREE.BoxGeometry(0.6, 2.0, 0.22), (l, w) => (Math.floor(w.y / 0.25) % 2 ? GOLD : LAP), { ...C, p: [1.72 * s, 3.05, 1.55], r: [0, 0.78 * s, -0.08 * s] });
    }
    k.seg([0, 4.15, 1.72], [0, 4.75, 1.62], 0.14, 0.1, 5, '#2E9E5A', C);
    k.add(new THREE.OctahedronGeometry(0.2, 0), '#2E9E5A', { ...C, p: [0, 4.85, 1.65], s: [1.3, 0.8, 0.7] });
    k.add(new THREE.OctahedronGeometry(0.11, 0), '#FF2E63', { ...C, p: [0, 4.5, 1.83], jitter: 0 });
  } else if (b === 'frost') {
    // icicles on the arms and chin
    for (const s of sides) k.seg([3.1 * s, 1.75, 1.0], [3.1 * s, 1.1, 1.05], 0.14, 0, 5, hdr('#C8FAFF', 1.2), { limb: s > 0 ? 3 : 4, pivot: [2.45 * s, 2.7, 0.3] });
    [[-0.5, 1.35, 2.72], [0.3, 1.3, 2.75], [0.9, 1.45, 2.6]].forEach(([x, y, z]) => k.seg([x, y + 0.2, z - 0.1], [x, y - 0.35, z], 0.12, 0, 5, hdr('#C8FAFF', 1.2)));
  } else if (b === 'grave') {
    // floating ecto wisps around the crown
    [[1.6, 5.4, -0.6], [-1.5, 5.6, -0.4], [0.3, 6.4, -0.9]].forEach((p) => k.add(new THREE.OctahedronGeometry(0.2, 0), hdr('#8CFFB0', 2.0), { ...C, p, s: [0.8, 1.6, 0.8] }));
  } else if (b === 'volcano') {
    // lava crust plates across the body
    [[40, 1.2], [300, 2.9], [180, 3.8], [230, 0.7], [85, 3.6], [140, 3.2]].forEach(([a, y], i) => {
      const t = (a * Math.PI) / 180, r = profR(prof, y);
      k.add(new THREE.OctahedronGeometry(0.55, 0), '#1E1418', { p: [Math.sin(t) * r, y, Math.cos(t) * r], q: qUp([Math.sin(t), 0.4, Math.cos(t)]), s: [1.1, 0.25, 0.9], jitter: 0.1 });
    });
  }
  return k.build({ height: 6.0, radius: 3.0 });
}

const ENEMY_BUILDERS = { blob: enemyBlob, goon: enemyGoon, zippy: enemyZippy, brute: enemyBrute, spitter: enemySpitter, bat: enemyBat, boss: enemyBoss };
export const ENEMY_TYPES = Object.keys(ENEMY_BUILDERS);
// Biome-less special types: the final-swarm ghost and the five island final bosses (+ the worm's body segment).
const SPECIAL_BUILDERS = { ghost: enemyGhost, tiki: bossTiki, yeti: bossYeti, worm: bossWorm, wormseg: bossWormSeg, lich: bossLich, dragon: bossDragon };
export const SPECIAL_TYPES = Object.keys(SPECIAL_BUILDERS);
export const FINAL_BOSSES = { tropical: 'tiki', frost: 'yeti', desert: 'worm', grave: 'lich', volcano: 'dragon' };

export function buildEnemyGeometry(type, biome = 'tropical') {
  const fn = ENEMY_BUILDERS[type];
  if (fn) return fn(BIOMES.includes(biome) ? biome : 'tropical');
  const sp = SPECIAL_BUILDERS[type];
  if (sp) return sp();
  throw new Error(`buildEnemyGeometry: unknown type "${type}"`);
}

// ---------------------------------------------------------------------------
// Props (origin at base; FrontSide-safe: thin surfaces are built two-sided)
// ---------------------------------------------------------------------------
function propPalm() {
  const k = new Kit(false, 201);
  const pts = [];
  for (let i = 0; i <= 6; i++) { const t = i / 6; pts.push([1.5 * t * t, 6.3 * t, 0.2 * t * t]); }
  for (let i = 0; i < 6; i++) {
    const r0 = 0.34 - i * 0.025;
    k.seg(pts[i], pts[i + 1], r0, r0 * 0.78, 6, i % 2 ? '#8B5A2B' : '#A8743F', { open: true });
  }
  const C = V(pts[6]).add(new THREE.Vector3(0, 0.1, 0));
  k.add(new THREE.IcosahedronGeometry(0.3, 0), '#6B7F2A', { p: C.toArray() });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    k.add(new THREE.OctahedronGeometry(0.17, 0), '#6B4423', { p: [C.x + Math.cos(a) * 0.24, C.y - 0.28, C.z + Math.sin(a) * 0.24], r: [a, a, 0] });
  }
  const up = new THREE.Vector3(0, 1, 0);
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * TAU + 0.3;
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const lift = [0.0, 0.6, 0.35, -0.8 - (f % 2) * 0.3], dist = [0, 1.2, 2.4, 3.5], w = [0.1, 0.72, 0.6, 0.05];
    const P = [], L = [], R = [];
    for (let i = 0; i < 4; i++) {
      const p = C.clone().addScaledVector(dir, dist[i]).addScaledVector(up, lift[i]);
      P.push(p);
      L.push(p.clone().addScaledVector(side, w[i]).addScaledVector(up, w[i] * 0.45));
      R.push(p.clone().addScaledVector(side, -w[i]).addScaledVector(up, w[i] * 0.45));
    }
    const tris = [];
    const pushUp = (a1, b1, c1) => {
      const n = new THREE.Vector3().crossVectors(b1.clone().sub(a1), c1.clone().sub(a1));
      if (n.y >= 0) tris.push(a1, b1, c1); else tris.push(a1, c1, b1);
    };
    for (let i = 0; i < 3; i++) {
      pushUp(P[i], L[i], L[i + 1]); pushUp(P[i], L[i + 1], P[i + 1]);
      pushUp(P[i], P[i + 1], R[i + 1]); pushUp(P[i], R[i + 1], R[i]);
    }
    const leaf = triGeo(tris);
    k.add(leaf, f % 2 ? '#3FA34D' : '#52B95C', { jitter: 0.06 });
    k.add(leaf, '#2E7D3A', { inv: true, jitter: 0.04 });
  }
  return k.build({ radius: 0.35, height: 7 });
}

function propPine() {
  const k = new Kit(false, 202);
  k.add(new THREE.CylinderGeometry(0.14, 0.22, 1.6, 6), '#7A4E2D', { p: [0, 0.8, 0] });
  const tiers = [[1.0, 2.1, 1.65], [2.1, 1.9, 1.3], [3.1, 1.6, 1.0], [4.0, 1.9, 0.7]];
  tiers.forEach(([y, h, r], i) => {
    const c1 = i % 2 ? '#2F8F5B' : '#3BA86A';
    k.add(new THREE.ConeGeometry(r, h, 8), (l) => (l.y < -h / 2 + 0.01 ? '#1F6B45' : c1), { p: [0, y + h / 2, 0], r: [0, i * 0.7, 0], jitter: 0.07 });
  });
  return k.build({ radius: 0.25, height: 5.9 });
}

function propRoundTree() {
  const k = new Kit(false, 203);
  k.seg([0, 0, 0], [0.1, 2.5, 0.05], 0.28, 0.18, 6, '#7A4E2D');
  k.seg([0.05, 1.6, 0], [0.7, 2.6, 0.2], 0.1, 0.07, 5, '#7A4E2D', { open: true });
  const leafy = (r) => (l) => (l.y > r * 0.35 ? '#7BD35A' : l.y < -r * 0.3 ? '#2E7D32' : '#4CAF50');
  k.add(lumpy(new THREE.IcosahedronGeometry(1.5, 1), 0.1, 3), leafy(1.5), { p: [0.1, 3.4, 0], s: [1, 0.9, 1], jitter: 0.06 });
  [[1.0, 2.9, 0.4, 0.9], [-0.9, 3.0, -0.3, 0.85], [0.2, 3.1, -1.0, 0.8], [-0.2, 4.4, 0.2, 0.7]].forEach(([x, y, z, r], i) =>
    k.add(new THREE.IcosahedronGeometry(r, 0), leafy(r), { p: [x, y, z], r: [i, i * 2, 0], jitter: 0.06 }));
  [[1.1, 3.3, 1.0], [-1.2, 3.6, 0.6], [0.6, 2.7, -1.2], [-0.5, 2.8, 1.25]].forEach(([x, y, z], i) =>
    k.add(new THREE.OctahedronGeometry(0.13, 0), i % 2 ? '#FF6B35' : '#FF4FA3', { p: [x, y, z] }));
  return k.build({ radius: 0.3, height: 5.1 });
}

function propRock() {
  const k = new Kit(false, 204);
  const grey = (r) => (l) => (l.y > r * 0.35 ? '#A3A8B0' : '#868B94');
  k.add(lumpy(new THREE.DodecahedronGeometry(0.75, 1), 0.22, 7), grey(0.75), { p: [0, 0.33, 0], s: [1, 0.68, 0.85], jitter: 0.1 });
  k.add(lumpy(new THREE.DodecahedronGeometry(0.32, 0), 0.2, 8), grey(0.32), { p: [0.72, 0.1, 0.4], s: [1, 0.8, 1], jitter: 0.1 });
  return k.build({ radius: 0.7, height: 0.85 });
}

function propBush() {
  const k = new Kit(false, 205);
  const green = (r) => (l) => (l.y > r * 0.3 ? '#58B85C' : '#3E9B4F');
  k.add(lumpy(new THREE.IcosahedronGeometry(0.5, 1), 0.12, 2), green(0.5), { p: [0, 0.42, 0], jitter: 0.07 });
  [[0.42, 0.3, 0.1, 0.4], [-0.38, 0.32, -0.12, 0.4], [0.05, 0.28, 0.45, 0.36], [-0.1, 0.3, -0.45, 0.34]].forEach(([x, y, z, r], i) =>
    k.add(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.12, 10 + i), green(r), { p: [x, y, z], r: [i, i, 0], jitter: 0.07 }));
  [[0.3, 0.62, 0.3], [-0.35, 0.58, 0.2], [0.1, 0.8, -0.2], [0.5, 0.45, -0.2], [-0.2, 0.5, 0.5]].forEach((p) =>
    k.add(new THREE.OctahedronGeometry(0.06, 0), '#FF4F7B', { p }));
  return k.build({ radius: 0.6, height: 0.95 });
}

function propFlower() {
  const k = new Kit(false, 206);
  const flowers = [[0, 0, 0.32, '#FF4FA3', '#FFE066'], [0.12, 0.08, 0.4, '#FFD166', '#FF8C42'], [-0.1, 0.1, 0.25, '#9B5CFF', '#FFE066']];
  flowers.forEach(([x, z, h, petal, center], i) => {
    const top = [x * 1.4, h, z * 1.4];
    k.seg([x, 0, z], top, 0.012, 0.01, 3, '#3E8E3E', { open: true });
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * TAU + i;
      k.add(new THREE.OctahedronGeometry(0.05, 0), petal, { p: [top[0] + Math.cos(a) * 0.05, h, top[2] + Math.sin(a) * 0.05], r: [0, -a, 0], s: [1.4, 0.35, 0.75] });
    }
    k.add(new THREE.OctahedronGeometry(0.025, 0), center, { p: [top[0], h + 0.01, top[2]] });
  });
  k.add(new THREE.OctahedronGeometry(0.06, 0), '#4CAF50', { p: [0.05, 0.06, -0.06], r: [0, 0.6, 0.5], s: [1.2, 0.25, 0.5] });
  k.add(new THREE.OctahedronGeometry(0.06, 0), '#4CAF50', { p: [-0.06, 0.05, 0.05], r: [0, -0.8, -0.5], s: [1.2, 0.25, 0.5] });
  return k.build({ radius: 0.15, height: 0.42 });
}

function propMushroom() {
  const k = new Kit(false, 207);
  const cap = (seed) => (l) => (hash3(l.x, l.y, l.z, seed) < 0.28 && l.y > 0.02 ? '#FFFFFF' : '#E53935');
  k.add(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 6), '#FFF1D6', { p: [0, 0.15, 0] });
  k.add(dome(0.22, 8, 3), cap(1), { p: [0, 0.28, 0], s: [1, 0.8, 1] });
  k.add(underside(0.22, 8, 0.04), '#E8C79A', { p: [0, 0.28, 0] });
  k.add(new THREE.CylinderGeometry(0.04, 0.05, 0.16, 5), '#FFF1D6', { p: [0.2, 0.08, 0.08] });
  k.add(dome(0.12, 6, 2), cap(2), { p: [0.2, 0.15, 0.08], s: [1, 0.8, 1] });
  k.add(underside(0.12, 6, 0.02), '#E8C79A', { p: [0.2, 0.15, 0.08] });
  return k.build({ radius: 0.15, height: 0.46 });
}

function propGrass() {
  // 3 blades x 2 sides = 6 triangles; per-vertex gradient; normals biased upward so tufts light like the ground.
  const verts = [], cols = [];
  const base = new THREE.Color('#3E8E3E'), tips = [new THREE.Color('#8BD35A'), new THREE.Color('#7CC24F'), new THREE.Color('#9BDB63')];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.4, h = 0.42 + i * 0.05;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz * 0.045, pz = dx * 0.045;
    const A = [px, 0, pz], B = [-px, 0, -pz], T = [dx * 0.14, h, dz * 0.14];
    verts.push(A, B, T, B, A, T);
    for (let j = 0; j < 2; j++) cols.push(base, base, tips[i]);
  }
  const g = triGeo(verts);
  const c = new Float32Array(18 * 3);
  cols.forEach((cc, i) => { c[i * 3] = cc.r; c[i * 3 + 1] = cc.g; c[i * 3 + 2] = cc.b; });
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.computeVertexNormals();
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) {
    const v = new THREE.Vector3(n.getX(i) * 0.35, n.getY(i) * 0.35 + 1, n.getZ(i) * 0.35).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData = { radius: 0.1, height: 0.52 };
  return g;
}

function propCrystal() {
  const k = new Kit(false, 208);
  const set = [[0, 0, 0.28, 1.5, 0, 0, '#FF4FD8'], [0.38, 0.1, 0.2, 1.0, 0.35, -0.3, '#3DF2FF'], [-0.34, 0.15, 0.2, 0.9, -0.2, 0.35, '#3DF2FF'], [0.05, -0.38, 0.18, 0.7, -0.4, 0.1, '#FF4FD8'], [0.12, 0.4, 0.14, 0.55, 0.3, 0.2, '#B06CFF']];
  const light = { '#FF4FD8': '#FFB3F0', '#3DF2FF': '#B8FBFF', '#B06CFF': '#DCC2FF' };
  for (const [x, z, r, h, rx, rz, c] of set) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz));
    const shade = (l) => (l.y > 0 ? light[c] : c);
    const base = new THREE.Vector3(x, -0.1, z);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    k.add(new THREE.CylinderGeometry(r, r * 0.9, h, 6, 1, true), shade, { p: base.clone().addScaledVector(up, h / 2).toArray(), q, jitter: 0.04 });
    k.add(new THREE.ConeGeometry(r, r * 1.6, 6, 1, true), light[c], { p: base.clone().addScaledVector(up, h + r * 0.8).toArray(), q, jitter: 0.06 });
  }
  return k.build({ radius: 0.5, height: 1.95 });
}

const PROP_BUILDERS = {
  palm: propPalm, pine: propPine, roundtree: propRoundTree, rock: propRock, bush: propBush, flower: propFlower, mushroom: propMushroom, grass: propGrass, crystal: propCrystal,
  // frost
  snowpine: propSnowPine, icecrystal: propIceCrystal, snowrock: propSnowRock, snowman: propSnowman, frozenbush: propFrozenBush, icespire: propIceSpire,
  // desert
  saguaro: propSaguaro, barrelcactus: propBarrelCactus, mesarock: propMesaRock, skull: propSkull, desertshrub: propDesertShrub, deadpalm: propDeadPalm,
  // grave
  deadtree: propDeadTree, tombstone: propTombstone, tombstone2: propTombstone2, tombstone3: propTombstone3, cross: propCross, pumpkin: propPumpkin, glowshroom: propGlowShroom, fence: propFence,
  // volcano
  obsidian: propObsidian, charredtree: propCharredTree, lavarock: propLavaRock, embercrystal: propEmberCrystal, bonepile: propBonePile, vent: propVent,
};
export const BIOME_PROPS = {
  tropical: ["palm", "pine", "roundtree", "rock", "bush", "flower", "mushroom", "grass", "crystal"],
  frost: ["snowpine", "icecrystal", "snowrock", "snowman", "frozenbush", "icespire"],
  desert: ["saguaro", "barrelcactus", "mesarock", "skull", "desertshrub", "deadpalm"],
  grave: ["deadtree", "tombstone", "tombstone2", "tombstone3", "cross", "pumpkin", "glowshroom", "fence"],
  volcano: ["obsidian", "charredtree", "lavarock", "embercrystal", "bonepile", "vent"],
};
export const PROP_KINDS = Object.keys(PROP_BUILDERS);

export function buildPropGeometry(kind) {
  const fn = PROP_BUILDERS[kind];
  if (!fn) throw new Error(`buildPropGeometry: unknown kind "${kind}"`);
  const g = fn();
  g.computeBoundingBox();
  g.userData.height = +g.boundingBox.max.y.toFixed(2);
  return g;
}

// ---------------------------------------------------------------------------
// Pickups & projectiles (centered on their origin — add your own hover height)
// ---------------------------------------------------------------------------
function starShape(ro, ri, n = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * TAU + Math.PI / 2, r = i % 2 ? ri : ro;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  return s;
}

function pickupGem() {
  const k = new Kit(false, 301);
  // white vertex colours (slight facet variation) so instanceColor tints it
  k.add(new THREE.CylinderGeometry(0.1, 0.17, 0.09, 6), (l) => (l.y > 0.04 ? '#FFFFFF' : '#E6E6E6'), { p: [0, 0.13, 0], jitter: 0 });
  k.add(new THREE.ConeGeometry(0.17, 0.26, 6, 1, true), (l, w, f) => (f % 2 ? '#FFFFFF' : '#D9D9D9'), { p: [0, -0.045, 0], r: [Math.PI, 0, 0], jitter: 0 });
  return k.build({ radius: 0.17, height: 0.35 });
}

function pickupCoin() {
  const k = new Kit(false, 302);
  k.add(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 14), (l) => (Math.abs(l.y) > 0.029 ? '#FFC23D' : '#D9961A'), { r: [Math.PI / 2, 0, 0], jitter: 0.03 });
  const star = new THREE.ExtrudeGeometry(starShape(0.12, 0.05), { depth: 0.02, bevelEnabled: false });
  k.add(star, '#FFE27A', { p: [0, 0, 0.028], jitter: 0.03 });
  k.add(star, '#FFE27A', { p: [0, 0, -0.028], r: [0, Math.PI, 0], jitter: 0.03 });
  return k.build({ radius: 0.2, height: 0.4 });
}

function pickupHeart() {
  const k = new Kit(false, 303);
  const sh = new THREE.Shape();
  sh.moveTo(5, 5);
  sh.bezierCurveTo(5, 5, 4, 0, 0, 0);
  sh.bezierCurveTo(-6, 0, -6, 7, -6, 7);
  sh.bezierCurveTo(-6, 11, -3, 15.4, 5, 19);
  sh.bezierCurveTo(12, 15.4, 16, 11, 16, 7);
  sh.bezierCurveTo(16, 7, 16, 0, 10, 0);
  sh.bezierCurveTo(7, 0, 5, 5, 5, 5);
  const depth = 4, bt = 2;
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bt, bevelSize: 1.6, bevelSegments: 1, curveSegments: 4 });
  const s = 0.5 / 25;
  k.add(g, (l) => (l.z > depth - 0.01 || l.z < 0.01 ? '#FF2E4D' : '#D11A3B'), { p: [-5 * s, 9.5 * s, -(depth / 2) * s], s: [s, -s, s], jitter: 0.03 });
  k.add(new THREE.OctahedronGeometry(0.045, 0), '#FFFFFF', { p: [-0.12, 0.1, 0.085], s: [1, 1.3, 0.5], jitter: 0 });
  return k.build({ radius: 0.25, height: 0.5 });
}

const PICKUP_BUILDERS = { gem: pickupGem, coin: pickupCoin, heart: pickupHeart };
export function buildPickupGeometry(kind) {
  const fn = PICKUP_BUILDERS[kind];
  if (!fn) throw new Error(`buildPickupGeometry: unknown kind "${kind}"`);
  return fn();
}

function projSaw() {
  const k = new Kit(false, 401);
  const sh = new THREE.Shape();
  const N = 12;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * TAU, a1 = ((i + 0.72) / N) * TAU;
    const p0 = [Math.cos(a0) * 0.3, Math.sin(a0) * 0.3], p1 = [Math.cos(a1) * 0.4, Math.sin(a1) * 0.4];
    if (i === 0) sh.moveTo(...p0); else sh.lineTo(...p0);
    sh.lineTo(...p1);
  }
  sh.closePath();
  const blade = new THREE.ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: false });
  k.add(blade, (l) => (l.z > 0.039 || l.z < 0.001 ? '#C9D1DB' : '#7D8795'), { r: [-Math.PI / 2, 0, 0], p: [0, -0.02, 0], jitter: 0.08 });
  k.add(new THREE.CylinderGeometry(0.22, 0.22, 0.046, 16, 1, true), '#8E97A5', { jitter: 0.02 });
  k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.08, 8), '#E53935', { jitter: 0.04 });
  k.add(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 6), '#F2F2F2', { jitter: 0 });
  return k.build({ radius: 0.4 });
}

function projBanana() {
  const k = new Kit(false, 402);
  const R = 0.45, path = [], radii = [0, 0.05, 0.07, 0.08, 0.07, 0.05, 0];
  for (let i = 0; i < 7; i++) { const t = -1.1 + (i / 6) * 2.2; path.push([R * Math.sin(t), 0, R * Math.cos(t) - R * 0.72]); }
  k.add(sweepGeo(path, radii, 6, 0.6), (l, w) => (Math.abs(w.x) > 0.34 ? '#6B4A1E' : w.y > 0.015 ? '#FFE135' : '#F2C81E'), { jitter: 0.04 });
  const g = k.build({ radius: 0.4 });
  const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function projPebble() {
  const k = new Kit(false, 403);
  k.add(new THREE.IcosahedronGeometry(0.15, 0), '#FFFFFF', { jitter: 0 });
  return k.build({ radius: 0.15 });
}

function projMeteor() {
  const k = new Kit(false, 404);
  const crack = (l) => {
    const v = Math.abs(Math.sin(l.x * 9.1 + l.y * 5.3) + Math.sin(l.z * 8.3 - l.x * 6.1));
    return v < 0.3 ? '#FFC23D' : v < 0.6 ? '#FF7A1A' : hash3(l.x, l.y, l.z, 3) > 0.5 ? '#3B2B2B' : '#2A1E1E';
  };
  k.add(lumpy(new THREE.IcosahedronGeometry(0.6, 1), 0.2, 12), crack, { jitter: 0.06 });
  return k.build({ radius: 0.6 });
}

function projSpit() {
  const k = new Kit(false, 405);
  const goo = (l) => (l.y > 0.08 && l.z > 0 ? '#FFC46B' : l.y < -0.08 ? '#E0661A' : '#FF8A1F');
  k.add(lumpy(new THREE.IcosahedronGeometry(0.18, 1), 0.08, 5), goo, { jitter: 0.03 });
  k.add(new THREE.IcosahedronGeometry(0.075, 0), '#FF8A1F', { p: [0.05, 0.02, -0.22] });
  k.add(new THREE.IcosahedronGeometry(0.05, 0), '#FF8A1F', { p: [-0.04, -0.03, -0.31] });
  return k.build({ radius: 0.2 });
}

const PROJ_BUILDERS = {
  saw: projSaw, banana: projBanana, pebble: projPebble, meteor: projMeteor, spit: projSpit,
  snowball: projSnowball, skull: projSkull, fireball: projFireball, coconut: projCoconut, scarab: projScarab, icicle: projIcicle, bone: projBone,
};
export const PROJECTILE_KINDS = Object.keys(PROJ_BUILDERS);
export function buildProjectileGeometry(kind) {
  const fn = PROJ_BUILDERS[kind];
  if (!fn) throw new Error(`buildProjectileGeometry: unknown kind "${kind}"`);
  return fn();
}

// ---------------------------------------------------------------------------
// Set pieces (Groups)
// ---------------------------------------------------------------------------
function glowMaterial(color, opacity = 0.8, vertexColors = false) {
  return new THREE.MeshBasicMaterial({ color, vertexColors, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
}

function solidMesh(geo, name, mat = makeToonMaterial()) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Plain (indexed) geometry with a greyscale per-vertex ramp for additive glows: fn(x,y,z) -> 0..1
function rampGeo(geo, fn) {
  const g = geo.index ? geo : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const v = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = v; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

export function buildChest() {
  const g = new THREE.Group(); g.name = 'chest';
  const mat = makeToonMaterial();
  const WOOD = '#A0522D', WOOD_D = '#7A3E22', GOLD = '#FFC23D', DARK = '#3A1F0F';
  const b = new Kit(false, 501);
  b.add(new THREE.BoxGeometry(1.2, 0.55, 0.8), WOOD, { p: [0, 0.275, 0], jitter: 0.06 });
  for (const y of [0.18, 0.37]) b.add(new THREE.BoxGeometry(1.21, 0.03, 0.81), WOOD_D, { p: [0, y, 0] });
  for (const x of [-0.57, 0.57]) for (const z of [-0.37, 0.37]) b.add(new THREE.BoxGeometry(0.1, 0.57, 0.1), GOLD, { p: [x, 0.285, z] });
  b.add(new THREE.BoxGeometry(1.24, 0.07, 0.84), GOLD, { p: [0, 0.53, 0] });
  b.add(new THREE.BoxGeometry(1.24, 0.06, 0.84), GOLD, { p: [0, 0.03, 0] });
  b.add(new THREE.BoxGeometry(0.2, 0.22, 0.05), GOLD, { p: [0, 0.43, 0.41] });
  b.add(new THREE.BoxGeometry(0.045, 0.09, 0.02), DARK, { p: [0, 0.42, 0.437], jitter: 0 });
  g.add(solidMesh(b.build(), 'base', mat));
  // lid: origin on the back hinge (y=0.55, z=-0.4); NEGATIVE rotation.x opens it (≈ -1.9 fully open)
  const lid = new THREE.Object3D(); lid.name = 'lid'; lid.position.set(0, 0.55, -0.4);
  const l = new Kit(false, 502);
  l.add(new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8, 1, false, 0, Math.PI), (lc) => (Math.abs(lc.y) > 0.59 ? WOOD_D : WOOD), { p: [0, 0, 0.4], r: [0, 0, Math.PI / 2], s: [1, 1, 1], order: 'XYZ', jitter: 0.06 });
  l.add(new THREE.BoxGeometry(1.2, 0.04, 0.8), WOOD_D, { p: [0, 0.02, 0.4] });
  for (const x of [-0.45, 0.45]) l.add(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 8, 1, false, 0, Math.PI), GOLD, { p: [x, 0, 0.4], r: [0, 0, Math.PI / 2] });
  l.add(new THREE.BoxGeometry(1.24, 0.06, 0.06), GOLD, { p: [0, 0.03, 0.8] });
  l.add(new THREE.BoxGeometry(0.14, 0.14, 0.05), GOLD, { p: [0, 0.03, 0.82] });
  const lidMesh = solidMesh(l.build(), 'lidMesh', mat);
  lidMesh.scale.set(1, 0.7, 1);
  lid.add(lidMesh);
  g.add(lid);
  // glow: light shaft fading upward + ground halo (additive; fade via material.opacity, tint via material.color)
  const shaft = rampGeo(new THREE.CylinderGeometry(0.75, 0.5, 3.0, 16, 1, true), (x, y) => (y < 0 ? 1 : 0));
  shaft.translate(0, 0.55 + 1.5, 0);
  const halo = rampGeo(new THREE.RingGeometry(0.55, 1.2, 24, 1), (x, y) => (Math.hypot(x, y) < 0.6 ? 1 : 0));
  halo.rotateX(-Math.PI / 2); halo.translate(0, 0.03, 0);
  const glow = new THREE.Mesh(mergeGeometries([shaft, halo]), glowMaterial('#FFD76A', 0.75, true));
  glow.name = 'glow';
  glow.renderOrder = 2;
  g.add(glow);
  g.userData = { radius: 0.75, height: 0.9 };
  return g;
}

export function buildShrine() {
  const g = new THREE.Group(); g.name = 'shrine';
  const k = new Kit(false, 601);
  const STONE = '#8E949E', STONE_L = '#A9AFB8', STONE_D = '#6F7580';
  k.add(new THREE.CylinderGeometry(2.5, 2.65, 0.3, 16), (l) => (l.y > 0.14 ? STONE_L : STONE), { p: [0, 0.15, 0], jitter: 0.06 });
  k.add(new THREE.CylinderGeometry(2.05, 2.15, 0.15, 16), (l) => (l.y > 0.07 ? '#B8BEC7' : STONE), { p: [0, 0.375, 0], jitter: 0.05 });
  k.add(new THREE.CylinderGeometry(0.7, 0.8, 0.15, 8), '#C3C8D0', { p: [0, 0.525, 0] });
  const RUNES = ['#3DF2FF', '#FF4FD8'];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + Math.PI / 6, x = Math.sin(a) * 1.75, z = Math.cos(a) * 1.75;
    k.add(new THREE.BoxGeometry(0.72, 0.12, 0.72), STONE_D, { p: [x, 0.51, z], r: [0, a, 0] });
    k.add(new THREE.CylinderGeometry(0.26, 0.3, 1.3, 6), STONE, { p: [x, 1.2, z], r: [0, a, 0], jitter: 0.08 });
    k.add(new THREE.BoxGeometry(0.7, 0.14, 0.7), STONE_L, { p: [x, 1.9, z], r: [0, a, 0] });
    // runes on the face pointing at the centre
    const inX = -Math.sin(a), inZ = -Math.cos(a);
    [[0, 1.55, 0.18, 0.1], [0, 1.25, 0.1, 0.18], [0, 0.95, 0.16, 0.1]].forEach(([, y, w, h], j) =>
      k.add(new THREE.BoxGeometry(w, h, 0.05), RUNES[(i + j) % 2], { p: [x + inX * 0.27, y, z + inZ * 0.27], r: [0, a, j === 1 ? 0.785 : 0], jitter: 0 }));
  }
  g.add(solidMesh(k.build(), 'platform'));
  // floating crystal (origin at its centre)
  const c = new Kit(false, 602);
  c.add(new THREE.ConeGeometry(0.42, 0.55, 6, 1, true), (l, w, f) => (f % 2 ? '#3DF2FF' : '#1FC8E8'), { p: [0, 0.075 + 0.275, 0], jitter: 0.03 });
  c.add(new THREE.CylinderGeometry(0.42, 0.42, 0.15, 6, 1, true), '#E9B8FF', { jitter: 0.03 });
  c.add(new THREE.ConeGeometry(0.42, 0.5, 6, 1, true), (l, w, f) => (f % 2 ? '#FF4FD8' : '#D63AB8'), { p: [0, -0.075 - 0.25, 0], r: [Math.PI, 0, 0], jitter: 0.03 });
  const crystal = new THREE.Mesh(c.build(), makeToonMaterial({ emissive: new THREE.Color('#2a2a55'), emissiveIntensity: 1 }));
  crystal.name = 'crystal';
  crystal.castShadow = true;
  crystal.position.set(0, 2.3, 0);
  g.add(crystal);
  // ring: flat magic circle on the platform (outer band + dashed inner band)
  const parts = [new THREE.RingGeometry(1.55, 1.8, 48, 1)];
  for (let i = 0; i < 12; i++) parts.push(new THREE.RingGeometry(1.1, 1.28, 3, 1, (i / 12) * TAU, (TAU / 12) * 0.6));
  const ringGeo = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); p.deleteAttribute('normal'); return p; }));
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, glowMaterial('#4FF3FF', 0.8));
  ring.name = 'ring';
  ring.position.y = 0.47;
  ring.renderOrder = 2;
  g.add(ring);
  g.userData = { radius: 2.65, height: 2.9 };
  return g;
}

function chevronShape(w, slope, t) {
  // "^" chevron pointing -Y in shape space (becomes +Z after rotateX(-PI/2))
  const a = (w * slope + t) / 2;
  const s = new THREE.Shape();
  s.moveTo(0, -a); s.lineTo(-w, -a + w * slope); s.lineTo(-w, -a + w * slope + t);
  s.lineTo(0, -a + t); s.lineTo(w, -a + w * slope + t); s.lineTo(w, -a + w * slope); s.closePath();
  return s;
}

export function buildJumpPad() {
  const g = new THREE.Group(); g.name = 'jumpPad';
  const k = new Kit(false, 701);
  k.add(new THREE.CylinderGeometry(1.2, 1.3, 0.22, 16), '#2B2B3A', { p: [0, 0.11, 0], jitter: 0.05 });
  k.add(new THREE.CylinderGeometry(1.1, 1.1, 0.04, 16), '#FF7A1A', { p: [0, 0.24, 0] });
  k.add(new THREE.CylinderGeometry(0.98, 0.98, 0.06, 16), '#FFD23D', { p: [0, 0.27, 0], jitter: 0.03 });
  const chev = new THREE.ExtrudeGeometry(chevronShape(0.45, 0.8, 0.16), { depth: 0.03, bevelEnabled: false });
  for (const z of [-0.2, 0.25]) k.add(chev, '#FF7A1A', { p: [0, 0.3, z], r: [-Math.PI / 2, 0, 0], jitter: 0 });
  g.add(solidMesh(k.build(), 'base'));
  const col = rampGeo(new THREE.CylinderGeometry(0.95, 0.9, 1.6, 20, 1, true), (x, y) => (y < 0 ? 1 : 0));
  col.translate(0, 0.3 + 0.8, 0);
  const halo = rampGeo(new THREE.RingGeometry(0.9, 1.35, 24, 1), (x, y) => (Math.hypot(x, y) < 0.95 ? 1 : 0));
  halo.rotateX(-Math.PI / 2); halo.translate(0, 0.31, 0);
  const glow = new THREE.Mesh(mergeGeometries([col, halo]), glowMaterial('#FFE066', 0.7, true));
  glow.name = 'glow';
  glow.renderOrder = 2;
  g.add(glow);
  g.userData = { radius: 1.3, height: 0.33 };
  return g;
}

export function buildBoostPad() {
  const g = new THREE.Group(); g.name = 'boostPad';
  const k = new Kit(false, 801);
  k.add(new THREE.BoxGeometry(1.8, 0.12, 3.0), '#2B2B3A', { p: [0, 0.06, 0], jitter: 0.04 });
  for (const s of sides) k.add(new THREE.BoxGeometry(0.14, 0.16, 3.0), '#FFD23D', { p: [0.9 * s, 0.08, 0] });
  k.add(new THREE.BoxGeometry(1.94, 0.16, 0.12), '#FFD23D', { p: [0, 0.08, 1.52] });
  k.add(new THREE.BoxGeometry(1.94, 0.16, 0.12), '#FFD23D', { p: [0, 0.08, -1.52] });
  g.add(solidMesh(k.build(), 'base'));
  // 3 chevrons pointing +Z; greyscale ramp (back dim -> front bright) × material.color
  const parts = [-0.9, 0, 0.9].map((z, i) => {
    const s = new THREE.ShapeGeometry(chevronShape(0.6, 0.75, 0.24));
    s.deleteAttribute('uv'); s.deleteAttribute('normal');
    s.rotateX(-Math.PI / 2); s.translate(0, 0, z);
    return rampGeo(s, () => 0.5 + i * 0.25);
  });
  const arrows = new THREE.Mesh(mergeGeometries(parts), glowMaterial('#3DF2FF', 0.95, true));
  arrows.name = 'arrows';
  arrows.position.y = 0.125;
  arrows.renderOrder = 2;
  g.add(arrows);
  g.userData = { halfWidth: 0.97, halfLength: 1.58, height: 0.16 };
  return g;
}

// ---------------------------------------------------------------------------
// Player: velociraptor (faces +Z; its left side is +X). 'rex' = the original teal raptor in an orange batting
// helmet; the other variants share the body and swap palette + headgear. Everyone swings the bat.
// ---------------------------------------------------------------------------
const PLAYER_VARIANTS = {
  rex: { TEAL: '#2EC4B6', STRIPE: '#1B8A80', CREAM: '#FFE8C2' },
  zappy: { TEAL: '#2F6BFF', STRIPE: '#FFD60A', CREAM: '#D6E4FF' },
  nana: { TEAL: '#FFD93D', STRIPE: '#8A5A2B', CREAM: '#FFF6D8', spots: true },
  blaze: { TEAL: '#FF5A1F', STRIPE: '#B71C1C', CREAM: '#FFE0A8' },
  tank: { TEAL: '#7A8450', STRIPE: '#586036', CREAM: '#C9C8A8', bulk: true },
  goldie: { TEAL: '#FFC43D', STRIPE: '#E8A020', CREAM: '#FFFFFF', shiny: true },
};
export const PLAYER_VARIANT_NAMES = Object.keys(PLAYER_VARIANTS);

export function buildPlayer(variant = 'rex') {
  const PV = PLAYER_VARIANTS[variant] || PLAYER_VARIANTS.rex;
  const rex = PV === PLAYER_VARIANTS.rex;
  const TEAL = PV.TEAL, STRIPE = PV.STRIPE, CREAM = PV.CREAM, ORANGE = '#FF7A1A', WOOD = '#C98B4B', TAPE = '#2B2B2B';
  const mat = PV.shiny ? makeToonMaterial({ emissive: new THREE.Color('#4a3000'), emissiveIntensity: 0.55 }) : makeToonMaterial();
  const mesh = (kit, name) => {
    const m = new THREE.Mesh(kit.build(), mat);
    m.name = name;
    m.castShadow = true;
    return m;
  };
  const spot = (l, seed) => PV.spots && hash3(l.x * 3, l.y * 3, l.z * 3, seed) < 0.22;
  const root = new THREE.Group(); root.name = 'player';

  // body — origin at the hips
  const bk = new Kit(false, 101);
  bk.add(new THREE.SphereGeometry(1, 10, 7), (l) => (l.y < -0.35 ? CREAM : PV.spots ? (spot(l, 1) ? STRIPE : TEAL) : l.y > 0.2 && Math.floor((l.z + 1.2) * 3) % 2 === 0 ? STRIPE : TEAL), { p: [0, 0.12, 0.1], r: [-0.3, 0, 0], s: [0.25, 0.27, 0.46] });
  bk.seg([0, 0.24, 0.36], [0, 0.5, 0.48], 0.12, 0.095, 7, (l) => (l.z > 0.04 ? CREAM : TEAL));
  const body = mesh(bk, 'body');
  body.position.set(0, 0.74, 0);
  root.add(body);

  // head — origin at the neck joint (top of neck)
  const hk = new Kit(false, 102);
  hk.add(new THREE.DodecahedronGeometry(0.16, 0), TEAL, { p: [0, 0.08, 0.02], s: [1.15, 0.95, 1.2] });
  hk.seg([0, 0.06, 0.06], [0, 0.03, 0.34], 0.12, 0.075, 6, (l, w) => (w.y < 0.045 - 0.1 * (w.z - 0.06) - 0.02 ? CREAM : TEAL));
  hk.seg([0, -0.08, 0.05], [0, -0.16, 0.28], 0.07, 0.04, 5, CREAM);
  hk.add(new THREE.BoxGeometry(0.1, 0.05, 0.22), '#7A1E3A', { p: [0, -0.075, 0.19], jitter: 0 });
  for (const s of sides) {
    for (const z of [0.21, 0.27]) hk.seg([0.045 * s, -0.035, z], [0.045 * s, -0.085, z + 0.005], 0.015, 0, 3, '#FFFFFF', { jitter: 0 });
    hk.seg([0.028 * s, -0.03, 0.31], [0.028 * s, -0.075, 0.315], 0.014, 0, 3, '#FFFFFF', { jitter: 0 });
    hk.eye([0.115 * s, 0.075, 0.11], 0.085, { dir: [1 * s, 0.2, 0.7], seg: 8, hs: 3, pseg: 6, look: [0, 0, 0.35] });
  }
  if (rex) {
    hk.add(dome(0.2, 10, 4), (l) => (Math.abs(l.x) < 0.05 ? '#FFFFFF' : ORANGE), { p: [0, 0.14, -0.01], s: [1.0, 1.0, 1.15], jitter: 0.03 });
    hk.add(new THREE.BoxGeometry(0.24, 0.025, 0.13), ORANGE, { p: [0, 0.145, 0.24], r: [-0.12, 0, 0] });
    hk.add(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 6), ORANGE, { p: [0, 0.345, -0.01] });
    hk.add(new THREE.IcosahedronGeometry(0.09, 0), ORANGE, { p: [0.185, 0.08, -0.07], s: [0.4, 1, 1.1] });
  } else {
    playerHeadgear(hk, variant);
  }
  const head = mesh(hk, 'head');
  head.position.set(0, 0.49, 0.47);
  body.add(head);

  // arms — origin at the shoulders
  const arm = (s) => {
    const ak = new Kit(false, 103 + s);
    ak.seg([0, 0, 0], [0.02 * s, -0.11, 0.07], 0.045, 0.036, 5, TEAL);
    ak.seg([0.02 * s, -0.11, 0.07], [0.02 * s, -0.1, 0.19], 0.036, 0.03, 5, TEAL);
    for (const dx of [-0.02, 0, 0.02]) ak.seg([0.02 * s + dx, -0.1, 0.19], [0.02 * s + dx * 1.4, -0.14, 0.24], 0.014, 0, 3, CREAM);
    if (variant === 'tank' && s > 0) {
      // small kite shield strapped to the left forearm
      ak.add(new THREE.OctahedronGeometry(0.13, 0), (l) => (l.y > 0.02 ? '#B8C0CC' : '#8A94A6'), { p: [0.075, -0.1, 0.12], s: [0.25, 1.15, 0.8] });
      ak.add(new THREE.BoxGeometry(0.012, 0.16, 0.03), '#D32F2F', { p: [0.11, -0.1, 0.12], jitter: 0 });
      ak.add(new THREE.BoxGeometry(0.012, 0.03, 0.12), '#D32F2F', { p: [0.11, -0.07, 0.12], jitter: 0 });
    }
    const m = mesh(ak, s > 0 ? 'armL' : 'armR');
    m.position.set(0.17 * s, 0.18, 0.4);
    body.add(m);
    return m;
  };
  const armL = arm(1), armR = arm(-1);

  // tail — origin at the tail base, long and stiff toward -Z
  const tk = new Kit(false, 105);
  tk.add(sweepGeo([[0, -0.02, 0.2], [0, 0, -0.2], [0, 0.03, -0.45], [0, 0.07, -0.7], [0, 0.12, -0.95], [0, 0.18, -1.18]], [0.13, 0.15, 0.12, 0.085, 0.05, 0], 7), (l, w) => {
    const cy = -0.155 * w.z;
    if (w.y < cy - 0.03) return CREAM;
    if (PV.spots) return spot(w, 2) ? STRIPE : TEAL;
    if (Math.floor(-w.z / 0.22) % 2 === 1 && w.y > cy + 0.02) return STRIPE;
    return TEAL;
  });
  const tail = mesh(tk, 'tail');
  tail.position.set(0, 0.14, -0.28);
  body.add(tail);

  // legs — origin at the hip joints (children of root so the body can bob/lean independently)
  const leg = (s) => {
    const lk = new Kit(false, 110 + s);
    lk.add(new THREE.DodecahedronGeometry(0.13, 0), TEAL, { p: [0.01 * s, -0.1, 0.03], s: [0.8, 1.3, 1.0], r: [0.3, 0, 0] });
    lk.seg([0.01 * s, -0.18, 0.08], [0.015 * s, -0.5, -0.07], 0.075, 0.05, 6, TEAL);
    lk.seg([0.015 * s, -0.5, -0.07], [0.015 * s, -0.68, 0.03], 0.048, 0.042, 5, STRIPE);
    lk.add(new THREE.BoxGeometry(0.12, 0.05, 0.15), STRIPE, { p: [0.015 * s, -0.715, 0.08] });
    for (const x of [0.05, 0.015]) lk.seg([x * s, -0.72, 0.14], [x * s, -0.735, 0.22], 0.022, 0, 4, CREAM);
    lk.seg([-0.02 * s, -0.72, 0.14], [-0.02 * s, -0.735, 0.2], 0.02, 0, 4, CREAM);
    lk.seg([-0.02 * s, -0.7, 0.1], [-0.028 * s, -0.62, 0.17], 0.022, 0, 4, CREAM); // sickle claw
    const m = mesh(lk, s > 0 ? 'legL' : 'legR');
    m.position.set(0.13 * s, 0.74, -0.04);
    root.add(m);
    return m;
  };
  const legL = leg(1), legR = leg(-1);
  if (PV.bulk) { // 'tank' is a little chunkier (feet stay planted: only widen/deepen)
    body.scale.set(1.14, 1.06, 1.08);
    for (const l of [legL, legR]) l.scale.set(1.18, 1, 1.12);
  }

  // bat — batPivot at shoulder height on the body's vertical axis; bat lies along +X (thick end outward)
  const batPivot = new THREE.Object3D(); batPivot.name = 'batPivot';
  batPivot.position.set(0, 1.05, 0);
  root.add(batPivot);
  const X = (x) => [x, 0, 0];
  const bat = new Kit(false, 120);
  bat.add(new THREE.CylinderGeometry(0.048, 0.048, 0.03, 8), TAPE, { p: X(0.15), r: [0, 0, Math.PI / 2] });
  bat.seg(X(0.15), X(0.45), 0.03, 0.03, 8, TAPE, { open: true });
  bat.seg(X(0.45), X(0.8), 0.03, 0.052, 8, WOOD, { open: true });
  bat.seg(X(0.8), X(1.2), 0.052, 0.068, 8, WOOD, { open: true });
  bat.add(dome(0.068, 8, 2), WOOD, { p: X(1.2), q: qUp([1, 0, 0]), s: [1, 0.5, 1] });
  const batMesh = mesh(bat, 'bat');
  batPivot.add(batMesh);

  root.userData.material = mat;
  root.userData.variant = rex ? 'rex' : variant;
  return { root, parts: { body, head, tail, legL, legR, armL, armR, batPivot, bat: batMesh }, height: 1.6 };
}

// Headgear for the non-rex variants, in head space (origin at the neck joint; head top ≈ y 0.23).
function playerHeadgear(hk, variant) {
  if (variant === 'zappy') {
    const PURPLE = '#7B2FF7', PURPLE_D = '#4B1A9E', YEL = hdr('#FFE14D', 1.5);
    hk.add(new THREE.CylinderGeometry(0.27, 0.27, 0.025, 12), PURPLE_D, { p: [0, 0.2, -0.01], r: [-0.12, 0, 0] });
    hk.add(new THREE.ConeGeometry(0.17, 0.46, 9), PURPLE, { p: [0, 0.42, -0.06], r: [-0.3, 0, 0.12] });
    hk.add(new THREE.OctahedronGeometry(0.04, 0), YEL, { p: [0.05, 0.63, -0.14], jitter: 0 });
    const bolt = new THREE.Shape();
    [[-0.02, 0.09], [0.04, 0.09], [0.008, 0.018], [0.045, 0.018], [-0.03, -0.095], [-0.004, -0.008], [-0.042, -0.008]].forEach(([x, y], i) => (i ? bolt.lineTo(x, y) : bolt.moveTo(x, y)));
    bolt.closePath();
    hk.add(new THREE.ExtrudeGeometry(bolt, { depth: 0.02, bevelEnabled: false }), YEL, { p: [0.0, 0.36, 0.07], r: [-0.42, 0, 0], s: [1.05, 1.05, 1], jitter: 0 });
  } else if (variant === 'nana') {
    const PEEL = '#FFD93D', FLESH = '#FFF3C4', TIP = '#5A3A1E';
    hk.add(dome(0.18, 10, 3), PEEL, { p: [0, 0.16, 0.0], s: [1.0, 0.62, 1.12] });
    hk.add(new THREE.CylinderGeometry(0.075, 0.11, 0.24, 8), FLESH, { p: [0, 0.34, 0.0], r: [-0.1, 0, 0] });
    hk.add(new THREE.CylinderGeometry(0.115, 0.125, 0.07, 8, 1, true), PEEL, { p: [0, 0.27, 0.0] });
    hk.add(dome(0.075, 8, 2), FLESH, { p: [0, 0.46, -0.012], r: [-0.1, 0, 0] });
    hk.add(new THREE.OctahedronGeometry(0.022, 0), TIP, { p: [0, 0.54, -0.02] });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4, dx = Math.sin(a), dz = Math.cos(a);
      hk.add(new THREE.BoxGeometry(0.12, 0.27, 0.018), (l) => (l.y > 0.1 ? TIP : PEEL), { p: [dx * 0.22, 0.27, dz * 0.22], q: new THREE.Quaternion().setFromEuler(new THREE.Euler(2.0, a, 0, 'YXZ')) });
    }
  } else if (variant === 'blaze') {
    [[0.14, 0.13, 0.055, 0.2, 1.6], [0.2, 0.04, 0.06, 0.27, 1.9], [0.22, -0.05, 0.06, 0.3, 1.6], [0.19, -0.14, 0.05, 0.24, 1.9], [0.14, -0.21, 0.04, 0.17, 1.6]].forEach(([y, z, r, h, m], i) =>
      hk.add(new THREE.ConeGeometry(r, h, 5), i % 2 ? hdr('#FFC23D', m) : hdr('#FF6A00', m), { p: [0, y + h / 2 - 0.03, z], r: [-0.45, 0, 0], s: [0.55, 1, 1.6], jitter: 0 }));
    hk.add(new THREE.CylinderGeometry(0.2, 0.205, 0.045, 12, 1, true), '#2B2B2B', { p: [0, 0.15, 0.01], r: [0.2, 0, 0] });
    for (const s of sides) {
      hk.add(new THREE.CylinderGeometry(0.055, 0.055, 0.045, 10), '#E0E0E0', { p: [0.075 * s, 0.205, 0.13], q: qUp([0.15 * s, 0.6, 0.8]) });
      hk.add(new THREE.CylinderGeometry(0.043, 0.043, 0.05, 10), hdr('#6FD8FF', 1.3), { p: [0.075 * s, 0.207, 0.133], q: qUp([0.15 * s, 0.6, 0.8]), jitter: 0 });
    }
  } else if (variant === 'tank') {
    const STEEL = '#A8B0BC', STEEL_D = '#7A8494';
    hk.add(dome(0.205, 10, 4), (l) => (Math.abs(l.x) < 0.03 ? STEEL_D : STEEL), { p: [0, 0.12, 0.0], s: [1.0, 1.05, 1.18] });
    hk.add(new THREE.BoxGeometry(0.21, 0.09, 0.24), STEEL, { p: [0, 0.1, 0.22], r: [-0.1, 0, 0] });
    hk.add(new THREE.BoxGeometry(0.17, 0.018, 0.02), '#1A1A22', { p: [0, 0.115, 0.34], r: [-0.1, 0, 0], jitter: 0 });
    hk.add(new THREE.BoxGeometry(0.02, 0.07, 0.02), '#1A1A22', { p: [0, 0.07, 0.345], jitter: 0 });
    [[0.33, 0.02], [0.35, -0.08], [0.32, -0.17]].forEach(([y, z], i) => hk.add(new THREE.OctahedronGeometry(0.06, 0), i % 2 ? '#B71C1C' : '#D32F2F', { p: [0, y, z], s: [0.6, 1.3, 1.1] }));
  } else if (variant === 'goldie') {
    const GOLD = '#FFD23D', LENS = '#101018';
    hk.add(new THREE.CylinderGeometry(0.085, 0.075, 0.06, 8, 1, true), GOLD, { p: [0, 0.255, 0.0] });
    for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU; hk.seg([Math.sin(a) * 0.08, 0.28, Math.cos(a) * 0.08], [Math.sin(a) * 0.09, 0.34, Math.cos(a) * 0.09], 0.025, 0, 4, GOLD); }
    hk.add(new THREE.OctahedronGeometry(0.022, 0), hdr('#FF2E63', 1.6), { p: [0, 0.26, 0.085], jitter: 0 });
    for (const s of sides) hk.add(new THREE.BoxGeometry(0.15, 0.095, 0.022), LENS, { p: [0.19 * s, 0.09, 0.165], r: [0, 0.96 * s, 0], jitter: 0 });
    hk.add(new THREE.BoxGeometry(0.26, 0.022, 0.022), LENS, { p: [0, 0.12, 0.215], jitter: 0 });
  }
}

// ===========================================================================
// THE ARCHIPELAGO — final-swarm ghost + the five island final bosses
// (all use the enemy vertex layout: position/normal/color/aLimb/aPivot)
// ===========================================================================
// piecewise-linear interpolation (xs ascending)
function interp(xs, vs, x) {
  if (x <= xs[0]) return vs[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) { const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return vs[i - 1] + (vs[i] - vs[i - 1]) * t; }
  return vs[vs.length - 1];
}
// cone from a to b whose colour fades from `base` to a glowing `tip` (per-vertex)
function glowSpike(k, a, b, r, radial, base, tip, o = {}) {
  const len = V(b).sub(V(a)).length();
  k.seg(a, b, r, 0, radial, (L) => (L.y > len * 0.2 ? tip : base), { ...o, perVertex: true });
}
const P3 = (o) => ({ x: +o[0].toFixed(3), y: +o[1].toFixed(3), z: +o[2].toFixed(3) });

// FINAL SWARM ghost: hooded wailing specter. Origin = bottom tip of its wispy tail. Bright (additive-friendly).
function enemyGhost() {
  const k = new Kit(true, 91);
  const G = (m) => hdr('#BFF6FF', m);
  // wispy tail (limb 8 sways it), fading toward the tip
  k.add(sweepGeo([[0, 0, -0.32], [0, 0.22, -0.26], [0, 0.48, -0.12], [0, 0.72, -0.02], [0, 0.97, 0.02]], [0, 0.11, 0.22, 0.32, 0.4], 6),
    (l, w) => G(0.45 + Math.min(1, w.y / 0.95) * 0.9), { limb: 8, pivot: [0, 0.95, 0], jitter: 0.03 });
  // robe
  k.add(lathe([[0.4, 0.95], [0.46, 1.12], [0.47, 1.3], [0.44, 1.5]], 7), G(1.3), { r: [0, 0.2, 0], jitter: 0.03 });
  k.add(new THREE.CircleGeometry(0.44, 7), '#16283A', { p: [0, 1.5, 0], r: [-Math.PI / 2, 0, 0.2], jitter: 0 });
  // hood, open at the front, dark inside
  const hood = new THREE.LatheGeometry([[0.47, 1.28], [0.5, 1.5], [0.45, 1.72], [0.32, 1.88], [0.12, 1.97], [0.0, 2.0]].map(([x, y]) => new THREE.Vector2(x, y)), 7, 0.78, TAU - 1.56);
  k.add(hood, G(1.4), { p: [0, 0, -0.04], jitter: 0.04 });
  k.add(hood, '#16283A', { p: [0, 0, -0.04], inv: true, jitter: 0 });
  // pale face with dark hollow eyes and a wailing mouth
  k.add(dome(0.25, 8, 3), G(1.6), { p: [0, 1.6, 0.2], q: qUp([0, 0, 1]), s: [1.0, 0.6, 1.25], jitter: 0 });
  for (const s of sides) k.add(new THREE.OctahedronGeometry(0.075, 0), '#04060A', { p: [0.09 * s, 1.67, 0.34], s: [0.8, 1.3, 0.45], r: [0, 0, -0.3 * s], jitter: 0 });
  k.add(new THREE.OctahedronGeometry(0.08, 0), '#04060A', { p: [0, 1.48, 0.33], s: [0.75, 1.5, 0.45], jitter: 0 });
  // arms reaching forward (3 = left/+X, 4 = right)
  for (const s of sides) {
    const A = { limb: s > 0 ? 3 : 4, pivot: [0.36 * s, 1.4, 0.05] };
    k.seg([0.36 * s, 1.4, 0.05], [0.34 * s, 1.34, 0.5], 0.1, 0.14, 4, G(1.25), A);
    for (const dx of [-0.05, 0, 0.05]) k.seg([0.33 * s + dx, 1.33, 0.5], [0.32 * s + dx * 1.8, 1.27 - Math.abs(dx), 0.8], 0.035, 0, 3, G(1.55), A);
  }
  return k.build({ height: 2.0, radius: 0.5 });
}

// TIKI TITAN (tropical final boss): three stacked carved faces, leafy crown, slam arms, stubby feet.
function bossTiki() {
  const k = new Kit(true, 901);
  const WDK = '#2E1A0A', TEAL = '#1FB5A5', RED = '#D83A2E', WHITE = '#F4EBD6', DARK = '#1E0E06';
  const EYE = hdr('#FFD23D', 2.3), GLOW = hdr('#FF9A1A', 2.0);
  const wood = (a, b2) => (l) => (hash3(l.x, l.y, l.z, 9) < 0.3 ? b2 : a);
  // stubby feet (1 = left/+X, 2 = right)
  for (const s of sides) {
    const L = { limb: s > 0 ? 1 : 2, pivot: [1.0 * s, 1.25, 0] };
    k.seg([1.0 * s, 1.25, 0], [1.05 * s, 0.4, 0.1], 0.55, 0.5, 8, '#4A2A12', { ...L, open: true });
    k.add(new THREE.BoxGeometry(1.1, 0.5, 1.6), '#6B3F1F', { ...L, p: [1.05 * s, 0.25, 0.35] });
    for (const dx of [-0.34, 0, 0.34]) k.add(new THREE.BoxGeometry(0.26, 0.3, 0.26), WDK, { ...L, p: [1.05 * s + dx, 0.15, 1.2] });
  }
  const HEAD = { limb: 7, pivot: [0, 4.6, 0] };
  const blocks = [
    { y0: 0.85, y1: 2.75, r: 1.6, c: '#6B3F1F', c2: '#5A3418', style: 'grin', o: {} },
    { y0: 2.75, y1: 4.6, r: 1.5, c: '#8A5A2B', c2: '#744A22', style: 'o', o: {} },
    { y0: 4.6, y1: 6.3, r: 1.4, c: '#A0692F', c2: '#8A5A2B', style: 'angry', o: HEAD },
  ];
  let eyes = null, mouth = null;
  blocks.forEach((B, bi) => {
    const o = B.o, h = B.y1 - B.y0, yc = (B.y0 + B.y1) / 2, zf = B.r * Math.cos(Math.PI / 12);
    k.add(new THREE.CylinderGeometry(B.r, B.r * 1.04, h, 12, 1, bi === 1), wood(B.c, B.c2), { ...o, p: [0, yc, 0], r: [0, Math.PI / 12, 0], jitter: 0.06 });
    // brow
    if (B.style === 'angry') for (const s of sides) k.add(new THREE.BoxGeometry(1.0, 0.3, 0.45), WDK, { ...o, p: [0.5 * s, yc + 0.6, zf + 0.05], r: [0.1, 0, 0.32 * s] });
    else k.add(new THREE.BoxGeometry(2.0, 0.3, 0.42), WDK, { ...o, p: [0, yc + 0.6, zf + 0.02], r: [0.12, 0, 0] });
    // glowing ring eyes
    for (const s of sides) {
      const ex = 0.52 * s, ey = yc + 0.2, er = B.style === 'angry' ? 0.4 : 0.35;
      k.add(new THREE.CylinderGeometry(er, er * 1.05, 0.2, 10), DARK, { ...o, p: [ex, ey, zf + 0.02], r: [Math.PI / 2, 0, 0], jitter: 0 });
      k.add(new THREE.CylinderGeometry(er * 0.68, er * 0.68, 0.12, 10), EYE, { ...o, p: [ex, ey, zf + 0.12], r: [Math.PI / 2, 0, 0], jitter: 0 });
      k.add(new THREE.CylinderGeometry(er * 0.26, er * 0.26, 0.06, 6), DARK, { ...o, p: [ex, ey, zf + 0.19], r: [Math.PI / 2, 0, 0], jitter: 0 });
    }
    if (bi === 2) eyes = P3([0, yc + 0.2, zf + 0.24]);
    // nose
    k.add(new THREE.CylinderGeometry(0.14, 0.32, 0.6, 4), B.c2, { ...o, p: [0, yc - 0.12, zf + 0.1], r: [-0.25, Math.PI / 4, 0] });
    // mouth
    const my = yc - 0.6;
    if (B.style === 'o') {
      k.add(new THREE.CylinderGeometry(0.42, 0.44, 0.22, 12), DARK, { ...o, p: [0, my, zf + 0.02], r: [Math.PI / 2, 0, 0], s: [1.3, 1, 1], jitter: 0 });
      k.add(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 12), GLOW, { ...o, p: [0, my, zf + 0.1], r: [Math.PI / 2, 0, 0], s: [1.3, 1, 1], jitter: 0 });
      k.add(new THREE.BoxGeometry(0.4, 0.5, 0.12), '#E0506A', { ...o, p: [0, my - 0.38, zf + 0.22], r: [0.5, 0, 0] });
    } else {
      const w = B.style === 'grin' ? 1.9 : 1.5;
      k.add(new THREE.BoxGeometry(w, 0.5, 0.26), DARK, { ...o, p: [0, my, zf + 0.02], jitter: 0 });
      k.add(new THREE.BoxGeometry(w * 0.86, 0.28, 0.1), GLOW, { ...o, p: [0, my, zf + 0.12], jitter: 0 });
      const n = B.style === 'grin' ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1) - 0.5) * w * 0.8;
        k.add(new THREE.BoxGeometry(0.16, 0.13, 0.1), WHITE, { ...o, p: [x, my + 0.17, zf + 0.16], jitter: 0 });
        if (B.style === 'grin') k.add(new THREE.BoxGeometry(0.16, 0.13, 0.1), WHITE, { ...o, p: [x, my - 0.17, zf + 0.16], jitter: 0 });
      }
      if (B.style === 'angry') {
        for (const s of sides) k.seg([0.55 * s, my - 0.22, zf + 0.16], [0.57 * s, my + 0.34, zf + 0.2], 0.1, 0, 4, WHITE, o);
        mouth = P3([0, my, zf + 0.2]);
      }
    }
    // war paint on the angled side faces + flared ears
    for (const s of sides) {
      const a = (Math.PI / 3) * s, px = Math.sin(a) * (zf + 0.02), pz = Math.cos(a) * (zf + 0.02);
      [[0.25, TEAL], [0.05, RED], [-0.15, TEAL]].forEach(([dy, c]) => k.add(new THREE.BoxGeometry(0.55, 0.11, 0.06), c, { ...o, p: [px, yc + dy, pz], r: [0, a, 0], jitter: 0 }));
      k.add(new THREE.BoxGeometry(0.34, 1.1, 0.7), (l) => (l.y > 0.3 ? RED : B.c2), { ...o, p: [(B.r + 0.1) * s, yc + 0.05, -0.1], r: [0, 0, 0.12 * s] });
    }
  });
  // painted bands at the joints
  [[2.75, TEAL, 1.7, {}], [4.6, RED, 1.6, {}], [6.2, TEAL, 1.5, HEAD]].forEach(([y, c, r, o]) =>
    k.add(new THREE.CylinderGeometry(r, r, 0.24, 12, 1, true), c, { ...o, p: [0, y, 0], r: [0, Math.PI / 12, 0] }));
  // leafy crown + feathers (head)
  const leaf = (base, dir, len, wid, c1, c2) => {
    const Bv = V(base), D = V(dir).normalize(), side = new THREE.Vector3().crossVectors(D, UP);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const mid = Bv.clone().addScaledVector(D, len * 0.45), tip = Bv.clone().addScaledVector(D, len);
    const g = triGeo([Bv, mid.clone().addScaledVector(side, wid), tip, Bv, tip, mid.clone().addScaledVector(side, -wid)]);
    k.add(g, c1, { ...HEAD, jitter: 0.05 });
    k.add(g, c2, { ...HEAD, inv: true, jitter: 0.03 });
  };
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU + 0.2;
    leaf([Math.sin(a) * 0.55, 6.3, Math.cos(a) * 0.55], [Math.sin(a) * 0.62, 1, Math.cos(a) * 0.62], 1.15 + (i % 2) * 0.2, 0.3, i % 2 ? '#3FA34D' : '#52B95C', '#2E7D3A');
  }
  [[0, RED], [2.1, TEAL], [4.2, RED]].forEach(([a, c]) => leaf([Math.sin(a) * 0.2, 6.3, Math.cos(a) * 0.2], [Math.sin(a) * 0.2, 1, Math.cos(a) * 0.2], 1.1, 0.12, c, c));
  // big slamming arms (3 = left/+X, 4 = right)
  let hand = null;
  for (const s of sides) {
    const A = { limb: s > 0 ? 3 : 4, pivot: [1.45 * s, 4.0, 0] };
    k.add(new THREE.DodecahedronGeometry(0.62, 0), '#8A5A2B', { ...A, p: [1.6 * s, 4.0, 0] });
    k.seg([1.6 * s, 3.9, 0.05], [2.35 * s, 2.95, 0.35], 0.46, 0.4, 8, '#8A5A2B', { ...A, open: true });
    k.add(new THREE.IcosahedronGeometry(0.42, 0), '#744A22', { ...A, p: [2.35 * s, 2.95, 0.35] });
    k.seg([2.35 * s, 2.95, 0.35], [2.45 * s, 1.9, 0.75], 0.4, 0.46, 8, '#8A5A2B', { ...A, open: true });
    k.add(new THREE.CylinderGeometry(0.5, 0.5, 0.26, 8, 1, true), TEAL, { ...A, p: [2.41 * s, 2.35, 0.6], q: qUp([0.1 * s, -1.05, 0.4]) });
    k.add(lumpy(new THREE.DodecahedronGeometry(0.68, 0), 0.08, 40 + s), '#6B3F1F', { ...A, p: [2.48 * s, 1.55, 0.85] });
    if (s > 0) hand = P3([2.48, 1.55, 0.85]);
  }
  return k.build({ height: 7.4, radius: 2.6, eyes, mouth, hand });
}

// YETI KING (frost final boss): shaggy pale fur chunks, navy face/chest/hands, crown of glowing ice spikes.
function bossYeti() {
  const k = new Kit(true, 902);
  const FUR = '#C4D2E6', FUR_L = '#E2EAF6', FUR_D = '#93A8C6', NAVY = '#1C2A52', NAVY_D = '#101A36', CLAW = '#F4F7FF';
  const ICE = hdr('#8FF6FF', 1.9), EYE = hdr('#6FF6FF', 2.8), MOUTH = '#3A0A1E', TONGUE = '#E0507A';
  const fur = (seed) => (l) => { const h = hash3(l.x, l.y, l.z, seed); return h < 0.3 ? FUR_D : h < 0.78 ? FUR : FUR_L; };
  const R = mulberry32(902);
  const tuft = (p, dir, size, o = {}) => { const r = R(); k.add(new THREE.OctahedronGeometry(size, 0), r < 0.35 ? FUR_D : r < 0.6 ? FUR_L : FUR, { ...o, p, q: qUp(dir), s: [0.55, 1.7, 0.4] }); };
  // legs (1 = left/+X, 2 = right)
  for (const s of sides) {
    const L = { limb: s > 0 ? 1 : 2, pivot: [0.95 * s, 2.1, -0.1] };
    k.add(lumpy(new THREE.IcosahedronGeometry(0.85, 1), 0.1, 50 + s), fur(3), { ...L, p: [1.0 * s, 1.5, -0.05], s: [0.95, 1.1, 1.0] });
    k.seg([1.02 * s, 1.0, 0.0], [1.05 * s, 0.4, 0.15], 0.62, 0.55, 8, fur(4), { ...L, open: true });
    k.add(new THREE.BoxGeometry(1.05, 0.46, 1.5), NAVY, { ...L, p: [1.05 * s, 0.23, 0.45] });
    for (const dx of [-0.32, 0, 0.32]) k.seg([1.05 * s + dx, 0.2, 1.15], [1.05 * s + dx, 0.08, 1.45], 0.13, 0, 5, CLAW, L);
    for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU + 0.4; tuft([1.03 * s + Math.sin(a) * 0.6, 0.75, 0.05 + Math.cos(a) * 0.6], [Math.sin(a), -1.4, Math.cos(a)], 0.3, L); }
  }
  // torso + navy chest
  k.add(lumpy(new THREE.IcosahedronGeometry(1.9, 1), 0.08, 51), fur(5), { p: [0, 3.45, -0.1], s: [1.2, 1.05, 0.95] });
  k.add(dome(1.3, 10, 3), NAVY, { p: [0, 3.25, 1.3], q: qUp([0, 0.08, 1]), s: [1.05, 0.5, 1.2], jitter: 0.04 });
  for (let i = 0; i < 40; i++) {
    const a = R() * TAU, e = (R() - 0.3) * 1.5;
    const n = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
    if (n.z > 0.4 && Math.abs(n.x) < 0.65 && n.y < 0.55) continue; // keep the chest clear
    tuft([n.x * 2.2, 3.45 + n.y * 1.95, -0.1 + n.z * 1.72], [n.x * 0.6, -1, n.z * 0.6], 0.34 + R() * 0.16);
  }
  // head (limb 7)
  const H = { limb: 7, pivot: [0, 4.9, 0.5] };
  k.add(lumpy(new THREE.IcosahedronGeometry(0.95, 1), 0.08, 52), fur(6), { ...H, p: [0, 5.4, 0.85], s: [1.1, 1.0, 1.0] });
  k.add(dome(0.72, 10, 3), NAVY, { ...H, p: [0, 5.2, 1.5], q: qUp([0, 0, 1]), s: [1.02, 0.6, 1.08] });
  for (const s of sides) {
    k.add(new THREE.BoxGeometry(0.62, 0.2, 0.36), FUR_L, { ...H, p: [0.3 * s, 5.66, 1.9], r: [0.2, 0, 0.38 * s] });
    k.add(new THREE.OctahedronGeometry(0.13, 0), EYE, { ...H, p: [0.3 * s, 5.47, 1.99], r: [0, 0, 0.35 * s], s: [1.5, 0.55, 0.5], jitter: 0 });
    for (let i = 0; i < 3; i++) tuft([0.95 * s, 5.2 + i * 0.3, 0.6 + i * 0.1], [0.8 * s, -0.6, 0], 0.26, H); // cheek fluff
  }
  k.add(new THREE.OctahedronGeometry(0.12, 0), NAVY_D, { ...H, p: [0, 5.28, 2.02], s: [1.3, 0.8, 0.8] });
  // roaring mouth
  k.add(dome(0.4, 10, 3), MOUTH, { ...H, p: [0, 4.92, 1.74], q: qUp([0, -0.1, 1]), s: [1.2, 0.45, 0.8], jitter: 0 });
  k.add(new THREE.BoxGeometry(0.44, 0.1, 0.3), TONGUE, { ...H, p: [0, 4.76, 1.86], r: [0.25, 0, 0] });
  for (const s of sides) {
    k.seg([0.25 * s, 5.18, 1.95], [0.23 * s, 4.9, 2.0], 0.075, 0, 5, CLAW, H);
    k.seg([0.3 * s, 4.66, 1.93], [0.28 * s, 4.9, 1.98], 0.07, 0, 5, CLAW, H);
  }
  k.add(new THREE.BoxGeometry(0.95, 0.24, 0.55), NAVY, { ...H, p: [0, 4.56, 1.62], r: [0.25, 0, 0] });
  // crown of glowing ice spikes
  k.add(new THREE.CylinderGeometry(0.66, 0.72, 0.2, 10, 1, true), hdr('#6FE0FF', 1.3), { ...H, p: [0, 6.12, 0.8] });
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU, h = i === 0 ? 0.85 : 0.45 + (i % 2) * 0.22;
    const b = [Math.sin(a) * 0.62, 6.12, 0.8 + Math.cos(a) * 0.62];
    k.seg(b, [b[0] * 1.25, 6.12 + h, 0.8 + (b[2] - 0.8) * 1.25], 0.17, 0, 5, ICE, H);
  }
  // huge arms (3 = left/+X, 4 = right)
  let hand = null;
  for (const s of sides) {
    const A = { limb: s > 0 ? 3 : 4, pivot: [1.95 * s, 4.4, 0.1] };
    k.add(lumpy(new THREE.IcosahedronGeometry(1.0, 1), 0.1, 53 + s), fur(7), { ...A, p: [2.1 * s, 4.45, 0.0] });
    k.seg([2.2 * s, 4.1, 0.1], [2.7 * s, 2.85, 0.5], 0.78, 0.62, 8, fur(8), { ...A, open: true });
    k.add(new THREE.IcosahedronGeometry(0.62, 0), fur(9), { ...A, p: [2.7 * s, 2.85, 0.5] });
    k.seg([2.7 * s, 2.85, 0.5], [2.8 * s, 1.35, 1.05], 0.64, 0.52, 8, fur(10), A);
    k.add(new THREE.DodecahedronGeometry(0.62, 0), NAVY, { ...A, p: [2.82 * s, 1.18, 1.12], s: [1, 0.9, 1.1] });
    for (const dx of [-0.25, 0, 0.25]) k.seg([2.82 * s + dx, 1.0, 1.6], [2.82 * s + dx, 0.72, 1.9], 0.1, 0, 5, CLAW, A);
    for (let i = 0; i < 7; i++) { const t = i / 6; tuft([(2.55 + t * 0.35) * s + 0.4 * s, 4.0 - t * 2.3, 0.2 + t * 0.6], [0.8 * s, -1, 0.1], 0.36, A); }
    if (s > 0) hand = P3([2.82, 1.18, 1.12]);
  }
  return k.build({ height: 7.0, radius: 2.5, mouth: P3([0, 4.92, 2.05]), eyes: P3([0, 5.47, 2.05]), hand });
}

// DUNE DEVOURER head. ORIGIN AT ITS CENTRE, faces +Z. Lamprey mouth with rings of teeth, 4 mandibles (3 = upper pair, 4 = lower pair).
const WORM = { PLATE: '#B08850', PLATE_L: '#CDA66C', PLATE_D: '#7A5A30', SPOT: hdr('#3DF2E0', 2.3) };
function bossWorm() {
  const k = new Kit(true, 903);
  const { PLATE, PLATE_L, PLATE_D, SPOT } = WORM;
  const FLESH = '#A8503F', FLESH_D = '#5A1A1E', TOOTH = '#F4EBD6', THROAT = hdr('#3DF2E0', 1.8);
  const toZ = [Math.PI / 2, 0, 0];
  // telescoping armour rings
  [[-1.75, -0.7, 1.6, 1.72], [-0.85, 0.3, 1.68, 1.8], [0.15, 1.05, 1.74, 1.8]].forEach(([z0, z1, rb, rt], i) => {
    k.add(new THREE.CylinderGeometry(rt, rb, z1 - z0, 16, 1, true), ribs(PLATE, PLATE_L, 16), { r: toZ, p: [0, 0, (z0 + z1) / 2], jitter: 0.06 });
    k.add(new THREE.CylinderGeometry(rt + 0.07, rt + 0.07, 0.16, 16, 1, true), PLATE_D, { r: toZ, p: [0, 0, z1 - 0.04] });
    for (let j = 0; j < 7; j++) {
      const a = (j / 7) * TAU + i * 0.45, n = [Math.cos(a), Math.sin(a), 0], r = (rb + rt) / 2 + 0.02;
      k.add(new THREE.OctahedronGeometry(0.15, 0), SPOT, { p: [n[0] * r, n[1] * r, (z0 + z1) / 2], q: qUp(n), s: [1, 0.3, 1.4], jitter: 0 });
    }
  });
  k.add(new THREE.CircleGeometry(1.62, 16), PLATE_D, { p: [0, 0, -1.74], r: [0, Math.PI, 0], jitter: 0 });
  // fleshy lip + funnel mouth into a glowing throat
  k.add(new THREE.TorusGeometry(1.5, 0.3, 6, 16), (l) => (hash3(l.x, l.y, l.z, 3) < 0.4 ? '#8A3A30' : FLESH), { p: [0, 0, 1.18] });
  const fun = new THREE.LatheGeometry([[1.5, 1.22], [1.25, 1.12], [0.9, 0.85], [0.55, 0.5], [0.3, 0.12], [0.0, -0.1]].map(([x, y]) => new THREE.Vector2(x, y)), 16);
  k.add(fun, (l) => (l.y > 0.95 ? FLESH : l.y > 0.3 ? FLESH_D : THROAT), { r: toZ, jitter: 0.05 });
  // rings of inward-pointing teeth
  [[1.22, 1.1, 14, 0.36], [0.88, 0.83, 12, 0.3], [0.55, 0.5, 9, 0.24]].forEach(([r, z, n, len], i) => {
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + i * 0.3, c = Math.cos(a), sn = Math.sin(a);
      k.seg([c * r, sn * r, z], [c * (r - len), sn * (r - len), z - 0.1], 0.085, 0, 4, TOOTH, { jitter: 0.03 });
    }
  });
  // crest spikes along the top
  [[0.6, 0.55], [-0.35, 0.7], [-1.25, 0.55]].forEach(([z, h]) => k.seg([0, 1.72, z], [0, 1.72 + h, z - 0.3], 0.22, 0, 5, (l) => (l.y > 0 ? PLATE_L : PLATE_D)));
  // mandibles
  [[0.25, 3], [0.75, 3], [1.25, 4], [1.75, 4]].forEach(([f, limb]) => {
    const a = f * Math.PI, c = Math.cos(a), sn = Math.sin(a), P = (r, z) => [c * r, sn * r, z];
    const base = P(1.55, 1.2);
    k.add(sweepGeo([base, P(1.78, 1.75), P(1.5, 2.4), P(1.0, 2.78)], [0.24, 0.2, 0.12, 0], 5), (l, w) => (w.z > 2.35 ? TOOTH : PLATE_D), { limb, pivot: base });
  });
  return k.build({ height: 3.6, radius: 1.9, mouth: P3([0, 0, 1.3]), origin: 'center' });
}

// One trailing DUNE DEVOURER body segment (origin at centre, faces +Z).
function bossWormSeg() {
  const k = new Kit(true, 904);
  const { PLATE, PLATE_L, PLATE_D, SPOT } = WORM;
  const prof = [[0, -1.05], [1.2, -1.02], [1.55, -0.72], [1.66, -0.1], [1.6, 0.55], [1.35, 0.95], [0, 1.02]];
  k.add(lathe(prof, 12), (l) => (l.y < -0.8 || l.y > 0.85 ? PLATE_D : Math.floor((Math.atan2(l.x, l.z) + Math.PI) / (TAU / 12)) % 2 ? PLATE : PLATE_L), { r: [Math.PI / 2, 0, 0], jitter: 0.06 });
  k.add(new THREE.CylinderGeometry(1.72, 1.72, 0.2, 12, 1, true), PLATE_D, { r: [Math.PI / 2, 0, 0], p: [0, 0, -0.1] });
  k.seg([0, 1.55, 0.3], [0, 2.2, 0.0], 0.2, 0, 5, (l) => (l.y > 0 ? PLATE_L : PLATE_D));
  k.seg([0, 1.55, -0.45], [0, 2.0, -0.72], 0.16, 0, 5, (l) => (l.y > 0 ? PLATE_L : PLATE_D));
  [0.9, 2.25, 4.05, 5.4].forEach((a) => {
    const n = [Math.cos(a), Math.sin(a), 0];
    k.add(new THREE.OctahedronGeometry(0.15, 0), SPOT, { p: [n[0] * 1.66, n[1] * 1.66, 0.25], q: qUp(n), s: [1, 0.3, 1.4], jitter: 0 });
  });
  return k.build({ height: 3.3, radius: 1.7, origin: 'center' });
}

// THE GRAVELORD (grave final boss): floating hooded reaper; origin at the ragged hem bottom.
function bossLich() {
  const k = new Kit(true, 905);
  const ROBE = '#3A1E5C', ROBE_D = '#1C0F2E', ROBE_L = '#4E2C78', BONE = '#EDE8D8', BONE_D = '#BDB49C', SOCK = '#0A0612', INNER = '#07040C';
  const GLOW = hdr('#5CFF9A', 2.4), WOOD = '#2E2226', STEEL = '#C9D3DA', STEEL_D = '#8A96A2';
  const prof = [[1.5, 0.4], [1.3, 1.0], [1.06, 1.9], [0.92, 2.8], [0.98, 3.45], [0.86, 3.85], [0.5, 4.1], [0.22, 4.18]];
  const profUp = prof.map(([x, y]) => [x, y]);
  k.add(lathe(prof, 16), (l) => (l.y < 0.62 ? ROBE_D : Math.floor((Math.atan2(l.x, l.z) + Math.PI) / (TAU / 16)) % 2 ? ROBE : ROBE_L), { jitter: 0.05 });
  k.add(new THREE.CircleGeometry(1.5, 16), ROBE_D, { p: [0, 0.4, 0], r: [Math.PI / 2, 0, 0], jitter: 0 });
  // ragged hem: tatter tips define y = 0
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU + 0.1, r = 1.42, tipY = [0, 0.14, 0.06, 0.22][i % 4];
    k.seg([Math.sin(a) * r, 0.52, Math.cos(a) * r], [Math.sin(a) * (r + 0.12), tipY, Math.cos(a) * (r + 0.12)], 0.24, 0, 3, i % 2 ? ROBE_D : ROBE);
  }
  // glowing runes: a strip down the front + a ring around the hem
  const rune = (p, rotY, sc, i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotY, 0));
    const strokes = [[[0, 0, 0.3, 0], [0.07, 0.06, 0.16, 0.7], [-0.06, -0.06, 0.16, -0.7]], [[-0.05, 0, 0.28, 0], [0.05, 0, 0.28, 0], [0, 0.03, 0.14, 1.57]], [[0, 0, 0.3, 0.5], [0, 0, 0.3, -0.5]]][i % 3];
    for (const [dx, dy, h, rz] of strokes) {
      const off = new THREE.Vector3(dx * sc, dy * sc, 0).applyQuaternion(q);
      k.add(new THREE.BoxGeometry(0.05 * sc, h * sc, 0.05), GLOW, { p: [p[0] + off.x, p[1] + off.y, p[2] + off.z], r: [0, rotY, rz], jitter: 0 });
    }
  };
  [0.95, 1.5, 2.05, 2.6, 3.1].forEach((y, i) => rune([0, y, profR(profUp, y) + 0.03], 0, 1.1, i));
  for (let i = 0; i < 9; i++) { const a = (i / 9) * TAU + 0.35, r = profR(profUp, 0.78) + 0.03; rune([Math.sin(a) * r, 0.78, Math.cos(a) * r], a, 0.9, i + 1); }
  // bone spikes on the shoulders
  for (const s of sides) for (let i = 0; i < 3; i++) k.seg([(0.72 + i * 0.1) * s, 3.9 - i * 0.05, -0.1 + i * 0.15], [(1.05 + i * 0.12) * s, 4.45 - i * 0.12, -0.3 + i * 0.15], 0.12, 0, 5, BONE_D);
  // hood (open front, dark inside) + skull with glowing green eyes (limb 7)
  const H = { limb: 7, pivot: [0, 3.95, 0.1] };
  const hood = new THREE.LatheGeometry([[0.66, 3.9], [0.74, 4.25], [0.7, 4.65], [0.54, 5.0], [0.28, 5.28], [0.02, 5.45]].map(([x, y]) => new THREE.Vector2(x, y)), 10, 0.75, TAU - 1.5);
  k.add(hood, (l) => (Math.floor((Math.atan2(l.x, l.z) + Math.PI) / (TAU / 10)) % 2 ? ROBE : ROBE_L), { ...H, p: [0, 0, 0.05] });
  k.add(hood, INNER, { ...H, p: [0, 0, 0.05], inv: true, jitter: 0 });
  k.add(new THREE.IcosahedronGeometry(0.36, 1), BONE, { ...H, p: [0, 4.58, 0.32], s: [0.92, 1.05, 1.0] });
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.11, 0), SOCK, { ...H, p: [0.13 * s, 4.64, 0.63], s: [1.1, 0.95, 0.5], jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.06, 0), GLOW, { ...H, p: [0.13 * s, 4.64, 0.67], jitter: 0 });
  }
  k.add(new THREE.OctahedronGeometry(0.06, 0), SOCK, { ...H, p: [0, 4.5, 0.67], s: [0.7, 1, 0.5], jitter: 0 });
  k.add(new THREE.BoxGeometry(0.36, 0.14, 0.26), BONE_D, { ...H, p: [0, 4.3, 0.46] });
  k.add(new THREE.BoxGeometry(0.3, 0.05, 0.04), '#FFFFFF', { ...H, p: [0, 4.38, 0.6], jitter: 0 });
  // left arm (limb 3, +X) raised, casting a green orb
  const LA = { limb: 3, pivot: [0.8, 3.8, 0.1] };
  k.seg([0.8, 3.8, 0.1], [1.35, 3.98, 0.55], 0.26, 0.4, 7, ROBE, { ...LA, open: true });
  k.seg([0.8, 3.8, 0.1], [1.35, 3.98, 0.55], 0.25, 0.39, 7, INNER, { ...LA, open: true, inv: true });
  k.seg([1.35, 3.98, 0.55], [1.55, 4.62, 0.75], 0.07, 0.06, 4, BONE, LA);
  k.add(new THREE.BoxGeometry(0.2, 0.1, 0.22), BONE, { ...LA, p: [1.57, 4.68, 0.77], r: [0.3, 0, 0.2] });
  [[-0.08, 0.02], [-0.03, 0.06], [0.03, 0.05], [0.08, 0.0]].forEach(([dx, dz]) => k.seg([1.57 + dx, 4.72, 0.78 + dz], [1.57 + dx * 2.2, 5.02, 0.8 + dz * 2], 0.03, 0, 3, BONE, LA));
  k.add(new THREE.IcosahedronGeometry(0.22, 0), GLOW, { ...LA, p: [1.6, 5.3, 0.8], jitter: 0 });
  [[0.3, 0.1, 0], [-0.25, 0.15, 0.1], [0.05, 0.32, -0.2]].forEach(([dx, dy, dz]) => k.add(new THREE.OctahedronGeometry(0.06, 0), GLOW, { ...LA, p: [1.6 + dx, 5.3 + dy, 0.8 + dz], s: [0.6, 1.6, 0.6], jitter: 0 }));
  // right arm (limb 4, -X) holding the scythe (part of limb 4 so it swings with the arm)
  const RA = { limb: 4, pivot: [-0.8, 3.8, 0.1] };
  k.seg([-0.8, 3.8, 0.1], [-1.3, 3.2, 0.5], 0.26, 0.4, 7, ROBE, { ...RA, open: true });
  k.seg([-0.8, 3.8, 0.1], [-1.3, 3.2, 0.5], 0.25, 0.39, 7, INNER, { ...RA, open: true, inv: true });
  k.seg([-1.3, 3.2, 0.5], [-1.45, 2.85, 0.9], 0.07, 0.06, 4, BONE, RA);
  k.add(new THREE.BoxGeometry(0.2, 0.24, 0.2), BONE, { ...RA, p: [-1.48, 2.78, 0.95] });
  const shaftZ = (y) => 1.02 - (y - 0.35) * 0.0296;
  k.seg([-1.5, 0.35, 1.02], [-1.5, 6.1, 0.85], 0.065, 0.065, 6, WOOD, { ...RA, open: true });
  [1.6, 4.0, 5.85].forEach((y) => k.add(new THREE.CylinderGeometry(0.09, 0.09, 0.14, 6), BONE_D, { ...RA, p: [-1.5, y, shaftZ(y)] }));
  k.add(new THREE.OctahedronGeometry(0.12, 0), BONE_D, { ...RA, p: [-1.5, 0.3, 1.02] });
  k.add(new THREE.BoxGeometry(0.16, 0.3, 0.3), BONE_D, { ...RA, p: [-1.5, 6.05, 0.86] });
  k.add(sweepGeo([[-1.5, 6.02, 0.86], [-1.5, 6.22, 1.6], [-1.5, 6.02, 2.4], [-1.5, 5.52, 3.0], [-1.5, 4.9, 3.2]], [0.075, 0.07, 0.055, 0.035, 0], 6, 5), (l, w, f) => (Math.floor(f / 2) % 3 === 0 ? STEEL_D : STEEL), { ...RA, jitter: 0.03 });
  // green wisps around the hem
  [[1.2, 0.9, 0.9], [-1.3, 1.4, 0.6], [0.6, 1.9, -1.2], [-0.8, 0.6, -1.3]].forEach((p) => k.add(new THREE.OctahedronGeometry(0.09, 0), GLOW, { p, s: [0.7, 1.8, 0.7], jitter: 0 }));
  return k.build({ height: 5.5, radius: 1.6, hand: P3([1.6, 5.3, 0.8]), eyes: P3([0, 4.64, 0.7]), scytheTip: P3([-1.5, 4.9, 3.2]) });
}

// MAGMAW, the inferno dragon (volcano final boss).
function bossDragon() {
  const k = new Kit(true, 906);
  const SC = '#1B1720', SC_L = '#2A2432', SC_D = '#110E15', BONE = '#E0D4BC';
  const LAVA = hdr('#FF5A00', 2.2), BELLY = hdr('#FF9A1A', 1.7), BELLY_D = hdr('#FF6A00', 1.25), EYE = hdr('#FFE14D', 2.8), THROAT = hdr('#FFC23D', 2.8);
  const MEM = hdr('#FF5A1A', 1.35), MEM_D = hdr('#E0300A', 1.05), MEM_EDGE = hdr('#FF9A2A', 1.75);
  const scales = (seed, p = 0.13) => (l) => { const h = hash3(l.x, l.y, l.z, seed); return h < p ? LAVA : h < 0.55 ? SC : h < 0.85 ? SC_L : SC_D; };
  const band = (t, w = 0.55) => (Math.floor((t + 20) / w) % 2 ? BELLY : BELLY_D);
  // body
  const BZ = [-2.5, -1.4, -0.2, 0.9, 1.75], BY = [2.75, 2.95, 3.15, 3.35, 3.6], BR = [0.85, 1.35, 1.55, 1.45, 0.9];
  const bodyScale = scales(3);
  k.add(sweepGeo(BZ.map((z, i) => [0, BY[i], z]), BR, 12), (l, w) => (w.y < interp(BZ, BY, w.z) - interp(BZ, BR, w.z) * 0.42 ? band(w.z) : bodyScale(l)), { jitter: 0.06 });
  // spiked back
  for (let i = 0; i < 8; i++) {
    const z = 1.3 - i * 0.5, y = interp(BZ, BY, z) + interp(BZ, BR, z) * 0.92, h = 0.65 + Math.sin((i / 7) * Math.PI) * 0.45;
    glowSpike(k, [0, y, z], [0, y + h, z - 0.4], 0.3, 5, SC_D, LAVA);
  }
  // tail (limb 8)
  const TL = { limb: 8, pivot: [0, 2.75, -2.3] };
  const TZ = [-5.3, -4.75, -4.0, -3.1, -2.0], TY = [1.42, 1.62, 2.0, 2.45, 2.75], TR = [0.12, 0.3, 0.5, 0.74, 1.0];
  const tailScale = scales(4);
  k.add(sweepGeo(TZ.map((z, i) => [0, TY[i], z]).reverse(), TR.slice().reverse(), 8), (l, w) => (w.y < interp(TZ, TY, w.z) - interp(TZ, TR, w.z) * 0.4 ? band(w.z, 0.5) : tailScale(l)), { ...TL, jitter: 0.05 });
  k.add(new THREE.OctahedronGeometry(0.6, 0), (L) => (Math.abs(L.x) > 0.4 || L.z < -0.4 ? LAVA : SC_D), { ...TL, p: [0, 1.38, -5.6], s: [1.0, 0.22, 1.1], perVertex: true });
  for (let i = 0; i < 5; i++) {
    const z = -2.5 - i * 0.55, y = interp(TZ, TY, z) + interp(TZ, TR, z) * 0.85;
    glowSpike(k, [0, y, z], [0, y + 0.5 - i * 0.07, z - 0.35], 0.2 - i * 0.02, 4, SC_D, LAVA, TL);
  }
  // neck + head (limb 7, pivot at the neck base)
  const NK = { limb: 7, pivot: [0, 3.65, 1.55] };
  const N0 = V([0, 3.4, 1.35]), N3 = V([0, 5.4, 3.3]);
  const nd = N3.clone().sub(N0).normalize(), nu = new THREE.Vector3(0, -nd.z, nd.y);
  const neckScale = scales(5);
  k.add(sweepGeo([[0, 3.4, 1.35], [0, 4.1, 2.25], [0, 4.8, 2.85], [0, 5.4, 3.3]], [1.1, 0.86, 0.72, 0.64], 10), (l, w) => {
    const rel = w.clone().sub(N0), along = rel.dot(nd);
    rel.addScaledVector(nd, -along);
    return rel.dot(nu) > 0.3 ? band(along, 0.45) : neckScale(l);
  }, { ...NK, jitter: 0.05 });
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4, p = N0.clone().lerp(N3, t), r = 1.0 - t * 0.36;
    const b = p.clone().addScaledVector(nu, -r * 0.9), tip = b.clone().addScaledVector(nu, -0.55).addScaledVector(nd, -0.3);
    glowSpike(k, b.toArray(), tip.toArray(), 0.22, 4, SC_D, LAVA, NK);
  }
  k.add(new THREE.DodecahedronGeometry(0.8, 0), scales(6, 0.12), { ...NK, p: [0, 5.78, 3.55], s: [1.0, 0.82, 1.15] });
  k.add(sweepGeo([[0, 5.85, 3.85], [0, 5.75, 4.6], [0, 5.62, 5.3]], [0.62, 0.48, 0.3], 7, 0.62), SC, NK);
  k.add(new THREE.OctahedronGeometry(0.32, 0), SC_L, { ...NK, p: [0, 5.6, 5.32], s: [1, 0.6, 0.8] });
  for (const s of sides) k.add(new THREE.OctahedronGeometry(0.06, 0), LAVA, { ...NK, p: [0.13 * s, 5.76, 5.42], jitter: 0 });
  const jawY = (z) => 5.32 - 0.55 * (z - 3.8);
  k.add(sweepGeo([[0, 5.32, 3.8], [0, 4.98, 4.45], [0, 4.66, 5.0]], [0.5, 0.38, 0.2], 6, 0.5), (l, w) => (w.y > jawY(w.z) ? '#5A1008' : SC), NK);
  k.add(new THREE.OctahedronGeometry(0.2, 0), SC_L, { ...NK, p: [0, 4.62, 5.05], s: [1.1, 0.7, 0.9] });
  k.add(new THREE.IcosahedronGeometry(0.4, 0), THROAT, { ...NK, p: [0, 5.3, 4.2], s: [1.0, 0.8, 1.2], jitter: 0 });
  k.add(new THREE.BoxGeometry(0.3, 0.08, 0.9), '#8A1A0A', { ...NK, p: [0, 5.1, 4.55], r: [0.45, 0, 0] });
  for (const s of sides) {
    for (let i = 0; i < 5; i++) { const t = i / 4, z = 4.15 + t * 1.0, x = (0.46 - t * 0.2) * s, y = 5.5 - t * 0.1; k.seg([x, y, z], [x * 0.95, y - 0.28 + t * 0.06, z + 0.03], 0.075 - t * 0.012, 0, 4, BONE, NK); }
    for (let i = 0; i < 4; i++) { const t = i / 3, z = 4.2 + t * 0.72, x = (0.34 - t * 0.13) * s, y = jawY(z) + (0.46 - t * 0.24) * 0.5; k.seg([x, y - 0.04, z], [x * 0.95, y + 0.22, z - 0.03], 0.065, 0, 4, BONE, NK); }
    // eyes + angry brows
    k.add(new THREE.OctahedronGeometry(0.15, 0), EYE, { ...NK, p: [0.6 * s, 5.98, 4.05], r: [0, 0.5 * s, 0.35 * s], s: [1.5, 0.5, 0.7], jitter: 0 });
    k.add(new THREE.BoxGeometry(0.55, 0.16, 0.34), SC_D, { ...NK, p: [0.55 * s, 6.16, 3.98], r: [0.1, 0.4 * s, 0.4 * s] });
    // horns
    k.add(sweepGeo([[0.32 * s, 6.2, 3.3], [0.68 * s, 6.72, 2.85], [0.92 * s, 6.98, 2.2], [0.98 * s, 6.9, 1.6]], [0.26, 0.19, 0.11, 0], 6), (l, w) => (w.z < 2.55 ? BONE : '#6A5A50'), NK);
    k.add(sweepGeo([[0.62 * s, 5.55, 3.35], [0.98 * s, 5.62, 2.95], [1.22 * s, 5.7, 2.45]], [0.15, 0.09, 0], 4), BONE, NK);
  }
  k.seg([0, 5.95, 4.85], [0, 6.28, 4.65], 0.12, 0, 4, BONE, NK);
  // hind legs (1 = left/+X, 2 = right)
  for (const s of sides) {
    const L = { limb: s > 0 ? 1 : 2, pivot: [1.15 * s, 2.75, -1.5] };
    k.add(lumpy(new THREE.IcosahedronGeometry(0.85, 1), 0.08, 60 + s), scales(11, 0.12), { ...L, p: [1.35 * s, 2.35, -1.45], s: [0.8, 1.15, 1.1] });
    k.seg([1.4 * s, 1.85, -1.3], [1.45 * s, 0.75, -1.9], 0.42, 0.3, 7, cracks(SC, LAVA, 0.12, 12), { ...L, open: true });
    k.seg([1.45 * s, 0.75, -1.9], [1.45 * s, 0.32, -1.45], 0.3, 0.26, 6, SC_L, { ...L, open: true });
    k.add(new THREE.DodecahedronGeometry(0.5, 0), SC, { ...L, p: [1.45 * s, 0.24, -1.2], s: [0.95, 0.5, 1.3] });
    for (const dx of [-0.24, 0, 0.24]) k.seg([1.45 * s + dx, 0.2, -0.65], [1.45 * s + dx * 1.2, 0.02, -0.3], 0.1, 0, 4, BONE, L);
  }
  // front legs (3 = left/+X, 4 = right)
  for (const s of sides) {
    const A = { limb: s > 0 ? 3 : 4, pivot: [1.2 * s, 3.05, 0.95] };
    k.add(lumpy(new THREE.IcosahedronGeometry(0.66, 1), 0.08, 70 + s), scales(13, 0.12), { ...A, p: [1.38 * s, 2.7, 1.0], s: [0.85, 1.3, 1.0] });
    k.seg([1.45 * s, 2.3, 1.1], [1.5 * s, 0.36, 1.55], 0.36, 0.28, 7, cracks(SC, LAVA, 0.12, 14), { ...A, open: true });
    k.add(new THREE.DodecahedronGeometry(0.46, 0), SC_L, { ...A, p: [1.5 * s, 0.24, 1.72], s: [0.95, 0.5, 1.25] });
    for (const dx of [-0.2, 0, 0.2]) k.seg([1.5 * s + dx, 0.2, 2.15], [1.5 * s + dx * 1.2, 0.02, 2.45], 0.09, 0, 4, BONE, A);
  }
  // wings (5 = left/+X, 6 = right), pivot at the shoulders; glowing membranes, span ~14.4 m
  for (const s of sides) {
    const W = { limb: s > 0 ? 5 : 6, pivot: [1.0 * s, 4.1, 0.75] };
    const m = (p) => new THREE.Vector3(p[0] * s, p[1], p[2]);
    const R0 = m([1.0, 4.25, 0.95]), E = m([3.2, 5.7, 0.45]), Wr = m([4.9, 6.1, -0.3]), R1 = m([1.1, 3.75, -1.45]);
    const F = [m([7.2, 5.0, -0.9]), m([6.6, 3.7, -2.1]), m([5.0, 3.1, -2.9]), m([3.2, 3.2, -2.9])];
    const pull = (a, b, c, t) => a.clone().lerp(b, 0.5).lerp(c, t);
    const M = [pull(F[0], F[1], Wr, 0.28), pull(F[1], F[2], Wr, 0.28), pull(F[2], F[3], Wr, 0.25), pull(F[3], R1, E, 0.22)];
    const tris = [[Wr, F[0], M[0]], [Wr, M[0], F[1]], [Wr, F[1], M[1]], [Wr, M[1], F[2]], [Wr, F[2], M[2]], [Wr, M[2], F[3]], [E, Wr, F[3]], [E, F[3], M[3]], [E, M[3], R1], [E, R1, R0]];
    const top = [];
    for (const [a, b, c] of tris) { const n = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)); if (n.y >= 0) top.push(a, b, c); else top.push(a, c, b); }
    const mem = triGeo(top), edge = [...F, ...M];
    const memCol = (bright, dark) => (L) => (edge.some((q) => q.distanceToSquared(L) < 1e-4) ? bright : dark);
    k.add(mem, memCol(MEM_EDGE, MEM), { ...W, perVertex: true, jitter: 0.04 });
    k.add(mem, memCol(MEM, MEM_D), { ...W, perVertex: true, inv: true, jitter: 0.03 });
    const bone = (a, b, ra, rb, rad) => k.seg(a.toArray(), b.toArray(), ra, rb, rad, SC_D, { ...W, open: true });
    bone(R0, E, 0.3, 0.22, 6); bone(E, Wr, 0.22, 0.15, 6);
    F.forEach((f, i) => bone(Wr, f, 0.13 - i * 0.015, 0.03, 5));
    k.add(new THREE.IcosahedronGeometry(0.26, 0), SC_L, { ...W, p: E.toArray() });
    k.add(new THREE.IcosahedronGeometry(0.22, 0), SC_L, { ...W, p: Wr.toArray() });
    k.seg(Wr.toArray(), Wr.clone().add(m([0.25, 0.55, 0.45])).toArray(), 0.13, 0, 4, BONE, W);
  }
  return k.build({ height: 7.0, radius: 3.5, mouth: P3([0, 5.15, 5.2]), eyes: P3([0, 5.98, 4.1]), wingspan: 14.4, length: 11.8 });
}

// ===========================================================================
// Biome props (origin at base, vertex colours, ≤ 320 tris)
// ===========================================================================
// shared: faceted crystal cluster [x, z, r, h, tiltX, tiltZ, colourIndex]
function crystalCluster(k, set, cols, baseY = -0.1) {
  for (const [x, z, r, h, rx, rz, ci] of set) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz));
    const [c, light] = cols[ci];
    const base = new THREE.Vector3(x, baseY, z), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    k.add(new THREE.CylinderGeometry(r, r * 0.9, h, 6, 1, true), (l) => (l.y > 0 ? light : c), { p: base.clone().addScaledVector(up, h / 2).toArray(), q, jitter: 0.04 });
    k.add(new THREE.ConeGeometry(r, r * 1.6, 6, 1, true), light, { p: base.clone().addScaledVector(up, h + r * 0.8).toArray(), q, jitter: 0.06 });
  }
}

// --- frost ---
function propSnowPine() {
  const k = new Kit(false, 211);
  k.add(new THREE.CylinderGeometry(0.14, 0.22, 1.4, 6), '#5A3A22', { p: [0, 0.7, 0] });
  const tiers = [[0.9, 2.0, 1.6], [1.9, 1.8, 1.25], [2.8, 1.6, 0.95], [3.6, 1.7, 0.66]];
  tiers.forEach(([y, h, r], i) => {
    k.add(new THREE.ConeGeometry(r, h, 8), (l) => (l.y < -h / 2 + 0.01 ? '#123A2A' : i % 2 ? '#1E5A3E' : '#256C48'), { p: [0, y + h / 2, 0], r: [0, i * 0.7, 0], jitter: 0.07 });
    const f = i === 3 ? 0.55 : 0.42;
    k.add(new THREE.ConeGeometry(r * f * 1.1, h * f * 1.02, 8, 1, true), '#F4F8FF', { p: [0, y + h - (h * f) / 2 + 0.03, 0], r: [0, i * 0.7, 0], jitter: 0.04 });
  });
  return k.build({ radius: 0.25, height: 5.3 });
}

function propIceCrystal() {
  const k = new Kit(false, 212);
  const cols = [[hdr('#3DE0FF', 1.25), hdr('#C8FCFF', 1.6)], [hdr('#6FB8FF', 1.15), hdr('#D8F4FF', 1.5)]];
  crystalCluster(k, [[0, 0, 0.3, 1.6, 0, 0, 0], [0.4, 0.1, 0.22, 1.1, 0.35, -0.3, 1], [-0.36, 0.15, 0.2, 0.95, -0.2, 0.35, 0], [0.05, -0.4, 0.18, 0.75, -0.4, 0.1, 1], [0.12, 0.42, 0.15, 0.6, 0.3, 0.2, 0]], cols);
  k.add(lumpy(new THREE.IcosahedronGeometry(0.55, 0), 0.15, 3), '#EAF2FF', { p: [0, 0.02, 0], s: [1.2, 0.28, 1.2], jitter: 0.05 });
  return k.build({ radius: 0.5, height: 2.1 });
}

function propSnowRock() {
  const k = new Kit(false, 213);
  const snowy = (t) => (l) => (l.y > t ? '#F4F8FF' : l.y > t - 0.18 ? '#B9C8DE' : '#5E6E86');
  k.add(lumpy(new THREE.DodecahedronGeometry(0.85, 1), 0.2, 17), snowy(0.3), { p: [0, 0.46, 0], s: [1.15, 0.72, 0.95], jitter: 0.08 });
  k.add(lumpy(new THREE.DodecahedronGeometry(0.36, 0), 0.2, 18), snowy(0.1), { p: [0.85, 0.22, 0.35], jitter: 0.08 });
  return k.build({ radius: 0.8, height: 1.0 });
}

function propSnowman() {
  const k = new Kit(false, 214);
  const snow = (r) => (l) => (l.y < -r * 0.3 ? '#BCD0EC' : l.y > r * 0.4 ? '#FFFFFF' : '#EEF4FC');
  const COAL = '#1A1A22';
  k.add(new THREE.SphereGeometry(0.62, 8, 5), snow(0.62), { p: [0, 0.55, 0], s: [1, 0.9, 1] });
  k.add(new THREE.SphereGeometry(0.46, 7, 5), snow(0.46), { p: [0.03, 1.3, 0.02] });
  k.add(new THREE.SphereGeometry(0.34, 7, 4), snow(0.34), { p: [0.07, 1.9, 0.04], r: [0, 0, 0.15] });
  for (const s of sides) k.add(new THREE.OctahedronGeometry(0.055, 0), COAL, { p: [0.07 + 0.12 * s, 1.99, 0.33], jitter: 0 });
  k.seg([0.07, 1.9, 0.34], [0.12, 1.84, 0.78], 0.07, 0, 5, '#FF8A1F');
  [[-0.14, 1.79], [0, 1.74], [0.14, 1.79]].forEach(([x, y]) => k.add(new THREE.OctahedronGeometry(0.035, 0), COAL, { p: [0.07 + x, y, 0.33], jitter: 0 }));
  k.add(new THREE.OctahedronGeometry(0.045, 0), COAL, { p: [0.03, 1.36, 0.46], jitter: 0 });
  for (const s of sides) {
    const sh = [0.03 + 0.4 * s, 1.4, 0.02], hand = [0.03 + 1.0 * s, 1.72 - (s < 0 ? 0.35 : 0), 0.12];
    k.seg(sh, hand, 0.035, 0.025, 4, '#6B4423', { open: true });
    k.seg(hand, [hand[0] + 0.14 * s, hand[1] + 0.14, hand[2]], 0.02, 0, 3, '#6B4423');
  }
  k.add(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 7), COAL, { p: [0.1, 2.2, 0.03], r: [0, 0, 0.15] });
  k.add(new THREE.CylinderGeometry(0.22, 0.24, 0.4, 7), (l) => (l.y < -0.12 && l.y > -0.2 ? '#D32F2F' : COAL), { p: [0.13, 2.41, 0.03], r: [0, 0, 0.15] });
  k.add(new THREE.CylinderGeometry(0.37, 0.4, 0.13, 8, 1, true), '#D32F2F', { p: [0.04, 1.63, 0.02] });
  return k.build({ radius: 0.6, height: 2.6 });
}

function propFrozenBush() {
  const k = new Kit(false, 215);
  const ice = (r) => (l) => (l.y > r * 0.3 ? '#D4E8FA' : '#7FA8D0');
  k.add(lumpy(new THREE.IcosahedronGeometry(0.5, 1), 0.12, 2), ice(0.5), { p: [0, 0.42, 0], jitter: 0.07 });
  [[0.42, 0.3, 0.1, 0.4], [-0.38, 0.32, -0.12, 0.4], [0.05, 0.28, 0.45, 0.36], [-0.1, 0.3, -0.45, 0.34]].forEach(([x, y, z, r], i) =>
    k.add(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.12, 10 + i), ice(r), { p: [x, y, z], r: [i, i, 0], jitter: 0.07 }));
  [[0.3, 0.72, 0.3], [-0.35, 0.68, 0.2], [0.1, 0.9, -0.2], [0.5, 0.55, -0.2], [-0.2, 0.62, 0.5]].forEach((p, i) =>
    k.add(new THREE.OctahedronGeometry(0.07, 0), hdr('#9FF6FF', 1.6), { p, s: [0.7, 1.8, 0.7], r: [i * 0.4, 0, i * 0.3], jitter: 0 }));
  return k.build({ radius: 0.6, height: 1.05 });
}

function propIceSpire() {
  const k = new Kit(false, 216);
  const shade = (h) => (l) => (l.y > h / 6 ? hdr('#D8FCFF', 1.35) : l.y > -h / 6 ? '#8FD8F4' : '#4F9CD0');
  [[0, 0, 0.62, 4.1, 0.06, -0.05], [0.55, 0.2, 0.36, 2.4, 0.25, -0.35], [-0.5, 0.3, 0.32, 2.0, -0.2, 0.4], [0.1, -0.55, 0.3, 1.6, -0.4, 0.1], [-0.25, -0.35, 0.22, 1.1, -0.3, 0.45]].forEach(([x, z, r, h, rx, rz], i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, i * 0.9, rz));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    k.add(new THREE.CylinderGeometry(0, r, h, 5, 3, true), shade(h), { p: new THREE.Vector3(x, -0.05, z).addScaledVector(up, h / 2).toArray(), q, jitter: 0.05 });
  });
  k.add(lumpy(new THREE.IcosahedronGeometry(0.75, 0), 0.2, 4), '#EAF2FF', { p: [0, 0, 0], s: [1.2, 0.3, 1.2] });
  return k.build({ radius: 0.7, height: 4.1 });
}

// --- desert ---
function propSaguaro() {
  const k = new Kit(false, 221);
  const G1 = '#3F9A45', G2 = '#2F7D38';
  const rib = ribs(G1, G2, 8), sweepRib = (l, w, f) => (Math.floor(f / 2) % 2 ? G1 : G2);
  k.add(new THREE.CylinderGeometry(0.42, 0.48, 4.4, 8, 2, true), rib, { p: [0, 2.2, 0] });
  k.add(dome(0.42, 8, 2), rib, { p: [0, 4.4, 0] });
  const arm = (pts, top) => {
    k.add(sweepGeo(pts, pts.map(() => 0.27), 7), sweepRib, { jitter: 0.05 });
    k.add(dome(0.27, 7, 2), G1, { p: top });
  };
  arm([[0.3, 1.9, 0], [0.85, 2.0, 0], [1.12, 2.3, 0], [1.18, 3.3, 0]], [1.18, 3.3, 0]);
  arm([[-0.3, 2.6, 0.05], [-0.8, 2.68, 0.1], [-1.02, 2.95, 0.1], [-1.08, 3.75, 0.1]], [-1.08, 3.75, 0.1]);
  for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU; k.add(new THREE.OctahedronGeometry(0.08, 0), i === 1 ? '#FFD23D' : '#FF5FA2', { p: [Math.sin(a) * 0.14, 4.82, Math.cos(a) * 0.14] }); }
  return k.build({ radius: 0.45, height: 4.9 });
}

function propBarrelCactus() {
  const k = new Kit(false, 222);
  k.add(lathe([[0, 0], [0.42, 0.02], [0.56, 0.25], [0.56, 0.55], [0.43, 0.8], [0.18, 0.93], [0, 0.95]], 10), ribs('#4FA84A', '#3A8A3C', 10), { jitter: 0.05 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    k.add(new THREE.OctahedronGeometry(0.1, 0), i % 2 ? '#FF5FA2' : '#FF7AB8', { p: [Math.sin(a) * 0.12, 0.99, Math.cos(a) * 0.12], r: [0, a + Math.PI / 2, 0.4], s: [0.7, 0.4, 1.5] });
  }
  k.add(new THREE.OctahedronGeometry(0.06, 0), '#FFD23D', { p: [0, 1.02, 0] });
  [[0.5, 0.4], [1.6, 0.6], [2.7, 0.35], [3.8, 0.62], [4.9, 0.45], [5.8, 0.7]].forEach(([a, y]) =>
    k.seg([Math.sin(a) * 0.54, y, Math.cos(a) * 0.54], [Math.sin(a) * 0.7, y + 0.06, Math.cos(a) * 0.7], 0.025, 0, 3, '#FFF3D0', { jitter: 0 }));
  return k.build({ radius: 0.55, height: 1.05 });
}

function propMesaRock() {
  const k = new Kit(false, 223);
  [[0, 1.3, 1.62, 1.85, '#B5452A'], [1.3, 2.45, 1.45, 1.6, '#D0643A'], [2.45, 3.6, 1.35, 1.45, '#A33A22'], [3.6, 4.75, 1.28, 1.36, '#D9774A'], [4.75, 5.75, 1.2, 1.28, '#B5452A'], [5.75, 6.1, 1.38, 1.24, '#E08A5A']].forEach(([y0, y1, rt, rb, c], i) =>
    k.add(lumpy(new THREE.CylinderGeometry(rt, rb, y1 - y0, 9, 1), 0.07, 30 + i), (l) => (l.y > (y1 - y0) / 2 - 0.01 && i === 5 ? '#C86A40' : c), { p: [0, (y0 + y1) / 2, 0], r: [0, i * 0.5, 0], jitter: 0.07 }));
  [[1.9, 0.3, 0.6, 0.5], [-1.4, 0.25, -1.3, 0.42]].forEach(([x, y, z, r], i) => k.add(lumpy(new THREE.DodecahedronGeometry(r, 0), 0.15, 40 + i), '#A33A22', { p: [x, y, z], jitter: 0.08 }));
  return k.build({ radius: 1.6, height: 6.1 });
}

function propSkull() {
  const k = new Kit(false, 224);
  const BONE = '#F2EBD9', BONE_D = '#D8CDB0', SOCK = '#2A2018';
  k.add(new THREE.DodecahedronGeometry(0.42, 0), BONE, { p: [0, 0.4, -0.2], s: [1.1, 0.85, 1.0] });
  k.seg([0, 0.36, 0.05], [0, 0.2, 0.78], 0.3, 0.17, 6, BONE_D);
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.13, 0), SOCK, { p: [0.27 * s, 0.46, 0.08], s: [1, 1, 0.6], jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.045, 0), SOCK, { p: [0.07 * s, 0.25, 0.8], jitter: 0 });
    k.add(sweepGeo([[0.32 * s, 0.55, -0.25], [0.75 * s, 0.6, -0.22], [1.0 * s, 0.88, -0.1], [0.95 * s, 1.18, 0.05]], [0.1, 0.08, 0.05, 0], 5), (l, w) => (w.y > 0.95 ? '#8A7A60' : BONE_D));
  }
  k.add(new THREE.BoxGeometry(0.34, 0.05, 0.3), '#E8DFC8', { p: [0, 0.09, 0.6] });
  return k.build({ radius: 0.6, height: 1.2 });
}

function propDesertShrub() {
  const k = new Kit(false, 225);
  const rnd = mulberry32(225), C = [0, 0.48, 0], cols = ['#A8844A', '#8A6A3A', '#C9A56A'];
  const rp = () => { const u = rnd() * 2 - 1, a = rnd() * TAU, s = Math.sqrt(1 - u * u); return [C[0] + Math.cos(a) * s * 0.5, C[1] + u * 0.45, C[2] + Math.sin(a) * s * 0.5]; };
  for (let i = 0; i < 18; i++) k.seg(rp(), rp(), 0.025, 0.018, 3, cols[i % 3], { open: true });
  [[0.15, 0.55, 0.1], [-0.2, 0.4, -0.1], [0.05, 0.3, -0.25]].forEach((p, i) => k.add(lumpy(new THREE.IcosahedronGeometry(0.18, 0), 0.2, 50 + i), cols[(i + 1) % 3], { p }));
  return k.build({ radius: 0.5, height: 0.95 });
}

function propDeadPalm() {
  const k = new Kit(false, 226);
  const pts = [];
  for (let i = 0; i <= 5; i++) { const t = i / 5; pts.push([1.8 * t * t, 5.4 * t, 0.3 * t * t]); }
  for (let i = 0; i < 5; i++) { const r0 = 0.3 - i * 0.03; k.seg(pts[i], pts[i + 1], r0, r0 * 0.8, 6, i % 2 ? '#7A6A58' : '#948068', { open: true }); }
  const C = V(pts[5]).add(new THREE.Vector3(0, 0.05, 0));
  k.add(new THREE.IcosahedronGeometry(0.26, 0), '#6E5A44', { p: C.toArray() });
  const up = new THREE.Vector3(0, 1, 0);
  for (let f = 0; f < 5; f++) {
    const a = (f / 5) * TAU + 0.5;
    const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a)), side = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const lift = [0, 0.1, -0.9, -2.2], dist = [0, 0.9, 1.6, 1.9], w = [0.08, 0.4, 0.3, 0.03];
    const P = [], L = [], R = [];
    for (let i = 0; i < 4; i++) {
      const p = C.clone().addScaledVector(dir, dist[i]).addScaledVector(up, lift[i]);
      P.push(p); L.push(p.clone().addScaledVector(side, w[i])); R.push(p.clone().addScaledVector(side, -w[i]));
    }
    const tris = [];
    for (let i = 0; i < 3; i++) tris.push(P[i], L[i], L[i + 1], P[i], L[i + 1], P[i + 1], P[i], P[i + 1], R[i + 1], P[i], R[i + 1], R[i]);
    const leaf = triGeo(tris);
    k.add(leaf, f % 2 ? '#A08050' : '#B8955E', { jitter: 0.06 });
    k.add(leaf, '#7A6040', { inv: true, jitter: 0.05 });
  }
  return k.build({ radius: 0.32, height: 5.6 });
}

// --- grave ---
function propDeadTree() {
  const k = new Kit(false, 231);
  const BARK = (l, w, f) => (f % 3 === 0 ? '#4E3A5E' : f % 3 === 1 ? '#3A2A46' : '#453352');
  const trunk = [[0, 0, 0], [0.18, 1.2, 0.05], [-0.12, 2.4, 0.12], [0.22, 3.6, -0.05], [0.05, 4.7, 0.1]];
  k.add(sweepGeo(trunk, [0.45, 0.32, 0.26, 0.18, 0.08], 6), BARK);
  [[1, [0.9, 2.2, 0.3], [1.5, 3.1, 0.2]], [2, [-1.0, 3.1, -0.2], [-1.4, 4.0, 0.1]], [3, [0.9, 4.3, -0.4], [1.2, 5.5, -0.3]], [3, [-0.7, 4.5, 0.4], [-0.9, 5.7, 0.7]], [4, [0.4, 5.6, 0.3], [0.2, 6.1, 0.5]]].forEach(([ti, mid, tip], i) => {
    k.add(sweepGeo([trunk[ti], mid, tip], [0.14 - (ti > 3 ? 0.06 : 0), 0.08, 0], 4), BARK);
    k.seg(mid, [mid[0] * 1.3 + 0.2, mid[1] + 0.5, mid[2] - 0.3], 0.04, 0, 3, '#2A1E30');
  });
  for (let i = 0; i < 3; i++) { const a = (i / 3) * TAU + 0.4; k.seg([0, 0.25, 0], [Math.sin(a) * 0.9, 0.02, Math.cos(a) * 0.9], 0.2, 0.04, 4, '#2A1E30'); }
  return k.build({ radius: 0.4, height: 6.1 });
}

function propTombstone() {
  const k = new Kit(false, 232);
  const ST = (l) => (hash3(l.x, l.y, l.z, 7) < 0.15 ? '#6E8A5A' : '#8E929C');
  k.add(new THREE.BoxGeometry(0.9, 0.95, 0.22, 2, 3, 1), ST, { p: [0, 0.6, 0], r: [0, 0, 0.06] });
  k.add(new THREE.CylinderGeometry(0.45, 0.45, 0.22, 8, 1, false, -Math.PI / 2, Math.PI), ST, { p: [-0.028, 1.074, 0], r: [-Math.PI / 2, 0, 0.06], order: 'ZYX' });
  k.add(new THREE.BoxGeometry(0.08, 0.36, 0.02), '#4E525A', { p: [-0.03, 0.82, 0.115], r: [0, 0, 0.06], jitter: 0 });
  k.add(new THREE.BoxGeometry(0.26, 0.07, 0.02), '#4E525A', { p: [-0.035, 0.9, 0.115], r: [0, 0, 0.06], jitter: 0 });
  k.add(new THREE.BoxGeometry(1.1, 0.14, 0.45), '#6E727C', { p: [0, 0.07, 0] });
  k.add(lumpy(new THREE.IcosahedronGeometry(0.6, 0), 0.12, 8), '#4A3A2E', { p: [0, 0.02, 0.95], s: [0.8, 0.28, 1.25] });
  return k.build({ radius: 0.55, height: 1.55 });
}

function propTombstone2() { // pointed obelisk-style stone
  const k = new Kit(false, 234);
  k.add(new THREE.BoxGeometry(0.8, 0.2, 0.8), '#6E727C', { p: [0, 0.1, 0] });
  k.add(new THREE.CylinderGeometry(0.22, 0.3, 1.5, 4, 4), (l) => (hash3(l.x, l.y, l.z, 2) < 0.15 ? '#6E8A5A' : '#9A9EA8'), { p: [0, 0.95, 0], r: [0, Math.PI / 4, 0] });
  k.add(new THREE.ConeGeometry(0.24, 0.35, 4), '#A8ACB6', { p: [0, 1.87, 0], r: [0, Math.PI / 4, 0] });
  return k.build({ radius: 0.45, height: 2.05 });
}

function propTombstone3() { // cracked, sunken slab leaning back
  const k = new Kit(false, 235);
  const ST = (l) => (hash3(l.x, l.y, l.z, 3) < 0.2 ? '#6E8A5A' : '#7E828C');
  k.add(new THREE.BoxGeometry(0.75, 0.8, 0.18), ST, { p: [0.05, 0.36, 0], r: [-0.3, 0, -0.12] });
  k.add(new THREE.BoxGeometry(0.4, 0.3, 0.18), ST, { p: [0.18, 0.86, -0.13], r: [-0.35, 0, 0.35] });
  k.add(lumpy(new THREE.IcosahedronGeometry(0.5, 0), 0.12, 9), '#4A3A2E', { p: [0, 0.0, 0.65], s: [0.8, 0.25, 1.1] });
  return k.build({ radius: 0.45, height: 1.1 });
}

function propCross() {
  const k = new Kit(false, 233);
  const W = (l, w, f) => (f % 4 < 2 ? '#6B4A2E' : '#5A3C24');
  k.add(new THREE.BoxGeometry(0.16, 1.6, 0.13), W, { p: [0, 0.78, 0], r: [0.08, 0.2, 0.1] });
  k.add(new THREE.BoxGeometry(0.85, 0.14, 0.13), W, { p: [-0.13, 1.12, 0.03], r: [0.08, 0.2, 0.1] });
  k.add(lumpy(new THREE.IcosahedronGeometry(0.55, 0), 0.12, 6), '#4A3A2E', { p: [0, 0.02, 0.75], s: [0.8, 0.28, 1.3] });
  return k.build({ radius: 0.3, height: 1.6 });
}

function propPumpkin() {
  const k = new Kit(false, 236);
  const FACE = hdr('#FFC23D', 2.4);
  k.add(new THREE.SphereGeometry(0.55, 10, 6), ribs('#FF7F11', '#E0600A', 10), { p: [0, 0.4, 0], s: [1, 0.74, 1] });
  k.seg([0, 0.78, 0], [0.06, 1.0, -0.05], 0.07, 0.05, 5, '#3E6B2A');
  k.add(new THREE.OctahedronGeometry(0.16, 0), '#3E8E3E', { p: [0.18, 0.8, -0.12], r: [0, 0.5, 0.3], s: [1.4, 0.2, 0.8] });
  for (const s of sides) k.add(new THREE.OctahedronGeometry(0.1, 0), FACE, { p: [0.18 * s, 0.52, 0.47], s: [1.1, 1.0, 0.4], r: [0, 0, Math.PI / 4], jitter: 0 });
  k.add(new THREE.OctahedronGeometry(0.06, 0), FACE, { p: [0, 0.42, 0.53], s: [1, 1, 0.4], jitter: 0 });
  [[-0.2, 0.3, 0.2], [0, 0.26, -0.2], [0.2, 0.3, 0.2]].forEach(([x, y, rz]) => k.add(new THREE.BoxGeometry(0.2, 0.08, 0.06), FACE, { p: [x, y, 0.49], r: [0, x * 0.8, rz], jitter: 0 }));
  return k.build({ radius: 0.55, height: 1.0 });
}

function propGlowShroom() {
  const k = new Kit(false, 237);
  [[0, 0, 0.62, 0.3, hdr('#3DF2FF', 1.6)], [0.3, 0.15, 0.4, 0.2, hdr('#C04DFF', 1.5)], [-0.25, 0.2, 0.32, 0.17, hdr('#C04DFF', 1.5)], [0.05, -0.3, 0.26, 0.14, hdr('#3DF2FF', 1.6)]].forEach(([x, z, h, r, c], i) => {
    k.add(new THREE.CylinderGeometry(r * 0.28, r * 0.36, h, 6, 1, true), '#D8D0E8', { p: [x, h / 2, z], r: [0.1 * i, 0, 0.08 * (i - 1.5)] });
    k.add(dome(r, 7, 2), c, { p: [x, h, z], s: [1, 0.7, 1], jitter: 0.04 });
    k.add(underside(r, 7, 0.03), '#5A4A7A', { p: [x, h, z] });
    k.add(new THREE.OctahedronGeometry(r * 0.2, 0), hdr('#FFFFFF', 1.8), { p: [x + r * 0.3, h + r * 0.55, z + r * 0.2], s: [1, 0.4, 1], jitter: 0 });
  });
  return k.build({ radius: 0.35, height: 0.85 });
}

function propFence() {
  const k = new Kit(false, 238);
  const IRON = '#26242E', ST = '#6E6A78';
  for (const s of sides) {
    k.add(new THREE.BoxGeometry(0.3, 1.3, 0.3), ST, { p: [1.5 * s, 0.65, 0] });
    k.add(new THREE.ConeGeometry(0.24, 0.22, 4), '#86828F', { p: [1.5 * s, 1.41, 0], r: [0, Math.PI / 4, 0] });
  }
  [0.35, 1.02].forEach((y) => k.add(new THREE.BoxGeometry(2.8, 0.06, 0.06), IRON, { p: [0, y, 0] }));
  for (let i = 0; i < 7; i++) {
    const x = -1.2 + i * 0.4, top = 1.18 + (i % 2) * 0.08;
    k.seg([x, 0.05, 0], [x, top, 0], 0.028, 0.028, 4, IRON, { open: true });
    k.add(new THREE.OctahedronGeometry(0.07, 0), IRON, { p: [x, top + 0.06, 0], s: [0.6, 1.4, 0.4] });
  }
  return k.build({ radius: 0.35, height: 1.52, halfWidth: 1.65 });
}

// --- volcano ---
function propObsidian() {
  const k = new Kit(false, 241);
  const glass = (l, w, f) => (f % 5 === 0 ? '#6A4A9A' : f % 5 === 2 ? '#3A2A52' : f % 2 ? '#1A1420' : '#241C2C');
  [[0, 0, 0.36, 2.0, 0.05, -0.08], [0.5, 0.2, 0.26, 1.3, 0.3, -0.45], [-0.45, 0.25, 0.24, 1.2, -0.25, 0.45], [0.1, -0.5, 0.22, 1.0, -0.45, 0.1], [-0.2, -0.3, 0.16, 0.7, -0.3, 0.5]].forEach(([x, z, r, h, rx, rz], i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, i, rz));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q), base = new THREE.Vector3(x, -0.1, z);
    k.add(new THREE.CylinderGeometry(r, r * 1.1, h, 6, 1, true), glass, { p: base.clone().addScaledVector(up, h / 2).toArray(), q, jitter: 0.08 });
    k.add(new THREE.ConeGeometry(r, r * 2.2, 6, 1, true), glass, { p: base.clone().addScaledVector(up, h + r * 1.1).toArray(), q, jitter: 0.08 });
  });
  return k.build({ radius: 0.6, height: 2.7 });
}

function propCharredTree() {
  const k = new Kit(false, 242);
  const CHAR = cracks('#1C1818', hdr('#FF5A00', 2.0), 0.1, 3), EMBER = hdr('#FF8A1A', 2.4);
  const trunk = [[0, 0, 0], [0.12, 1.3, 0.05], [-0.08, 2.6, 0.1], [0.1, 3.7, 0]];
  k.add(sweepGeo(trunk, [0.4, 0.3, 0.2, 0.08], 6), CHAR);
  [[1, [0.8, 2.1, 0.2], [1.2, 2.9, 0.1]], [2, [-0.8, 3.0, -0.2], [-1.1, 3.6, 0.1]], [2, [0.6, 3.3, -0.4], [0.8, 4.2, -0.4]], [3, [-0.2, 4.2, 0.3], [-0.3, 4.6, 0.5]]].forEach(([ti, mid, tip]) => {
    k.add(sweepGeo([trunk[ti], mid, tip], [0.12, 0.07, 0.02], 4), CHAR);
    k.add(new THREE.OctahedronGeometry(0.1, 0), EMBER, { p: tip, jitter: 0 });
  });
  k.add(new THREE.OctahedronGeometry(0.1, 0), EMBER, { p: [0.1, 3.72, 0], jitter: 0 });
  return k.build({ radius: 0.35, height: 4.7 });
}

function propLavaRock() {
  const k = new Kit(false, 243);
  k.add(lumpy(new THREE.DodecahedronGeometry(0.8, 1), 0.2, 21), cracks('#221E24', hdr('#FF6A00', 2.2), 0.22, 4), { p: [0, 0.43, 0], s: [1.15, 0.7, 1], jitter: 0.08 });
  k.add(lumpy(new THREE.DodecahedronGeometry(0.34, 0), 0.2, 22), cracks('#2A2428', hdr('#FF8A1A', 2.2), 0.3, 5), { p: [0.8, 0.14, 0.35], jitter: 0.08 });
  return k.build({ radius: 0.8, height: 0.95 });
}

function propEmberCrystal() {
  const k = new Kit(false, 244);
  const cols = [[hdr('#FF7A00', 1.5), hdr('#FFD23D', 2.1)], [hdr('#FF4A00', 1.4), hdr('#FFB300', 1.9)]];
  crystalCluster(k, [[0, 0, 0.28, 1.5, 0, 0, 0], [0.38, 0.1, 0.2, 1.0, 0.35, -0.3, 1], [-0.34, 0.15, 0.2, 0.9, -0.2, 0.35, 0], [0.05, -0.38, 0.18, 0.7, -0.4, 0.1, 1], [0.12, 0.4, 0.14, 0.55, 0.3, 0.2, 0]], cols);
  k.add(lumpy(new THREE.DodecahedronGeometry(0.5, 0), 0.2, 5), '#221E24', { p: [0, 0.0, 0], s: [1.2, 0.4, 1.2] });
  return k.build({ radius: 0.5, height: 1.95 });
}

function propBonePile() {
  const k = new Kit(false, 245);
  const BONE = '#E8E0CC', BONE_D = '#C9BFA6';
  [[[-0.5, 0.12, -0.2], [0.45, 0.14, 0.15]], [[-0.3, 0.14, 0.4], [0.4, 0.3, -0.3]], [[0.1, 0.1, -0.55], [0.3, 0.12, 0.5]], [[-0.55, 0.24, 0.2], [0.1, 0.4, 0.05]]].forEach(([a, b], i) => {
    k.seg(a, b, 0.055, 0.055, 5, i % 2 ? BONE : BONE_D, { open: true });
    const d = V(b).sub(V(a)).normalize(), side = new THREE.Vector3().crossVectors(d, UP).normalize().multiplyScalar(0.05);
    for (const p of [a, b]) for (const sg of [1, -1]) k.add(new THREE.OctahedronGeometry(0.075, 0), BONE, { p: V(p).addScaledVector(side, sg).toArray(), jitter: 0.04 });
  });
  k.add(new THREE.DodecahedronGeometry(0.24, 0), BONE, { p: [0.05, 0.42, 0.25], s: [1, 0.9, 1.1], r: [0.3, 0.4, 0] });
  for (const s of sides) k.add(new THREE.OctahedronGeometry(0.07, 0), '#2A2018', { p: [0.05 + 0.09 * s, 0.46, 0.49], jitter: 0 });
  return k.build({ radius: 0.6, height: 0.68 });
}

function propVent() {
  const k = new Kit(false, 246);
  k.add(lathe([[1.25, 0], [1.0, 0.35], [0.62, 0.75], [0.46, 0.86], [0.36, 0.72], [0.0, 0.62]], 10), (l) => (l.y > 0.8 ? '#3A2E30' : hash3(l.x, l.y, l.z, 6) < 0.15 ? hdr('#FF5A00', 2.0) : '#221C20'), { jitter: 0.07 });
  k.add(new THREE.CircleGeometry(0.37, 10), hdr('#FF8A1A', 2.5), { p: [0, 0.745, 0], r: [-Math.PI / 2, 0, 0], jitter: 0 });
  return k.build({ radius: 1.0, height: 0.86, mouth: { x: 0, y: 0.7, z: 0 } });
}

// ===========================================================================
// New projectiles (centred on their origin)
// ===========================================================================
function projSnowball() {
  const k = new Kit(false, 406);
  k.add(lumpy(new THREE.IcosahedronGeometry(0.45, 1), 0.07, 6), (l) => (l.y < -0.12 ? '#A8C4E8' : l.y > 0.2 ? '#FFFFFF' : '#E4EEFA'), { jitter: 0.04 });
  return k.build({ radius: 0.45 });
}

function projSkull() {
  const k = new Kit(false, 407);
  const B = hdr('#B6FFC8', 1.4), F = hdr('#5CFF7A', 1.9), SOCK = '#06140A';
  k.add(new THREE.IcosahedronGeometry(0.3, 1), B, { p: [0, 0.04, -0.02], s: [0.9, 0.95, 1.05], jitter: 0.04 });
  k.add(new THREE.BoxGeometry(0.3, 0.12, 0.24), hdr('#9CFFB4', 1.2), { p: [0, -0.2, 0.08] });
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.09, 0), SOCK, { p: [0.1 * s, 0.07, 0.26], s: [1, 1, 0.5], jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.035, 0), hdr('#EFFFD8', 2.6), { p: [0.1 * s, 0.07, 0.3], jitter: 0 });
  }
  [[0, 0.2, 0.2, 0.55], [0.15, 0.1, 0.14, 0.45], [-0.15, 0.1, 0.14, 0.45], [0, -0.05, 0.15, 0.4]].forEach(([x, y, r, len]) => k.seg([x, y, -0.12], [x * 1.4, y + 0.12, -0.12 - len], r, 0, 5, F));
  return k.build({ radius: 0.4 });
}

function projFireball() {
  const k = new Kit(false, 408);
  k.add(new THREE.IcosahedronGeometry(0.3, 1), (l) => (l.z > 0.05 ? hdr('#FFF0A0', 2.8) : hdr('#FFB300', 2.3)), { jitter: 0.03 });
  for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; k.seg([Math.cos(a) * 0.14, Math.sin(a) * 0.14, -0.05], [Math.cos(a) * 0.24, Math.sin(a) * 0.24, -0.6 - (i % 2) * 0.15], 0.17, 0, 5, i % 2 ? hdr('#FF6A00', 1.8) : hdr('#FF9A1A', 2.0)); }
  k.seg([0, 0, -0.1], [0, 0, -0.95], 0.2, 0, 6, hdr('#FF5A00', 1.6));
  return k.build({ radius: 0.45 });
}

function projCoconut() {
  const k = new Kit(false, 409);
  k.add(lumpy(new THREE.IcosahedronGeometry(0.35, 1), 0.06, 7), (l) => (hash3(l.x, l.y, l.z, 2) < 0.4 ? '#5A3A1E' : '#6B4423'), { jitter: 0.06 });
  [[0.08, 0.33, 0.06], [-0.08, 0.33, 0.06], [0, 0.34, -0.07]].forEach((p) => k.add(new THREE.OctahedronGeometry(0.045, 0), '#2A1A0E', { p, jitter: 0 }));
  [[0.12, 0.08, 0.6], [0.17, -0.02, -0.6], [0.22, -0.1, 0.6], [0.26, -0.2, -0.5]].forEach(([x, y, rz]) => k.add(new THREE.BoxGeometry(0.03, 0.13, 0.02), '#F2E6C9', { p: [x, y, Math.sqrt(Math.max(0, 0.35 * 0.35 - x * x - y * y)) + 0.005], r: [0, Math.atan2(x, 0.3), rz], jitter: 0 }));
  return k.build({ radius: 0.36 });
}

function projScarab() {
  const k = new Kit(false, 410);
  k.add(dome(0.24, 8, 3), (l) => (Math.abs(l.x) < 0.02 ? '#062A28' : l.y > 0.14 ? '#7FFFF0' : '#13B8A8'), { p: [0, -0.02, -0.03], s: [1, 0.8, 1.25] });
  k.add(new THREE.CylinderGeometry(0.23, 0.2, 0.05, 8), '#0B4F4B', { p: [0, -0.03, -0.03], s: [1, 1, 1.25] });
  k.add(new THREE.IcosahedronGeometry(0.1, 0), '#0E8F86', { p: [0, 0.0, 0.3] });
  for (const s of sides) {
    k.seg([0.05 * s, -0.01, 0.36], [0.03 * s, 0.03, 0.46], 0.025, 0, 3, '#FFC23D');
    [0.12, -0.02, -0.16].forEach((z) => k.seg([0.18 * s, -0.04, z], [0.3 * s, -0.12, z + 0.04], 0.018, 0.012, 3, '#062A28', { open: true }));
  }
  return k.build({ radius: 0.3 });
}

function projIcicle() {
  const k = new Kit(false, 411);
  const c = (l, w, f) => (f % 2 ? hdr('#9FF6FF', 1.3) : hdr('#DFFFFF', 1.5));
  k.add(new THREE.CylinderGeometry(0, 0.16, 1.0, 6, 1, true), c, { p: [0, 0, 0.1], r: [Math.PI / 2, 0, 0], jitter: 0.03 });
  k.add(new THREE.CylinderGeometry(0.16, 0, 0.3, 6, 1, true), hdr('#6FD8FF', 1.2), { p: [0, 0, -0.55], r: [Math.PI / 2, 0, 0], jitter: 0.03 });
  return k.build({ radius: 0.6 });
}

function projBone() {
  const k = new Kit(false, 412);
  k.seg([-0.33, 0, 0], [0.33, 0, 0], 0.065, 0.065, 6, '#F2EBD9', { open: true });
  for (const x of [-0.38, 0.38]) for (const z of [-0.075, 0.075]) k.add(new THREE.IcosahedronGeometry(0.1, 0), '#E8DFC8', { p: [x, 0, z], s: [1, 0.8, 1] });
  return k.build({ radius: 0.48 });
}

// ===========================================================================
// Eruption hazards: clusters of spikes, origin at base (~2.2 m)
// ===========================================================================
const HAZARD_STYLE = {
  icespike: { base: '#3F8FC8', tip: hdr('#CFFBFF', 1.8), mid: hdr('#6FE0FF', 1.3), debris: '#DCEBFA' },
  sandspike: { base: '#B8925A', tip: '#EBCB92', mid: '#D2AE72', debris: '#C9A26A', bands: true },
  bonespike: { base: '#C9BFA6', tip: '#FFFFFF', mid: '#E8E0CC', debris: '#D8CDB5' },
  lavaspike: { base: '#1E1A22', tip: hdr('#FF7A1A', 2.4), mid: '#2E2630', debris: '#2A2428' },
};
function buildHazard(kind) {
  const S = HAZARD_STYLE[kind];
  const k = new Kit(false, 1500 + Object.keys(HAZARD_STYLE).indexOf(kind));
  [[0, 0, 0.36, 2.2, 0.04, -0.05], [0.5, 0.25, 0.26, 1.5, 0.3, -0.4], [-0.45, 0.3, 0.24, 1.35, 0.25, 0.4], [0.15, -0.5, 0.22, 1.15, -0.4, -0.1], [-0.35, -0.35, 0.18, 0.85, -0.35, 0.4]].forEach(([x, z, r, h, rx, rz], i) => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, i * 1.3, rz));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const colour = S.bands
      ? (L) => (L.y > h * 0.25 ? S.tip : Math.floor((L.y + h) / 0.3) % 2 ? S.mid : S.base)
      : (L) => (L.y > h * 0.3 ? S.tip : L.y > -h * 0.15 ? S.mid : S.base);
    k.add(new THREE.CylinderGeometry(0, r, h, 5, 2), colour, { p: new THREE.Vector3(x, -0.1, z).addScaledVector(up, h / 2).toArray(), q, perVertex: !S.bands, jitter: 0.05 });
  });
  [[0.7, -0.2], [-0.6, -0.5], [0.1, 0.65], [-0.75, 0.3]].forEach(([x, z], i) => k.add(new THREE.OctahedronGeometry(0.18, 0), S.debris, { p: [x, 0.05, z], r: [i, i * 2, 0], s: [1, 0.6, 1] }));
  return k.build({ radius: 0.8, height: 2.2 });
}
export const HAZARD_KINDS = Object.keys(HAZARD_STYLE);
export function buildHazardGeometry(kind) {
  if (!HAZARD_STYLE[kind]) throw new Error(`buildHazardGeometry: unknown kind "${kind}"`);
  return buildHazard(kind);
}

// ===========================================================================
// Structures (Groups with named children the game animates)
// ===========================================================================
// flat ring of rune glyphs (flat = lying on the ground, else standing in the XY plane facing +Z)
function runeGeo(n, radius, size, seed = 1, flat = true) {
  const rnd = mulberry32(seed), parts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU, strokes = 2 + Math.floor(rnd() * 2);
    for (let j = 0; j < strokes; j++) {
      const p = new THREE.PlaneGeometry(size * 0.13, size * (0.45 + rnd() * 0.5));
      p.rotateZ((rnd() - 0.5) * 1.8); p.translate((rnd() - 0.5) * size * 0.45, (rnd() - 0.5) * size * 0.25, 0);
      if (flat) { p.translate(0, radius, 0); p.rotateX(-Math.PI / 2); p.rotateY(a); } else { p.translate(0, radius, 0); p.rotateZ(a); }
      parts.push(rampGeo(p, () => 1));
    }
  }
  return mergeGeometries(parts);
}
// glowing circle the player stands in (bright rim, faint fill)
function padMesh(r, color, y) {
  const geo = rampGeo(new THREE.RingGeometry(r * 0.12, r, 40, 3), (x, yy) => { const d = Math.hypot(x, yy) / r; return d > 0.8 ? 1 : 0.22; });
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, glowMaterial(color, 0.8, true));
  m.name = 'pad'; m.position.y = y; m.renderOrder = 2;
  return m;
}
function glowChild(geo, name, color, opacity = 0.85, vc = true) {
  const m = new THREE.Mesh(geo, glowMaterial(color, opacity, vc));
  m.name = name; m.renderOrder = 2;
  return m;
}

function portal(o) {
  const g = new THREE.Group(); g.name = o.name;
  const mat = makeToonMaterial();
  const { RZ, RY, RR, RT } = o;
  const k = new Kit(false, o.seed);
  k.add(new THREE.CylinderGeometry(o.pr, o.pr + 0.3, 0.45, 20), (l) => (l.y > 0.2 ? o.ST_L : o.ST), { p: [0, 0.225, 0], jitter: 0.07 });
  k.add(new THREE.CylinderGeometry(o.pr - 0.8, o.pr - 0.6, 0.32, 20), (l) => (l.y > 0.15 ? o.TOP : o.ST_D), { p: [0, 0.61, 0], jitter: 0.05 });
  if (o.trim) k.add(new THREE.CylinderGeometry(o.pr + 0.04, o.pr + 0.04, 0.09, 20, 1, true), o.trim, { p: [0, 0.4, 0], jitter: 0 });
  // ring supports + a sill under the ring
  for (const s of sides) {
    k.seg([(RR - 0.15) * s, 0.7, RZ], [(RR - 0.35) * s, 2.0, RZ], 0.42, 0.3, 6, o.ST, { jitter: 0.06 });
    k.add(new THREE.BoxGeometry(0.8, 0.22, 0.8), o.CAP, { p: [(RR - 0.35) * s, 2.05, RZ] });
  }
  k.add(new THREE.BoxGeometry(1.8, 0.5, 1.1), o.ST_D, { p: [0, 0.9, RZ] });
  o.decoratePlatform(k);
  g.add(solidMesh(k.build(), 'platform', mat));
  const r = new Kit(false, o.seed + 1);
  o.decorateRing(r);
  const ring = solidMesh(r.build(), 'ring', mat);
  ring.position.set(0, RY, RZ);
  g.add(ring);
  const vortex = new THREE.Mesh(new THREE.CircleGeometry(o.VR, 48), new THREE.MeshBasicMaterial({ color: o.vortex, side: THREE.DoubleSide }));
  vortex.name = 'vortex'; vortex.position.set(0, RY, RZ);
  g.add(vortex);
  const runes = glowChild(runeGeo(o.runeN, o.runeR, 0.42, o.seed), 'runes', o.rune);
  runes.position.y = 0.785;
  g.add(runes);
  const pad = padMesh(1.25, o.pad, 0.785);
  pad.position.z = 1.3;
  g.add(pad);
  g.userData = { radius: 3.2, height: o.height, portalCenter: { x: 0, y: RY, z: RZ }, padCenter: { x: 0, y: 0.785, z: 1.3 } };
  return g;
}

function structBossPortal() {
  const RR = 2.95, RT = 0.46;
  const ST = '#3A3440', ST_D = '#231F29', ST_L = '#554C60', BONE = '#D8D0BC', SOCK = '#120E16', GEM = hdr('#FF2A6A', 2.2), GEM2 = hdr('#B04DFF', 2.0);
  return portal({
    name: 'bossPortal', seed: 1001, RZ: -1.1, RY: 3.9, RR, RT, VR: 2.6, pr: 4.2, height: 7.9,
    ST, ST_D, ST_L, TOP: '#4A4254', CAP: ST_L, vortex: '#7A2CFF', rune: '#FF2A6A', pad: '#B04DFF', runeN: 28, runeR: 3.05,
    decoratePlatform(k) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + TAU / 16, x = Math.sin(a) * 4.32, z = Math.cos(a) * 4.32;
        k.add(new THREE.IcosahedronGeometry(0.22, 0), BONE, { p: [x, 0.26, z], s: [1, 0.9, 0.8], r: [0, a, 0] });
        for (const s of sides) k.add(new THREE.OctahedronGeometry(0.065, 0), SOCK, { p: [x + Math.cos(a) * 0.08 * s + Math.sin(a) * 0.16, 0.29, z - Math.sin(a) * 0.08 * s + Math.cos(a) * 0.16], jitter: 0 });
      }
      for (let i = 0; i < 6; i++) { // leaning standing stones around the back
        const a = Math.PI * 0.62 + (i / 5) * Math.PI * 0.76, x = Math.sin(a) * 3.75, z = Math.cos(a) * 3.75;
        k.add(new THREE.BoxGeometry(0.5, 1.5 + (i % 2) * 0.5, 0.35), (l) => (l.y > 0.5 ? ST_L : ST), { p: [x, 1.0, z], r: [0.1 * (i % 2 ? 1 : -1), a, 0.12] });
        k.add(new THREE.OctahedronGeometry(0.1, 0), i % 2 ? GEM : GEM2, { p: [x - Math.sin(a) * 0.2, 1.35, z - Math.cos(a) * 0.2], jitter: 0 });
      }
    },
    decorateRing(r) {
      r.add(new THREE.TorusGeometry(RR, RT, 6, 24), (l) => (hash3(l.x, l.y, l.z, 2) < 0.3 ? ST_D : ST), { jitter: 0.08 });
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + TAU / 24, c = Math.cos(a), sn = Math.sin(a);
        if (sn < -0.8) continue; // bottom sits in the platform
        r.seg([c * (RR + RT * 0.6), sn * (RR + RT * 0.6), 0], [c * (RR + RT + 0.8), sn * (RR + RT + 0.8), 0], 0.24, 0, 4, ST_L, { jitter: 0.06 });
        r.add(new THREE.OctahedronGeometry(0.14, 0), i % 2 ? GEM : GEM2, { p: [c * RR, sn * RR, RT * 0.95], jitter: 0 });
      }
      // horned skull at the crown of the ring
      r.add(new THREE.IcosahedronGeometry(0.62, 1), BONE, { p: [0, RR + RT + 0.3, 0.25], s: [1, 0.95, 0.9] });
      for (const s of sides) {
        r.add(new THREE.OctahedronGeometry(0.18, 0), GEM, { p: [0.22 * s, RR + RT + 0.38, 0.8], s: [1, 0.8, 0.45], jitter: 0 });
        r.seg([0.45 * s, RR + RT + 0.55, 0.1], [1.05 * s, RR + RT + 1.2, -0.1], 0.15, 0, 5, BONE);
      }
      r.add(new THREE.BoxGeometry(0.62, 0.2, 0.4), BONE, { p: [0, RR + RT - 0.15, 0.45] });
    },
  });
}

function structExitPortal() {
  const RR = 2.5, RT = 0.36;
  const WH = '#F4F1EA', WH_D = '#D8D2C4', GOLD = '#FFC23D', GOLD_D = '#D9961A', GEM = hdr('#3DF2FF', 2.0);
  return portal({
    name: 'exitPortal', seed: 1011, RZ: -1.0, RY: 3.35, RR, RT, VR: 2.3, pr: 3.9, height: 7.0,
    ST: WH, ST_D: WH_D, ST_L: '#FFFFFF', TOP: '#FBF8F0', CAP: GOLD, trim: GOLD, vortex: '#FFF3C4', rune: '#FFD23D', pad: '#FFE27A', runeN: 24, runeR: 2.8,
    decoratePlatform(k) {
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + TAU / 16; k.add(new THREE.OctahedronGeometry(0.16, 0), i % 2 ? GEM : GOLD, { p: [Math.sin(a) * 4.02, 0.24, Math.cos(a) * 4.02], s: [1, 1.2, 1], jitter: 0 }); }
    },
    decorateRing(r) {
      r.add(new THREE.TorusGeometry(RR, RT, 6, 24), (l, w, f) => (f % 6 < 2 ? WH_D : WH), { jitter: 0.04 });
      r.add(new THREE.TorusGeometry(RR - RT * 0.55, 0.1, 4, 24), GOLD, { p: [0, 0, RT * 0.6], jitter: 0.03 });
      r.add(new THREE.TorusGeometry(RR + RT * 0.8, 0.09, 4, 24), GOLD_D, { jitter: 0.03 });
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU, c = Math.cos(a), sn = Math.sin(a);
        if (sn < -0.75) continue;
        const len = i % 2 ? 0.55 : 0.95;
        r.seg([c * (RR + RT * 0.7), sn * (RR + RT * 0.7), 0], [c * (RR + RT + len), sn * (RR + RT + len), 0], 0.14, 0, 4, i % 2 ? GOLD_D : GOLD, { jitter: 0.03 });
      }
      const star = new THREE.ExtrudeGeometry(starShape(0.62, 0.27), { depth: 0.18, bevelEnabled: false });
      r.add(star, GOLD, { p: [0, RR + RT + 0.62, -0.09], jitter: 0.04 });
      r.add(new THREE.OctahedronGeometry(0.18, 0), GEM, { p: [0, RR + RT + 0.62, 0.14], jitter: 0 });
    },
  });
}

function structMoai() {
  const g = new THREE.Group(); g.name = 'moai';
  const ST = '#7E858F', ST_D = '#5E646E', ST_L = '#9AA1AA', MOSS = '#6E8A4A';
  const stone = (l) => { const h = hash3(l.x, l.y, l.z, 4); return h < 0.14 ? MOSS : h < 0.55 ? ST : ST_L; };
  const k = new Kit(false, 1101);
  k.add(new THREE.BoxGeometry(3.4, 0.4, 4.6), (l) => (l.y > 0.19 ? ST_L : ST_D), { p: [0, 0.2, 0.2], jitter: 0.06 });
  k.add(new THREE.BoxGeometry(2.2, 0.2, 0.6), ST_D, { p: [0, 0.1, 2.75] });
  k.add(new THREE.BoxGeometry(1.4, 3.1, 1.2, 2, 5, 2), stone, { p: [0, 1.95, -0.9], jitter: 0.06 });
  k.add(new THREE.BoxGeometry(1.5, 0.34, 0.5), ST_L, { p: [0, 3.02, -0.3] });
  for (const s of sides) k.add(new THREE.BoxGeometry(0.42, 0.26, 0.1), '#24262B', { p: [0.36 * s, 2.72, -0.27], jitter: 0 });
  k.add(new THREE.CylinderGeometry(0.12, 0.3, 1.2, 4), ST, { p: [0, 2.25, -0.18], r: [-0.18, Math.PI / 4, 0] });
  k.add(new THREE.BoxGeometry(0.8, 0.14, 0.2), ST_D, { p: [0, 1.5, -0.24] });
  k.add(new THREE.BoxGeometry(0.9, 0.12, 0.22), ST_L, { p: [0, 1.36, -0.24] });
  k.add(new THREE.BoxGeometry(1.2, 0.5, 0.4), ST, { p: [0, 1.0, -0.32] });
  for (const s of sides) k.add(new THREE.BoxGeometry(0.16, 1.3, 0.4), ST_D, { p: [0.76 * s, 2.35, -0.95] });
  k.add(new THREE.CylinderGeometry(0.62, 0.66, 0.55, 10), (l) => (l.y > 0.26 ? '#B35A3E' : '#9A4A32'), { p: [0, 3.78, -0.95], jitter: 0.05 });
  g.add(solidMesh(k.build(), 'statue'));
  const eyes = glowChild(mergeGeometries(sides.map((s) => rampGeo(new THREE.BoxGeometry(0.34, 0.16, 0.04).translate(0.36 * s, 2.72, -0.2), () => 1))), 'eyes', '#3DF2FF', 0.95);
  g.add(eyes);
  const pad = padMesh(1.1, '#3DF2FF', 0.41); pad.position.z = 1.35; g.add(pad);
  g.userData = { radius: 2.8, height: 4.1, padCenter: { x: 0, y: 0.41, z: 1.35 } };
  return g;
}

function structTotem() {
  const g = new THREE.Group(); g.name = 'totem';
  const W = '#3A2418', W2 = '#4E3020', WD = '#1E120A', RED = '#C62828', BONE = '#E8E0CC';
  const k = new Kit(false, 1201);
  k.add(new THREE.CylinderGeometry(1.4, 1.6, 0.3, 12), (l) => (l.y > 0.14 ? '#6E6874' : '#5A5560'), { p: [0, 0.15, 0], jitter: 0.06 });
  [[0.3, 1.35, 0.55, W], [1.35, 2.35, 0.5, W2], [2.35, 3.3, 0.46, W]].forEach(([y0, y1, r, c], i) => {
    const yc = (y0 + y1) / 2, zf = r * Math.cos(Math.PI / 8);
    k.add(new THREE.CylinderGeometry(r, r * 1.05, y1 - y0, 8), c, { p: [0, yc, 0], r: [0, Math.PI / 8, 0], jitter: 0.06 });
    k.add(new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.08, 8, 1, true), RED, { p: [0, y1 - 0.05, 0], r: [0, Math.PI / 8, 0] });
    for (const s of sides) {
      k.add(new THREE.BoxGeometry(0.22, 0.13, 0.08), WD, { p: [0.18 * s, yc + 0.17, zf], jitter: 0 });
      k.add(new THREE.BoxGeometry(0.07, 0.42, 0.05), RED, { p: [0.33 * s, yc - 0.04, zf - 0.08], r: [0, 0.45 * s, 0], jitter: 0 });
    }
    k.add(new THREE.BoxGeometry(0.46, 0.13, 0.1), WD, { p: [0, yc - 0.24, zf], jitter: 0 });
    k.add(new THREE.BoxGeometry(0.12, 0.22, 0.14), i % 2 ? W : W2, { p: [0, yc, zf + 0.03] });
  });
  for (const s of sides) k.add(new THREE.BoxGeometry(0.95, 0.35, 0.12), (l) => (l.x * s > 0.2 ? RED : WD), { p: [0.9 * s, 2.15, 0], r: [0, 0, 0.25 * s] });
  k.add(new THREE.IcosahedronGeometry(0.42, 1), BONE, { p: [0, 3.68, 0.03], s: [0.95, 1, 1.05] });
  k.add(new THREE.BoxGeometry(0.52, 0.1, 0.24), RED, { p: [0, 3.73, 0.32], jitter: 0 });
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.1, 0), '#150A08', { p: [0.15 * s, 3.72, 0.4], s: [1, 0.9, 0.5], jitter: 0 });
    k.seg([0.3 * s, 3.85, 0], [0.62 * s, 4.25, -0.08], 0.09, 0, 5, BONE);
  }
  k.add(new THREE.BoxGeometry(0.34, 0.14, 0.24), BONE, { p: [0, 3.36, 0.2] });
  g.add(solidMesh(k.build(), 'pole'));
  const fl = [[0, 0, 0.3, 0.95], [0.13, 0.05, 0.18, 0.62], [-0.12, -0.05, 0.19, 0.68]].map(([x, z, r, h]) => {
    const c = new THREE.ConeGeometry(r, h, 8, 1, true); c.translate(x, h / 2, z);
    return rampGeo(c, (px, py) => Math.max(0, 1 - py / (h * 1.05)));
  });
  const flame = glowChild(mergeGeometries(fl), 'flame', '#FF7A1A', 0.95);
  flame.position.y = 4.02;
  g.add(flame);
  g.add(padMesh(2.1, '#FF3A2A', 0.31));
  g.userData = { radius: 2.6, height: 5.0 };
  return g;
}

function structGreed() {
  const g = new THREE.Group(); g.name = 'greed';
  const GOLD = '#FFC23D', GOLD_D = '#D9961A', GOLD_L = '#FFE27A', RUBY = hdr('#FF2E63', 1.8);
  const k = new Kit(false, 1301);
  k.add(new THREE.CylinderGeometry(1.25, 1.4, 0.35, 10), (l) => (l.y > 0.17 ? '#4E4458' : '#3A3040'), { p: [0, 0.175, 0] });
  k.add(new THREE.CylinderGeometry(0.85, 0.95, 0.25, 10), GOLD_D, { p: [0, 0.475, 0] });
  k.add(new THREE.CylinderGeometry(0.42, 0.52, 1.0, 8), (l, w, f) => (f % 4 < 2 ? GOLD : GOLD_L), { p: [0, 1.1, 0] });
  k.add(new THREE.CylinderGeometry(0.75, 0.55, 0.22, 10), GOLD, { p: [0, 1.71, 0] });
  for (let i = 0; i < 9; i++) { const a = i * 2.4, rr = 1.0 + (i % 3) * 0.1; k.add(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 8), i % 2 ? GOLD : GOLD_L, { p: [Math.sin(a) * rr, 0.38 + (i % 2) * 0.04, Math.cos(a) * rr], r: [(i % 3) * 0.2, 0, (i % 2) * 0.3], jitter: 0 }); }
  for (let i = 0; i < 4; i++) { const a = (i / 4) * TAU + Math.PI / 4; k.add(new THREE.OctahedronGeometry(0.09, 0), RUBY, { p: [Math.sin(a) * 0.47, 1.1, Math.cos(a) * 0.47], jitter: 0 }); }
  g.add(solidMesh(k.build(), 'pedestal'));
  const d = new Kit(false, 1302);
  d.add(new THREE.IcosahedronGeometry(0.34, 1), GOLD, { p: [0, -0.1, 0], s: [1.05, 0.95, 0.9] });
  d.add(new THREE.DodecahedronGeometry(0.27, 0), GOLD_L, { p: [0, 0.3, 0.02] });
  for (const s of sides) {
    d.add(new THREE.OctahedronGeometry(0.07, 0), RUBY, { p: [0.1 * s, 0.34, 0.24], jitter: 0 });
    d.seg([0.3 * s, 0.02, 0.05], [0.18 * s, -0.12, 0.3], 0.07, 0.06, 5, GOLD_D);
    d.add(new THREE.OctahedronGeometry(0.1, 0), GOLD_D, { p: [0.26 * s, 0.33, -0.02], s: [0.5, 1, 1] });
    d.add(new THREE.IcosahedronGeometry(0.12, 0), GOLD_D, { p: [0.18 * s, -0.4, 0.12], s: [1, 0.6, 1.3] });
  }
  d.add(new THREE.BoxGeometry(0.2, 0.04, 0.05), '#6A3A00', { p: [0, 0.22, 0.25], jitter: 0 });
  for (let i = 0; i < 5; i++) { const a = (i / 5) * TAU; d.seg([Math.sin(a) * 0.16, 0.5, Math.cos(a) * 0.16], [Math.sin(a) * 0.2, 0.66, Math.cos(a) * 0.2], 0.05, 0, 4, GOLD); }
  const idol = new THREE.Mesh(d.build(), makeToonMaterial({ emissive: new THREE.Color('#6a4400'), emissiveIntensity: 0.6 }));
  idol.name = 'idol'; idol.castShadow = true; idol.position.set(0, 2.45, 0);
  g.add(idol);
  const shaft = rampGeo(new THREE.CylinderGeometry(0.8, 0.6, 2.2, 16, 1, true), (x, y) => (y < 0 ? 0.9 : 0));
  shaft.translate(0, 1.82 + 1.1, 0);
  const halo = rampGeo(new THREE.RingGeometry(0.62, 1.1, 24, 1), (x, y) => (Math.hypot(x, y) < 0.7 ? 1 : 0));
  halo.rotateX(-Math.PI / 2); halo.translate(0, 1.83, 0);
  g.add(glowChild(mergeGeometries([shaft, halo]), 'glow', '#FFD23D', 0.7));
  g.add(padMesh(1.9, '#FFD23D', 0.03));
  g.userData = { radius: 2.5, height: 3.15, idolCenter: { x: 0, y: 2.45, z: 0 } };
  return g;
}

function structPylon() {
  const g = new THREE.Group(); g.name = 'pylon';
  const STEEL = '#8A94A6', STEEL_D = '#4A5260', STEEL_L = '#B8C2D0', COPPER = '#C87533', SILVER = '#E6ECF4';
  const k = new Kit(false, 1401);
  k.add(new THREE.CylinderGeometry(1.35, 1.45, 0.3, 16), (l) => (l.y > 0.14 ? STEEL : STEEL_D), { p: [0, 0.15, 0], jitter: 0.04 });
  for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU + TAU / 32; k.add(new THREE.BoxGeometry(0.42, 0.12, 0.06), i % 2 ? '#FFD23D' : '#22242A', { p: [Math.sin(a) * 1.41, 0.15, Math.cos(a) * 1.41], r: [0, a, 0], jitter: 0 }); }
  k.add(new THREE.CylinderGeometry(0.3, 0.42, 2.1, 8), (l, w, f) => (f % 4 < 2 ? STEEL : STEEL_L), { p: [0, 1.35, 0] });
  [0.8, 1.3, 1.8].forEach((y) => k.add(new THREE.TorusGeometry(0.42 - (y - 0.8) * 0.05, 0.075, 4, 10), COPPER, { p: [0, y, 0], r: [Math.PI / 2, 0, 0] }));
  k.add(new THREE.CylinderGeometry(0.16, 0.22, 0.2, 8), STEEL_D, { p: [0, 2.42, 0] });
  k.add(new THREE.TorusGeometry(0.55, 0.2, 6, 12, Math.PI), (l) => (l.x > 0 ? '#E53935' : '#C62828'), { p: [0, 2.95, 0], r: [0, 0, Math.PI] });
  for (const s of sides) k.add(new THREE.CylinderGeometry(0.2, 0.2, 0.28, 8), SILVER, { p: [0.55 * s, 3.09, 0] });
  g.add(solidMesh(k.build(), 'base'));
  const o = new Kit(false, 1402);
  o.add(new THREE.IcosahedronGeometry(0.26, 1), (l) => (hash3(l.x, l.y, l.z, 2) < 0.4 ? hdr('#DFFFFF', 2.2) : hdr('#3DF2FF', 1.8)), { jitter: 0 });
  for (let i = 0; i < 6; i++) { const a = i * 1.1, e = ((i % 3) - 1) * 0.7, dd = [Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)]; o.add(new THREE.OctahedronGeometry(0.06, 0), hdr('#BFFBFF', 2.4), { p: dd.map((v) => v * 0.36), q: qUp(dd), s: [0.5, 3, 0.5], jitter: 0 }); }
  const orb = new THREE.Mesh(o.build(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
  orb.name = 'orb'; orb.castShadow = true; orb.position.set(0, 3.5, 0);
  g.add(orb);
  const halo = rampGeo(new THREE.IcosahedronGeometry(0.58, 1), () => 0.55); halo.translate(0, 3.5, 0);
  const ring = rampGeo(new THREE.RingGeometry(0.3, 0.8, 24, 1), (x, y) => (Math.hypot(x, y) < 0.35 ? 1 : 0)).toNonIndexed(); ring.translate(0, 3.5, 0);
  const shaft = rampGeo(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 6, 1, true), () => 0.8).toNonIndexed(); shaft.translate(0, 3.1, 0);
  g.add(glowChild(mergeGeometries([halo, ring, shaft]), 'glow', '#3DF2FF', 0.5));
  g.add(padMesh(1.95, '#3DF2FF', 0.03));
  g.userData = { radius: 2.6, height: 3.9, orbCenter: { x: 0, y: 3.5, z: 0 } };
  return g;
}

const STRUCTURE_BUILDERS = { bossPortal: structBossPortal, exitPortal: structExitPortal, moai: structMoai, totem: structTotem, greed: structGreed, pylon: structPylon };
export const STRUCTURE_KINDS = Object.keys(STRUCTURE_BUILDERS);
export function buildStructure(kind) {
  const fn = STRUCTURE_BUILDERS[kind];
  if (!fn) throw new Error(`buildStructure: unknown kind "${kind}"`);
  return fn();
}
