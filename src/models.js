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
        colArr[i] = Math.min(1, c.r * k); colArr[i + 1] = Math.min(1, c.g * k); colArr[i + 2] = Math.min(1, c.b * k);
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
// ---------------------------------------------------------------------------
function enemyBlob() {
  const k = new Kit(true, 11);
  const PINK = '#FF4FA3', DARK = '#C2185B', SHINE = '#FFA3D2';
  const prof = [[0, 0], [0.5, 0], [0.575, 0.1], [0.565, 0.28], [0.48, 0.5], [0.33, 0.7], [0.16, 0.86], [0.05, 0.96], [0, 1.0]];
  k.add(lathe(prof, 10), (l, w) => (w.y < 0.12 ? DARK : w.y > 0.5 && w.x < -0.1 && w.z > 0.05 ? SHINE : PINK));
  for (const s of sides) {
    k.eye([0.15 * s, 0.5, 0.385], 0.16, { dir: [0.38 * s, 0.3, 1], look: [-0.06 * s, -0.06, 0], limb: 7, pivot: [0, 0.5, 0.3] });
  }
  k.add(dome(0.07, 7, 2), '#5A0B2E', { p: [0, 0.3, 0.525], q: qUp([0, 0.2, 1]), s: [1.5, 0.5, 1.0], jitter: 0 });
  return k.build({ height: 1.0, radius: 0.55 });
}

function enemyGoon() {
  const k = new Kit(true, 22);
  const SKIN = '#8B5CF6', SKIN_D = '#6A3FD8', CLOTH = '#3B2A5C', BELLY = '#B79BFF', BONE = '#F2E6C9';
  for (const s of sides) {
    const limb = s > 0 ? 1 : 2, hip = [0.13 * s, 0.38, 0];
    k.seg(hip, [0.14 * s, 0.08, 0.01], 0.085, 0.075, 5, SKIN, { limb, pivot: hip, open: true });
    k.add(new THREE.BoxGeometry(0.16, 0.09, 0.25), SKIN_D, { limb, pivot: hip, p: [0.14 * s, 0.045, 0.05] });
  }
  k.add(new THREE.CylinderGeometry(0.24, 0.29, 0.2, 7), CLOTH, { p: [0, 0.4, 0] });
  k.add(new THREE.IcosahedronGeometry(0.27, 0), (l) => (l.z > 0.1 && l.y < 0.12 ? BELLY : SKIN), { p: [0, 0.62, 0], s: [1.08, 1.0, 0.92] });
  // head group (limb 7)
  const H = { limb: 7, pivot: [0, 0.84, 0] };
  k.add(new THREE.DodecahedronGeometry(0.33, 0), SKIN, { ...H, p: [0, 1.07, 0.05], s: [1.12, 0.92, 1.0] });
  for (const s of sides) {
    k.seg([0.29 * s, 1.1, 0.0], [0.6 * s, 1.25, -0.07], 0.1, 0, 3, SKIN, H);
    k.eye([0.13 * s, 1.14, 0.29], 0.11, { ...H, dir: [0.3 * s, 0.1, 1], seg: 7, hs: 3, pseg: 5, look: [-0.05 * s, -0.04, 0] });
    k.seg([0.075 * s, 0.92, 0.3], [0.085 * s, 1.0, 0.34], 0.026, 0, 3, BONE, H);
  }
  k.seg([0, 1.04, 0.3], [0, 0.97, 0.49], 0.075, 0, 4, SKIN_D, H);
  // arms (3 = left/+X, 4 = right/-X) + bone club in right hand
  for (const s of sides) {
    const limb = s > 0 ? 3 : 4, sh = [0.3 * s, 0.78, 0];
    k.seg(sh, [0.37 * s, 0.5, 0.06], 0.065, 0.055, 4, SKIN, { limb, pivot: sh });
    k.add(new THREE.OctahedronGeometry(0.09, 0), SKIN, { limb, pivot: sh, p: [0.38 * s, 0.46, 0.07], s: [1, 0.9, 1.1] });
  }
  const R = { limb: 4, pivot: [-0.3, 0.78, 0] };
  k.seg([-0.38, 0.38, 0.0], [-0.38, 0.66, 0.3], 0.03, 0.045, 4, BONE, { ...R, open: true });
  k.add(new THREE.OctahedronGeometry(0.055, 0), BONE, { ...R, p: [-0.34, 0.68, 0.33] });
  k.add(new THREE.OctahedronGeometry(0.055, 0), BONE, { ...R, p: [-0.42, 0.68, 0.33] });
  return k.build({ height: 1.4, radius: 0.45 });
}

