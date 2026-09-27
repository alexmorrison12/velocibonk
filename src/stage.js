// One island of a run: the countdown, spawn director, mini-bosses, the boss portal, the final boss,
// the FINAL SWARM, and every shrine interaction. Operates on the Game instance.
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
  g.hpMult = 1; g.dmgMult = 1;
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
  const tEff = t + k * 200;
  const min = tEff / 60;
  g.hpMult = (1 + min * 0.55 + min * min * 0.075) * Math.pow(1.75, k) * (g.greedActive ? 1.3 : 1) * (g.swarm ? 1 + g.swarmLevel * 0.12 : 1);
  g.dmgMult = (1 + min * 0.11) * Math.pow(1.08, k) * (g.swarm ? 1 + g.swarmLevel * 0.1 : 1);
  // bosses hit hard but must never one-shot a healthy build
  g.bossDmg = 1 + k * 0.35 + (t / 60) * 0.06;

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
    g.ui.announce('SURROUNDED!', { sub: 'bonk your way out', color: '#FF3D8B', duration: 1.6 });
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
  // the countdown hits zero: the boss comes to you, and the FINAL SWARM begins
  if (t >= ISLAND_TIME && !g.swarm) {
    g.swarm = true; g.swarmT = 0; g.swarmLevel = 0;
    if (!g.finalSpawned) summonFinalBoss(g, bossSpawnPos(g, 30));
    g.ui.announce('FINAL SWARM', { sub: 'kill the boss before it kills you', color: '#FF3D8B', duration: 3 });
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

export function summonFinalBoss(g, pos) {
  const I = g.island;
  g.finalSpawned = true;
  if (g.world.bossPortal) g.world.bossPortal.state = 'active';
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
    const cost = g.chestCost();
    if (d < 1.9) {
      if (g.gold >= cost) {
        g.gold -= cost; c.opened = true; g.chestsOpened++; g.progress.add('chests');
        g.fx.confetti(_p.set(c.x, c.y + 1.2, c.z), 70);
        g.openChoices('chest');
        return;
      }
      prompt = `CHEST · ${cost} GOLD — need ${cost - Math.floor(g.gold)} more`;
    } else prompt = `CHEST · ${cost} GOLD — walk in to open`;
  }
  // shrines
  for (const s of w.shrines) {
    if (s.used) continue;
    const d = Math.hypot(P.x - s.x, P.z - s.z);
    const R = 2.9;
    const need = s.kind === 'blessing' ? 2.5 : s.kind === 'moai' ? 2.2 : s.kind === 'pylon' ? 0.8 : 1.5;
    const label = { blessing: 'BLESSING SHRINE', moai: 'MOAI HEAD', totem: 'CHALLENGE TOTEM', greed: 'GREED IDOL', pylon: 'MAGNET PYLON' }[s.kind];
    const what = { blessing: 'a tome blessing', moai: 'a raw stat boost', totem: 'a timed trial for epic loot', greed: 'more gold & XP, tougher foes', pylon: 'pull in every gem on the island' }[s.kind];
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
  // boss portal
  const bp = w.bossPortal;
  if (bp && !g.finalSpawned && !g.cleared) {
    const d = Math.hypot(P.x - bp.x, P.z - bp.z);
    if (d < 3.4) {
      bp.state = 'charging'; bp.progress = Math.min(1, bp.progress + dt / 2.2);
      prompt = `BOSS PORTAL · SUMMONING ${g.island.bossName} ${Math.floor(bp.progress * 100)}%`;
      if (bp.progress >= 1) {
        g.audio.play('portal');
        g.fx.pillar?.(_p.set(bp.x, bp.y, bp.z), '#B45CFF', 1.2, 3.5);
        const a = Math.atan2(P.x - bp.x, P.z - bp.z);
        summonFinalBoss(g, { x: bp.x - Math.sin(a) * 4, z: bp.z - Math.cos(a) * 4 });
        return;
      }
    } else {
      if (bp.state === 'charging') bp.state = 'idle';
      bp.progress = Math.max(0, bp.progress - dt * 0.6);
      if (d < 9) prompt = `BOSS PORTAL · stand inside to summon ${g.island.bossName} early (bonus score)`;
    }
  }
  // exit portal
  const ep = w.exitPortal;
  if (ep && g.cleared) {
    const d = Math.hypot(P.x - ep.x, P.z - ep.z);
    const next = g.nextIsland();
    if (d < 3.2 && ep.t > 1) { g.enterExitPortal(); return; }
    if (d < 14) prompt = next ? `EXIT PORTAL · jump in to travel to ${next.name}` : g.islandN === 5 ? 'EXIT PORTAL · step through to claim victory' : `EXIT PORTAL · step through to end the run (${ISLANDS[g.islandN].name} unlocked!)`;
  }
  if (prompt !== g._prompt) { g._prompt = prompt; g.ui.setPrompt(prompt); }
}

function activateShrine(g, s) {
  s.used = true; s.progress = 1;
  g.progress.add('shrines');
  g.fx.ring(_p.set(s.x, s.y + 0.3, s.z), 8, s.kind === 'greed' ? '#FFC23D' : '#1AE3FF', 0.6, 1);
  if (s.kind === 'blessing') { g.audio.play('shrine'); g.openChoices('shrine'); }
  else if (s.kind === 'moai') { g.audio.play('moai'); g.openChoices('moai'); }
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
  if (g.cleared) return g.nextIsland() ? 'ISLAND CLEARED — FIND THE PORTAL' : 'ISLAND CLEARED — STEP INTO THE PORTAL';
  if (g.swarm) return 'FINAL SWARM — KILL THE BOSS';
  if (g.finalBoss && g.finalBoss.alive) return `${g.island.bossName} — ${stageTimeLeft(g) > 0 ? 'BEAT IT BEFORE 0:00' : 'NOW!'}`;
  const mt = MINI_TIMES[g.miniIdx];
  if (mt !== undefined && g.islandTime < mt) return `BOSS IN ${fmtTime(mt - g.islandTime)} · PORTAL OPEN`;
  return `FINAL BOSS AT 0:00 · OR USE THE PORTAL`;
}

export { MINI_TIMES, clamp };
