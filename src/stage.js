// One island of a run: the countdown, spawn director, mini-bosses, the boss portal, the final boss,
// the EXTINCTION wave, and every shrine interaction. Operates on the Game instance.
import * as THREE from 'three';
import { T, TDEF } from './enemies.js';
import { PLAY_R } from './world.js';
import { ISLANDS, ISLAND_TIME } from './biomes.js';
import { clamp } from './rng.js';

const _p = new THREE.Vector3();
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const MINI_TIMES = [160, 320];

export function resetStage(g) {
  g.islandTime = 0; g.nextElite = 40; g.nextHorde = 70; g.miniIdx = 0; g.miniWarned = -1;
  g.finalBoss = null; g.finalSpawned = false; g.swarm = false; g.swarmLevel = 0; g.swarmT = 0; g.swarmSpeed = 1;
  g.cleared = false; g.greedActive = false; g.trial = null; g.lavaT = 0;
  stageMults(g);
}

// enemy HP / damage scaling. Each island starts at least a bit tougher than the last one ended
// (g.hpCarry, set when an island is cleared), so a carried-over build never lands on a pushover island.
export function stageMults(g) {
  const k = g.islandN - 1, t = g.islandTime || 0;
  const min = (t + k * 200) / 60;
  const base = Math.max((1.25 + min * 0.6 + min * min * 0.08) * Math.pow(1.75, k), (g.hpCarry || 0) * 1.15);
  g.hpBase = base;
  g.hpMult = base * (g.greedActive ? 1.3 : 1) * (g.swarm ? 1 + g.swarmLevel * 0.12 : 1);
  g.dmgMult = (1 + min * 0.11) * Math.pow(1.08, k) * (g.swarm ? 1 + g.swarmLevel * 0.1 : 1);
  // bosses hit hard but must never one-shot a healthy build
  g.bossDmg = 1 + k * 0.35 + (t / 60) * 0.06;
}

export function stageTimeLeft(g) { return Math.max(0, ISLAND_TIME - g.islandTime); }

export function spawnAround(g, ti, rMin, rMax, opts) {
  const P = g.player.pos;
  for (let tries = 0; tries < 6; tries++) {
    const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
    const x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > PLAY_R + 4) continue;
    if (!TDEF[ti].fly && g.world.heightAt(x, z) < 0.3) continue;
    return g.enemies.spawn(ti, x, z, Object.assign({ hpMult: g.hpMult, dmgMult: g.dmgMult }, opts));
  }
  return -1;
}

