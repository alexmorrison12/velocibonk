// VELOCISMASH — a 3D survivors-like where SPEED IS DAMAGE.
// Orchestrates rendering, input, the island-hopping run, bosses, quests/unlocks, scoring, and the
// daily/challenge/leaderboard meta.
import * as THREE from 'three';
import { World, PLAY_R } from './world.js';
import { Player } from './player.js';
import { Enemies, T, TDEF } from './enemies.js';
import { Pickups } from './pickups.js';
import { Arsenal, WEAPONS } from './weapons.js';
import { rollChoices, applyTome, applyStat, freshStats, TOMES, BOONS, boonChoices } from './upgrades.js';
import { FX, PostFX } from './fx.js';
import { UI } from './ui.js';
import { Leaderboard } from './leaderboard.js';
import { Hazards } from './hazards.js';
import { audio } from './audio.js';
import { ISLANDS, ISLAND_TIME, weaponCap, tomeCap, islandSeed } from './biomes.js';
import { Progress, CHARACTERS, CHAR_ORDER, QUESTS, PERKS } from './progress.js';
import { resetStage, updateDirector, interact, updateTrial, phaseText, stageTimeLeft, spawnAround } from './stage.js';
import { mulberry32, hashString, clamp, lerp } from './rng.js';

const SHARE_URL = 'https://alexmorrison12.github.io/velocismash/';
const LAUNCH_UTC = Date.UTC(2026, 8, 26);

