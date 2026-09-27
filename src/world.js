// The island: heightfield terrain, stylized water + sky, instanced props, and gameplay landmarks
// (jump pads, boost pads, chests, shrines). Everything is generated from the run seed.
import * as THREE from 'three';
import { mulberry32, Noise2D, clamp, lerp, smoothstep } from './rng.js';
import {
  makeToonMaterial, buildPropGeometry, buildChest, buildShrine, buildJumpPad, buildBoostPad,
} from './models.js';

export const ISLAND_R = 175;       // shoreline radius (approx)
export const PLAY_R = ISLAND_R * 0.9; // hard boundary for the player
const SIZE = 460;                  // terrain mesh extent (meters)
const SEG = 184;                   // 2.5 m cells
const CELL = SIZE / SEG;
const HALF = SIZE / 2;
const HMIN = -9, HMAX = 48;        // height texture encoding range

const _c = new THREE.Color();

export class World {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.heights = new Float32Array((SEG + 1) * (SEG + 1));
    this.colliders = [];            // {x, z, r}
    this.colGrid = new Map();
    this.pads = [];                 // {x, z, y, kind:'jump'|'boost', dir:{x,z}, obj, cd}
    this.chests = [];               // {x, z, y, opened, obj, cost}
    this.shrines = [];              // {x, z, y, used, progress, obj}
    this.time = 0;
    this._buildSky();
    this._buildWater();
    this.propMat = makeToonMaterial();
    // vegetation sways in the breeze (vertex shader, scaled by height above the base)
    this.windU = { value: 0 };
    this.vegMat = makeToonMaterial();
    this.vegMat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = this.windU;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
            float sway = sin(uWind * 1.7 + ip.x * 0.21 + ip.z * 0.17) * 0.6 + sin(uWind * 3.1 + ip.x * 0.5) * 0.25;
            float hk = max(position.y, 0.0);
            transformed.x += sway * hk * hk * 0.012;
            transformed.z += sway * hk * hk * 0.007;
          #endif`);
    };
    this.vegMat.customProgramCacheKey = () => 'veg';
    this.propGeos = {};
    for (const k of ['palm', 'pine', 'roundtree', 'rock', 'bush', 'flower', 'mushroom', 'grass', 'crystal']) {
      this.propGeos[k] = buildPropGeometry(k);
    }
  }

  // ---------------------------------------------------------------- generation
  generate(seed) {
    this.seed = seed;
    const rand = mulberry32(seed);
    this.rand = rand;
    this.noise = new Noise2D(rand);
    // dispose the previous island
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      if (child.isInstancedMesh || child.userData.disposable) child.geometry?.dispose?.();
    }
    this.colliders.length = 0; this.colGrid.clear();
    this.pads.length = 0; this.chests.length = 0; this.shrines.length = 0;

    this._buildTerrain();
    this._placeLandmarks(rand);
    this._placeProps(rand);
    this._updateWaterHeightTex();
  }

  rawHeight(x, z) {
    const n = this.noise;
    const r = Math.hypot(x, z);
    const d = r / ISLAND_R;
    const ang = Math.atan2(z, x);
    const wob = n.noise(Math.cos(ang) * 1.6 + 11.3, Math.sin(ang) * 1.6 - 4.1) * 0.13
      + n.noise(Math.cos(ang) * 4 + 3, Math.sin(ang) * 4 + 7) * 0.04;
    const island = smoothstep(1.03, 0.8, d + wob);
    // rolling hills (great for sliding)
    let h = n.fbm(x * 0.0085, z * 0.0085, 4) * 8.5 + 6.5;
    // long ridges = natural ramps
    const ridge = 1 - Math.abs(n.noise(x * 0.011 + 50, z * 0.011 - 30));
    h += Math.pow(ridge, 5) * 11 * smoothstep(-0.1, 0.5, n.noise(x * 0.004 + 99, z * 0.004));
    // mountains toward the rim
    const m = smoothstep(0.3, 0.8, n.noise(x * 0.0052 - 70, z * 0.0052 + 40) * 0.5 + 0.5);
    h += m * m * 30 * smoothstep(0.3, 0.7, d);
    // a flat-ish plaza at spawn
    const c = smoothstep(20, 7, r);
    h = lerp(h, 6, c);
    return lerp(HMIN + 1.5, h, island);
  }

  _buildTerrain() {
    const H = this.heights;
    for (let iz = 0; iz <= SEG; iz++) {
      for (let ix = 0; ix <= SEG; ix++) {
        H[iz * (SEG + 1) + ix] = this.rawHeight(ix * CELL - HALF, iz * CELL - HALF);
      }
    }
    const triCount = SEG * SEG * 2;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 9);
    const n = this.noise;
    const sand = new THREE.Color('#F1DB9C'), wetSand = new THREE.Color('#C9AE72'),
      grassA = new THREE.Color('#66BD48'), grassB = new THREE.Color('#86CC52'), grassC = new THREE.Color('#4B9E44'),
      rockA = new THREE.Color('#A39785'), rockB = new THREE.Color('#857B6D'), cliff = new THREE.Color('#C9A27A'),
      seabed = new THREE.Color('#D6C089'), peak = new THREE.Color('#CFC6B6');
    let p = 0;
    const tri = (ax, az, bx, bz, cx, cz) => {
      const ha = H[az * (SEG + 1) + ax], hb = H[bz * (SEG + 1) + bx], hc = H[cz * (SEG + 1) + cx];
      const x0 = ax * CELL - HALF, z0 = az * CELL - HALF, x1 = bx * CELL - HALF, z1 = bz * CELL - HALF, x2 = cx * CELL - HALF, z2 = cz * CELL - HALF;
      // normal (ensure CCW when viewed from above)
      const ux = x1 - x0, uy = hb - ha, uz = z1 - z0, vx = x2 - x0, vy = hc - ha, vz = z2 - z0;
      let ny = uz * vx - ux * vz;
      let order = ny > 0;
      const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const slope = Math.abs(ny) / len; // 1 = flat
      const hAvg = (ha + hb + hc) / 3, cxm = (x0 + x1 + x2) / 3, czm = (z0 + z1 + z2) / 3;
      const patch = n.noise(cxm * 0.03, czm * 0.03) * 0.5 + n.noise(cxm * 0.11, czm * 0.11) * 0.25;
      if (hAvg < -0.2) _c.copy(seabed).lerp(wetSand, clamp(-hAvg / 6, 0, 1));
      else if (hAvg < 1.2) _c.copy(sand);
      else if (hAvg < 2.0) _c.copy(sand).lerp(grassB, (hAvg - 1.2) / 0.8);
      else {
        _c.copy(patch > 0.15 ? grassB : patch < -0.2 ? grassC : grassA);
        if (hAvg > 26) _c.lerp(peak, smoothstep(26, 40, hAvg));
      }
      if (slope < 0.8 && hAvg > 0.5) _c.copy(slope < 0.62 ? rockB : rockA).lerp(cliff, clamp(patch + 0.3, 0, 0.6));
      const j = 0.94 + ((Math.sin(cxm * 12.9898 + czm * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.1;
      const r = _c.r * j, g = _c.g * j, b = _c.b * j;
      const verts = order ? [x0, ha, z0, x1, hb, z1, x2, hc, z2] : [x0, ha, z0, x2, hc, z2, x1, hb, z1];
      for (let k = 0; k < 9; k++) pos[p + k] = verts[k];
      for (let k = 0; k < 3; k++) { col[p + k * 3] = r; col[p + k * 3 + 1] = g; col[p + k * 3 + 2] = b; }
      p += 9;
    };
    for (let iz = 0; iz < SEG; iz++) {
      for (let ix = 0; ix < SEG; ix++) {
        // two triangles per cell, diagonal from (ix, iz+1) to (ix+1, iz) — matches heightAt()
        tri(ix, iz, ix + 1, iz, ix, iz + 1);
        tri(ix, iz + 1, ix + 1, iz, ix + 1, iz + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = makeToonMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.userData.disposable = true;
    this.root.add(mesh);
    this.terrain = mesh;
  }

  heightAt(x, z) {
    let fx = (x + HALF) / CELL, fz = (z + HALF) / CELL;
    if (fx < 0) fx = 0; else if (fx > SEG - 0.001) fx = SEG - 0.001;
    if (fz < 0) fz = 0; else if (fz > SEG - 0.001) fz = SEG - 0.001;
    const ix = fx | 0, iz = fz | 0;
    const u = fx - ix, v = fz - iz;
    const W = SEG + 1, H = this.heights;
    const h00 = H[iz * W + ix], h10 = H[iz * W + ix + 1], h01 = H[(iz + 1) * W + ix], h11 = H[(iz + 1) * W + ix + 1];
    if (u + v <= 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }

  normalAt(x, z, out) {
    const e = 0.6;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    out.set(-hx, 2 * e, -hz).normalize();
    return out;
  }

  isLand(x, z, minH = 1.0) {
    return Math.hypot(x, z) < PLAY_R && this.heightAt(x, z) > minH;
  }

  // ---------------------------------------------------------------- sky + water
  _buildSky() {
    const top = new THREE.Color('#3E7BE0'), mid = new THREE.Color('#8EC8FF'), horizon = new THREE.Color('#FFD6A8'), sunCol = new THREE.Color('#FFF3C4');
    this.fogColor = new THREE.Color('#F4D8B8');
    this.sunDir = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTop: { value: top }, uMid: { value: mid }, uHorizon: { value: horizon }, uSun: { value: sunCol }, uSunDir: { value: this.sunDir } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 uTop,uMid,uHorizon,uSun,uSunDir; varying vec3 vDir;
        void main(){ float y = vDir.y; vec3 c = mix(uHorizon, uMid, smoothstep(-0.02, 0.22, y)); c = mix(c, uTop, smoothstep(0.2, 0.85, y));
          c = mix(c, uHorizon*0.9, smoothstep(0.0,-0.25,y));
          float s = max(dot(normalize(vDir), uSunDir), 0.0);
          c += uSun * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.35 + pow(s, 3.0)*0.12);
          gl_FragColor = vec4(c, 1.0); }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
    sky.frustumCulled = false; sky.renderOrder = -10;
    this.scene.add(sky);
    this.sky = sky;

    // drifting low-poly clouds + distant sea stacks for parallax depth
    this.clouds = new THREE.Group();
    const cloudMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const rand = mulberry32(1234);
    for (let i = 0; i < 26; i++) {
      const parts = [];
      const g = new THREE.Group();
      const n = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const s = 14 + rand() * 18;
        const geo = new THREE.IcosahedronGeometry(s, 0);
        const cc = new Float32Array(geo.attributes.position.count * 3);
        const pa = geo.attributes.position;
        for (let v = 0; v < pa.count; v++) {
          const t = clamp((pa.getY(v) / s + 1) * 0.5, 0, 1);
          _c.set('#F3B6C8').lerp(new THREE.Color('#FFFDF8'), Math.pow(t, 0.7));
          cc[v * 3] = _c.r; cc[v * 3 + 1] = _c.g; cc[v * 3 + 2] = _c.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(cc, 3));
        const m = new THREE.Mesh(geo, cloudMat);
        m.position.set((k - n / 2) * s * 0.9, rand() * s * 0.4, (rand() - 0.5) * s);
        m.scale.y = 0.55;
        g.add(m);
      }
      const a = rand() * Math.PI * 2, rr = 420 + rand() * 260;
      g.position.set(Math.cos(a) * rr, 90 + rand() * 120, Math.sin(a) * rr);
      g.lookAt(0, g.position.y, 0);
      this.clouds.add(g);
    }
    this.scene.add(this.clouds);

    const stackMat = makeToonMaterial();
    for (let i = 0; i < 14; i++) {
      const geo = new THREE.CylinderGeometry(6 + rand() * 10, 14 + rand() * 12, 30 + rand() * 60, 6, 3);
      const pa = geo.attributes.position;
      const cc = new Float32Array(pa.count * 3);
      for (let v = 0; v < pa.count; v++) {
        pa.setX(v, pa.getX(v) + (rand() - 0.5) * 5); pa.setZ(v, pa.getZ(v) + (rand() - 0.5) * 5);
        const top = pa.getY(v) > 0;
        _c.set(top ? '#63B84A' : '#9C8A78');
        cc[v * 3] = _c.r; cc[v * 3 + 1] = _c.g; cc[v * 3 + 2] = _c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      const ng = geo.toNonIndexed(); ng.computeVertexNormals();
      const m = new THREE.Mesh(ng, stackMat);
      const a = rand() * Math.PI * 2, rr = 290 + rand() * 180;
      m.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      this.scene.add(m);
    }
  }

  _buildWater() {
    this.heightTex = new THREE.DataTexture(new Uint8Array((SEG + 1) * (SEG + 1) * 4), SEG + 1, SEG + 1, THREE.RGBAFormat);
    this.heightTex.magFilter = THREE.LinearFilter; this.heightTex.minFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(1800, 1800, 220, 220);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uHeight: { value: this.heightTex }, uSunDir: { value: this.sunDir },
        uShallow: { value: new THREE.Color('#3FE0D0') }, uDeep: { value: new THREE.Color('#1560BD') }, uFar: { value: new THREE.Color('#2A6FD6') },
        uFog: { value: this.fogColor }, uFogNear: { value: 90 }, uFogFar: { value: 560 },
      },
      vertexShader: `uniform float uTime; varying vec3 vW;
        void main(){ vec3 p = position; vec4 w = modelMatrix * vec4(p,1.0);
          w.y += sin(w.x*0.09 + uTime*1.1)*0.22 + sin(w.z*0.12 - uTime*0.8)*0.18 + sin((w.x+w.z)*0.045 + uTime*0.6)*0.3;
          vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime; uniform sampler2D uHeight; uniform vec3 uSunDir, uShallow, uDeep, uFar, uFog; uniform float uFogNear, uFogFar; varying vec3 vW;
        void main(){
          vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (n.y < 0.0) n = -n;
          vec2 uv = vW.xz / ${SIZE.toFixed(1)} + 0.5;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float th = mix(${HMIN.toFixed(1)}, ${HMAX.toFixed(1)}, texture2D(uHeight, uv).r);
          th = mix(${HMIN.toFixed(1)}, th, inside);
          float depth = clamp(-th, 0.0, 10.0);
          vec3 col = mix(uShallow, uDeep, smoothstep(0.3, 7.0, depth));
          col = mix(col, uFar, smoothstep(250.0, 600.0, length(vW.xz)));
          float band = sin(depth * 5.0 - uTime * 2.2) * 0.5 + 0.5;
          float foam = smoothstep(1.4, 0.15, depth) * (0.45 + 0.55 * band) * inside;
          col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0) * 0.85);
          float diff = max(dot(n, uSunDir), 0.0);
          vec3 v = normalize(cameraPosition - vW);
          float spec = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 80.0);
          float fres = pow(1.0 - max(v.y, 0.0), 3.0);
          col = col * (0.62 + 0.45 * diff) + spec * 1.6 + fres * 0.12;
          float f = smoothstep(uFogNear, uFogFar, length(cameraPosition - vW));
          gl_FragColor = vec4(mix(col, uFog, f), 1.0);
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.frustumCulled = false;
    this.scene.add(this.water);
  }

  _updateWaterHeightTex() {
    const d = this.heightTex.image.data;
    for (let i = 0; i < this.heights.length; i++) {
      const v = clamp((this.heights[i] - HMIN) / (HMAX - HMIN), 0, 1) * 255;
      d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
    }
    this.heightTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- placement
  _randomLand(rand, opts = {}) {
    const { minH = 1.4, maxH = 99, minR = 0, maxR = PLAY_R * 0.97, minSlope = 0.82, avoid = 0 } = opts;
    const nrm = new THREE.Vector3();
    for (let tries = 0; tries < 60; tries++) {
      const a = rand() * Math.PI * 2, r = Math.sqrt(lerp((minR / maxR) ** 2, 1, rand())) * maxR;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = this.heightAt(x, z);
      if (h < minH || h > maxH) continue;
      if (this.normalAt(x, z, nrm).y < minSlope) continue;
      if (avoid > 0 && this._nearLandmark(x, z, avoid)) continue;
      return { x, z, y: h };
    }
    return null;
  }

  _nearLandmark(x, z, dist) {
    const d2 = dist * dist;
    for (const l of this._landmarks) if ((l.x - x) ** 2 + (l.z - z) ** 2 < d2) return true;
    return false;
  }

  _placeLandmarks(rand) {
    this._landmarks = [{ x: 0, z: 0 }];
    const add = (obj, p, rotY = 0) => {
      obj.position.set(p.x, p.y, p.z); obj.rotation.y = rotY;
      obj.traverse(o => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
      this.root.add(obj);
      this._landmarks.push(p);
      return obj;
    };
    const nrm = new THREE.Vector3();
    for (let i = 0; i < 20; i++) {
      const p = this._randomLand(rand, { minR: 14, avoid: 14, minSlope: 0.9 }); if (!p) continue;
      const obj = add(buildJumpPad(), p);
      this.pads.push({ x: p.x, z: p.z, y: p.y, kind: 'jump', obj, cd: 0 });
    }
    for (let i = 0; i < 22; i++) {
      const p = this._randomLand(rand, { minR: 12, avoid: 12, minSlope: 0.8 }); if (!p) continue;
      this.normalAt(p.x, p.z, nrm);
      // point boost pads downhill so they chain into slides; flat ground gets a random heading
      let dx = nrm.x, dz = nrm.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) { const a = rand() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); } else { dx /= l; dz /= l; }
      const obj = add(buildBoostPad(), p, Math.atan2(dx, dz));
      this.pads.push({ x: p.x, z: p.z, y: p.y, kind: 'boost', dir: { x: dx, z: dz }, obj, cd: 0 });
    }
    for (let i = 0; i < 16; i++) {
      const p = this._randomLand(rand, { minR: 18, avoid: 16, minSlope: 0.85 }); if (!p) continue;
      const obj = add(buildChest(), p, rand() * Math.PI * 2);
      this.chests.push({ x: p.x, z: p.z, y: p.y, opened: false, obj, openT: 0 });
    }
    for (let i = 0; i < 6; i++) {
      const p = this._randomLand(rand, { minR: 30, avoid: 24, minSlope: 0.88 }); if (!p) continue;
      const obj = add(buildShrine(), p);
      this.shrines.push({ x: p.x, z: p.z, y: p.y, used: false, progress: 0, obj });
    }
  }

  _placeProps(rand) {
    const dummy = new THREE.Object3D();
    const nrm = new THREE.Vector3();
    const place = (kind, count, opts, collide, scaleMin = 0.8, scaleMax = 1.3) => {
      const geo = this.propGeos[kind];
      const veg = kind !== 'rock' && kind !== 'crystal';
      const mesh = new THREE.InstancedMesh(geo, veg ? this.vegMat : this.propMat, count);
      let n = 0;
      for (let i = 0; i < count; i++) {
        const p = this._randomLand(rand, opts); if (!p) continue;
        if (opts.avoid2 && this._nearLandmark(p.x, p.z, opts.avoid2)) continue;
        const s = lerp(scaleMin, scaleMax, rand());
        dummy.position.set(p.x, p.y - 0.15 * s, p.z);
        dummy.rotation.set((rand() - 0.5) * 0.12, rand() * Math.PI * 2, (rand() - 0.5) * 0.12);
        if (kind === 'grass' || kind === 'flower') { this.normalAt(p.x, p.z, nrm); dummy.rotation.x = nrm.z * 0.6; dummy.rotation.z = -nrm.x * 0.6; }
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        mesh.setMatrixAt(n++, dummy.matrix);
        if (collide) this._addCollider(p.x, p.z, (geo.userData.radius || 0.5) * s * collide);
      }
      mesh.count = n;
      mesh.castShadow = !!opts.shadow; mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
      return mesh;
    };
    place('palm', 110, { minH: 1.0, maxH: 5, minR: 12, avoid2: 5, minSlope: 0.75, shadow: true }, 1, 0.8, 1.25);
    place('roundtree', 150, { minH: 3, maxH: 24, minR: 16, avoid2: 5, minSlope: 0.8, shadow: true }, 1, 0.8, 1.4);
    place('pine', 130, { minH: 9, maxH: 45, minR: 20, avoid2: 5, minSlope: 0.72, shadow: true }, 1, 0.8, 1.5);
    place('rock', 170, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 2.2);
    place('bush', 220, { minH: 1.8, minR: 6, avoid2: 3, minSlope: 0.75 }, 0, 0.7, 1.4);
    place('flower', 320, { minH: 2, minR: 3, avoid2: 2, minSlope: 0.8 }, 0, 0.8, 1.5);
    place('mushroom', 90, { minH: 2, minR: 8, avoid2: 2, minSlope: 0.8 }, 0, 0.8, 1.6);
    place('grass', 4200, { minH: 1.6, minR: 2, minSlope: 0.78 }, 0, 0.7, 1.5);
    place('crystal', 36, { minH: 12, minR: 40, avoid2: 6, minSlope: 0.6, shadow: true }, 0.8, 0.8, 1.8);
  }

  _addCollider(x, z, r) {
    const c = { x, z, r };
    this.colliders.push(c);
    const k = ((Math.floor(x / 8) + 64) << 8) | (Math.floor(z / 8) + 64);
    let arr = this.colGrid.get(k); if (!arr) { arr = []; this.colGrid.set(k, arr); }
    arr.push(c);
  }

  // push a circle (x,z,r) out of static colliders; returns adjusted {x,z} via out, and hit normal via out.nx/nz
  collide(x, z, r, out) {
    out.x = x; out.z = z; out.hit = false;
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
      const arr = this.colGrid.get(((gx + 64) << 8) | (gz + 64)); if (!arr) continue;
      for (const c of arr) {
        const dx = out.x - c.x, dz = out.z - c.z, rr = r + c.r, d2 = dx * dx + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), push = rr - d;
          out.x += dx / d * push; out.z += dz / d * push; out.hit = true; out.nx = dx / d; out.nz = dz / d;
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- per-frame
  update(dt, t, playerPos) {
    this.time = t;
    this.water.material.uniforms.uTime.value = t;
    this.windU.value = t;
    this.water.position.x = 0;
    this.clouds.rotation.y = t * 0.004;
    this.sky.position.copy(playerPos || this.sky.position);
    for (const p of this.pads) {
      if (p.cd > 0) p.cd -= dt;
      const glow = p.obj.getObjectByName(p.kind === 'jump' ? 'glow' : 'arrows');
      if (glow && glow.material) {
        const pulse = 0.55 + 0.45 * Math.sin(t * (p.kind === 'jump' ? 5 : 8) + p.x);
        glow.material.opacity = p.cd > 0 ? 0.25 : pulse;
      }
    }
    for (const s of this.shrines) {
      const cr = s.obj.getObjectByName('crystal');
      if (cr) { cr.rotation.y = t * 1.4; cr.position.y = (cr.userData.baseY ??= cr.position.y) + Math.sin(t * 2 + s.x) * 0.25; cr.visible = !s.used; }
      const ring = s.obj.getObjectByName('ring');
      if (ring && ring.material) ring.material.opacity = s.used ? 0.05 : 0.35 + 0.35 * Math.sin(t * 3) + s.progress * 0.6;
    }
    for (const c of this.chests) {
      const glow = c.obj.getObjectByName('glow');
      if (glow && glow.material) glow.material.opacity = c.opened ? Math.max(0, 1 - c.openT) * 0.9 : 0.35 + 0.2 * Math.sin(t * 3 + c.x);
      if (c.opened) {
        c.openT += dt;
        const lid = c.obj.getObjectByName('lid');
        if (lid) lid.rotation.x = -Math.min(1, c.openT * 4) * 1.9;
      }
    }
  }
}
