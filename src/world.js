// An island of the Archipelago: heightfield terrain shaped per biome, stylized liquid (sea, ice,
// lava, swamp) + sky (sun, moon, stars, aurora), instanced props, and gameplay landmarks
// (pads, chests, five shrine types, the boss portal and the exit portal). Generated from a seed.
import * as THREE from 'three';
import { mulberry32, Noise2D, clamp, lerp, smoothstep } from './rng.js';
import * as M from './models.js';
import { ISLANDS } from './biomes.js';

export const ISLAND_R = 175;          // shoreline radius (approx)
export const PLAY_R = ISLAND_R * 0.9; // hard boundary for the player
const SIZE = 460;                     // terrain mesh extent (meters)
const SEG = 184;                      // 2.5 m cells
const CELL = SIZE / SEG;
const HALF = SIZE / 2;
const HMIN = -9, HMAX = 56;           // height texture encoding range

const _c = new THREE.Color(), _c2 = new THREE.Color();
const col = (hex) => new THREE.Color(hex);

export const SHRINE_KINDS = ['blessing', 'moai', 'totem', 'greed', 'pylon'];

export class World {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.heights = new Float32Array((SEG + 1) * (SEG + 1));
    this.colliders = [];
    this.colGrid = new Map();
    this.pads = []; this.chests = []; this.shrines = [];
    this.bossPortal = null; this.exitPortal = null;
    this.time = 0;
    this.island = ISLANDS[0];
    this.sunDir = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();
    this.fogColor = new THREE.Color('#F4D8B8');
    this._buildSky();
    this._buildWater();
    this.propMat = M.makeToonMaterial();
    this.windU = { value: 0 };
    this.vegMat = M.makeToonMaterial();
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
    this.cloudGroup = new THREE.Group(); scene.add(this.cloudGroup);
    this.stackGroup = new THREE.Group(); scene.add(this.stackGroup);
  }

  propGeo(kind) {
    if (!this.propGeos[kind]) {
      try { this.propGeos[kind] = M.buildPropGeometry(kind); }
      catch { this.propGeos[kind] = this.propGeo('rock'); }
    }
    return this.propGeos[kind];
  }

  // ---------------------------------------------------------------- generation
  generate(seed, island = ISLANDS[0], opts = {}) {
    this.seed = seed;
    this.island = island;
    this.opts = opts;
    const rand = mulberry32(seed);
    this.rand = rand;
    this.noise = new Noise2D(rand);
    const va = rand() * Math.PI * 2, vr = 85 + rand() * 25;
    this.volcano = { x: Math.cos(va) * vr, z: Math.sin(va) * vr };
    for (const child of [...this.root.children]) {
      this.root.remove(child);
      if (child.isInstancedMesh || child.userData.disposable) child.geometry?.dispose?.();
    }
    this.colliders.length = 0; this.colGrid.clear();
    this.pads.length = 0; this.chests.length = 0; this.shrines.length = 0;
    this.bossPortal = null; this.exitPortal = null;

    this._applySky();
    this._buildClouds();
    this._buildStacks();
    this._buildTerrain();
    this._placeLandmarks(rand);
    this._placeProps(rand);
    this._updateWaterHeightTex();
    this._applyLiquid();
  }

  rawHeight(x, z) {
    const n = this.noise, shape = this.island.terrain.shape;
    const r = Math.hypot(x, z);
    const d = r / ISLAND_R;
    const ang = Math.atan2(z, x);
    const wob = n.noise(Math.cos(ang) * 1.6 + 11.3, Math.sin(ang) * 1.6 - 4.1) * 0.13
      + n.noise(Math.cos(ang) * 4 + 3, Math.sin(ang) * 4 + 7) * 0.04;
    const island = smoothstep(1.03, 0.8, d + wob);
    const inland = smoothstep(0.92, 0.55, d);
    let h;
    if (shape === 'frost') {
      h = n.fbm(x * 0.008, z * 0.008, 4) * 10 + 7;
      const ridge = 1 - Math.abs(n.noise(x * 0.01 + 50, z * 0.01 - 30));
      h += Math.pow(ridge, 3) * 13 * smoothstep(-0.2, 0.5, n.noise(x * 0.004 + 99, z * 0.004));
      const m = smoothstep(0.25, 0.75, n.noise(x * 0.0055 - 70, z * 0.0055 + 40) * 0.5 + 0.5);
      h += m * m * 44 * smoothstep(0.25, 0.65, d);
      const lake = smoothstep(0.5, 0.72, n.noise(x * 0.012 + 200, z * 0.012 - 120)) * inland;
      h = lerp(h, -1.6, lake);
    } else if (shape === 'desert') {
      const a = 0.62, ux = x * Math.cos(a) + z * Math.sin(a);
      const warp = n.noise(x * 0.006, z * 0.006) * 40;
      const dune = Math.pow(1 - Math.abs(Math.sin((ux + warp) * 0.042)), 1.6);
      h = 5 + n.fbm(x * 0.006, z * 0.006, 3) * 5 + dune * (6 + 6 * (n.noise(x * 0.01 + 7, z * 0.01) * 0.5 + 0.5));
      const mesa = smoothstep(0.5, 0.57, n.noise(x * 0.0075 - 300, z * 0.0075 + 90)) * smoothstep(0.85, 0.4, d);
      h = lerp(h, 21 + n.noise(x * 0.03, z * 0.03) * 0.6, mesa);
      const oasis = smoothstep(0.62, 0.8, n.noise(x * 0.015 + 500, z * 0.015 + 500)) * inland;
      h = lerp(h, -1.3, oasis);
    } else if (shape === 'grave') {
      h = n.fbm(x * 0.009, z * 0.009, 4) * 6 + 5.5;
      const m = smoothstep(0.3, 0.8, n.noise(x * 0.006 - 70, z * 0.006 + 40) * 0.5 + 0.5);
      h += m * m * 22 * smoothstep(0.3, 0.7, d);
      const ridge = 1 - Math.abs(n.noise(x * 0.013 + 50, z * 0.013 - 30));
      h += Math.pow(ridge, 6) * 7;
      const pool = smoothstep(0.38, 0.62, n.noise(x * 0.014 + 40, z * 0.014 + 80)) * inland;
      h = lerp(h, -1.1, pool * 0.95);
    } else if (shape === 'volcano') {
      h = n.fbm(x * 0.009, z * 0.009, 5) * 9 + 6;
      const vd = Math.hypot(x - this.volcano.x, z - this.volcano.z);
      const cone = Math.max(0, 1 - vd / 72);
      h += Math.pow(cone, 1.7) * 50;
      if (vd < 13) h -= Math.pow(1 - vd / 13, 2) * 22;
      const channel = 1 - Math.abs(n.noise(x * 0.0095 + 11, z * 0.0095 - 7));
      const river = smoothstep(0.93, 0.975, channel) * inland * smoothstep(20, 34, vd);
      h = lerp(h, -1.4, river);
    } else {
      h = n.fbm(x * 0.0085, z * 0.0085, 4) * 8.5 + 6.5;
      const ridge = 1 - Math.abs(n.noise(x * 0.011 + 50, z * 0.011 - 30));
      h += Math.pow(ridge, 5) * 11 * smoothstep(-0.1, 0.5, n.noise(x * 0.004 + 99, z * 0.004));
      const m = smoothstep(0.3, 0.8, n.noise(x * 0.0052 - 70, z * 0.0052 + 40) * 0.5 + 0.5);
      h += m * m * 30 * smoothstep(0.3, 0.7, d);
    }
    // a flat plaza at spawn, and a flat pad under the boss portal
    h = lerp(h, 6, smoothstep(20, 7, r));
    if (this._portalSite) {
      const pd = Math.hypot(x - this._portalSite.x, z - this._portalSite.z);
      h = lerp(h, this._portalSite.h, smoothstep(16, 7, pd));
    }
    return lerp(HMIN + 1.5, h, island);
  }

  _buildTerrain() {
    // pick the boss portal site first so the terrain can flatten around it
    this._portalSite = null;
    const pr = mulberry32(this.seed ^ 0x51f00d);
    for (let i = 0; i < 40 && !this._portalSite; i++) {
      const a = pr() * Math.PI * 2, rr = 95 + pr() * 35;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      const h = this.rawHeight(x, z);
      if (h > 2 && h < 30) this._portalSite = { x, z, h };
    }
    const H = this.heights;
    for (let iz = 0; iz <= SEG; iz++) for (let ix = 0; ix <= SEG; ix++) H[iz * (SEG + 1) + ix] = this.rawHeight(ix * CELL - HALF, iz * CELL - HALF);
    const P = this.island.terrain, shape = P.shape;
    const sand = col(P.sand), wet = col(P.wet), gA = col(P.a), gB = col(P.b), gC = col(P.c),
      rockA = col(P.rockA), rockB = col(P.rockB), cliff = col(P.cliff), seabed = col(P.seabed), peak = col(P.peak),
      dirt = P.dirt ? col(P.dirt) : null;
    const glow = P.glow || null;
    const n = this.noise;
    const triCount = SEG * SEG * 2;
    const pos = new Float32Array(triCount * 9), cl = new Float32Array(triCount * 9), gw = new Float32Array(triCount * 3);
    let p = 0;
    const tri = (ax, az, bx, bz, cx, cz) => {
      const ha = H[az * (SEG + 1) + ax], hb = H[bz * (SEG + 1) + bx], hc = H[cz * (SEG + 1) + cx];
      const x0 = ax * CELL - HALF, z0 = az * CELL - HALF, x1 = bx * CELL - HALF, z1 = bz * CELL - HALF, x2 = cx * CELL - HALF, z2 = cz * CELL - HALF;
      const ux = x1 - x0, uy = hb - ha, uz = z1 - z0, vx = x2 - x0, vy = hc - ha, vz = z2 - z0;
      const ny = uz * vx - ux * vz;
      const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      const slope = Math.abs(ny) / len;
      const hAvg = (ha + hb + hc) / 3, cxm = (x0 + x1 + x2) / 3, czm = (z0 + z1 + z2) / 3;
      const patch = n.noise(cxm * 0.03, czm * 0.03) * 0.5 + n.noise(cxm * 0.11, czm * 0.11) * 0.25;
      let glowing = false;
      if (hAvg < -0.2) _c.copy(seabed).lerp(wet, clamp(-hAvg / 6, 0, 1));
      else if (hAvg < 1.2) _c.copy(sand);
      else if (hAvg < 2.0) _c.copy(sand).lerp(gB, (hAvg - 1.2) / 0.8);
      else {
        _c.copy(patch > 0.15 ? gB : patch < -0.2 ? gC : gA);
        if (dirt && patch < -0.28) _c.copy(dirt);
        if (hAvg > 26) _c.lerp(peak, smoothstep(26, 40, hAvg));
      }
      if (slope < 0.8 && hAvg > 0.5) {
        if (shape === 'desert') _c.copy((Math.floor(hAvg / 1.7) & 1) ? cliff : rockA).lerp(rockB, clamp(-patch, 0, 0.35));
        else if (shape === 'frost' && hAvg > 14 && slope > 0.66) _c.copy(peak).lerp(cliff, 0.35);
        else _c.copy(slope < 0.62 ? rockB : rockA).lerp(cliff, clamp(patch + 0.3, 0, 0.6));
      }
      if (glow) {
        // glowing lava veins through the basalt, and white-hot crust along the lava shore
        const vein = 1 - Math.abs(n.noise(cxm * 0.045 + 3, czm * 0.045 - 9));
        if (hAvg > 0.6 && vein > 0.965 && slope > 0.7) { _c.setRGB(glow[0], glow[1], glow[2]); glowing = true; }
        else if (hAvg > -0.3 && hAvg < 0.7) { _c.setRGB(glow[0] * 0.75, glow[1] * 0.5, glow[2] * 0.5); glowing = true; }
      }
      const j = glowing ? 1 : 0.94 + ((Math.sin(cxm * 12.9898 + czm * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.1;
      const r = _c.r * j, g = _c.g * j, b = _c.b * j;
      const order = ny > 0;
      const verts = order ? [x0, ha, z0, x1, hb, z1, x2, hc, z2] : [x0, ha, z0, x2, hc, z2, x1, hb, z1];
      for (let k = 0; k < 9; k++) pos[p + k] = verts[k];
      for (let k = 0; k < 3; k++) { cl[p + k * 3] = r; cl[p + k * 3 + 1] = g; cl[p + k * 3 + 2] = b; gw[p / 3 + k] = glowing ? 1 : 0; }
      p += 9;
    };
    for (let iz = 0; iz < SEG; iz++) for (let ix = 0; ix < SEG; ix++) {
      tri(ix, iz, ix + 1, iz, ix, iz + 1);
      tri(ix, iz + 1, ix + 1, iz, ix + 1, iz + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cl, 3));
    geo.setAttribute('aGlow', new THREE.BufferAttribute(gw, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (!this.terrainMat) {
      // lava veins are emissive: they glow their own color instead of being lit (and washed out)
      this.terrainMat = M.makeToonMaterial();
      this.terrainMat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGlow; varying float vGlow;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * 1.35;\ndiffuseColor.rgb *= 1.0 - vGlow * 0.9;');
      };
      this.terrainMat.customProgramCacheKey = () => 'terrain-glow';
    }
    const mesh = new THREE.Mesh(geo, this.terrainMat);
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

  isLand(x, z, minH = 1.0) { return Math.hypot(x, z) < PLAY_R && this.heightAt(x, z) > minH; }

  // liquid under a point (inland lakes/rivers/pools): 0 none, else the island's liquid kind + 1
  liquidAt(x, z) {
    if (this.heightAt(x, z) > 0.05) return 0;
    return this.island.liquid.kind + 1;
  }

  // ---------------------------------------------------------------- sky, clouds, sea stacks
  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Color() },
        uSunDir: { value: this.sunDir }, uSunSize: { value: 900 }, uStars: { value: 0 }, uAurora: { value: 0 }, uMoon: { value: 0 }, uTime: { value: 0 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: `uniform vec3 uTop,uMid,uHorizon,uSun,uSunDir; uniform float uSunSize,uStars,uAurora,uMoon,uTime; varying vec3 vDir;
        float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        void main(){
          vec3 d = normalize(vDir); float y = d.y;
          vec3 c = mix(uHorizon, uMid, smoothstep(-0.02, 0.22, y)); c = mix(c, uTop, smoothstep(0.2, 0.85, y));
          c = mix(c, uHorizon * 0.9, smoothstep(0.0, -0.25, y));
          if (uStars > 0.0) {
            vec3 g = floor(d * 260.0); float s = h3(g);
            float tw = 0.6 + 0.4 * sin(uTime * 3.0 + s * 40.0);
            c += vec3(step(0.9965, s) * uStars * tw * smoothstep(0.02, 0.3, y) * 1.6);
          }
          if (uAurora > 0.0) {
            float band = sin(d.x * 7.0 + uTime * 0.25 + sin(d.z * 5.0 + uTime * 0.18) * 1.6);
            float curtain = smoothstep(0.55, 1.0, band) * smoothstep(0.12, 0.35, y) * smoothstep(0.85, 0.45, y);
            float rip = 0.6 + 0.4 * sin(d.x * 40.0 + uTime * 1.3 + d.z * 23.0);
            c += mix(vec3(0.25, 1.4, 0.8), vec3(1.2, 0.35, 1.3), smoothstep(0.3, 0.7, y)) * curtain * rip * 0.55 * uAurora;
          }
          float s = max(dot(d, uSunDir), 0.0);
          if (uMoon > 0.5) {
            float disc = smoothstep(0.9975, 0.9985, s);
            float crater = 0.85 + 0.15 * sin(d.x * 900.0) * sin(d.y * 700.0);
            c = mix(c, uSun * 1.3 * crater, disc);
            c += uSun * (pow(s, 60.0) * 0.35 + pow(s, 8.0) * 0.12);
          } else {
            c += uSun * (pow(s, uSunSize) * 6.0 + pow(s, 12.0) * 0.35 + pow(s, 3.0) * 0.12);
          }
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
    sky.frustumCulled = false; sky.renderOrder = -10;
    this.scene.add(sky);
    this.sky = sky;
  }

  _applySky() {
    const S = this.island.sky, u = this.sky.material.uniforms;
    u.uTop.value.set(S.top); u.uMid.value.set(S.mid); u.uHorizon.value.set(S.horizon); u.uSun.value.set(S.sun);
    this.sunDir.set(S.sunDir[0], S.sunDir[1], S.sunDir[2]).normalize();
    u.uSunSize.value = S.sunSize; u.uStars.value = S.stars || 0; u.uAurora.value = S.aurora || 0; u.uMoon.value = S.moon || 0;
    this.fogColor.set(this.island.fog.color);
  }

  _buildClouds() {
    for (const c of [...this.cloudGroup.children]) { this.cloudGroup.remove(c); c.traverse(o => o.geometry?.dispose?.()); }
    const cloudMat = this.cloudMat || (this.cloudMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }));
    const rand = mulberry32(1234 + this.island.n);
    const bottom = col(this.island.clouds.bottom), top = col(this.island.clouds.top);
    const count = this.island.id === 'grave' ? 14 : 26;
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const n = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        const s = 14 + rand() * 18;
        const geo = new THREE.IcosahedronGeometry(s, 0);
        const cc = new Float32Array(geo.attributes.position.count * 3);
        const pa = geo.attributes.position;
        for (let v = 0; v < pa.count; v++) {
          const t = clamp((pa.getY(v) / s + 1) * 0.5, 0, 1);
          _c.copy(bottom).lerp(top, Math.pow(t, 0.7));
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
      this.cloudGroup.add(g);
    }
  }

  _buildStacks() {
    for (const c of [...this.stackGroup.children]) { this.stackGroup.remove(c); c.geometry?.dispose?.(); }
    const stackMat = this.stackMat || (this.stackMat = M.makeToonMaterial());
    const rand = mulberry32(777 + this.island.n * 31);
    const topC = col(this.island.stacks.top), botC = col(this.island.stacks.bottom);
    for (let i = 0; i < 14; i++) {
      const geo = new THREE.CylinderGeometry(6 + rand() * 10, 14 + rand() * 12, 30 + rand() * 60, 6, 3);
      const pa = geo.attributes.position;
      const cc = new Float32Array(pa.count * 3);
      for (let v = 0; v < pa.count; v++) {
        pa.setX(v, pa.getX(v) + (rand() - 0.5) * 5); pa.setZ(v, pa.getZ(v) + (rand() - 0.5) * 5);
        _c.copy(pa.getY(v) > 0 ? topC : botC);
        cc[v * 3] = _c.r; cc[v * 3 + 1] = _c.g; cc[v * 3 + 2] = _c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(cc, 3));
      const ng = geo.toNonIndexed(); ng.computeVertexNormals(); geo.dispose();
      const m = new THREE.Mesh(ng, stackMat);
      const a = rand() * Math.PI * 2, rr = 290 + rand() * 180;
      m.position.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
      this.stackGroup.add(m);
    }
  }

  // ---------------------------------------------------------------- liquids
  _buildWater() {
    this.heightTex = new THREE.DataTexture(new Uint8Array((SEG + 1) * (SEG + 1) * 4), SEG + 1, SEG + 1, THREE.RGBAFormat);
    this.heightTex.magFilter = THREE.LinearFilter; this.heightTex.minFilter = THREE.LinearFilter;
    const geo = new THREE.PlaneGeometry(1800, 1800, 220, 220);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uHeight: { value: this.heightTex }, uSunDir: { value: this.sunDir }, uKind: { value: 0 },
        uShallow: { value: new THREE.Color() }, uDeep: { value: new THREE.Color() }, uFar: { value: new THREE.Color() }, uFoam: { value: new THREE.Color() },
        uFog: { value: this.fogColor }, uFogNear: { value: 90 }, uFogFar: { value: 560 },
      },
      vertexShader: `uniform float uTime; uniform int uKind; varying vec3 vW;
        void main(){ vec4 w = modelMatrix * vec4(position,1.0);
          float amp = uKind == 1 ? 0.0 : (uKind == 2 ? 0.55 : (uKind == 3 ? 0.25 : 1.0));
          float sp = uKind == 2 ? 0.35 : 1.0;
          w.y += (sin(w.x*0.09 + uTime*1.1*sp)*0.22 + sin(w.z*0.12 - uTime*0.8*sp)*0.18 + sin((w.x+w.z)*0.045 + uTime*0.6*sp)*0.3) * amp;
          vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime; uniform int uKind; uniform sampler2D uHeight; uniform vec3 uSunDir, uShallow, uDeep, uFar, uFoam, uFog; uniform float uFogNear, uFogFar; varying vec3 vW;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
        float cells(vec2 p){ vec2 i = floor(p), f = fract(p); float m = 1.0;
          for (int y=-1;y<=1;y++) for (int x=-1;x<=1;x++){ vec2 g = vec2(float(x),float(y)); vec2 o = vec2(hash(i+g), hash(i+g+7.3)); m = min(m, length(g + o - f)); }
          return m; }
        void main(){
          vec3 n = normalize(cross(dFdx(vW), dFdy(vW))); if (n.y < 0.0) n = -n;
          vec2 uv = vW.xz / ${SIZE.toFixed(1)} + 0.5;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float th = mix(${HMIN.toFixed(1)}, ${HMAX.toFixed(1)}, texture2D(uHeight, uv).r);
          th = mix(${HMIN.toFixed(1)}, th, inside);
          float depth = clamp(-th, 0.0, 10.0);
          vec3 v = normalize(cameraPosition - vW);
          float dist = length(cameraPosition - vW);
          vec3 col;
          if (uKind == 2) {
            // LAVA: slow churning flow with a dark crust network and white-hot seams (emissive, blooms)
            vec2 q = vW.xz * 0.045 + vec2(uTime * 0.03, uTime * 0.018);
            float f = vnoise(q * 2.0 + vnoise(q * 3.0 + uTime * 0.05) * 2.0);
            float crust = smoothstep(0.08, 0.22, cells(vW.xz * 0.11 + vec2(uTime * 0.02, 0.0)));
            col = mix(uShallow * 2.4, uDeep * 1.6, f);
            col = mix(col * 1.4 + vec3(0.6, 0.35, 0.05), col * 0.18, crust * 0.85);
            col = mix(col, uFar * 0.9, smoothstep(260.0, 620.0, length(vW.xz)));
            float pulse = 0.85 + 0.15 * sin(uTime * 1.7 + vW.x * 0.07);
            col *= pulse;
          } else if (uKind == 1) {
            // ICE: frozen shelf near the island (cracked, sparkly), open water further out
            float shelf = smoothstep(9.0, 5.0, depth) * inside;
            float cr = cells(vW.xz * 0.16);
            vec3 ice = mix(uShallow, uDeep, 0.25 + 0.25 * vnoise(vW.xz * 0.05));
            ice = mix(ice * 0.78, ice, smoothstep(0.02, 0.07, cr));
            float spark = step(0.985, hash(floor(vW.xz * 3.0))) * pow(max(dot(reflect(-uSunDir, vec3(0,1,0)), v), 0.0), 8.0);
            ice += vec3(spark * 2.2);
            vec3 water = mix(uDeep, uFar, smoothstep(250.0, 600.0, length(vW.xz)));
            float diff = max(dot(n, uSunDir), 0.0);
            water = water * (0.62 + 0.45 * diff) + pow(max(dot(reflect(-uSunDir, n), v), 0.0), 80.0) * 1.4;
            col = mix(water, ice * (0.8 + 0.3 * max(uSunDir.y, 0.0)), shelf);
          } else {
            col = mix(uShallow, uDeep, smoothstep(0.3, 7.0, depth));
            col = mix(col, uFar, smoothstep(250.0, 600.0, length(vW.xz)));
            float band = sin(depth * 5.0 - uTime * 2.2) * 0.5 + 0.5;
            float foam = smoothstep(1.4, 0.15, depth) * (0.45 + 0.55 * band) * inside;
            if (uKind == 3) {
              foam *= 0.5;
              float bub = step(0.93, vnoise(vW.xz * 0.7 + uTime * 0.2)) * inside;
              col += uFoam * bub * 1.3;
            }
            col = mix(col, uFoam, clamp(foam, 0.0, 1.0) * 0.85);
            float diff = max(dot(n, uSunDir), 0.0);
            float spec = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 80.0);
            float fres = pow(1.0 - max(v.y, 0.0), 3.0);
            col = col * (0.62 + 0.45 * diff) + spec * (uKind == 3 ? 0.4 : 1.6) + fres * 0.12;
          }
          float fo = smoothstep(uFogNear, uFogFar, dist);
          if (uKind == 2) fo *= 0.6;
          gl_FragColor = vec4(mix(col, uFog, fo), 1.0);
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.frustumCulled = false;
    this.scene.add(this.water);
  }

  _applyLiquid() {
    const L = this.island.liquid, u = this.water.material.uniforms;
    u.uKind.value = L.kind;
    u.uShallow.value.set(L.shallow); u.uDeep.value.set(L.deep); u.uFar.value.set(L.far); u.uFoam.value.set(L.foam);
    u.uFogNear.value = this.island.fog.near + 10; u.uFogFar.value = this.island.fog.far + 100;
    this.water.position.y = L.kind === 2 ? -0.15 : 0;
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

  _structure(kind) {
    let obj = null;
    if (kind === 'blessing') obj = M.buildShrine();
    else if (typeof M.buildStructure === 'function') { try { obj = M.buildStructure(kind); } catch { obj = null; } }
    if (!obj) obj = M.buildShrine(); // art fallback
    return obj;
  }

  _vortex(obj, a, b) {
    const v = obj.getObjectByName('vortex');
    if (v && this.fx && this.fx.makeVortexMaterial) {
      try { v.material = this.fx.makeVortexMaterial(a, b); v.userData.vortex = true; v.renderOrder = 2; } catch { /* keep art material */ }
    }
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
    // boss portal (terrain was flattened for it)
    if (this._portalSite) {
      const s = this._portalSite;
      const p = { x: s.x, z: s.z, y: this.heightAt(s.x, s.z) };
      const obj = add(this._structure('bossPortal'), p, Math.atan2(-s.x, -s.z));
      this._vortex(obj, '#7A1CFF', '#FF2A4A');
      this.bossPortal = { ...p, obj, state: 'idle', progress: 0 };
      this._landmarks.push({ x: p.x, z: p.z }, { x: p.x + 6, z: p.z }, { x: p.x - 6, z: p.z });
    }
    const nrm = new THREE.Vector3();
    for (let i = 0; i < 20; i++) {
      const p = this._randomLand(rand, { minR: 14, avoid: 14, minSlope: 0.9 }); if (!p) continue;
      const obj = add(M.buildJumpPad(), p);
      this.pads.push({ x: p.x, z: p.z, y: p.y, kind: 'jump', obj, cd: 0 });
    }
    for (let i = 0; i < 22; i++) {
      const p = this._randomLand(rand, { minR: 12, avoid: 12, minSlope: 0.8 }); if (!p) continue;
      this.normalAt(p.x, p.z, nrm);
      let dx = nrm.x, dz = nrm.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) { const a = rand() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); } else { dx /= l; dz /= l; }
      const obj = add(M.buildBoostPad(), p, Math.atan2(dx, dz));
      this.pads.push({ x: p.x, z: p.z, y: p.y, kind: 'boost', dir: { x: dx, z: dz }, obj, cd: 0 });
    }
    for (let i = 0; i < 16; i++) {
      const p = this._randomLand(rand, { minR: 18, avoid: 16, minSlope: 0.85 }); if (!p) continue;
      const obj = add(M.buildChest(), p, rand() * Math.PI * 2);
      this.chests.push({ x: p.x, z: p.z, y: p.y, opened: false, obj, openT: 0 });
    }
    const kinds = ['blessing', 'blessing', 'blessing', 'moai', 'moai', 'moai', 'totem', 'totem', 'pylon', 'pylon'];
    if (this.opts.greed) kinds.push('greed');
    for (const kind of kinds) {
      const p = this._randomLand(rand, { minR: 26, avoid: 22, minSlope: 0.86 }); if (!p) continue;
      const obj = add(this._structure(kind), p, rand() * Math.PI * 2);
      this.shrines.push({ x: p.x, z: p.z, y: p.y, kind, used: false, progress: 0, obj, t: 0 });
    }
  }

  spawnExitPortal(x, z) {
    let px = x, pz = z;
    // nudge onto dry land if the boss died over liquid
    for (let i = 0; i < 20 && this.heightAt(px, pz) < 0.5; i++) { px *= 0.9; pz *= 0.9; }
    const p = { x: px, z: pz, y: this.heightAt(px, pz) };
    const obj = this._structure('exitPortal');
    obj.position.set(p.x, p.y, p.z);
    obj.rotation.y = Math.atan2(-px, -pz);
    obj.traverse(o => { if (o.isMesh && !o.material.transparent) { o.castShadow = true; o.receiveShadow = true; } });
    this._vortex(obj, '#1AE3FF', '#FFE14D');
    obj.scale.setScalar(0.01);
    this.root.add(obj);
    this.exitPortal = { ...p, obj, t: 0 };
    return this.exitPortal;
  }

  _placeProps(rand) {
    const dummy = new THREE.Object3D();
    const nrm = new THREE.Vector3();
    const tint = this.island.grassTint;
    for (const [kind, count, opts, collide, scaleMin, scaleMax] of this.island.props) {
      const geo = this.propGeo(kind);
      const veg = !['rock', 'crystal', 'snowrock', 'icecrystal', 'icespire', 'mesarock', 'skull', 'tombstone', 'obsidian', 'lavarock', 'embercrystal', 'bonepile', 'vent', 'fence', 'cross', 'snowman', 'pumpkin'].includes(kind);
      const mesh = new THREE.InstancedMesh(geo, veg ? this.vegMat : this.propMat, count);
      if (kind === 'grass') { mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3); }
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
        mesh.setMatrixAt(n, dummy.matrix);
        if (kind === 'grass') { const j = 0.85 + rand() * 0.3; mesh.instanceColor.setXYZ(n, tint[0] * j, tint[1] * j, tint[2] * j); }
        n++;
        if (collide) this._addCollider(p.x, p.z, (geo.userData.radius || 0.5) * s * collide);
      }
      mesh.count = n;
      mesh.castShadow = !!opts.shadow; mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
  }

  _addCollider(x, z, r) {
    const c = { x, z, r };
    this.colliders.push(c);
    const k = ((Math.floor(x / 8) + 64) << 8) | (Math.floor(z / 8) + 64);
    let arr = this.colGrid.get(k); if (!arr) { arr = []; this.colGrid.set(k, arr); }
    arr.push(c);
  }

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
    this.sky.material.uniforms.uTime.value = t;
    this.windU.value = t;
    this.cloudGroup.rotation.y = t * 0.004;
    if (playerPos) this.sky.position.copy(playerPos);
    const glowOp = (o, v) => { if (o && o.material && 'opacity' in o.material) o.material.opacity = v; };
    for (const p of this.pads) {
      if (p.cd > 0) p.cd -= dt;
      const glow = p.obj.getObjectByName(p.kind === 'jump' ? 'glow' : 'arrows');
      if (glow && glow.material) glow.material.opacity = p.cd > 0 ? 0.25 : 0.55 + 0.45 * Math.sin(t * (p.kind === 'jump' ? 5 : 8) + p.x);
    }
    for (const s of this.shrines) {
      const o = s.obj, used = s.used, ph = t + s.x * 0.1;
      if (s.kind === 'blessing') {
        const cr = o.getObjectByName('crystal');
        if (cr) { cr.rotation.y = t * 1.4; cr.position.y = (cr.userData.baseY ??= cr.position.y) + Math.sin(t * 2 + s.x) * 0.25; cr.visible = !used; }
        glowOp(o.getObjectByName('ring'), used ? 0.05 : 0.35 + 0.35 * Math.sin(t * 3) + s.progress * 0.6);
      } else if (s.kind === 'moai') {
        glowOp(o.getObjectByName('eyes'), used ? 0.08 : 0.55 + 0.35 * Math.sin(ph * 2.2) + s.progress * 0.5);
      } else if (s.kind === 'totem') {
        const f = o.getObjectByName('flame');
        if (f) { f.scale.set(1 + Math.sin(t * 13) * 0.08, 1 + Math.sin(t * 9 + 1) * 0.15, 1); f.visible = !used || s.active; }
        glowOp(f, s.active ? 1 : 0.8);
      } else if (s.kind === 'greed') {
        const idol = o.getObjectByName('idol');
        if (idol) { idol.rotation.y = t * 1.2; idol.position.y = (idol.userData.baseY ??= idol.position.y) + Math.sin(t * 1.8) * 0.2; idol.visible = !used; }
        glowOp(o.getObjectByName('glow'), used ? 0.05 : 0.5 + 0.3 * Math.sin(t * 2.5));
      } else if (s.kind === 'pylon') {
        const orb = o.getObjectByName('orb');
        if (orb) { orb.rotation.y = t * 3; orb.position.y = (orb.userData.baseY ??= orb.position.y) + Math.sin(t * 3 + s.z) * 0.18; orb.visible = !used; }
        glowOp(o.getObjectByName('glow'), used ? 0.05 : 0.45 + 0.45 * Math.abs(Math.sin(t * 6)));
      }
      glowOp(o.getObjectByName('pad'), used ? 0.04 : 0.25 + s.progress * 0.7 + 0.1 * Math.sin(t * 3));
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
    const bp = this.bossPortal;
    if (bp) {
      const o = bp.obj, ring = o.getObjectByName('ring');
      const k = bp.state === 'idle' ? 0.35 : bp.state === 'charging' ? 0.5 + bp.progress : bp.state === 'active' ? 1.4 : 0.05;
      if (ring) ring.rotation.z = t * (0.2 + k * 0.8);
      glowOp(o.getObjectByName('runes'), Math.min(1, 0.2 + k * 0.6));
      glowOp(o.getObjectByName('pad'), Math.min(1, 0.2 + k * 0.5 + 0.1 * Math.sin(t * 4)));
      const v = o.getObjectByName('vortex');
      if (v && v.userData.vortex && this.fx?.setVortexIntensity) this.fx.setVortexIntensity(v.material, bp.state === 'used' ? 0.08 : k);
    }
    const ep = this.exitPortal;
    if (ep) {
      ep.t += dt;
      const s = Math.min(1, ep.t / 0.8), e = 1 - Math.pow(1 - s, 3);
      ep.obj.scale.setScalar(Math.max(0.01, e * (1 + Math.sin(Math.min(1, ep.t) * Math.PI) * 0.12)));
      const ring = ep.obj.getObjectByName('ring');
      if (ring) ring.rotation.z = -t * 0.9;
      glowOp(ep.obj.getObjectByName('runes'), 0.6 + 0.4 * Math.sin(t * 5));
      glowOp(ep.obj.getObjectByName('pad'), 0.5 + 0.3 * Math.sin(t * 4));
      const v = ep.obj.getObjectByName('vortex');
      if (v && v.userData.vortex && this.fx?.setVortexIntensity) this.fx.setVortexIntensity(v.material, 1.3);
    }
  }
}