export function updateDirector(g, dt) {
  const E = g.enemies, k = g.islandN - 1;
  if (g.cleared) return;
  g.islandTime += dt;
  const t = g.islandTime;
  stageMults(g);

  const boss = g.finalBoss && g.finalBoss.alive;
  let target = (26 + t * 0.9 + (t / 60) ** 2 * 10) * (1 + 0.15 * k) * (g.greedActive ? 1.4 : 1);
  if (boss) target *= 0.55;
  target = Math.min(target, 1900);
  const deficit = target - E.aliveCount;
  const perFrame = Math.min(deficit, 3 + (t / 60) * 1.6 + k);
  const tt = t + (k > 0 ? 150 : 0);
  const w = [Math.max(2.5, 10 - (tt / 60) * 1.3), tt > 25 ? 6 : 0, tt > 55 ? 4.5 : 0, tt > 85 ? 3.5 : 0, tt > 115 ? 2 : 0, tt > 150 ? 1 + (tt / 60) * 0.25 : 0];
  const tot = w.reduce((a, b) => a + b, 0);
  for (let s = 0; s < perFrame; s++) {
    let r = Math.random() * tot, ti = 0;
    for (let q = 0; q < w.length; q++) { r -= w[q]; if (r <= 0) { ti = q; break; } }
    if (ti === T.zippy) { for (let q = 0; q < 4; q++) spawnAround(g, T.zippy, 36, 44); s += 3; }
    else spawnAround(g, ti, 32, 48);
  }
  // elites
  if (t >= g.nextElite) {
    g.nextElite += Math.max(18, 42 - (t / 60) * 2);
    const pool = [T.goon, T.blob, ...(tt > 100 ? [T.brute, T.spitter] : []), ...(tt > 60 ? [T.zippy, T.bat] : [])];
    if (spawnAround(g, pool[(Math.random() * pool.length) | 0], 26, 34, { elite: true }) >= 0) g.ui.toast('ELITE SPOTTED — big loot', { color: '#FFB020' });
  }
  // horde rings
  if (t >= g.nextHorde && !g.swarm) {
    g.nextHorde += 80;
    const n = Math.min(90, 28 + (t / 60) * 9 + k * 8);
    const P = g.player.pos;
    const ti = tt > 150 ? T.goon : T.blob;
    for (let q = 0; q < n; q++) {
      const a = q / n * Math.PI * 2, x = P.x + Math.cos(a) * 24, z = P.z + Math.sin(a) * 24;
      if (g.world.heightAt(x, z) > 0.3 && Math.hypot(x, z) < PLAY_R + 4) E.spawn(ti, x, z, { hpMult: g.hpMult, dmgMult: g.dmgMult });
    }
    g.ui.announce('SURROUNDED!', { sub: 'smash your way out', color: '#FF3D8B', duration: 1.6 });
    g.audio.play('warning', { volume: 0.5 });
  }
  // mini-bosses
  const mt = MINI_TIMES[g.miniIdx];
  if (mt !== undefined && !g.finalSpawned) {
    if (t >= mt - 5 && g.miniWarned !== g.miniIdx) {
      g.miniWarned = g.miniIdx;
      g.ui.announce('BOSS INCOMING', { sub: 'jump over the shockwaves!', color: '#FF3D8B', duration: 2.4 });
      g.audio.play('warning');
    }
    if (t >= mt) {
      const I = g.island;
      let id, name, title, hpK = 1;
      if (g.miniIdx === 0) { id = 'chonk'; name = I.miniName; title = 'BIG. ROUND. ANGRY.'; }
      else if (k === 0) { id = 'warlord'; name = 'THE WARLORD'; title = 'HE SKIPPED LEG DAY. NEVER ARM DAY.'; }
      else { const prev = ISLANDS[k - 1]; id = prev.boss; name = prev.bossName + ' RETURNS'; title = 'A FAMILIAR FACE, NOW ANGRIER'; hpK = 0.4; }
      g.miniIdx++;
      const pos = bossSpawnPos(g, 34);
      const b = g.enemies.spawnBoss(id, pos.x, pos.z, { name, title, hpMult: g.hpMult * hpK * (id === 'chonk' ? 1 : 0.85), dmgMult: g.bossDmg });
      if (b) g.onBossSpawn(b, false);
    }
  }
  // the countdown hits zero: the boss comes to you, and the EXTINCTION wave begins
  if (t >= ISLAND_TIME && !g.swarm) {
    g.swarm = true; g.swarmT = 0; g.swarmLevel = 0;
    if (!g.finalSpawned) summonFinalBoss(g, bossSpawnPos(g, 30));
    g.ui.announce('EXTINCTION', { sub: 'smash the boss before it wipes you out', color: '#FF3D8B', duration: 3 });
    g.audio.play('swarmstart'); g.audio.startMusic('final', g.island.id);
    g.post.setSwarm?.(0.5);
  }
  if (g.swarm) {
    g.swarmT += dt;
    const lvl = Math.floor(g.swarmT / 10);
    if (lvl > g.swarmLevel) { g.swarmLevel = lvl; g.ui.toast(`THE SWARM GROWS · ×${(1 + lvl * 0.12).toFixed(1)}`, { color: '#9FEFFF', duration: 1.4 }); }
    g.swarmSpeed = 1 + g.swarmLevel * 0.08;
    g.post.setSwarm?.(Math.min(1, 0.5 + g.swarmLevel * 0.08));
    const rate = 3 + g.swarmLevel * 1.5;
    g.ghostAcc = (g.ghostAcc || 0) + rate * dt;
    while (g.ghostAcc >= 1) {
      g.ghostAcc -= 1;
      if (spawnAround(g, T.ghost, 26, 40) >= 0 && Math.random() < 0.15) g.audio.play('ghost', { volume: 0.35 });
    }
  }
}

function bossSpawnPos(g, dist) {
  const P = g.player.pos;
  let bx = P.x, bz = P.z;
  for (let tries = 0; tries < 16; tries++) {
    const a = Math.random() * Math.PI * 2;
    bx = P.x + Math.cos(a) * dist; bz = P.z + Math.sin(a) * dist;
    if (g.world.heightAt(bx, bz) > 0.8 && Math.hypot(bx, bz) < PLAY_R - 4) break;
  }
  return { x: bx, z: bz };
}