function enemyZippy() {
  const k = new Kit(true, 33);
  const SHELL = '#FF5A36', SHELL_D = '#DB3F1F', BELLY = '#FFD166', LEG = '#7A1E12', HEAD = '#C7351F';
  k.add(dome(0.3, 8, 3), (l) => (Math.floor((l.z + 0.3) / 0.15) % 2 ? SHELL : SHELL_D), { p: [0, 0.14, -0.04], s: [1, 0.95, 1.3] });
  k.add(new THREE.CylinderGeometry(0.29, 0.25, 0.09, 7), BELLY, { p: [0, 0.12, -0.04], s: [1, 1, 1.3] });
  const H = { limb: 7, pivot: [0, 0.2, 0.3] };
  k.add(new THREE.IcosahedronGeometry(0.15, 0), HEAD, { ...H, p: [0, 0.21, 0.38], s: [1.1, 0.9, 1.0] });
  for (const s of sides) {
    k.eye([0.075 * s, 0.29, 0.43], 0.085, { ...H, dir: [0.4 * s, 0.5, 1], seg: 6, full: 3, pseg: 6 });
    k.seg([0.05 * s, 0.3, 0.42], [0.15 * s, 0.56, 0.56], 0.013, 0.01, 3, LEG, { ...H, open: true });
    k.add(new THREE.OctahedronGeometry(0.035, 0), BELLY, { ...H, p: [0.15 * s, 0.57, 0.565] });
    k.seg([0.05 * s, 0.15, 0.5], [0.025 * s, 0.1, 0.58], 0.025, 0, 3, BELLY, H);
  }
  // 6 legs, tripod gait: limb 1 = L-front, R-mid, L-back; limb 2 = R-front, L-mid, R-back
  [0.18, -0.03, -0.24].forEach((z, i) => {
    for (const s of sides) {
      const limb = (s > 0) === (i !== 1) ? 1 : 2;
      const hip = [0.22 * s, 0.13, z], knee = [0.36 * s, 0.2, z + 0.02], foot = [0.42 * s, 0.0, z + 0.04];
      k.seg(hip, knee, 0.028, 0.024, 4, LEG, { limb, pivot: hip, open: true });
      k.seg(knee, foot, 0.024, 0.018, 4, LEG, { limb, pivot: hip, open: true });
    }
  });
  k.add(sweepGeo([[0, 0.14, -0.38], [0, 0.16, -0.55], [0, 0.24, -0.68], [0, 0.36, -0.7]], [0.03, 0.025, 0.018, 0], 4), '#FF8FA3', { limb: 8, pivot: [0, 0.14, -0.4] });
  return k.build({ height: 0.6, radius: 0.4 });
}

