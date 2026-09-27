// VELOCIBONK — a Megabonk-style survivors-like where SPEED IS DAMAGE.
// Orchestrates rendering, input, the run director, scoring, and the daily/challenge meta.
import * as THREE from 'three';
import { World, PLAY_R } from './world.js';
import { Player } from './player.js';
import { Enemies, T, TDEF, TYPES } from './enemies.js';
import { Pickups } from './pickups.js';
import { Arsenal, WEAPONS } from './weapons.js';
import { rollChoices, applyTome, freshStats, TOMES } from './upgrades.js';
import { FX, PostFX } from './fx.js';
import { UI } from './ui.js';
import { Leaderboard } from './leaderboard.js';
import { audio } from './audio.js';
import { mulberry32, hashString, clamp, lerp } from './rng.js';

const SHARE_URL = 'https://alexmorrison12.github.io/velocibonk/';
const LAUNCH_UTC = Date.UTC(2026, 8, 26);
const BOSS_TIMES = [180, 360, 540];
const FINAL_T = 600;

// ------------------------------------------------------------------ persistence (best-effort)
const store = {
  get(k, d) { try { const v = localStorage.getItem('velocibonk.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('velocibonk.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

function dailyInfo(n = null) {
  const now = new Date();
  let utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (n != null) utc = LAUNCH_UTC + (n - 1) * 86400000;
  const d = new Date(utc);
  const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const num = Math.max(1, Math.floor((utc - LAUNCH_UTC) / 86400000) + 1);
  const pretty = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { n: num, label, pretty, seed: hashString('velocibonk-daily-' + label) };
}

function parseChallenge() {
  const m = /^#vs-(?:d(\d+)|s([0-9a-z]+))-(\d+)$/.exec(location.hash || '');
  if (!m) return null;
  const score = parseInt(m[3], 10);
  if (m[1]) { const d = dailyInfo(parseInt(m[1], 10)); return { score, daily: d.n, seed: d.seed, tag: `d${d.n}` }; }
  return { score, daily: null, seed: parseInt(m[2], 36) >>> 0, tag: `s${m[2]}` };
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const RANKS = [[0, 'Pebble Pusher'], [25e3, 'Casual Bonker'], [150e3, 'Momentum Enjoyer'], [750e3, 'Speed Demon'], [3e6, 'Sonic Raptor'], [15e6, 'Terminal Velocity'], [60e6, 'VELOCIGOD']];
const rankFor = s => RANKS.reduce((r, [min, name]) => (s >= min ? name : r), RANKS[0][1]);

// ------------------------------------------------------------------ game
class Game {
  constructor() {
    const host = document.getElementById('game');
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    host.appendChild(renderer.domElement);
    this.canvas = renderer.domElement;

    const scene = this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2200);
    this.world = new World(scene);
    scene.fog = new THREE.Fog(this.world.fogColor, 80, 460);
    const hemi = new THREE.HemisphereLight('#D6ECFF', '#8C6A4C', 1.3);
    scene.add(hemi);
    const sun = this.sun = new THREE.DirectionalLight('#FFF1D6', 2.35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 1; sc.far = 260;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
    scene.add(sun); scene.add(sun.target);

    this.fx = new FX(scene);
    this.fx.getGroundY = (x, z) => this.world.heightAt(x, z);
    this.post = new PostFX(renderer, scene, this.camera);
    this.post.setSize(innerWidth, innerHeight);
    // only genuinely emissive things (gems, sparks, beams, fire) should bloom — never sunlit terrain
    if (this.post.bloom) { this.post.bloom.threshold = 1.25; this.post.bloom.strength = 0.6; this.post.bloom.radius = 0.45; }
    this.player = new Player(scene, this.world);
    this.enemies = new Enemies(scene, this.world, this);
    this.pickups = new Pickups(scene, this.world, this);
    this.arsenal = new Arsenal(scene, this);
    this.audio = audio;

    this.settings = Object.assign({ master: 0.8, music: 0.55, sfx: 0.8, sensitivity: 1, invertY: false, quality: 'high', showFps: false }, store.get('settings', {}));
    this.bests = store.get('bests', []);
    this.challenge = parseChallenge();
    this.daily = dailyInfo();

    this.ui = new UI(document.getElementById('ui'), {
      onStart: (mode) => this.startRun(mode),
      onResume: () => this.resume(),
      onQuit: () => this.toTitle(),
      onRestart: () => this.startRun(this.lastMode || 'daily'),
      onPick: (i) => this.pick(i),
      onReroll: () => this.reroll(),
      onSettings: (s) => this.applySettings(s),
      onCopyShare: () => {},
    });

    this.lb = new Leaderboard(this, { getName: () => store.get('name', ''), setName: (n) => store.set('name', n) });

    this.keys = {}; this.mouseDX = 0; this.mouseDY = 0; this.lastMouseInput = 0;
    this.yaw = 0; this.pitch = 0.38; this.camDist = 8.5; this.shakeAmp = 0;
    this.state = 'title'; this.time = 0; this.timeScale = 1;
    this.fps = 60; this.hudTick = 0; this.mapTick = 0;
    this.enemyDots = new Float32Array(2400);
    this.hud = { hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: 10, time: 0, score: 0, kills: 0, gold: 0, speed: 0, momentum: 1, ram: false, phase: '', weapons: [], tomes: [], boss: null, fps: null };
    this.momentum = 1; this.ramming = false;
    this._bindInput();
    this.applySettings(this.settings, true);
    this.world.generate(this.challenge ? this.challenge.seed : this.daily.seed);
    this.player.reset(0, 0);
    addEventListener('resize', () => this.onResize());
    this.toTitle();
    this.prewarm();
    requestAnimationFrame(t => { this.last = t; this.frame(t); });
    setTimeout(() => document.getElementById('boot')?.classList.add('gone'), 250);
    window.__vb = this; // handy for debugging from the console
  }

  // compile every shader up front (pools start hidden) so the first meteor/boss/level-up doesn't hitch
  prewarm() {
    const hidden = [];
    this.scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try { this.renderer.compile(this.scene, this.camera); } catch { /* best effort */ }
    for (const o of hidden) o.visible = false;
  }

  // ---------------------------------------------------------------- settings / input
  applySettings(s, silent) {
    this.settings = Object.assign(this.settings, s);
    store.set('settings', this.settings);
    audio.setVolumes({ master: this.settings.master, music: this.settings.music, sfx: this.settings.sfx });
    if (this._quality !== this.settings.quality) {
      this._quality = this.settings.quality;
      this.post.setQuality(this.settings.quality);
      this.renderer.shadowMap.enabled = this.settings.quality === 'high';
      this.sun.castShadow = this.settings.quality === 'high';
      this.post.setSize(innerWidth, innerHeight);
    }
  }

  onResize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.post.setSize(innerWidth, innerHeight);
  }

  _bindInput() {
    const k = this.keys;
    addEventListener('keydown', (e) => {
      if (e.repeat) { if (['Space', 'ShiftLeft', 'ShiftRight', 'KeyC'].includes(e.code)) e.preventDefault(); return; }
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      k[e.code] = true;
      if (e.code === 'Space') { this.jumpPressed = true; e.preventDefault(); }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyC') this.slidePressed = true;
      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (this.state === 'playing' && !document.pointerLockElement) this.pause();
        else if (this.state === 'paused' && e.code === 'KeyP') this.resume();
      }
      if (e.code === 'KeyF' && this.state === 'playing') this.settings.showFps = !this.settings.showFps;
    });
    addEventListener('keyup', (e) => { k[e.code] = false; });
    addEventListener('blur', () => { for (const key in k) k[key] = false; if (this.state === 'playing') this.pause(); });
    this.canvas.addEventListener('mousedown', (e) => {
      audio.init();
      if (this.state === 'playing') {
        if (!document.pointerLockElement) this.lockPointer();
        if (e.button === 2) { this.keys.Mouse2 = true; this.slidePressed = true; }
      }
    });
    addEventListener('mouseup', (e) => { if (e.button === 2) this.keys.Mouse2 = false; });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas || (e.buttons & 1 && this.state === 'playing')) {
        this.mouseDX += e.movementX; this.mouseDY += e.movementY; this.lastMouseInput = this.time;
      }
    });
    addEventListener('wheel', (e) => { if (this.state === 'playing') this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 1.2, 6, 18); }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement && this.state === 'playing' && !this._modalUnlock) this.pause();
      this._modalUnlock = false;
    });
    addEventListener('pointerdown', () => audio.init(), { once: true });
    addEventListener('keydown', () => audio.init(), { once: true });
  }

  lockPointer() {
    try { const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock()?.catch?.(() => {}); } catch { /* unsupported */ } }); } catch { /* unsupported */ }
  }
  unlockPointer() { if (document.pointerLockElement) { this._modalUnlock = true; document.exitPointerLock(); } }

  // ---------------------------------------------------------------- flow
  toTitle() {
    this.state = 'title';
    this.unlockPointer();
    this.ui.hideGameOver?.(); this.ui.hidePause?.(); this.ui.hideLevelUp?.();
    this.ui.showHUD(false);
    this.enemies.reset(); this.pickups.reset(); this.arsenal.reset(); this.fx.clear();
    this.player.model.visible = true;
    if (this.ghost) this.ghost.model.visible = false;
    this.ui.showTitle({
      dailyNumber: this.challenge?.daily ?? this.daily.n, dateLabel: this.daily.pretty,
      bests: this.bests.slice(0, 5), challenge: this.challenge ? { score: this.challenge.score, daily: this.challenge.daily, name: null } : null,
      settings: this.settings,
    });
    this.lb.refresh();
    audio.startMusic('title');
  }

  startRun(mode) {
    audio.init();
    this.lastMode = mode;
    let seed, dailyN = null, ch = null;
    if (mode === 'challenge' && this.pendingChallenge) ch = this.pendingChallenge;
    else if (mode === 'daily' && this.challenge) ch = this.challenge;
    if (ch) { seed = ch.seed; dailyN = ch.daily; }
    else if (mode === 'daily') { seed = this.daily.seed; dailyN = this.daily.n; }
    else { seed = (Math.random() * 2 ** 32) >>> 0; }
    this.run = { seed, daily: dailyN, tag: dailyN ? `d${dailyN}` : `s${seed.toString(36)}`, challenge: ch, challengeBeaten: false };
    if (this.world.seed !== seed) this.world.generate(seed);
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.enemies.reset(); this.pickups.reset(); this.arsenal.reset(); this.fx.clear();
    this.stats = freshStats();
    this.tomes = new Map();
    this.arsenal.add('bat'); this.arsenal.add('pebble');
    this.player.reset(0, 0); this.player.model.visible = true; this.player.model.rotation.set(0, 0, 0);
    this.hp = this.stats.maxHp; this.level = 1; this.xp = 0; this.xpNext = this.xpFor(1);
    this.gold = 0; this.kills = 0; this.score = 0; this.runTime = 0; this.levelsPending = 0; this.rerolls = 2;
    this.invuln = 0; this.topSpeed = 0; this.maxMomentum = 1; this.bossKills = 0; this.chestsOpened = 0;
    this.nextElite = 40; this.nextHorde = 70; this.bossIdx = 0; this.bossWarned = -1; this.final = false;
    this.hpMult = 1; this.dmgMult = 1; this.dmgTaken = 0; this.numbersThisFrame = 0;
    this.momentum = 1; this.ramming = false; this.dying = 0; this.timeScale = 1; this.hitStop = 0;
    this.combo = 0; this.comboT = 0; this.nextComboMilestone = 25; this.bestCombo = 0;
    this.damageFlash = 0; this.whiteFlash = 0;
    this.yaw = 0; this.pitch = 0.38;
    this.dmgByWeapon = {};
    for (const c of this.world.chests) { c.opened = false; c.openT = 0; const lid = c.obj.getObjectByName('lid'); if (lid) lid.rotation.x = 0; }
    for (const s of this.world.shrines) { s.used = false; s.progress = 0; }
    this.hookPlayerEvents();
    this.ghostRec = []; this.ghostRecT = 0;
    this.ghostData = store.get('ghost.' + this.run.tag, null);
    this.ghostDone = false;
    if (this.ghost) this.ghost.model.visible = !!this.ghostData;
    if (this.ghostData) {
      if (!this.ghost) {
        this.ghost = new Player(this.scene, this.world);
        this.ghost.model.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.38; o.material.depthWrite = false; o.material.emissive = new THREE.Color('#1AE3FF'); o.material.emissiveIntensity = 0.8; o.castShadow = false; } });
      }
      this.ghost.model.visible = true;
      setTimeout(() => this.ui.toast(`GHOST RACE · your best here: ${fmt(this.ghostData.score)}`, { color: '#1AE3FF', duration: 3.5 }), 2600);
    }
    this.ui.hideTitle(); this.ui.hideGameOver?.(); this.ui.hidePause?.();
    this.ui.showHUD(true);
    this.state = 'playing';
    this.lockPointer();
    audio.startMusic('run'); audio.setIntensity(0);
    const rc = this.run.challenge;
    this.ui.announce(rc ? `BEAT ${fmt(rc.score)}` : this.run.daily ? `DAILY #${this.run.daily}` : 'RANDOM ISLAND',
      { sub: rc ? `${rc.name ? rc.name.toUpperCase() + '’S RUN · ' : ''}${this.run.daily ? 'DAILY #' + this.run.daily : 'RANDOM ISLAND'}` : 'SPEED IS DAMAGE — GO FAST', color: rc ? '#FF3D8B' : '#FFE14D', duration: 2.4 });
    // quick controls primer (first run of the session gets the full set)
    const tips = [['WASD move · MOUSE look · click to lock the cursor', 1.2], ['SPACE jump — hold it to bunny-hop and build speed', 4.2], ['SHIFT slide downhill · SHIFT in the air = SLAM', 7.2], ['×2 MOMENTUM = RAM MODE: plow straight through them', 10.2]];
    this._tipTimers?.forEach(clearTimeout);
    this._tipTimers = (this._shownTips ? tips.slice(1, 2) : tips).map(([t, d]) => setTimeout(() => { if (this.state === 'playing' || this.state === 'levelup') this.ui.toast(t, { color: '#1AE3FF', duration: 3.2 }); }, d * 1000));
    this._shownTips = true;
    this.ramAnnounced = false;
    // opening wave so the first seconds already feel alive
    for (let i = 0; i < 14; i++) this.spawnAround(T.blob, 22, 34);
  }

  // launched from a leaderboard row: play that run's island with its score as the target
  startChallenge({ score, name, tag }) {
    const m = /^(?:d(\d+)|s([0-9a-z]+))$/.exec(tag || '');
    if (!m) return;
    if (m[1]) { const d = dailyInfo(parseInt(m[1], 10)); this.pendingChallenge = { score, name, daily: d.n, seed: d.seed, tag }; }
    else this.pendingChallenge = { score, name, daily: null, seed: parseInt(m[2], 36) >>> 0, tag };
    this.startRun('challenge');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.ui.showPause(this.settings);
    audio.duck(0.6, 0.3);
  }
  resume() {
    if (this.state !== 'paused') return;
    this.ui.hidePause();
    this.state = 'playing';
    this.lockPointer();
  }

  xpFor(L) { return Math.floor(6 + L * 4.5 + Math.pow(L, 1.85) * 0.7); }

  // ---------------------------------------------------------------- level up / chest / shrine
  openChoices(source) {
    this.choiceSource = source;
    this.choices = rollChoices({ arsenal: this.arsenal, tomes: this.tomes, stats: this.stats, rand: this.rand, source });
    if (this.choices.every(c => c.kind === 'bonus')) {
      // fully maxed build: don't interrupt the carnage with a modal
      if (source === 'level') this.levelsPending--;
      this.score += 25000 * this.momentum; this.gold += 20; this.hp = Math.min(this.stats.maxHp, this.hp + 15);
      this.ui.toast(`MAXED OUT · +${fmt(25000 * this.momentum)}`, { color: '#FFB020', duration: 1.2 });
      return;
    }
    this.state = 'levelup';
    this.unlockPointer();
    const title = source === 'chest' ? 'CHEST!' : source === 'shrine' ? 'SHRINE BLESSING' : 'LEVEL UP!';
    this.ui.showLevelUp({ title, choices: this.choices, rerolls: this.rerolls });
    audio.play(source === 'chest' ? 'chest' : source === 'shrine' ? 'shrine' : 'levelup');
    audio.duck(0.5, 1.2);
  }

  pick(i) {
    if (this.state !== 'levelup') return;
    const c = this.choices[i]; if (!c) return;
    if (c.kind === 'weapon') {
      const w = this.arsenal.get(c.id);
      if (w) { w.level++; w.bonus += c.bonus; } else this.arsenal.add(c.id, c.bonus);
    } else if (c.kind === 'tome') {
      this.tomes.set(c.id, (this.tomes.get(c.id) || 0) + 1);
      applyTome(this.stats, c.id, c.value);
      if (c.id === 'vitality') this.hp += c.value;
    } else if (c.id === 'gold') this.gold += 60;
    else if (c.id === 'heal') this.hp = this.stats.maxHp;
    else if (c.id === 'score') this.score += 25000;
    audio.play(c.rarity === 'legendary' ? 'legendary' : 'pick');
    this.ui.hideLevelUp();
    if (this.choiceSource === 'level') this.levelsPending--;
    this.state = 'playing';
    this.whiteFlash = c.rarity === 'legendary' ? 0.6 : 0.25;
    this.fx.confetti(this.player.pos.clone().setY(this.player.pos.y + 1.5), c.rarity === 'legendary' ? 90 : 30);
    this.lockPointer();
  }

  reroll() {
    if (this.state !== 'levelup' || this.rerolls <= 0) return;
    this.rerolls--;
    this.choices = rollChoices({ arsenal: this.arsenal, tomes: this.tomes, stats: this.stats, rand: this.rand, source: this.choiceSource });
    this.ui.showLevelUp({ title: this.choiceSource === 'chest' ? 'CHEST!' : this.choiceSource === 'shrine' ? 'SHRINE BLESSING' : 'LEVEL UP!', choices: this.choices, rerolls: this.rerolls });
    audio.play('reroll');
  }

  // ---------------------------------------------------------------- callbacks from systems
  addXp(v) {
    this.xp += v * this.stats.wisdom;
    while (this.xp >= this.xpNext) { this.xp -= this.xpNext; this.level++; this.xpNext = this.xpFor(this.level); this.levelsPending++; }
  }
  addGold(v) { this.gold += v; }
  heal(v) {
    const before = this.hp; this.hp = Math.min(this.stats.maxHp, this.hp + v);
    if (this.hp > before) { this.fx.damageNumber(this.player.pos.clone().setY(this.player.pos.y + 2), this.hp - before, { color: '#8CFF5A' }); audio.play('heal', { volume: 0.5 }); }
  }
  shake(a) { this.shakeAmp = Math.min(1.4, this.shakeAmp + a); }

  onDamage(i, amount, crit, source, dealt) {
    this.dmgByWeapon[source] = (this.dmgByWeapon[source] || 0) + dealt;
    const E = this.enemies;
    if (this.numbersThisFrame < 14 || crit) {
      this.numbersThisFrame++;
      _p.set(E.x[i] + (Math.random() - 0.5) * 0.6, E.y[i] + E.yo[i] + TDEF[E.type[i]].height * E.scale[i] + 0.3, E.z[i]);
      const big = this.momentum >= 3;
      this.fx.damageNumber(_p, amount, { crit, color: crit ? '#FFD23F' : big ? '#FF9E2C' : '#FFFFFF', scale: big ? 1.25 : 1 });
    }
    if (source !== 'hotfeet' && source !== 'aura') audio.play(crit ? 'crit' : 'hit', { volume: 0.35, pitch: 0.9 + Math.random() * 0.25 });
  }

  onKill(i, ti, x, y, z, elite) {
    const def = TDEF[ti];
    this.kills++;
    this.combo = (this.comboT > 0 ? this.combo : 0) + 1; this.comboT = 1.6;
    if (this.combo >= this.nextComboMilestone) {
      const m = this.nextComboMilestone;
      this.nextComboMilestone = m < 100 ? m + 25 : m < 500 ? m + 100 : m + 250;
      this.score += m * 20 * this.momentum;
      this.fx.popText(_p.copy(this.player.pos).setY(this.player.pos.y + 3.4), `${m} BONK COMBO!`, m >= 250 ? '#FF3D8B' : '#FFE14D', m >= 100 ? 1.9 : 1.5);
      if (m >= 100) audio.play('newbest', { volume: 0.4 });
    }
    const pts = def.pts * (elite ? 10 : 1) * this.momentum;
    this.score += pts;
    const min = this.runTime / 60;
    const xpv = def.xp * (elite ? 12 : 1) * (1 + Math.min(min, 4) * 0.08);
    if (ti === T.boss) {
      for (let k = 0; k < 30; k++) this.pickups.gem(x, y + 1, z, xpv / 30);
      for (let k = 0; k < 40; k++) this.pickups.coin(x, y + 1, z, 1, 9);
      this.pickups.heart(x, y + 1, z);
    } else {
      this.pickups.gem(x, y + 0.5, z, xpv);
      if (this.rand() < def.gold * (1 + this.stats.luck)) this.pickups.coin(x, y + 0.5, z, 1);
      if (elite) { for (let k = 0; k < 14; k++) this.pickups.coin(x, y + 0.5, z, 1, 6); if (this.rand() < 0.5) this.pickups.heart(x, y + 0.5, z); }
      else if (this.rand() < 0.014) this.pickups.heart(x, y + 0.5, z);
    }
    if (Math.random() < 0.35) audio.play('kill', { volume: 0.3, pitch: 0.85 + Math.random() * 0.4 });
    if (ti === T.boss) this.onBossKilled(x, y, z);
  }

  onCorpsePop(i, ti, x, y, z) {
    _p.set(x, y, z);
    this.fx.burst(_p, TDEF[ti].color, ti === T.boss ? 60 : ti === T.brute ? 16 : 7, { speed: ti === T.boss ? 16 : 7, size: ti === T.boss ? 0.5 : 0.2, life: 0.55 });
  }

  onRam(i, dx, dz) {
    const dmg = 20 * this.stats.might * this.momentum * (1 + this.stats.momentum * 0.25);
    const crit = Math.random() < this.stats.crit;
    this.enemies.damage(i, dmg * (crit ? 2 : 1), crit, dx, dz, 22 + this.momentum * 7, 'ram');
    if (Math.random() < 0.45) audio.play('ram', { volume: 0.5, pitch: 0.9 + Math.random() * 0.3 });
    if (Math.random() < 0.08) this.fx.popText(this.player.pos.clone().setY(this.player.pos.y + 2.6), 'RAM!', '#FF3D8B', 1.3);
    this.shake(0.05);
    const v = this.player.vel; v.x *= 0.992; v.z *= 0.992;
  }

  hurtPlayer(dmg, fx, fz, shock) {
    if (this.invuln > 0 || this.state !== 'playing' || this.dying) return;
    const d = dmg * (1 - this.stats.armor);
    this.hp -= d; this.dmgTaken += d;
    this.invuln = 0.7;
    this.damageFlash = 1;
    this.shake(shock ? 0.8 : 0.3);
    audio.play('hurt', { volume: 0.7 });
    this.fx.damageNumber(this.player.pos.clone().setY(this.player.pos.y + 2.2), d, { color: '#FF3D5A', scale: 1.2 });
    const P = this.player.pos, dx = P.x - fx, dz = P.z - fz, l = Math.hypot(dx, dz) + 1e-4;
    this.player.vel.x += dx / l * 6; this.player.vel.z += dz / l * 6;
    if (this.hp <= 0) this.die();
  }

  die() {
    this.hp = 0; this.dying = 2.2; this.timeScale = 0.3;
    this.player.dead = true;
    audio.play('death'); audio.stopMusic();
    this.ui.announce('BONKED.', { color: '#FF3D8B', duration: 2 });
    this.player.vel.set(0, 18, 0); this.player.onGround = false;
  }

  gameOver() {
    this.state = 'gameover';
    this.timeScale = 1;
    this.unlockPointer();
    this.ui.showHUD(false);
    const score = Math.round(this.score);
    const prevBest = this.bests[0]?.score || 0;
    const entry = { score, time: Math.round(this.runTime), kills: this.kills, daily: this.run.daily, date: new Date().toISOString().slice(0, 10) };
    this.bests.push(entry); this.bests.sort((a, b) => b.score - a.score); this.bests = this.bests.slice(0, 10);
    store.set('bests', this.bests);
    const isBest = score > prevBest;
    const oldGhost = store.get('ghost.' + this.run.tag, null);
    if (!oldGhost || score > oldGhost.score) {
      store.set('ghost.' + this.run.tag, { score, path: this.ghostRec });
      const tags = store.get('ghostTags', []).filter(t => t !== this.run.tag); tags.unshift(this.run.tag);
      for (const old of tags.slice(6)) { try { localStorage.removeItem('velocibonk.ghost.' + old); } catch { /* ignore */ } }
      store.set('ghostTags', tags.slice(0, 6));
    }
    if (this.ghost) this.ghost.model.visible = false;
    const ch = this.run.challenge;
    const challenge = ch ? { target: ch.score, won: score > ch.score, diff: score - ch.score } : null;
    this.lb.prepareSubmit({ score, time: this.runTime, kills: this.kills, level: this.level, topSpeed: this.topSpeed, maxMomentum: this.maxMomentum, tag: this.run.tag });
    const link = `${SHARE_URL || location.href.split('#')[0]}#vs-${this.run.tag}-${score}`;
    const shareText = [
      `VELOCIBONK 🦖 ${this.run.daily ? `Daily #${this.run.daily}` : 'Random Island'}`,
      `💥 ${fmt(score)} pts · ⏱ ${fmtTime(this.runTime)} · ☠ ${fmt(this.kills)} bonks`,
      `🏎 ${Math.round(this.topSpeed * 3.6)} km/h top speed · ×${this.maxMomentum.toFixed(1)} momentum`,
      `Beat it: ${link}`,
    ].join('\n');
    const names = { ...Object.fromEntries(Object.entries(WEAPONS).map(([k, v]) => [k, v.name])), ram: 'Ramming', slam: 'Slam' };
    const iconFor = { ram: 'ram', slam: 'quake' };
    const damageByWeapon = Object.entries(this.dmgByWeapon).map(([id, dmg]) => ({ id: iconFor[id] || id, name: names[id] || id, dmg: Math.round(dmg) })).sort((a, b) => b.dmg - a.dmg);
    this.ui.showGameOver({
      score, time: this.runTime, kills: this.kills, level: this.level, topSpeed: this.topSpeed, maxMomentum: this.maxMomentum,
      bossKills: this.bossKills, damageByWeapon, isBest, rank: rankFor(score), bests: this.bests.slice(0, 5), daily: this.run.daily, challenge, shareText,
    });
    if (isBest) audio.play('newbest');
    audio.startMusic('title');
  }

  onBossKilled(x, y, z) {
    this.bossKills++;
    this.score += 5000 * this.bossKills * this.momentum;
    this.rerolls++;
    this.whiteFlash = 1; this.hitStop = 0.5;
    this.shake(1.2);
    _p.set(x, y + 2, z);
    this.fx.confetti(_p, 160);
    this.fx.ring(_p, 30, '#FFE14D', 0.8, 2);
    this.fx.popText(_p.clone().setY(y + 7), 'BOSS BONKED!', '#FFE14D', 3);
    audio.play('explosion', { volume: 1, pitch: 0.6 });
    audio.play('newbest', { volume: 0.8 });
    this.ui.announce('BOSS BONKED!', { sub: `+${fmt(5000 * this.bossKills * this.momentum)} · +1 reroll`, color: '#FFE14D' });
    audio.startMusic(this.runTime >= FINAL_T ? 'final' : 'run');
  }

  // ---------------------------------------------------------------- spawning / director
  spawnAround(ti, rMin, rMax, opts) {
    const P = this.player.pos;
    for (let tries = 0; tries < 6; tries++) {
      const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
      const x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
      if (Math.hypot(x, z) > PLAY_R + 4) continue;
      if (!TDEF[ti].fly && this.world.heightAt(x, z) < 0.3) continue;
      return this.enemies.spawn(ti, x, z, Object.assign({ hpMult: this.hpMult, dmgMult: this.dmgMult }, opts));
    }
    return -1;
  }

  director(dt) {
    const t = this.runTime, min = t / 60, E = this.enemies;
    this.hpMult = 1 + min * 0.55 + min * min * 0.075 + (this.final ? Math.pow((t - FINAL_T) / 60, 2) * 1.5 + (t - FINAL_T) / 60 * 2 : 0);
    this.dmgMult = 1 + min * 0.13 + (this.final ? (t - FINAL_T) / 60 * 0.5 : 0);
    const bossAlive = E.boss && E.state[E.boss.i] === 1;
    let target = 26 + t * 0.9 + min * min * 10;
    if (bossAlive) target *= 0.45;
    if (this.final) target = 1300 + (t - FINAL_T) * 4;
    target = Math.min(target, 2200);
    const deficit = target - E.aliveCount;
    const perFrame = Math.min(deficit, this.final ? 24 : 3 + min * 1.6);
    // weights by time
    const w = [Math.max(2.5, 10 - min * 1.3), t > 25 ? 6 : 0, t > 55 ? 4.5 : 0, t > 85 ? 3.5 : 0, t > 115 ? 2 : 0, t > 150 ? 1 + min * 0.25 : 0];
    const tot = w.reduce((a, b) => a + b, 0);
    for (let s = 0; s < perFrame; s++) {
      let r = Math.random() * tot, ti = 0;
      for (let k = 0; k < w.length; k++) { r -= w[k]; if (r <= 0) { ti = k; break; } }
      if (ti === T.zippy) { for (let q = 0; q < 4; q++) this.spawnAround(T.zippy, 36, 44); s += 3; }
      else this.spawnAround(ti, 32, 48);
    }
    // elites
    if (t >= this.nextElite) {
      this.nextElite += Math.max(18, 42 - min * 2);
      const pool = [T.goon, T.blob, ...(t > 100 ? [T.brute, T.spitter] : []), ...(t > 60 ? [T.zippy, T.bat] : [])];
      const i = this.spawnAround(pool[(Math.random() * pool.length) | 0], 26, 34, { elite: true });
      if (i >= 0) this.ui.toast('ELITE SPOTTED — big loot', { color: '#FFB020' });
    }
    // horde rings
    if (t >= this.nextHorde) {
      this.nextHorde += 80;
      const n = Math.min(90, 28 + min * 9);
      const P = this.player.pos;
      const ti = t > 150 ? T.goon : T.blob;
      for (let k = 0; k < n; k++) {
        const a = k / n * Math.PI * 2, x = P.x + Math.cos(a) * 24, z = P.z + Math.sin(a) * 24;
        if (this.world.heightAt(x, z) > 0.3 && Math.hypot(x, z) < PLAY_R + 4) E.spawn(ti, x, z, { hpMult: this.hpMult, dmgMult: this.dmgMult });
      }
      this.ui.announce('SURROUNDED!', { sub: 'bonk your way out', color: '#FF3D8B', duration: 1.6 });
      audio.play('warning', { volume: 0.5 });
    }
    // bosses
    const bt = BOSS_TIMES[this.bossIdx];
    if (bt !== undefined) {
      if (t >= bt - 6 && this.bossWarned !== this.bossIdx) {
        this.bossWarned = this.bossIdx;
        this.ui.announce('BOSS INCOMING', { sub: 'jump over the shockwaves!', color: '#FF3D8B', duration: 2.6 });
        audio.play('warning');
      }
      if (t >= bt) {
        this.bossIdx++;
        const P = this.player.pos;
        let bx = 0, bz = 0;
        for (let tries = 0; tries < 12; tries++) {
          const a = Math.random() * Math.PI * 2;
          bx = P.x + Math.cos(a) * 34; bz = P.z + Math.sin(a) * 34;
          if (this.world.heightAt(bx, bz) > 0.5 && Math.hypot(bx, bz) < PLAY_R) break;
        }
        E.spawnBoss(bx, bz, this.bossIdx, this.hpMult * (1 + (this.bossIdx - 1) * 0.35));
        audio.play('bossroar'); audio.startMusic('boss');
        this.shake(0.8);
      }
    }
    if (!this.final && t >= FINAL_T) {
      this.final = true;
      this.ui.announce('FINAL SWARM', { sub: 'survive. as. long. as. you. can.', color: '#FF3D8B', duration: 3 });
      audio.play('swarm'); audio.startMusic('final');
    }
  }

  phaseText() {
    const t = this.runTime, E = this.enemies;
    if (E.boss && E.state[E.boss.i] === 1) return 'BOSS FIGHT';
    if (this.final) return 'FINAL SWARM';
    const bt = BOSS_TIMES[this.bossIdx];
    if (bt !== undefined) return `BOSS IN ${fmtTime(Math.max(0, bt - t))}`;
    return `FINAL SWARM IN ${fmtTime(Math.max(0, FINAL_T - t))}`;
  }

  // ---------------------------------------------------------------- player events
  hookPlayerEvents() {
    const P = this.player, fx = this.fx;
    P.events = {
      jump: () => audio.play('jump', { volume: 0.45 }),
      doublejump: () => { audio.play('doublejump', { volume: 0.45 }); fx.ring(_p.copy(P.pos).setY(P.pos.y + 0.2), 1.6, '#FFFFFF', 0.25, 0.25); },
      bhop: (chain) => { if (chain === 5 || chain === 10 || chain === 25 || (chain % 50 === 0)) fx.popText(_p.copy(P.pos).setY(P.pos.y + 2.8), `BHOP ×${chain}`, '#1AE3FF', 0.9); },
      slide: () => { audio.play('slide', { volume: 0.5 }); fx.dust(P.pos, 6); },
      slamstart: () => audio.play('slam', { volume: 0.6 }),
      superbounce: () => { fx.popText(_p.copy(P.pos).setY(P.pos.y + 2.8), 'SUPER BOUNCE!', '#FFE14D', 1.2); audio.play('jumppad', { volume: 0.6, pitch: 1.3 }); },
      land: (fall, slam) => {
        if (fall > 6) { fx.dust(P.pos, Math.min(14, 3 + fall / 4)); audio.play('land', { volume: clamp(fall / 40, 0.2, 0.7) }); }
        if (slam) this.slamImpact(fall);
        this.arsenal.onLand(fall, slam);
      },
      pad: (kind) => {
        if (kind === 'jump') { audio.play('jumppad', { volume: 0.7 }); fx.ring(_p.copy(P.pos).setY(P.pos.y + 0.3), 3, '#FFB020', 0.35, 0.5); }
        else { audio.play('boost', { volume: 0.7 }); fx.popText(_p.copy(P.pos).setY(P.pos.y + 2.5), 'BOOST!', '#1AE3FF', 1.1); }
      },
    };
  }

  slamImpact(fall) {
    const P = this.player.pos, E = this.enemies;
    const r = 3.8 * this.stats.area * (1 + fall / 60);
    const dmg = 22 * (1 + fall / 30) * this.stats.might * this.momentum;
    this.fx.ring(_p.copy(P).setY(P.y + 0.3), r, '#FFFFFF', 0.35, 0.7);
    this.fx.burst(_p.copy(P).setY(P.y + 0.3), '#d8c29a', 18, { speed: 9, up: 6, size: 0.25 });
    this.shake(0.35 + fall / 120);
    audio.play('bonk', { volume: 0.9, pitch: 0.7 });
    const n = E.query(P.x, P.z, r, _hits, 600);
    for (let k = 0; k < n; k++) {
      const i = _hits[k], dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4;
      const crit = Math.random() < this.stats.crit;
      E.damage(i, dmg * (crit ? 2 : 1), crit, dx / d, dz / d, 26, 'slam');
    }
    if (n >= 8) this.fx.popText(_p.copy(P).setY(P.y + 3), `SLAM ×${n}!`, '#FFE14D', 1.4);
  }

  // ---------------------------------------------------------------- per-frame
  frame(now) {
    requestAnimationFrame(t => this.frame(t));
    const rdt = Math.min(0.05, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    this.fps = lerp(this.fps, 1 / rdt, 0.05);
    this.tick(rdt);
  }

  tick(rdt) {
    this.time += rdt;
    this.numbersThisFrame = 0;
    let dt = rdt;

    if (this.state === 'playing') {
      if (this.hitStop > 0) { this.hitStop -= rdt; dt = rdt * 0.15; }
      if (this.dying > 0) {
        this.dying -= rdt;
        dt = rdt * this.timeScale;
        this.player.model.rotation.x += rdt * 8; this.player.model.rotation.z += rdt * 5;
        if (this.dying <= 0) { this.gameOver(); }
      }
      if (this.state === 'playing') this.update(dt, rdt);
    } else if (this.state === 'title') {
      this.updateTitle(rdt);
    }

    // visuals that run in every state
    const P = this.player.pos;
    this.world.update(rdt, this.time, P);
    const frozen = this.state === 'levelup' || this.state === 'paused';
    this.fx.update(frozen ? 0 : dt, this.time, this.camera);
    if (this.state === 'playing' || this.state === 'gameover') this.enemies.render(this.time);
    this.sun.position.set(P.x + this.world.sunDir.x * 90, P.y + this.world.sunDir.y * 90, P.z + this.world.sunDir.z * 90);
    this.sun.target.position.copy(P);
    const speed01 = this.state === 'playing' ? clamp((this.momentum - 1.25) / 2.6, 0, 1) : 0;
    audio.setSpeed(this.state === 'playing' ? speed01 : 0);
    this.damageFlash = Math.max(0, this.damageFlash - rdt * 2.5);
    this.whiteFlash = Math.max(0, (this.whiteFlash || 0) - rdt * 1.8);
    const lowHp = this.state === 'playing' && this.stats ? clamp(1 - this.hp / this.stats.maxHp / 0.3, 0, 1) : 0;
    this.post.render(rdt, { speed01, damage: this.damageFlash, lowHp, time: this.time, flash: this.whiteFlash });
    if (this.state === 'playing' || this.state === 'levelup' || this.state === 'paused') this.updateHUD(rdt);
  }

  updateTitle(dt) {
    // hero tracking shot: the raptor sprints laps of the plaza; the camera sits inside the lap,
    // ahead of it, so it charges across the frame (lower right) with the island behind
    const P = this.player;
    const a = this.time * 0.55, R = 10;
    P.pos.set(Math.cos(a) * R, 0, Math.sin(a) * R); P.pos.y = this.world.heightAt(P.pos.x, P.pos.z);
    P.vel.set(-Math.sin(a) * 13, 0, Math.cos(a) * 13);
    P.onGround = true; P.sliding = false; P.dead = false;
    P.animate(dt, this.time, 0);
    if (((this.time * 0.7) % 1) < dt * 0.7) P.swing();
    const ox = Math.cos(a), oz = Math.sin(a);           // outward from the plaza center
    const tx = -Math.sin(a), tz = Math.cos(a);          // running direction
    const cam = this.camera;
    const cx = P.pos.x - ox * 6.5 + tx * 4.5, cz = P.pos.z - oz * 6.5 + tz * 4.5;
    cam.position.set(cx, P.pos.y + 1.9, cz);
    let dx = P.pos.x - cx, dz = P.pos.z - cz; const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
    const rx = -dz, rz = dx; // camera right
    cam.lookAt(P.pos.x - rx * 2.6, P.pos.y + 2.0, P.pos.z - rz * 2.6);
    cam.fov = 58; cam.updateProjectionMatrix();
  }

  update(dt, rdt) {
    const P = this.player, k = this.keys, s = this.settings;
    this.runTime += dt;
    // camera input
    const sens = 0.0023 * s.sensitivity;
    this.yaw -= this.mouseDX * sens;
    this.pitch = clamp(this.pitch + this.mouseDY * sens * (s.invertY ? -1 : 1), -0.25, 1.2);
    this.mouseDX = this.mouseDY = 0;
    if (k.ArrowLeft || k.KeyQ) { this.yaw += rdt * 2.4; this.lastMouseInput = this.time; }
    if (k.ArrowRight || k.KeyE) { this.yaw -= rdt * 2.4; this.lastMouseInput = this.time; }
    // gentle auto-follow when the mouse is idle (helps without pointer lock)
    if (this.time - this.lastMouseInput > 1.2 && P.hSpeed > 12) {
      const target = Math.atan2(P.vel.x, P.vel.z);
      let d = target - this.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * 0.9);
    }
    const input = {
      fwd: k.KeyW || k.ArrowUp, back: k.KeyS || k.ArrowDown, left: k.KeyA, right: k.KeyD,
      jumpPressed: this.jumpPressed, jumpHeld: !!k.Space, slide: k.ShiftLeft || k.ShiftRight || k.KeyC || k.Mouse2, slidePressed: this.slidePressed,
    };
    this.jumpPressed = false; this.slidePressed = false;
    // sub-step the controller for stable high-speed physics
    const steps = P.hSpeed > 30 ? 3 : 2;
    for (let i = 0; i < steps; i++) {
      P.update(dt / steps, i === 0 ? input : { ...input, jumpPressed: false, slidePressed: false }, this.yaw, this.stats);
    }
    P.animate(dt, this.time, this.yaw);

    // momentum: speed -> damage multiplier (fast attack, slow release)
    const eff = Math.hypot(P.hSpeed, Math.max(0, -P.vel.y) * 0.55);
    const target = Math.min(8, 1 + this.stats.momentum * Math.max(0, eff - 8) / 10);
    this.momentum = target > this.momentum ? lerp(this.momentum, target, 1 - Math.exp(-10 * dt)) : lerp(this.momentum, target, 1 - Math.exp(-2.4 * dt));
    this.ramming = this.momentum >= 2 && !P.dead;
    if (this.ramming && !this.ramAnnounced) {
      this.ramAnnounced = true;
      this.ui.announce('RAM MODE!', { sub: 'you are the weapon now', color: '#FF3D8B', duration: 1.6 });
      audio.play('boost', { volume: 0.6, pitch: 0.8 });
    }
    this.topSpeed = Math.max(this.topSpeed, P.hSpeed);
    this.maxMomentum = Math.max(this.maxMomentum, this.momentum);
    this.fx.trail(_p.copy(P.pos).setY(P.pos.y + 0.8), clamp((this.momentum - 1.3) / 2.5, 0, 1));
    this.updateGhost(dt);

    // survival
    if (!this.dying) {
      this.invuln -= dt;
      this.comboT -= dt; if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      if (this.comboT <= 0 && this.combo) { this.combo = 0; this.nextComboMilestone = 25; }
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
      this.director(dt);
      this.enemies.update(dt, this.time);
      this.arsenal.update(dt, this.time);
      this.pickups.update(dt, this.time);
      this.interact(dt);
      this.score += dt * 5 * (1 + this.runTime / 60);
      const rc = this.run.challenge;
      if (rc && !this.run.challengeBeaten && this.score > rc.score) {
        this.run.challengeBeaten = true;
        this.ui.announce('CHALLENGE BEATEN!', { sub: `you passed ${rc.name ? rc.name.toUpperCase() : 'the target'}: ${fmt(rc.score)}`, color: '#8CFF5A', duration: 2.4 });
        audio.play('newbest', { volume: 0.8 });
      }
      audio.setIntensity(clamp(this.enemies.aliveCount / 700 + this.runTime / 900, 0, 1));
      if (this.levelsPending > 0 && this.state === 'playing') this.openChoices('level');
    } else {
      this.enemies.update(dt * 0.5, this.time);
    }
    this.updateCamera(dt, rdt);
  }

  updateGhost(dt) {
    // record at 10 Hz (decimeters, compact)
    this.ghostRecT -= dt;
    if (this.ghostRecT <= 0 && !this.dying) {
      this.ghostRecT = 0.1;
      const P = this.player.pos;
      this.ghostRec.push(Math.round(P.x * 10), Math.round(P.y * 10), Math.round(P.z * 10));
    }
    const G = this.ghost, D = this.ghostData;
    if (!G || !D || !G.model.visible) return;
    const s = D.path, n = s.length / 3;
    const f = this.runTime * 10, i = Math.floor(f);
    if (i >= n - 1) {
      if (!this.ghostDone) {
        this.ghostDone = true; G.model.visible = false;
        _p.set(s[(n - 1) * 3] / 10, s[(n - 1) * 3 + 1] / 10 + 1, s[(n - 1) * 3 + 2] / 10);
        this.fx.burst(_p, '#1AE3FF', 30, { speed: 8 });
        this.ui.toast('YOU OUTLIVED YOUR GHOST!', { color: '#1AE3FF', duration: 3 });
        audio.play('newbest', { volume: 0.6 });
      }
      return;
    }
    const u = f - i, a = i * 3, b = a + 3;
    const x = (s[a] + (s[b] - s[a]) * u) / 10, y = (s[a + 1] + (s[b + 1] - s[a + 1]) * u) / 10, z = (s[a + 2] + (s[b + 2] - s[a + 2]) * u) / 10;
    G.vel.set((s[b] - s[a]), (s[b + 1] - s[a + 1]), (s[b + 2] - s[a + 2]));
    G.pos.set(x, y, z);
    G.onGround = y - this.world.heightAt(x, z) < 0.3; G.sliding = false; G.slamming = false; G.dead = false;
    G.animate(dt, this.time, 0);
  }

  interact(dt) {
    const P = this.player.pos, w = this.world;
    let prompt = null;
    for (const c of w.chests) {
      if (c.opened) continue;
      const d = Math.hypot(P.x - c.x, P.z - c.z);
      if (d > 5) continue;
      const cost = this.chestCost();
      if (d < 1.9) {
        if (this.gold >= cost) {
          this.gold -= cost; c.opened = true; this.chestsOpened++;
          this.fx.confetti(_p.set(c.x, c.y + 1.2, c.z), 70);
          this.openChoices('chest');
          return;
        }
        prompt = `CHEST · ${cost} GOLD — need ${cost - Math.floor(this.gold)} more`;
      } else prompt = `CHEST · ${cost} GOLD — walk in to open`;
    }
    for (const s of w.shrines) {
      if (s.used) continue;
      const d = Math.hypot(P.x - s.x, P.z - s.z);
      if (d < 2.8) {
        s.progress += dt / 2.5;
        prompt = `SHRINE · CHANNELING ${Math.floor(s.progress * 100)}%`;
        if (Math.random() < 0.3) this.fx.burst(_p.set(s.x + (Math.random() - 0.5) * 4, s.y + 0.3, s.z + (Math.random() - 0.5) * 4), '#1AE3FF', 1, { speed: 1, up: 6, gravity: -2, life: 1 });
        if (s.progress >= 1) { s.used = true; this.fx.ring(_p.set(s.x, s.y + 0.3, s.z), 8, '#1AE3FF', 0.6, 1); this.openChoices('shrine'); return; }
      } else {
        s.progress = Math.max(0, s.progress - dt * 0.5);
        if (d < 7) prompt = 'SHRINE · stand inside to channel a blessing';
      }
    }
    if (prompt !== this._prompt) { this._prompt = prompt; this.ui.setPrompt(prompt); }
  }

  chestCost() { const n = this.chestsOpened; return 15 + n * 12 + n * n * 3; }

  updateCamera(dt, rdt) {
    const P = this.player, cam = this.camera;
    const speedK = clamp((P.hSpeed - 9) / 30, 0, 1);
    const dist = this.camDist + speedK * 4;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const tx = P.pos.x, ty = P.pos.y + 1.9, tz = P.pos.z;
    let cx = tx - Math.sin(this.yaw) * cp * dist, cy = ty + sp * dist, cz = tz - Math.cos(this.yaw) * cp * dist;
    const gh = this.world.heightAt(cx, cz) + 1.0;
    if (cy < gh) cy = gh;
    this.shakeAmp *= Math.exp(-7 * rdt);
    const sh = this.shakeAmp * 0.6;
    cam.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz + (Math.random() - 0.5) * sh);
    cam.lookAt(tx, ty + 0.4, tz);
    const fov = 68 + clamp((this.momentum - 1) / 3, 0, 1) * 24;
    cam.fov = lerp(cam.fov, fov, 1 - Math.exp(-6 * rdt));
    cam.updateProjectionMatrix();
  }

  updateHUD(rdt) {
    const h = this.hud, E = this.enemies;
    h.hp = Math.max(0, this.hp); h.maxHp = this.stats.maxHp; h.level = this.level; h.xp = this.xp; h.xpNext = this.xpNext;
    h.time = this.runTime; h.score = Math.round(this.score); h.kills = this.kills; h.gold = Math.floor(this.gold);
    h.speed = this.player.hSpeed; h.momentum = this.momentum; h.ram = this.ramming; h.phase = this.phaseText();
    h.fps = this.settings.showFps ? Math.round(this.fps) : null;
    if (h.weapons.length !== this.arsenal.list.length || h.weapons.some((w, i) => w.level !== this.arsenal.list[i].level)) {
      h.weapons = this.arsenal.list.map(w => ({ id: w.id, name: WEAPONS[w.id].name, level: w.level, maxLevel: WEAPONS[w.id].max }));
    }
    if (h.tomes.length !== this.tomes.size || h.tomes.some(t => t.level !== this.tomes.get(t.id))) {
      h.tomes = [...this.tomes].map(([id, level]) => ({ id, name: TOMES[id].name, level, maxLevel: 5 }));
    }
    const b = E.boss;
    if (b && E.state[b.i] === 1) {
      if (!h.boss) h.boss = { name: b.name, hp: 0, maxHp: 1 };
      h.boss.name = b.name; h.boss.hp = Math.max(0, E.hp[b.i]); h.boss.maxHp = E.maxHp[b.i];
    } else h.boss = null;
    this.ui.updateHUD(h);
    // minimap at ~10 Hz
    this.mapTick -= rdt;
    if (this.mapTick <= 0) {
      this.mapTick = 0.1;
      const dots = this.enemyDots; let n = 0;
      for (let k = 0; k < E.activeCount && n < 1200; k++) { const i = E.active[k]; if (E.state[i] !== 1) continue; dots[n * 2] = E.x[i]; dots[n * 2 + 1] = E.z[i]; n++; }
      const P = this.player.pos;
      this.ui.updateMinimap({
        px: P.x, pz: P.z, heading: this.yaw, worldRadius: PLAY_R, enemies: dots, enemyCount: n,
        chests: this.world.chests.map(c => ({ x: c.x, z: c.z, opened: c.opened })),
        shrines: this.world.shrines.map(s => ({ x: s.x, z: s.z, used: s.used })),
        pads: this.world.pads.map(p => ({ x: p.x, z: p.z })),
        boss: b && E.state[b.i] === 1 ? { x: E.x[b.i], z: E.z[b.i] } : null,
      });
    }
  }
}

const _p = new THREE.Vector3();
const _hits = new Int32Array(2048);

function boot() {
  try { new Game(); }
  catch (err) {
    console.error(err);
    const b = document.getElementById('boot');
    if (b) b.textContent = 'This browser could not start WebGL. Try Chrome, Edge, Safari or Firefox on a desktop.';
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