// FOSSIL ECHO: a bone-white ghost of this island's final boss — about half its strength, slower,
// no enrage. Beating it grants a Fossil Boon (a unique run power) and two free chests.
export function awakenFossilEcho(g) {
  const I = g.island, gate = g.world.fossilGate;
  const a = Math.atan2(-gate.x, -gate.z);
  const x = gate.x + Math.sin(a) * 8, z = gate.z + Math.cos(a) * 8;
  const hp = g.hpMult * 0.8 * (1 + 0.8 * (g.islandN - 1)) * 0.5;
  const b = g.enemies.spawnBoss(I.boss, x, z, { name: 'FOSSIL ' + I.bossName, title: 'AN ECHO FROM BEFORE THE EXTINCTION', fossil: true, gapK: 1.3, hpMult: hp, dmgMult: (g.bossDmg || 1) * 0.8 });
  if (!b) return null;
  gate.state = 'active';
  g.fossilEcho = b;
  g.onBossSpawn(b, false);
  return b;
}

export function summonFinalBoss(g, pos) {
  const I = g.island;
  g.finalSpawned = true;
  if (g.world.meteor) g.world.meteor.state = 'used';
  const b = g.enemies.spawnBoss(I.boss, pos.x, pos.z, { name: I.bossName, title: I.bossTitle, final: true, hpMult: g.hpMult * (1 + Math.min(0.2, Math.max(0, g.islandTime - 120) / 1200)) * 0.8 * (1 + 0.8 * (g.islandN - 1)), dmgMult: g.bossDmg || 1 });
  if (!b) return null;
  g.finalBoss = b;
  g.onBossSpawn(b, true);
  return b;
}