function enemyBrute() {
  const k = new Kit(true, 44);
  const SLATE = '#5B6C9A', SLATE_D = '#46557D', CHUNK = '#8FA3D1', GLOW = '#FF9E2C';
  for (const s of sides) {
    const limb = s > 0 ? 1 : 2, hip = [0.42 * s, 0.9, -0.1];
    k.seg(hip, [0.46 * s, 0.22, -0.02], 0.25, 0.21, 5, SLATE_D, { limb, pivot: hip });
    k.add(new THREE.BoxGeometry(0.44, 0.26, 0.58), CHUNK, { limb, pivot: hip, p: [0.47 * s, 0.13, 0.06] });
  }
  k.add(lumpy(new THREE.DodecahedronGeometry(0.8, 0), 0.08, 4), SLATE, { p: [0, 1.58, -0.05], s: [1.28, 0.98, 0.95], r: [0.3, 0, 0], jitter: 0.1 });
  [[0.35, 2.2, -0.45, 0.4], [-0.3, 2.28, -0.35, -0.5], [0.0, 1.95, -0.78, 1.1]].forEach(([x, y, z, a]) =>
    k.add(new THREE.OctahedronGeometry(0.28, 0), CHUNK, { p: [x, y, z], r: [a * 0.5, a, -0.6 * a], s: [1, 1.4, 1] }));
  const H = { limb: 7, pivot: [0, 2.12, 0.35] };
  k.add(new THREE.IcosahedronGeometry(0.26, 0), SLATE, { ...H, p: [0, 2.28, 0.5], s: [1.1, 0.9, 1] });
  k.add(new THREE.BoxGeometry(0.5, 0.11, 0.18), SLATE_D, { ...H, p: [0, 2.39, 0.68], r: [0.2, 0, 0] });
  k.add(new THREE.BoxGeometry(0.38, 0.13, 0.22), SLATE_D, { ...H, p: [0, 2.13, 0.62] });
  for (const s of sides) {
    k.add(new THREE.OctahedronGeometry(0.065, 0), GLOW, { ...H, p: [0.11 * s, 2.3, 0.72], s: [1.5, 0.8, 0.6], jitter: 0 });
  }
  for (const s of sides) {
    const limb = s > 0 ? 3 : 4, sh = [0.95 * s, 2.02, 0.05], A = { limb, pivot: sh };
    k.add(lumpy(new THREE.IcosahedronGeometry(0.44, 0), 0.1, 5 + s), CHUNK, { ...A, p: [1.0 * s, 2.14, 0.0] });
    k.seg([0.98 * s, 2.0, 0.05], [1.12 * s, 1.25, 0.22], 0.27, 0.22, 5, SLATE, { ...A, open: true });
    k.add(new THREE.IcosahedronGeometry(0.25, 0), SLATE_D, { ...A, p: [1.12 * s, 1.25, 0.22] });
    k.seg([1.12 * s, 1.25, 0.22], [1.12 * s, 0.46, 0.33], 0.24, 0.33, 5, SLATE, { ...A, open: true });
    k.add(lumpy(new THREE.IcosahedronGeometry(0.37, 0), 0.1, 9 + s), CHUNK, { ...A, p: [1.12 * s, 0.4, 0.34] });
  }
  return k.build({ height: 2.6, radius: 1.1 });
}

function enemySpitter() {
  const k = new Kit(true, 55);
  const CAP = '#FF8A1F', CAP_D = '#E0660F', SPOT = '#FFF1D6', STEM = '#F5E6C8', STEM_D = '#DCC49A', GILL = '#E8C79A', LIP = '#FFB057', DARK = '#3A1206';
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
    k.eye([0.13 * s, 0.88, 0.27], 0.1, { dir: [0.35 * s, 0.05, 1], seg: 7, hs: 3, pseg: 6, look: [-0.05 * s, 0.02, 0] });
  }
  return k.build({ height: 1.6, radius: 0.6, muzzle: { x: 0, y: 0.62, z: 0.68 } });
}

function enemyBat() {
  const k = new Kit(true, 66);
  const BODY = '#3A2A5C', BELLY = '#56427F', BONE = '#2A1D45', MEM = '#FF3D8B', MEM_D = '#C92A6E', YEL = '#FFD166';
  k.add(new THREE.IcosahedronGeometry(0.3, 1), (l) => (l.z > 0.1 && l.y < -0.05 ? BELLY : BODY));
  for (const s of sides) {
    k.seg([0.12 * s, 0.2, -0.02], [0.21 * s, 0.47, -0.05], 0.1, 0, 4, BODY);
    k.eye([0.11 * s, 0.07, 0.235], 0.085, { dir: [0.35 * s, 0.15, 1], white: YEL, seg: 7, hs: 3, pseg: 6, pupil: 0.5, px: 0.45 });
    k.seg([0.05 * s, -0.1, 0.27], [0.045 * s, -0.2, 0.26], 0.03, 0, 3, YEL, { jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.05, 0), BONE, { p: [0.08 * s, -0.31, -0.04] });
  }
  // wings: spread horizontally along ±X at rest; flap = rotate about Z through the shoulder pivot
  const S0 = [0.2, 0.08, 0.08], S1 = [0.2, 0.0, -0.16], E = [0.52, 0.13, 0.1], T = [0.82, 0.07, -0.06];
  const F1 = [0.7, 0.01, -0.32], F2 = [0.46, 0.0, -0.36], M0 = [0.7, 0.05, -0.16], M1 = [0.56, 0.03, -0.25], M2 = [0.33, 0.02, -0.23];
  const fan = [[T, M0], [M0, F1], [F1, M1], [M1, F2], [F2, M2], [M2, S1], [S1, S0]];
  const top = [];
  for (const [a, b] of fan) {
    const n = new THREE.Vector3().crossVectors(V(a).sub(V(E)), V(b).sub(V(E)));
    if (n.y >= 0) top.push(E, a, b); else top.push(E, b, a);
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
    k.seg(m(E), m([0.54, 0.2, 0.15]), 0.022, 0, 3, YEL, W);
  }
  const g = k.build({ height: 0.6, radius: 0.45 });
  return g;
}