const store = {
  get(k, d) { try { const v = localStorage.getItem('velocismash.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('velocismash.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

function dailyInfo(n = null) {
  const now = new Date();
  let utc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (n != null) utc = LAUNCH_UTC + (n - 1) * 86400000;
  const d = new Date(utc);
  const label = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const num = Math.max(1, Math.floor((utc - LAUNCH_UTC) / 86400000) + 1);
  const pretty = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { n: num, label, pretty, seed: hashString('velocismash-daily-' + label) };
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
const RANKS = [[0, 'Pebble Pusher'], [50e3, 'Casual Smasher'], [500e3, 'Momentum Enjoyer'], [3e6, 'Speed Demon'], [15e6, 'Island Hopper'], [60e6, 'Sonic Raptor'], [200e6, 'Terminal Velocity'], [600e6, 'VELOCIGOD']];
const rankFor = s => RANKS.reduce((r, [min, name]) => (s >= min ? name : r), RANKS[0][1]);

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
    this.fx = new FX(scene);
    this.world = new World(scene);
    this.world.fx = this.fx;
    this.fx.getGroundY = (x, z) => this.world.heightAt(x, z);
    scene.fog = new THREE.Fog(this.world.fogColor, 80, 460);
    this.hemi = new THREE.HemisphereLight('#D6ECFF', '#8C6A4C', 1.3);
    scene.add(this.hemi);
    const sun = this.sun = new THREE.DirectionalLight('#FFF1D6', 2.35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 1; sc.far = 260;
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
    scene.add(sun); scene.add(sun.target);

    this.post = new PostFX(renderer, scene, this.camera);
    this.post.setSize(innerWidth, innerHeight);
    if (this.post.bloom) { this.post.bloom.threshold = 1.25; this.post.bloom.strength = 0.6; this.post.bloom.radius = 0.45; }
    this.progress = new Progress();
    this.progress.onComplete = (q) => this.onQuestComplete(q);
    this.player = new Player(scene, this.world, this.progress.selectedChar);
    this.enemies = new Enemies(scene, this.world, this);
    this.pickups = new Pickups(scene, this.world, this);
    this.arsenal = new Arsenal(scene, this);
    this.hazards = new Hazards(scene, this);
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
      onSelectCharacter: (id) => this.selectCharacter(id),
      onOpenQuests: () => this.ui.showQuests?.(this.progress.list()),
    });
    this.lb = new Leaderboard(this, { getName: () => store.get('name', ''), setName: (n) => store.set('name', n) });

    this.keys = {}; this.mouseDX = 0; this.mouseDY = 0; this.lastMouseInput = 0;
    this.yaw = 0; this.pitch = 0.38; this.camDist = 8.5; this.shakeAmp = 0;
    this.state = 'title'; this.time = 0; this.timeScale = 1;
    this.fps = 60; this.mapTick = 0;
    this.enemyDots = new Float32Array(2400);
    this.hud = { hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: 10, time: 0, score: 0, kills: 0, gold: 0, speed: 0, momentum: 1, ram: false, phase: '', weapons: [], tomes: [], boss: null, fps: null, island: null, timeLeft: null, swarm: false, trial: null, bossPhase: 1 };
    this.momentum = 1; this.ramming = false; this.bossDmgMult = 1; this.islandN = 1; this.island = ISLANDS[0];
    this._bindInput();
    this.applySettings(this.settings, true);
    addEventListener('resize', () => this.onResize());
    this.toTitle();
    this.prewarm();
    requestAnimationFrame(t => { this.last = t; this.frame(t); });
    setTimeout(() => document.getElementById('boot')?.classList.add('gone'), 250);
    window.__vb = this;
  }

  prewarm() {
    const hidden = [];
    this.scene.traverse(o => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    try { this.renderer.compile(this.scene, this.camera); } catch { /* best effort */ }
    for (const o of hidden) o.visible = false;
  }

  // ---------------------------------------------------------------- settings / input
  applySettings(s) {
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
      if (e.code === 'Space') { this.jumpPressed = true; if (this.state === 'playing') e.preventDefault(); }
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

  // ---------------------------------------------------------------- islands
  applyIsland(I) {
    this.island = I;
    const f = this.scene.fog; f.color.set(I.fog.color); f.near = I.fog.near; f.far = I.fog.far;
    this.hemi.color.set(I.light.sky); this.hemi.groundColor.set(I.light.ground); this.hemi.intensity = I.light.hemi;
    this.sun.color.set(I.light.sun); this.sun.intensity = I.light.sunI;
    this.renderer.toneMappingExposure = I.light.exposure;
    this.post.setGrade?.(I.grade);
    this.fx.setAmbient?.(I.ambient);
    audio.setAmbience?.(I.id);
    this.enemies.setBiome(I.id);
    this.player.friction = I.friction;
  }

  setupIsland(n) {
    const I = ISLANDS[n - 1];
    this.islandN = n;
    this.maxIsland = Math.max(this.maxIsland || 1, n);
    this.world.generate(islandSeed(this.run.seed, n), I, { greed: this.progress.hasShrine('greed') });
    this.applyIsland(I);
    this.enemies.reset(); this.pickups.reset(); this.hazards.clear(); this.fx.clear(); this.arsenal.clearTransient();
    resetStage(this);
    this.player.reset(0, 0);
    this.wcap = weaponCap(n); this.tcap = tomeCap(n);
    this.chestsOpened = Math.floor((this.chestsOpened || 0) / 2);
    this._prompt = undefined; this.ui.setPrompt(null);
    for (let i = 0; i < 14 + n * 4; i++) spawnAround(this, T.blob, 22, 34);
  }

  nextIsland() {
    const n = this.islandN + 1;
    return n <= 5 && n <= this.unlockedAtStart ? ISLANDS[n - 1] : null;
  }

  // ---------------------------------------------------------------- flow
  titleIsland() {
    const n = this.progress.islandsUnlocked();
    const I = ISLANDS[n - 1];
    this.run = { seed: this.challenge ? this.challenge.seed : this.daily.seed };
    this.world.generate(islandSeed(this.run.seed, n), I, { greed: false });
    this.applyIsland(I);
  }

  titleData() {
    const P = this.progress, cleared = P.life.cleared || 0, un = P.islandsUnlocked();
    return {
      dailyNumber: this.challenge?.daily ?? this.daily.n, dateLabel: this.daily.pretty,
      bests: this.bests.slice(0, 5), challenge: this.challenge ? { score: this.challenge.score, daily: this.challenge.daily, name: null } : null,
      settings: this.settings,
      characters: CHAR_ORDER.map(id => { const C = CHARACTERS[id]; return { id, name: C.name, title: C.title, passive: C.passive, start: WEAPONS[C.start[0]]?.name || C.start[0], unlocked: P.hasChar(id), req: P.charReq(id), secret: id === 'goldie' }; }),
      selectedChar: P.selectedChar,
      islands: ISLANDS.map(I => ({ n: I.n, name: I.name, biome: I.id, unlocked: I.n <= un, cleared: cleared >= I.n, best: P.islandBest[I.n] || null })),
      quests: { done: P.done.size, total: QUESTS.length },
    };
  }

  toTitle() {
    this.state = 'title';
    this.unlockPointer();
    this.ui.hideGameOver?.(); this.ui.hidePause?.(); this.ui.hideLevelUp?.(); this.ui.hideIslandIntro?.();
    this.ui.showHUD(false);
    this.enemies.reset(); this.pickups.reset(); this.arsenal.reset(); this.hazards.clear(); this.fx.clear();
    this.post.setSwarm?.(0); this.post.warp?.(0);
    this.player.setVariant(this.progress.selectedChar);
    this.player.model.visible = true; this.player.model.rotation.set(0, 0, 0);
    if (this.ghost) this.ghost.model.visible = false;
    this.titleIsland();
    this.ui.showTitle(this.titleData());
    this.lb.refresh();
    audio.startMusic('title');
  }

  selectCharacter(id) {
    if (!CHARACTERS[id] || !this.progress.hasChar(id)) return;
    this.progress.selectedChar = id; this.progress.save();
    this.player.setVariant(id);
    audio.play('uiclick');
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
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    const P = this.progress;
    P.startRun();
    this.unlockedAtStart = P.islandsUnlocked();
    this.maxIsland = 1; this.islandsCleared = 0;
    // character + perks
    const charId = P.hasChar(P.selectedChar) ? P.selectedChar : 'rex';
    const C = CHARACTERS[charId];
    this.charId = charId;
    this.player.setVariant(charId);
    this.stats = freshStats();
    for (const [k2, v] of Object.entries(C.stats)) this.stats[k2] += v;
    if (P.hasPerk('gold15')) this.stats.gold += 0.15;
    if (P.hasPerk('xp10')) this.stats.wisdom += 0.1;
    this.bossDmgMult = P.hasPerk('bossdmg') ? 1.2 : 1;
    this.reviveLeft = P.hasPerk('revive') ? 1 : 0;
    this.tomes = new Map();
    this.arsenal.reset();
    for (const w of C.start) this.arsenal.add(w);
    this.hp = this.stats.maxHp; this.level = 1; this.xp = 0; this.xpNext = this.xpFor(1);
    this.gold = P.hasPerk('gold20') ? 20 : 0;
    this.kills = 0; this.score = 0; this.runTime = 0; this.levelsPending = 0; this.rerolls = 2 + (P.hasPerk('reroll') ? 1 : 0);
    this.invuln = 0; this.topSpeed = 0; this.maxMomentum = 1; this.bossKills = 0; this.chestsOpened = 0;
    this.dmgTaken = 0; this.numbersThisFrame = 0; this.noHitT = 0;
    this.momentum = 1; this.ramming = false; this.dying = 0; this.timeScale = 1; this.hitStop = 0;
    this.combo = 0; this.comboT = 0; this.nextComboMilestone = 25; this.bestCombo = 0;
    this.damageFlash = 0; this.whiteFlash = 0;
    this.yaw = 0; this.pitch = 0.38;
    this.dmgByWeapon = {};
    this.boons = {}; this.shellT = 0; this.fossilEcho = null;
    this.setupIsland(1);
    this.player.model.visible = true; this.player.model.rotation.set(0, 0, 0);
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
    this.ui.hideTitle(); this.ui.hideGameOver?.(); this.ui.hidePause?.(); this.ui.hideQuests?.(); this.ui.hideLevelUp?.();
    this.ui.showHUD(true);
    this.state = 'playing';
    this.lockPointer();
    audio.startMusic('run', this.island.id); audio.setIntensity(0);
    const rc = this.run.challenge;
    this.ui.announce(rc ? `BEAT ${fmt(rc.score)}` : this.run.daily ? `DAILY #${this.run.daily}` : 'RANDOM RUN',
      { sub: rc ? `${rc.name ? rc.name.toUpperCase() + '’S RUN · ' : ''}${this.run.daily ? 'DAILY #' + this.run.daily : 'RANDOM RUN'}` : `ISLAND 1 · ${this.island.name}`, color: rc ? '#FF3D8B' : '#FFE14D', duration: 2.4 });
    const tips = [['WASD move · MOUSE look · click to lock the cursor', 1.2], ['SPACE jump — hold it to bunny-hop and build speed', 4.2], ['SHIFT slide downhill · SHIFT in the air = SLAM', 7.2], ['×2 MOMENTUM = RAM MODE: plow straight through them', 10.2], ['Crack the METEOR CRATER (on your map) to summon the boss early for bonus score', 14], ['A FOSSIL GATE hides on every island: beat its echo for a Fossil Boon', 19]];
    this._tipTimers?.forEach(clearTimeout);
    this._tipTimers = (this._shownTips ? tips.slice(4) : tips).map(([t, d]) => setTimeout(() => { if (this.state === 'playing' || this.state === 'levelup') this.ui.toast(t, { color: '#1AE3FF', duration: 3.2 }); }, d * 1000));
    this._shownTips = true;
    this.ramAnnounced = false;
  }

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

  xpFor(L) { return Math.floor(6 + L * 4.5 + Math.pow(L, 1.85) * 0.7 + (L > 60 ? 0.02 * Math.pow(L - 60, 3) : 0)); }

  // ---------------------------------------------------------------- level up / chest / shrine
  choiceTitle(source) { return { chest: 'CHEST!', shrine: 'SHRINE BLESSING', amber: 'AMBER MUTATION', boon: 'FOSSIL BOON', trial: 'TRIAL REWARD', boss: 'BOSS LOOT' }[source] || 'LEVEL UP!'; }

  roll(source) {
    const P = this.progress;
    if (source === 'boon') {
      const c = boonChoices(this.rand, this.boons, 3 + (P.hasPerk('boonplus') ? 1 : 0));
      if (c.length) return c;
      source = 'trial'; // every boon owned: epic loot instead
    }
    return rollChoices({
      arsenal: this.arsenal, tomes: this.tomes, stats: this.stats, rand: this.rand, source: source === 'boss' ? 'chest' : source,
      wcap: this.wcap, tcap: this.tcap, unlocked: { weapon: (id) => P.hasWeapon(id), tome: (id) => P.hasTome(id) },
      slots: { weapons: this.boons.pocket ? 6 : 5, tomes: 6 },
    });
  }

  openChoices(source) {
    this.choiceSource = source;
    this.choices = this.roll(source);
    if (source === 'level' && this.choices.every(c => c.kind === 'stat')) {
      // fully maxed build: auto-take a stat boost instead of stopping the carnage
      // (30% strength: level-ups come fast late in a run and full boosts would snowball)
      const c = this.choices[0];
      applyStat(this.stats, c.stat, c.value * 0.3);
      if (c.stat === 'skin') this.hp += c.value * 0.3;
      this.levelsPending--;
      if (!this._maxToastT || this.time - this._maxToastT > 4) { this._maxToastT = this.time; this.ui.toast(`MAXED OUT · level-ups now grant small stat boosts`, { color: '#FFB020', duration: 1.6 }); }
      return;
    }
    this.state = 'levelup';
    this.unlockPointer();
    this.ui.showLevelUp({ title: this.choiceTitle(source), choices: this.choices, rerolls: this.rerolls });
    audio.play(source === 'boon' ? 'legendary' : source === 'chest' || source === 'boss' ? 'chest' : source === 'shrine' ? 'shrine' : source === 'amber' ? 'amber' : 'levelup');
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
    } else if (c.kind === 'stat') {
      applyStat(this.stats, c.stat, c.value);
      if (c.stat === 'skin') this.hp += c.value;
    } else if (c.kind === 'boon') {
      this.boons[c.boon] = true;
      if (c.boon === 'apex') this.bossDmgMult *= 1.3;
      if (c.boon === 'fortune') this.stats.gold += 0.4;
      this.ui.toast(`FOSSIL BOON · ${c.name}`, { color: '#FFD08A', duration: 2.4 });
    }
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
    this.choices = this.roll(this.choiceSource);
    this.ui.showLevelUp({ title: this.choiceTitle(this.choiceSource), choices: this.choices, rerolls: this.rerolls });
    audio.play('reroll');
  }

  // ---------------------------------------------------------------- callbacks from systems
  get greedK() { return this.greedActive ? 1.5 : 1; }
  addXp(v) {
    this.xp += v * this.stats.wisdom * this.greedK;
    while (this.xp >= this.xpNext) { this.xp -= this.xpNext; this.level++; this.xpNext = this.xpFor(this.level); this.levelsPending++; }
    this.progress.max('level', this.level);
  }
  addGold(v) { this.gold += v * this.stats.gold * this.greedK; }
  heal(v) {
    const before = this.hp; this.hp = Math.min(this.stats.maxHp, this.hp + v);
    if (this.hp > before) { this.fx.damageNumber(this.player.pos.clone().setY(this.player.pos.y + 2), this.hp - before, { color: '#8CFF5A' }); audio.play('heal', { volume: 0.5 }); }
  }
  shake(a) { this.shakeAmp = Math.min(1.4, this.shakeAmp + a); }
  slowPlayer(t) { this.player.slowT = Math.max(this.player.slowT, t); }
  get islandNum() { return this.islandN; }

  onDamage(i, amount, crit, source, dealt) {
    this.dmgByWeapon[source] = (this.dmgByWeapon[source] || 0) + dealt;
    this.progress.add('damage', dealt);
    const E = this.enemies;
    if (this.numbersThisFrame < 14 || crit) {
      this.numbersThisFrame++;
      _p.set(E.x[i] + (Math.random() - 0.5) * 0.6, E.y[i] + E.yo[i] + TDEF[E.type[i]].height * E.scale[i] + 0.3, E.z[i]);
      const big = this.momentum >= 3;
      this.fx.damageNumber(_p, amount, { crit, color: crit ? '#FFD23F' : big ? '#FF9E2C' : '#FFFFFF', scale: big ? 1.25 : 1 });
    }
    if (source !== 'hotfeet' && source !== 'aura' && source !== 'blackhole') audio.play(crit ? 'crit' : 'hit', { volume: 0.35, pitch: 0.9 + Math.random() * 0.25 });
  }

  countKill(pts) {
    this.kills++;
    this.progress.add('kills');
    this.combo = (this.comboT > 0 ? this.combo : 0) + 1; this.comboT = 1.6;
    this.progress.max('combo', this.combo);
    if (this.combo >= this.nextComboMilestone) {
      const m = this.nextComboMilestone;
      this.nextComboMilestone = m < 100 ? m + 25 : m < 500 ? m + 100 : m + 250;
      this.score += Math.min(m, 1000) * 20 * this.momentum;
      this.fx.popText(_p.copy(this.player.pos).setY(this.player.pos.y + 3.4), `${m} SMASH COMBO!`, m >= 250 ? '#FF3D8B' : '#FFE14D', m >= 100 ? 1.9 : 1.5);
      if (m >= 100) audio.play('newbest', { volume: 0.4 });
    }
    this.score += pts * this.momentum;
    if (this.trial) this.trial.kills++;
    if (this.boons.leech && this.hp < this.stats.maxHp) this.hp = Math.min(this.stats.maxHp, this.hp + 0.35);
  }

  onKill(i, ti, x, y, z, elite, boss) {
    const def = TDEF[ti];
    this.countKill(def.pts * (elite ? 10 : 1));
    const k = this.islandN - 1;
    const xpv = def.xp * (elite ? 12 : 1) * (1 + Math.min(this.islandTime / 60, 4) * 0.08) * (1 + k * 0.35);
    if (boss) {
      const drops = boss.isFinal ? 60 : 30;
      for (let q = 0; q < drops; q++) this.pickups.gem(x, y + 1, z, xpv / drops);
      for (let q = 0; q < (boss.isFinal ? 70 : 40); q++) this.pickups.coin(x, y + 1, z, 1, 10);
      this.pickups.heart(x, y + 1, z);
      this.onBossDead(boss, x, y, z);
    } else if (def.xp > 0) {
      this.pickups.gem(x, y + 0.5, z, xpv);
      if (this.rand() < def.gold * (1 + this.stats.luck)) this.pickups.coin(x, y + 0.5, z, 1);
      if (elite) { for (let q = 0; q < 14; q++) this.pickups.coin(x, y + 0.5, z, 1, 6); if (this.rand() < 0.5) this.pickups.heart(x, y + 0.5, z); }
      else if (this.rand() < 0.014) this.pickups.heart(x, y + 0.5, z);
    }
    if (Math.random() < 0.35) audio.play('kill', { volume: 0.3, pitch: 0.85 + Math.random() * 0.4 });
  }

  purgeKill(i) {
    const E = this.enemies, def = TDEF[E.type[i]];
    this.countKill(def.pts * 0.5);
    if (Math.random() < 0.08 && def.xp > 0) this.pickups.gem(E.x[i], E.y[i] + 0.5, E.z[i], def.xp * 3);
  }

  onCorpsePop(i, ti, x, y, z) {
    _p.set(x, y, z);
    const big = TDEF[ti].boss;
    this.fx.burst(_p, TDEF[ti].color, big ? 70 : ti === T.brute ? 16 : 7, { speed: big ? 16 : 7, size: big ? 0.5 : 0.2, life: 0.55 });
    if (big) this.fx.shatter?.(_p, TDEF[ti].color);
  }

  onRam(i, dx, dz) {
    const dmg = 20 * this.stats.might * this.momentum * (1 + this.stats.momentum * 0.25);
    const crit = Math.random() < this.stats.crit;
    this.enemies.damage(i, dmg * (crit ? 2 : 1), crit, dx, dz, 22 + this.momentum * 7, 'ram');
    this.progress.add('rams');
    if (Math.random() < 0.45) audio.play('ram', { volume: 0.5, pitch: 0.9 + Math.random() * 0.3 });
    if (Math.random() < 0.08) this.fx.popText(this.player.pos.clone().setY(this.player.pos.y + 2.6), 'RAM!', '#FF3D8B', 1.3);
    this.shake(0.05);
    const v = this.player.vel; v.x *= 0.992; v.z *= 0.992;
  }

  hurtPlayer(dmg, fx, fz, shock) {
    if (this.invuln > 0 || this.state !== 'playing' || this.dying || this.cleared) return;
    if (this.boons.shell && this.shellT <= 0) {
      // Amber Shell soaks the hit
      this.shellT = 10; this.invuln = 0.6;
      this.fx.ring(_p.copy(this.player.pos).setY(this.player.pos.y + 1), 2.6, '#FFB020', 0.4, 0.8);
      this.fx.shatter?.(_p.copy(this.player.pos).setY(this.player.pos.y + 1.2), '#FFC45A');
      audio.play('shatter', { volume: 0.6 });
      return;
    }
    // no single hit can take more than 45% of max HP: bosses are scary, never unfair
    const d = Math.min(dmg * (1 - this.stats.armor), this.stats.maxHp * 0.45);
    this.hp -= d; this.dmgTaken += d;
    this.progress.add('taken', d);
    this.noHitT = 0;
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
    if (this.reviveLeft > 0) {
      this.reviveLeft--;
      this.hp = this.stats.maxHp * 0.5; this.invuln = 3;
      const P = this.player.pos, E = this.enemies;
      const n = E.query(P.x, P.z, 14, _hits, 800);
      for (let q = 0; q < n; q++) { const i = _hits[q], dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4; E.damage(i, 1e9 * (E.bossAt(i) ? 0 : 1), false, dx / d, dz / d, 40, 'revive'); }
      this.fx.ring(_p.copy(P).setY(P.y + 0.5), 16, '#8CFF5A', 0.6, 1.5);
      this.fx.pillar?.(_p.copy(P), '#8CFF5A', 1, 3);
      this.whiteFlash = 0.8;
      this.ui.announce('SECOND WIND!', { sub: 'back at 50% HP', color: '#8CFF5A', duration: 1.8 });
      audio.play('heal'); audio.play('unlock', { volume: 0.6 });
      return;
    }
    this.hp = 0; this.dying = 2.2; this.timeScale = 0.3;
    this.player.dead = true;
    audio.play('death'); audio.stopMusic();
    this.ui.announce('SMASHED.', { color: '#FF3D8B', duration: 2 });
    this.player.vel.set(0, 18, 0); this.player.onGround = false;
  }

  // ---------------------------------------------------------------- bosses
  onBossSpawn(b, final) {
    this._prompt = null; this.ui.setPrompt(null);
    audio.play(b.id === 'dragon' ? 'dragonroar' : 'bossroar');
    this.shake(0.8);
    this.ui.bossIntro?.({ name: b.name, title: b.title, tag: final ? 'FINAL BOSS' : b.isFossil ? 'FOSSIL ECHO' : 'MINI-BOSS' });
    if (final) {
      audio.play('bossintro');
      audio.startMusic('boss', this.island.id);
      // cinematic: freeze the action and frame the boss for a beat
      this.introBoss = b; this.introT = 2.4; this.state = 'intro';
    } else audio.startMusic('boss', this.island.id);
  }

  onBossPhase(b) {
    this.ui.announce(`${b.name} ENRAGED!`, { sub: 'phase two', color: '#FF3D8B', duration: 2 });
    audio.play('phase2');
    this.whiteFlash = 0.5; this.shake(0.9);
    this.fx.ring(_p.set(b.x, b.gy + 1, b.z), 18, '#FF3D3D', 0.6, 2);
  }

  onBossDead(b, x, y, z) {
    this.bossKills++;
    if (b.id === 'chonk') this.progress.add('chonks');
    const bonus = (b.isFinal ? 20000 : b.isFossil ? 10000 : 5000) * this.islandN * this.momentum;
    this.score += bonus;
    this.whiteFlash = 1; this.hitStop = 0.5;
    this.shake(1.2);
    _p.set(x, y + 2, z);
    this.fx.confetti(_p, 160);
    this.fx.ring(_p, 30, '#FFE14D', 0.8, 2);
    audio.play('explosion', { volume: 1, pitch: 0.6 });
    if (b.isFinal) { this.islandCleared(x, z); return; }
    if (b.isFossil) { this.fossilEchoDefeated(b, x, z); return; }
    this.rerolls++;
    this.fx.popText(_p.clone().setY(y + 7), 'BOSS SMASHED!', '#FFE14D', 3);
    audio.play('newbest', { volume: 0.8 });
    this.ui.announce('BOSS SMASHED!', { sub: `+${fmt(bonus)} · +1 reroll · boss loot`, color: '#FFE14D' });
    audio.startMusic(this.swarm ? 'final' : 'run', this.island.id);
    setTimeout(() => { if (this.state === 'playing') this.openChoices('boss'); }, 900);
  }

  islandCleared(x, z) {
    this.cleared = true; this.islandsCleared++;
    const left = stageTimeLeft(this);
    const clearBonus = 25000 * this.islandN * (1 + left / 120);
    this.score += clearBonus;
    this.swarm = false; this.post.setSwarm?.(0);
    this.hazards.clear();
    const purged = this.enemies.purge();
    this.progress.clearIsland(this.islandN);
    if (left >= 180) this.progress.max('fastBoss', 1);
    if (this.greedActive) this.progress.max('greedClear', 1);
    const best = this.progress.islandBest;
    best[this.islandN] = Math.max(best[this.islandN] || 0, Math.round(this.score));
    this.progress.save();
    // any other boss still around (mini-boss, Fossil Echo) crumbles
    for (const ob of [...this.enemies.bosses]) if (ob.alive) this.enemies.dismiss(ob.i);
    if (this.world.fossilGate && this.world.fossilGate.state === 'active') this.world.fossilGate.state = 'used';
    { // the cannon rises a few steps away from the player, never under their feet
      const P = this.player.pos; let dx = x - P.x, dz = z - P.z; const dl = Math.hypot(dx, dz);
      if (dl < 0.5) { dx = -P.x; dz = -P.z; } const k = 9 / (Math.hypot(dx, dz) || 1);
      this.world.spawnCannon(x + (dl < 9 ? dx * k : 0), z + (dl < 9 ? dz * k : 0));
    }
    audio.play('victory'); audio.play('portalopen', { volume: 0.7 });
    audio.startMusic('victory', this.island.id);
    this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.maxHp * 0.3);
    this.ui.announce('ISLAND CLEARED!', { sub: `+${fmt(clearBonus)}${left > 0 ? ` (${fmtTime(left)} early)` : ''} · ${purged} enemies vaporized · the LAUNCH CANNON is up`, color: '#FFE14D', duration: 3.5 });
    this.fx.popText(_p.copy(this.player.pos).setY(this.player.pos.y + 4), 'ISLAND CLEARED!', '#FFE14D', 3.2);
  }

  fossilEchoDefeated(b, x, z) {
    const gate = this.world.fossilGate;
    if (gate) gate.state = 'used';
    this.fossilEcho = null;
    this.progress.add('fossils');
    // two free chests burst out where the echo fell
    for (let k = 0; k < 2; k++) {
      const a = Math.random() * Math.PI * 2, cx = x + Math.cos(a) * (3 + k * 2), cz = z + Math.sin(a) * (3 + k * 2);
      if (this.world.heightAt(cx, cz) > 0.4) this.world.spawnFreeChest(cx, cz); else this.world.spawnFreeChest(x, z);
    }
    this.fx.popText(_p.set(x, this.world.heightAt(x, z) + 7, z), 'FOSSIL SHATTERED!', '#FFD08A', 3);
    audio.play('newbest', { volume: 0.8 });
    this.ui.announce('FOSSIL SHATTERED!', { sub: 'choose a Fossil Boon · 2 free chests dropped', color: '#FFD08A', duration: 2.6 });
    audio.startMusic(this.swarm ? 'final' : 'run', this.island.id);
    setTimeout(() => { if (this.state === 'playing') this.openChoices('boon'); }, 900);
  }

  // stand on the launch cannon's pad: you get loaded and fired off the island
  fireCannon() {
    const c = this.world.cannon; if (!c || c.fired) return;
    c.fired = true; c.recoil = 1;
    this.world.cannonMuzzle(this.launchPos = new THREE.Vector3(), this.launchDir = new THREE.Vector3());
    this.launchT = 0; this.state = 'launch';
    this.player.pos.copy(this.launchPos);
    this.fx.burst(_p.copy(this.launchPos), '#FFE14D', 40, { speed: 14, size: 0.35, glow: 2 });
    this.fx.burst(_p.copy(this.launchPos), '#9A9AA8', 30, { speed: 9, size: 0.5 });
    this.fx.confetti?.(_p.copy(this.launchPos), 60);
    this.fx.ring(_p.copy(this.launchPos), 8, '#FFFFFF', 0.4, 1);
    this.shake(1.2); this.whiteFlash = 0.35;
    audio.play('explosion', { volume: 1, pitch: 0.7 }); audio.play('boost', { volume: 0.9 }); audio.play('warp', { volume: 0.7 });
    this.ui.setPrompt(null); this._prompt = null;
  }

  updateLaunch(rdt) {
    this.launchT += rdt;
    const t = this.launchT, P = this.player, d = this.launchDir;
    // a huge floaty arc out over the sea
    const sp = 55;
    P.pos.set(this.launchPos.x + d.x * sp * t, this.launchPos.y + d.y * sp * t - 6 * t * t, this.launchPos.z + d.z * sp * t);
    P.vel.set(d.x * sp, d.y * sp - 12 * t, d.z * sp);
    P.onGround = false; P.animate(rdt, this.time, 0);
    P.model.rotation.x += rdt * 9;
    this.momentum = 8; this.fx.trail(_p.copy(P.pos), 1);
    const cam = this.camera;
    cam.position.set(P.pos.x - d.x * 14, P.pos.y + 4 - t * 2, P.pos.z - d.z * 14);
    cam.lookAt(P.pos.x, P.pos.y, P.pos.z);
    cam.fov = lerp(cam.fov, 100, 0.08); cam.updateProjectionMatrix();
    if (t > 1.2) {
      P.model.rotation.set(0, 0, 0);
      if (this.nextIsland()) { this.state = 'warp'; this.warpT = 0; this.warpSwapped = false; }
      else { this.victory = true; this.gameOver(true); }
    }
  }

  // ---------------------------------------------------------------- quests
  onQuestComplete(q) {
    const r = q.reward;
    this.ui.questComplete?.({ name: q.name, reward: r, bonus: q.bonus || null });
    audio.play(r.kind === 'character' || r.kind === 'island' ? 'unlock' : 'quest');
    if (!this.ui.questComplete) this.ui.toast(`QUEST · ${q.name} → ${r.name}`, { color: '#FFE14D', duration: 3 });
  }

  // ---------------------------------------------------------------- game over / victory
  gameOver(victory = false) {
    this.state = 'gameover';
    this.timeScale = 1;
    this.unlockPointer();
    this.ui.showHUD(false);
    this.post.setSwarm?.(0);
    const score = Math.round(this.score);
    const prevBest = this.bests[0]?.score || 0;
    const entry = { score, time: Math.round(this.runTime), kills: this.kills, daily: this.run.daily, date: new Date().toISOString().slice(0, 10), island: this.maxIsland };
    this.bests.push(entry); this.bests.sort((a, b) => b.score - a.score); this.bests = this.bests.slice(0, 10);
    store.set('bests', this.bests);
    const isBest = score > prevBest;
    const oldGhost = store.get('ghost.' + this.run.tag, null);
    if (!oldGhost || score > oldGhost.score) {
      store.set('ghost.' + this.run.tag, { score, path: this.ghostRec });
      const tags = store.get('ghostTags', []).filter(t => t !== this.run.tag); tags.unshift(this.run.tag);
      for (const old of tags.slice(6)) { try { localStorage.removeItem('velocismash.ghost.' + old); } catch { /* ignore */ } }
      store.set('ghostTags', tags.slice(0, 6));
    }
    if (this.ghost) this.ghost.model.visible = false;
    const ch = this.run.challenge;
    const challenge = ch ? { target: ch.score, won: score > ch.score, diff: score - ch.score } : null;
    this.lb.prepareSubmit({ score, time: this.runTime, kills: this.kills, level: this.level, topSpeed: this.topSpeed, maxMomentum: this.maxMomentum, tag: this.run.tag, island: this.maxIsland });
    const link = `${SHARE_URL}#vs-${this.run.tag}-${score}`;
    const trueEnd = victory && this.islandN === 5;
    const shareText = [
      `VELOCISMASH 🦖 ${this.run.daily ? `Daily #${this.run.daily}` : 'Random Run'} · ${trueEnd ? 'ARCHIPELAGO CONQUERED 👑' : `Island ${this.maxIsland}/5`}`,
      `💥 ${fmt(score)} pts · ⏱ ${fmtTime(this.runTime)} · ☠ ${fmt(this.kills)} smashes`,
      `🏎 ${Math.round(this.topSpeed * 3.6)} km/h top speed · ×${this.maxMomentum.toFixed(1)} momentum`,
      `Beat it: ${link}`,
    ].join('\n');
    const names = { ...Object.fromEntries(Object.entries(WEAPONS).map(([k, v]) => [k, v.name])), ram: 'Ramming', slam: 'Slam', revive: 'Second Wind' };
    const iconFor = { ram: 'ram', slam: 'quake', revive: 'heal' };
    const damageByWeapon = Object.entries(this.dmgByWeapon).map(([id, dmg]) => ({ id: iconFor[id] || id, name: names[id] || id, dmg: Math.round(dmg) })).sort((a, b) => b.dmg - a.dmg);
    const unlocks = this.progress.newThisRun.flatMap(q => [q.reward, q.bonus].filter(Boolean));
    this.ui.showGameOver({
      score, time: this.runTime, kills: this.kills, level: this.level, topSpeed: this.topSpeed, maxMomentum: this.maxMomentum,
      bossKills: this.bossKills, damageByWeapon, isBest, rank: rankFor(score), bests: this.bests.slice(0, 5), daily: this.run.daily, challenge, shareText,
      victory, headline: trueEnd ? 'VELOCISMASH CONQUERED!' : victory ? 'ISLAND CLEARED!' : undefined,
      islandsCleared: this.islandsCleared, islandReached: this.maxIsland, unlocks, questsDone: this.progress.newThisRun.map(q => q.name),
    });
    if (trueEnd) audio.play('truevictory'); else if (victory) audio.play('victory'); else if (isBest) audio.play('newbest');
    audio.startMusic(victory ? 'victory' : 'title', this.island.id);
  }

  // ---------------------------------------------------------------- player events
  hookPlayerEvents() {
    const P = this.player, fx = this.fx;
    P.events = {
      jump: () => audio.play('jump', { volume: 0.45 }),
      doublejump: () => { audio.play('doublejump', { volume: 0.45 }); fx.ring(_p.copy(P.pos).setY(P.pos.y + 0.2), 1.6, '#FFFFFF', 0.25, 0.25); },
      bhop: (chain) => { this.progress.max('bhop', chain); if (chain === 5 || chain === 10 || chain === 25 || (chain % 50 === 0)) fx.popText(_p.copy(P.pos).setY(P.pos.y + 2.8), `BHOP ×${chain}`, '#1AE3FF', 0.9); },
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
    // tuned down: slams are crowd control, not a boss killer (bosses also take only 30%)
    const dmg = 12 * (1 + Math.min(fall, 60) / 45) * this.stats.might * Math.min(this.momentum, 2.5);
    this.fx.ring(_p.copy(P).setY(P.y + 0.3), r, '#FFFFFF', 0.35, 0.7);
    this.fx.burst(_p.copy(P).setY(P.y + 0.3), '#d8c29a', 18, { speed: 9, up: 6, size: 0.25 });
    this.shake(0.35 + fall / 120);
    audio.play('smash', { volume: 0.9, pitch: 0.7 });
    const n = E.query(P.x, P.z, r, _hits, 600);
    for (let k = 0; k < n; k++) {
      const i = _hits[k], dx = E.x[i] - P.x, dz = E.z[i] - P.z, d = Math.hypot(dx, dz) + 1e-4;
      const crit = Math.random() < this.stats.crit;
      E.damage(i, dmg * (crit ? 2 : 1), crit, dx / d, dz / d, 26, 'slam');
    }
    this.progress.max('slamHits', n);
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
        if (this.dying <= 0) this.gameOver(false);
      }
      if (this.state === 'playing') this.update(dt, rdt);
    } else if (this.state === 'title') {
      this.updateTitle(rdt);
    } else if (this.state === 'intro') {
      this.updateIntro(rdt);
    } else if (this.state === 'warp') {
      this.updateWarp(rdt);
    } else if (this.state === 'launch') {
      this.updateLaunch(rdt);
    }

    const P = this.player.pos;
    this.world.update(rdt, this.time, P);
    const frozen = this.state === 'levelup' || this.state === 'paused';
    this.fx.update(frozen ? 0 : dt, this.time, this.camera);
    if (this.state !== 'title') this.enemies.render(this.time);
    this.sun.position.set(P.x + this.world.sunDir.x * 90, P.y + this.world.sunDir.y * 90, P.z + this.world.sunDir.z * 90);
    this.sun.target.position.copy(P);
    const speed01 = this.state === 'playing' ? clamp((this.momentum - 1.25) / 2.6, 0, 1) : 0;
    audio.setSpeed(this.state === 'playing' ? speed01 : 0);
    this.damageFlash = Math.max(0, this.damageFlash - rdt * 2.5);
    this.whiteFlash = Math.max(0, (this.whiteFlash || 0) - rdt * 1.8);
    const lowHp = this.state === 'playing' && this.stats ? clamp(1 - this.hp / this.stats.maxHp / 0.3, 0, 1) : 0;
    this.post.render(rdt, { speed01, damage: this.damageFlash, lowHp, time: this.time, flash: this.whiteFlash });
    if (this.state === 'playing' || this.state === 'levelup' || this.state === 'paused' || this.state === 'intro') this.updateHUD(rdt);
  }

  updateTitle(dt) {
    const P = this.player;
    const a = this.time * 0.55, R = 10;
    P.pos.set(Math.cos(a) * R, 0, Math.sin(a) * R); P.pos.y = this.world.heightAt(P.pos.x, P.pos.z);
    P.vel.set(-Math.sin(a) * 13, 0, Math.cos(a) * 13);
    P.onGround = true; P.sliding = false; P.dead = false;
    P.animate(dt, this.time, 0);
    if (((this.time * 0.7) % 1) < dt * 0.7) P.swing();
    const ox = Math.cos(a), oz = Math.sin(a), tx = -Math.sin(a), tz = Math.cos(a);
    const cam = this.camera;
    const cx = P.pos.x - ox * 6.5 + tx * 4.5, cz = P.pos.z - oz * 6.5 + tz * 4.5;
    cam.position.set(cx, P.pos.y + 1.9, cz);
    let dx = P.pos.x - cx, dz = P.pos.z - cz; const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
    cam.lookAt(P.pos.x + dz * 2.6, P.pos.y + 2.0, P.pos.z - dx * 2.6);
    cam.fov = 58; cam.updateProjectionMatrix();
  }

  // boss intro: a short cinematic framing the boss
  updateIntro(rdt) {
    const b = this.introBoss;
    this.introT -= rdt;
    if (!b || !b.alive || this.introT <= 0) { this.state = 'playing'; this.introBoss = null; return; }
    const E = this.enemies, i = b.i, P = this.player.pos;
    const bx = E.x[i], bz = E.z[i], by = E.y[i] + E.yo[i];
    const h = TDEF[E.type[i]].height * E.scale[i];
    let dx = P.x - bx, dz = P.z - bz; const d = Math.hypot(dx, dz) + 1e-4; dx /= d; dz /= d;
    const k = 1 - this.introT / 2.4;
    const dist = h * 1.6 + 6 - k * 2.5;
    const side = 0.35;
    this.camera.position.set(bx + (dx * Math.cos(side) - dz * Math.sin(side)) * dist, by + h * 0.55 + 1.5, bz + (dz * Math.cos(side) + dx * Math.sin(side)) * dist);
    this.camera.lookAt(bx, by + h * 0.6, bz);
    this.camera.fov = lerp(this.camera.fov, 50, 0.1); this.camera.updateProjectionMatrix();
    E.ph[i] += rdt * 3;
    b.squash = Math.sin(this.introT * 8) * 0.05;
  }

  // portal travel between islands
  updateWarp(rdt) {
    this.warpT += rdt;
    const t = this.warpT;
    const x = t < 1.2 ? t / 1.2 : t < 1.45 ? 1 : Math.max(0, 1 - (t - 1.45) / 1.1);
    this.post.warp?.(x);
    this.whiteFlash = t > 1.0 && t < 1.6 ? 1 : this.whiteFlash;
    this.camera.fov = lerp(this.camera.fov, 60 + x * 50, 0.2); this.camera.updateProjectionMatrix();
    if (!this.warpSwapped && t >= 1.25) {
      this.warpSwapped = true;
      const n = this.islandN + 1;
      this.setupIsland(n);
      const I = this.island;
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.maxHp * 0.5);
      if (this.ghost) this.ghost.model.visible = false;
      this.ui.showIslandIntro?.({ n, name: I.name, biome: I.id, subtitle: I.subtitle, caps: `WEAPONS LV ${this.wcap} · CHARMS LV ${this.tcap}` });
      audio.startMusic('run', I.id);
      this.updateCamera(0.016, 0.016);
    }
    if (t >= 2.6) {
      this.post.warp?.(0);
      this.state = 'playing';
      this.lockPointer();
      this.ui.announce(`ISLAND ${this.islandN} · ${this.island.name}`, { sub: `level caps raised: weapons ${this.wcap} · charms ${this.tcap}`, color: '#FFE14D', duration: 2.6 });
      setTimeout(() => this.ui.hideIslandIntro?.(), 900);
    }
  }

  update(dt, rdt) {
    const P = this.player, k = this.keys, s = this.settings;
    this.runTime += dt;
    const sens = 0.0023 * s.sensitivity;
    this.yaw -= this.mouseDX * sens;
    this.pitch = clamp(this.pitch + this.mouseDY * sens * (s.invertY ? -1 : 1), -0.25, 1.2);
    this.mouseDX = this.mouseDY = 0;
    if (k.ArrowLeft || k.KeyQ) { this.yaw += rdt * 2.4; this.lastMouseInput = this.time; }
    if (k.ArrowRight || k.KeyE) { this.yaw -= rdt * 2.4; this.lastMouseInput = this.time; }
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
    // liquids: lava burns and bounces, swamp drags, frozen lakes are slick
    const liq = this.world.liquidAt(P.pos.x, P.pos.z);
    const onLiquid = liq && P.pos.y - this.world.heightAt(P.pos.x, P.pos.z) < 0.25;
    P.swampK = onLiquid && liq === 4 ? 0.72 : 1;
    P.friction = onLiquid && liq === 2 ? 0.12 : this.island.friction;
    if (onLiquid && liq === 3 && !this.dying) {
      this.lavaT -= dt;
      if (this.lavaT <= 0) {
        this.lavaT = 0.4;
        P.vel.y = 15; P.onGround = false;
        this.hurtPlayer(10 * (1 + (this.islandN - 1) * 0.3), P.pos.x, P.pos.z);
        this.fx.burst(_p.copy(P.pos).setY(P.pos.y + 0.3), '#FF7A1A', 16, { speed: 8, up: 8, glow: 2 });
        audio.play('lava', { volume: 0.6 });
      }
    }
    const steps = P.hSpeed > 30 ? 3 : 2;
    for (let i = 0; i < steps; i++) P.update(dt / steps, i === 0 ? input : { ...input, jumpPressed: false, slidePressed: false }, this.yaw, this.stats);
    P.animate(dt, this.time, this.yaw);

    const eff = Math.hypot(P.hSpeed, Math.max(0, -P.vel.y) * 0.25);
    const target = Math.min(8, 1 + this.stats.momentum * Math.max(0, eff - 8) / 10);
    this.momentum = target > this.momentum ? lerp(this.momentum, target, 1 - Math.exp(-10 * dt)) : lerp(this.momentum, target, 1 - Math.exp(-(this.boons.rush ? 0.95 : 2.4) * dt));
    this.ramming = this.momentum >= 2 && !P.dead;
    if (this.ramming && !this.ramAnnounced) {
      this.ramAnnounced = true;
      this.ui.announce('RAM MODE!', { sub: 'you are the weapon now', color: '#FF3D8B', duration: 1.6 });
      audio.play('boost', { volume: 0.6, pitch: 0.8 });
    }
    if (P.hSpeed > this.topSpeed) { this.topSpeed = P.hSpeed; this.progress.max('kmh', this.topSpeed * 3.6); }
    if (P.airTime > 0) this.progress.max('air', P.airTime);
    this.maxMomentum = Math.max(this.maxMomentum, this.momentum);
    this.fx.trail(_p.copy(P.pos).setY(P.pos.y + 0.8), clamp((this.momentum - 1.3) / 2.5, 0, 1));
    if (this.islandN === 1) this.updateGhost(dt);

    if (!this.dying) {
      this.invuln -= dt;
      if (this.boons.shell && this.shellT > 0) { this.shellT -= dt; if (this.shellT <= 0) this.fx.ring(_p.copy(P.pos).setY(P.pos.y + 1), 1.8, '#FFB020', 0.3, 0.4); }
      if (this.runTime > 60) { this.noHitT += dt; this.progress.max('nohit', this.noHitT); }
      this.comboT -= dt; if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      if (this.comboT <= 0 && this.combo) { this.combo = 0; this.nextComboMilestone = 25; }
      this.hp = Math.min(this.stats.maxHp, this.hp + this.stats.regen * dt);
      if (this.hp < this.stats.maxHp * 0.3) { this.beatT = (this.beatT || 0) - dt; if (this.beatT <= 0) { this.beatT = 0.9; audio.play('heartbeat'); } }
      updateDirector(this, dt);
      this.enemies.update(dt, this.time);
      this.hazards.update(dt);
      this.arsenal.update(dt, this.time);
      this.pickups.update(dt, this.time);
      updateTrial(this, dt);
      if (this.state === 'playing') interact(this, dt);
      if (!this.cleared) this.score += dt * 5 * (1 + this.islandTime / 60) * this.islandN;
      const rc = this.run.challenge;
      if (rc && !this.run.challengeBeaten && this.score > rc.score) {
        this.run.challengeBeaten = true;
        this.ui.announce('CHALLENGE BEATEN!', { sub: `you passed ${rc.name ? rc.name.toUpperCase() : 'the target'}: ${fmt(rc.score)}`, color: '#8CFF5A', duration: 2.4 });
        audio.play('newbest', { volume: 0.8 });
      }
      audio.setIntensity(clamp(this.enemies.aliveCount / 700 + this.islandTime / 900, 0, 1));
      if (this.levelsPending > 0 && this.state === 'playing') this.openChoices('level');
    } else {
      this.enemies.update(dt * 0.5, this.time);
    }
    this.updateCamera(dt, rdt);
  }

  updateGhost(dt) {
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

  chestCost() { const n = this.chestsOpened; return Math.round((15 + n * 12 + n * n * 3) * (this.boons?.fortune ? 0.7 : 1)); }

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
    h.speed = this.player.hSpeed; h.momentum = this.momentum; h.ram = this.ramming; h.phase = phaseText(this);
    h.fps = this.settings.showFps ? Math.round(this.fps) : null;
    h.timeLeft = stageTimeLeft(this);
    if (!h.island || h.island.n !== this.islandN) h.island = { n: this.islandN, name: this.island.name, biome: this.island.id };
    h.swarm = !!this.swarm;
    const tr = this.trial;
    if (tr) { if (!h.trial) h.trial = {}; h.trial.label = tr.label; h.trial.progress = tr.kills; h.trial.goal = tr.goal; h.trial.timeLeft = Math.max(0, tr.time); } else h.trial = null;
    if (h.weapons.length !== this.arsenal.list.length || h.weapons.some((w, i) => w.level !== this.arsenal.list[i].level || w.maxLevel !== this.wcap)) {
      h.weapons = this.arsenal.list.map(w => ({ id: w.id, name: WEAPONS[w.id].name, level: w.level, maxLevel: this.wcap }));
    }
    if (h.tomes.length !== this.tomes.size || h.tomes.some(t => t.level !== this.tomes.get(t.id) || t.maxLevel !== this.tcap)) {
      h.tomes = [...this.tomes].map(([id, level]) => ({ id, name: TOMES[id].name, level, maxLevel: this.tcap }));
    }
    const b = E.primaryBoss();
    if (b) {
      if (!h.boss) h.boss = { name: b.name, hp: 0, maxHp: 1 };
      h.boss.name = b.name; h.boss.hp = Math.max(0, E.hp[b.i]); h.boss.maxHp = E.maxHp[b.i];
      h.bossPhase = b.phase;
    } else { h.boss = null; h.bossPhase = 1; }
    this.ui.updateHUD(h);
    this.mapTick -= rdt;
    if (this.mapTick <= 0) {
      this.mapTick = 0.1;
      const dots = this.enemyDots; let n = 0;
      for (let q = 0; q < E.activeCount && n < 1200; q++) { const i = E.active[q]; if (E.state[i] !== 1) continue; dots[n * 2] = E.x[i]; dots[n * 2 + 1] = E.z[i]; n++; }
      const P = this.player.pos, w = this.world;
      const portals = [];
      if (w.meteor && !this.cleared && !this.finalSpawned) portals.push({ x: w.meteor.x, z: w.meteor.z, kind: 'meteor', active: true });
      if (w.fossilGate && !this.cleared) portals.push({ x: w.fossilGate.x, z: w.fossilGate.z, kind: 'fossil', active: w.fossilGate.state !== 'used' });
      if (w.cannon) portals.push({ x: w.cannon.x, z: w.cannon.z, kind: 'cannon', active: true });
      this.ui.updateMinimap({
        px: P.x, pz: P.z, heading: this.yaw, worldRadius: PLAY_R, enemies: dots, enemyCount: n,
        chests: w.chests.map(c => ({ x: c.x, z: c.z, opened: c.opened })),
        shrines: w.shrines.map(s => ({ x: s.x, z: s.z, used: s.used, kind: s.kind })),
        pads: w.pads.map(p => ({ x: p.x, z: p.z })),
        boss: b && E.state[b.i] === 1 ? { x: E.x[b.i], z: E.z[b.i] } : null,
        portals, biome: this.island.id,
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