// ---------------------------------------------------------------- interactions
export function interact(g, dt) {
  const P = g.player.pos, w = g.world;
  let prompt = null;
  // chests
  for (const c of w.chests) {
    if (c.opened) continue;
    const d = Math.hypot(P.x - c.x, P.z - c.z);
    if (d > 5) continue;
    const cost = c.free ? 0 : g.chestCost();
    if (d < 1.9) {
      if (g.gold >= cost) {
        g.gold -= cost; c.opened = true; if (!c.free) g.chestsOpened++; g.progress.add('chests');
        g.fx.confetti(_p.set(c.x, c.y + 1.2, c.z), 70);
        g.openChoices('chest');
        return;
      }
      prompt = `CHEST · ${cost} GOLD — need ${cost - Math.floor(g.gold)} more`;
    } else prompt = c.free ? 'FREE CHEST · walk in to open' : `CHEST · ${cost} GOLD — walk in to open`;
  }
  // shrines
  for (const s of w.shrines) {
    if (s.used) continue;
    const d = Math.hypot(P.x - s.x, P.z - s.z);
    const R = 2.9;
    const need = s.kind === 'blessing' ? 2.5 : s.kind === 'amber' ? 2.2 : s.kind === 'pylon' ? 0.8 : 1.5;
    const label = { blessing: 'BLESSING SHRINE', amber: 'AMBER OBELISK', totem: 'CHALLENGE TOTEM', greed: 'GREED IDOL', pylon: 'MAGNET PYLON' }[s.kind];
    const what = { blessing: 'a charm blessing', amber: 'a mutation (raw stat boost)', totem: 'a timed trial for epic loot', greed: 'more gold & XP, tougher foes', pylon: 'pull in every gem on the island' }[s.kind];
    if (d < R) {
      if (s.kind === 'totem' && g.trial) { prompt = 'A TRIAL IS ALREADY RUNNING'; continue; }
      s.progress += dt / need;
      prompt = `${label} · ${Math.floor(Math.min(1, s.progress) * 100)}%`;
      if (Math.random() < 0.3) g.fx.burst(_p.set(s.x + (Math.random() - 0.5) * 4, s.y + 0.3, s.z + (Math.random() - 0.5) * 4), s.kind === 'greed' ? '#FFC23D' : s.kind === 'totem' ? '#FF5A3A' : '#1AE3FF', 1, { speed: 1, up: 6, gravity: -2, life: 1 });
      if (s.progress >= 1) { activateShrine(g, s); return; }
    } else {
      s.progress = Math.max(0, s.progress - dt * 0.5);
      if (d < 7) prompt = `${label} · stand inside: ${what}`;
    }
  }
  // meteor crater: stand in it to crack the meteor and summon the final boss early
  const mc = w.meteor;
  if (mc && !g.finalSpawned && !g.cleared) {
    const d = Math.hypot(P.x - mc.x, P.z - mc.z);
    if (d < 4.6) {
      mc.state = 'charging'; mc.progress = Math.min(1, mc.progress + dt / 2.2);
      prompt = `METEOR CRATER · CRACKING IT OPEN ${Math.floor(mc.progress * 100)}%`;
      if (Math.random() < 0.4) g.fx.burst(_p.set(mc.x + (Math.random() - 0.5) * 3, mc.y + 1, mc.z + (Math.random() - 0.5) * 3), '#FF7A1A', 1, { speed: 3, up: 5, life: 0.6, glow: 2 });
      if (mc.progress >= 1) {
        g.audio.play('portal'); g.audio.play('explosion', { volume: 1, pitch: 0.55 });
        _p.set(mc.x, mc.y + 1.5, mc.z);
        g.fx.burst(_p, '#FF7A1A', 50, { speed: 16, up: 12, size: 0.4, glow: 2 });
        g.fx.burst(_p, '#3A2A24', 30, { speed: 12, up: 10, size: 0.5 });
        g.fx.ring(_p, 16, '#FF9E2C', 0.6, 1.5);
        g.fx.pillar?.(_p.set(mc.x, mc.y, mc.z), '#FF5A1A', 1.2, 3.5);
        g.shake(1.1);
        // the blast throws you clear of the crater
        { const dx = P.x - mc.x, dz = P.z - mc.z, dd = Math.hypot(dx, dz) + 1e-3; g.player.vel.set(dx / dd * 16, 13, dz / dd * 16); g.player.onGround = false; }
        summonFinalBoss(g, { x: mc.x, z: mc.z });
        return;
      }
    } else {
      if (mc.state === 'charging') mc.state = 'idle';
      mc.progress = Math.max(0, mc.progress - dt * 0.6);
      if (d < 10) prompt = `METEOR CRATER · stand inside to summon ${g.island.bossName} early (bonus score)`;
    }
  }
  // fossil gate: awaken a Fossil Echo (optional, once per island)
  const fg = w.fossilGate;
  if (fg && fg.state !== 'used' && fg.state !== 'active' && !g.cleared) {
    const d = Math.hypot(P.x - fg.px, P.z - fg.pz);
    if (d < 3.2) {
      fg.state = 'charging'; fg.progress = Math.min(1, fg.progress + dt / 2.0);
      prompt = `FOSSIL GATE · AWAKENING THE ECHO ${Math.floor(fg.progress * 100)}%`;
      if (fg.progress >= 1) {
        g.audio.play('portal', { pitch: 0.8 });
        g.fx.pillar?.(_p.set(fg.x, fg.y, fg.z), '#FFD08A', 1.2, 3.5);
        awakenFossilEcho(g);
        return;
      }
    } else {
      if (fg.state === 'charging') fg.state = 'idle';
      fg.progress = Math.max(0, fg.progress - dt * 0.6);
      if (Math.hypot(P.x - fg.x, P.z - fg.z) < 12) prompt = `FOSSIL GATE · stand in the jaws: fight a Fossil Echo for a boon + 2 free chests`;
    }
  }
  // launch cannon: stand on its pad to get fired off the island
  const cn = w.cannon;
  if (cn && g.cleared && !cn.fired) {
    const d = Math.hypot(P.x - cn.px, P.z - cn.pz);
    const next = g.nextIsland();
    const where = next ? `to ${next.name}` : g.islandN === 5 ? 'into legend' : `home (${ISLANDS[g.islandN].name} unlocked!)`;
    if (d > 4.5 && cn.t > 1) cn.armed = true; // must walk up to it: never fires on someone who was standing there
    if (d < 2.8 && cn.armed) {
      cn.progress = Math.min(1, cn.progress + dt / 1.0);
      prompt = `LAUNCH CANNON · LOADING ${3 - Math.min(2, Math.floor(cn.progress * 3))}…`;
      if (cn.progress >= 1) { g.fireCannon(); return; }
    } else {
      cn.progress = Math.max(0, cn.progress - dt);
      if (Math.hypot(P.x - cn.x, P.z - cn.z) < 16) prompt = `LAUNCH CANNON · climb in to get fired ${where}`;
    }
  }
  if (prompt !== g._prompt) { g._prompt = prompt; g.ui.setPrompt(prompt); }
}