function enemyBoss() {
  const k = new Kit(true, 77);
  const PURP = '#7B2FF7', DARKP = '#4B1A9E', SHINE = '#A874FF', GOO = '#8E4BFF', STONE = '#3E2A6B';
  const GOLD = '#FFC23D', GOLD_D = '#D9961A', BLACK = '#1A0A2E';
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
    k.eye([0.7 * s, 3.2, 2.04], 0.62, { dir: [0.33 * s, 0.3, 1], seg: 10, hs: 4, pseg: 8, pupil: 0.5, look: [-0.12 * s, -0.05, 0] });
    k.add(new THREE.BoxGeometry(1.05, 0.24, 0.32), BLACK, { p: [0.74 * s, 3.9, 1.95], r: [-0.45, 0, 0.38 * s] });
  }
  k.add(dome(0.85, 12, 3), '#2A0845', { p: [0, 2.05, 2.6], q: qUp([0, 0.1, 1]), s: [1.65, 0.45, 0.72], jitter: 0 });
  const mz = (x, y) => 2.6 + 0.38 * Math.sqrt(Math.max(0, 1 - (x / 1.4) ** 2 - ((y - 2.05) / 0.61) ** 2)) + 0.05;
  for (const x of [-0.75, -0.25, 0.25, 0.75]) k.seg([x, 2.58, mz(x, 2.42)], [x, 2.22, mz(x, 2.42) + 0.03], 0.13, 0, 4, '#FFFFFF', { s: [1, 1, 0.6], jitter: 0 });
  for (const s of sides) k.seg([0.55 * s, 1.52, mz(0.55, 1.7)], [0.55 * s, 1.92, mz(0.55, 1.7) + 0.03], 0.15, 0, 4, '#FFFFFF', { s: [1, 1, 0.6], jitter: 0 });
  k.add(new THREE.IcosahedronGeometry(0.3, 0), '#FF5FA8', { p: [0, 1.72, 2.82], s: [1.3, 0.45, 0.8] });
  // crown (limb 7 — wobbles)
  const C = { limb: 7, pivot: [0, 4.8, 0] };
  k.add(new THREE.CylinderGeometry(1.3, 1.18, 0.6, 14, 1, true), GOLD, { ...C, p: [0, 4.72, 0] });
  k.add(new THREE.CylinderGeometry(1.3, 1.18, 0.6, 14, 1, true), GOLD_D, { ...C, p: [0, 4.72, 0], inv: true });
  const GEMS = ['#FF2E63', '#3DF2FF', '#FF4FD8', '#4F7BFF'];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU, a2 = a + TAU / 14;
    const tipY = i === 0 ? 5.95 : 5.72;
    k.seg([Math.sin(a) * 1.22, 4.95, Math.cos(a) * 1.22], [Math.sin(a) * 1.34, tipY, Math.cos(a) * 1.34], 0.24, 0, 4, GOLD, C);
    k.add(new THREE.OctahedronGeometry(0.15, 0), GEMS[i % 4], { ...C, p: [Math.sin(a) * 1.34, tipY + 0.08, Math.cos(a) * 1.34], jitter: 0 });
    k.add(new THREE.OctahedronGeometry(0.13, 0), GEMS[(i + 2) % 4], { ...C, p: [Math.sin(a2) * 1.27, 4.72, Math.cos(a2) * 1.27], r: [0, a2, 0], s: [1, 1, 0.5], jitter: 0 });
  }
  // stubby arms (3 = +X, 4 = -X) with gold cuffs; scepter in the right (-X) fist
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
  k.add(new THREE.IcosahedronGeometry(0.38, 0), '#FF3D8B', { ...SC, p: [-3.5, 4.45, 0.48], jitter: 0.08 });
  return k.build({ height: 6.0, radius: 3.0 });
}

const ENEMY_BUILDERS = { blob: enemyBlob, goon: enemyGoon, zippy: enemyZippy, brute: enemyBrute, spitter: enemySpitter, bat: enemyBat, boss: enemyBoss };
export const ENEMY_TYPES = Object.keys(ENEMY_BUILDERS);

export function buildEnemyGeometry(type) {
  const fn = ENEMY_BUILDERS[type];
  if (!fn) throw new Error(`buildEnemyGeometry: unknown type "${type}"`);
  return fn();
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

const PROP_BUILDERS = { palm: propPalm, pine: propPine, roundtree: propRoundTree, rock: propRock, bush: propBush, flower: propFlower, mushroom: propMushroom, grass: propGrass, crystal: propCrystal };
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

const PROJ_BUILDERS = { saw: projSaw, banana: projBanana, pebble: projPebble, meteor: projMeteor, spit: projSpit };
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
// Player: velociraptor in an orange batting helmet (faces +Z; its left side is +X)
// ---------------------------------------------------------------------------
export function buildPlayer() {
  const TEAL = '#2EC4B6', STRIPE = '#1B8A80', CREAM = '#FFE8C2', ORANGE = '#FF7A1A', WOOD = '#C98B4B', TAPE = '#2B2B2B';
  const mat = makeToonMaterial();
  const mesh = (kit, name) => {
    const m = new THREE.Mesh(kit.build(), mat);
    m.name = name;
    m.castShadow = true;
    return m;
  };
  const root = new THREE.Group(); root.name = 'player';

  // body — origin at the hips
  const bk = new Kit(false, 101);
  bk.add(new THREE.SphereGeometry(1, 10, 7), (l) => (l.y < -0.35 ? CREAM : l.y > 0.2 && Math.floor((l.z + 1.2) * 3) % 2 === 0 ? STRIPE : TEAL), { p: [0, 0.12, 0.1], r: [-0.3, 0, 0], s: [0.25, 0.27, 0.46] });
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
  hk.add(dome(0.2, 10, 4), (l) => (Math.abs(l.x) < 0.05 ? '#FFFFFF' : ORANGE), { p: [0, 0.14, -0.01], s: [1.0, 1.0, 1.15], jitter: 0.03 });
  hk.add(new THREE.BoxGeometry(0.24, 0.025, 0.13), ORANGE, { p: [0, 0.145, 0.24], r: [-0.12, 0, 0] });
  hk.add(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 6), ORANGE, { p: [0, 0.345, -0.01] });
  hk.add(new THREE.IcosahedronGeometry(0.09, 0), ORANGE, { p: [0.185, 0.08, -0.07], s: [0.4, 1, 1.1] });
  const head = mesh(hk, 'head');
  head.position.set(0, 0.49, 0.47);
  body.add(head);

  // arms — origin at the shoulders
  const arm = (s) => {
    const ak = new Kit(false, 103 + s);
    ak.seg([0, 0, 0], [0.02 * s, -0.11, 0.07], 0.045, 0.036, 5, TEAL);
    ak.seg([0.02 * s, -0.11, 0.07], [0.02 * s, -0.1, 0.19], 0.036, 0.03, 5, TEAL);
    for (const dx of [-0.02, 0, 0.02]) ak.seg([0.02 * s + dx, -0.1, 0.19], [0.02 * s + dx * 1.4, -0.14, 0.24], 0.014, 0, 3, CREAM);
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
  return { root, parts: { body, head, tail, legL, legR, armL, armR, batPivot, bat: batMesh }, height: 1.6 };
}