function activateShrine(g, s) {
  s.used = true; s.progress = 1;
  g.progress.add('shrines');
  g.fx.ring(_p.set(s.x, s.y + 0.3, s.z), 8, s.kind === 'greed' ? '#FFC23D' : '#1AE3FF', 0.6, 1);
  if (s.kind === 'blessing') { g.audio.play('shrine'); g.openChoices('shrine'); }
  else if (s.kind === 'amber') { g.audio.play('amber'); g.openChoices('amber'); }
  else if (s.kind === 'pylon') {
    g.pickups.vacuum();
    g.fx.pillar?.(_p.set(s.x, s.y, s.z), '#1AE3FF', 0.8, 3);
    g.audio.play('pylon');
    g.ui.toast('MAGNET PYLON · every gem is coming to you', { color: '#1AE3FF' });
  } else if (s.kind === 'greed') {
    g.greedActive = true;
    g.audio.play('greed');
    g.ui.announce('GREED!', { sub: '+50% gold & XP · enemies +30% HP, +40% spawns', color: '#FFC23D', duration: 2.4 });
  } else if (s.kind === 'totem') {
    s.active = true;
    const goal = 40 + g.islandN * 15;
    g.trial = { shrine: s, goal, kills: 0, time: 40, label: `KILL ${goal}` };
    g.audio.play('totem');
    g.ui.announce('TRIAL!', { sub: `kill ${goal} in 40 seconds for epic loot`, color: '#FF5A3A', duration: 2.2 });
    const P = g.player.pos;
    for (let q = 0; q < 34; q++) {
      const a = q / 34 * Math.PI * 2, x = P.x + Math.cos(a) * 18, z = P.z + Math.sin(a) * 18;
      if (g.world.heightAt(x, z) > 0.3) g.enemies.spawn(q % 6 === 0 ? T.brute : T.goon, x, z, { hpMult: g.hpMult, dmgMult: g.dmgMult, elite: q % 11 === 0 });
    }
  }
}

export function updateTrial(g, dt) {
  const tr = g.trial;
  if (!tr) return;
  tr.time -= dt;
  // keep the trial fed: there are always enough enemies close by to finish it
  tr.feedT = (tr.feedT || 0) - dt;
  if (tr.feedT <= 0 && tr.kills < tr.goal) {
    tr.feedT = 0.4;
    const E = g.enemies, P = g.player.pos;
    let near = 0;
    for (let q = 0; q < E.activeCount; q++) { const j = E.active[q]; if (E.state[j] === 1 && (E.x[j] - P.x) ** 2 + (E.z[j] - P.z) ** 2 < 28 * 28) near++; }
    const want = Math.min(60, tr.goal - tr.kills + 14);
    for (let q = 0; q < Math.min(12, want - near); q++) spawnAround(g, Math.random() < 0.12 ? T.brute : Math.random() < 0.5 ? T.goon : T.blob, 15, 24);
  }
  if (tr.kills >= tr.goal) {
    g.trial = null; tr.shrine.active = false;
    g.progress.lifeAdd('lifeTrials');
    g.audio.play('trialwin');
    g.gold += 30;
    g.ui.announce('TRIAL COMPLETE!', { sub: 'epic loot + 30 gold', color: '#8CFF5A', duration: 2 });
    g.openChoices('trial');
  } else if (tr.time <= 0) {
    g.trial = null; tr.shrine.active = false;
    g.audio.play('trialfail');
    g.ui.announce('TRIAL FAILED', { sub: `${tr.kills}/${tr.goal} — so close`, color: '#FF3D8B', duration: 1.8 });
  }
}

export function phaseText(g) {
  if (g.cleared) return g.world.cannon?.fired ? 'LAUNCHED! HOLD ON TO YOUR HAT' : 'ISLAND CLEARED — GET TO THE LAUNCH CANNON';
  if (g.swarm) return 'EXTINCTION — SMASH THE BOSS';
  if (g.finalBoss && g.finalBoss.alive) return `${g.island.bossName} — ${stageTimeLeft(g) > 0 ? 'BEAT IT BEFORE 0:00' : 'NOW!'}`;
  const mt = MINI_TIMES[g.miniIdx];
  if (mt !== undefined && g.islandTime < mt) return `BOSS IN ${fmtTime(mt - g.islandTime)} · CRATER IS HOT`;
  return `FINAL BOSS AT 0:00 · OR CRACK THE METEOR`;
}

export { MINI_TIMES, clamp };
