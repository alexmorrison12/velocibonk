// Persistent progression: quests ("do X → unlock Y"), characters, perks and island unlocks.
// Everything unlocked is derived from completed quests, so there is one source of truth.

const KEY = 'velocibonk.progress';

export const BASE_WEAPONS = ['bat', 'pebble', 'saw', 'zap', 'banana', 'aura'];
export const BASE_TOMES = ['might', 'haste', 'multishot', 'size', 'zoomies', 'magnet', 'vitality', 'regen'];

export const CHARACTERS = {
  rex:    { name: 'REX', title: 'The Bonker', start: ['bat', 'pebble'], passive: '+15% speed→damage conversion', stats: { momentum: 0.15 } },
  zappy:  { name: 'ZAPPY', title: 'Storm Caller', start: ['zap', 'pebble'], passive: '+10% crit chance', stats: { crit: 0.1 } },
  nana:   { name: 'NANA', title: 'Banana Bandit', start: ['banana', 'bat'], passive: '+1 projectile', stats: { multishot: 1 } },
  blaze:  { name: 'BLAZE', title: 'Hot Wheels', start: ['hotfeet', 'bat'], passive: '+15% move speed', stats: { moveSpeed: 0.15 } },
  tank:   { name: 'TANK', title: 'Built Different', start: ['aura', 'bat'], passive: '+60 max HP · +15% armor · −8% speed', stats: { maxHp: 60, armor: 0.15, moveSpeed: -0.08 } },
  goldie: { name: 'GOLDIE', title: 'The Legend', start: ['blackhole', 'bat'], passive: '+50% gold · +30% luck', stats: { luck: 0.3, gold: 0.5 } },
};
export const CHAR_ORDER = ['rex', 'zappy', 'nana', 'blaze', 'tank', 'goldie'];

export const PERKS = {
  gold20:  { name: 'Head Start', desc: 'Start every run with 20 gold' },
  reroll:  { name: 'Second Opinion', desc: '+1 reroll every run' },
  revive:  { name: 'Second Wind', desc: 'Revive once per run at 50% HP' },
  gold15:  { name: 'Gold Digger', desc: '+15% gold' },
  xp10:    { name: 'Quick Study', desc: '+10% XP' },
  bossdmg: { name: 'Boss Slayer', desc: '+20% damage to bosses' },
};

// stat: a per-run counter the game increments; 'max' stats keep the best value seen this run.
// scope 'run' resets each run, 'life' accumulates forever.
export const QUESTS = [
  { id: 'clear1', cat: 'ISLANDS', name: 'Island Hopper', desc: 'Defeat the Tiki Titan and clear Palm Paradise', stat: 'cleared', goal: 1, reward: { kind: 'island', id: 2, name: 'Frostbite Peaks' } },
  { id: 'clear2', cat: 'ISLANDS', name: 'Cold Blooded', desc: 'Defeat the Yeti King and clear Frostbite Peaks', stat: 'cleared', goal: 2, reward: { kind: 'island', id: 3, name: 'Sunscorch Dunes' }, bonus: { kind: 'weapon', id: 'frost', name: 'Frost Nova' } },
  { id: 'clear3', cat: 'ISLANDS', name: 'Dune Bonker', desc: 'Defeat the Dune Devourer and clear Sunscorch Dunes', stat: 'cleared', goal: 3, reward: { kind: 'island', id: 4, name: 'Gloomhollow' } },
  { id: 'clear4', cat: 'ISLANDS', name: 'Grave Robber', desc: 'Defeat the Gravelord and clear Gloomhollow', stat: 'cleared', goal: 4, reward: { kind: 'island', id: 5, name: 'Magma Core' }, bonus: { kind: 'weapon', id: 'blackhole', name: 'Black Hole' } },
  { id: 'clear5', cat: 'ISLANDS', name: 'VELOCIGOD', desc: 'Slay Magmaw and conquer the Archipelago', stat: 'cleared', goal: 5, reward: { kind: 'character', id: 'goldie', name: 'GOLDIE' } },

  { id: 'speed100', cat: 'MOVEMENT', name: 'Speed Freak', desc: 'Reach 100 km/h', stat: 'kmh', goal: 100, reward: { kind: 'tome', id: 'momentum', name: 'Momentum Tome' } },
  { id: 'speed180', cat: 'MOVEMENT', name: 'Terminal Velocity', desc: 'Reach 180 km/h', stat: 'kmh', goal: 180, reward: { kind: 'character', id: 'blaze', name: 'BLAZE' } },
  { id: 'bhop25', cat: 'MOVEMENT', name: 'Bunny Mode', desc: 'Chain 25 bunny hops', stat: 'bhop', goal: 25, reward: { kind: 'tome', id: 'springs', name: 'Springs Tome' } },
  { id: 'air5', cat: 'MOVEMENT', name: 'Frequent Flyer', desc: 'Stay airborne for 5 seconds', stat: 'air', goal: 5, reward: { kind: 'weapon', id: 'lance', name: 'Sonic Lance' } },
  { id: 'slam15', cat: 'MOVEMENT', name: 'Meteor Strike', desc: 'Hit 15 enemies with a single slam', stat: 'slamHits', goal: 15, reward: { kind: 'weapon', id: 'meteor', name: 'Sky Bonk' } },
  { id: 'ram150', cat: 'MOVEMENT', name: 'Wrecking Ball', desc: 'RAM 150 enemies in one run', stat: 'rams', goal: 150, reward: { kind: 'weapon', id: 'quake', name: 'Quake Boots' } },

  { id: 'kills1000', cat: 'COMBAT', name: 'Horde Hunter', desc: 'Bonk 1,000 enemies in one run', stat: 'kills', goal: 1000, reward: { kind: 'weapon', id: 'hotfeet', name: 'Hot Feet' } },
  { id: 'life10k', cat: 'COMBAT', name: 'Bonk Master', desc: 'Bonk 10,000 enemies in total', stat: 'lifeKills', goal: 10000, scope: 'life', reward: { kind: 'tome', id: 'crit', name: 'Crit Tome' } },
  { id: 'combo250', cat: 'COMBAT', name: 'Combo King', desc: 'Reach a 250 bonk combo', stat: 'combo', goal: 250, reward: { kind: 'tome', id: 'luck', name: 'Luck Tome' } },
  { id: 'zap10', cat: 'COMBAT', name: 'Chain Reaction', desc: 'Hit 10 enemies with one Zeus Juice bolt', stat: 'zapChain', goal: 10, reward: { kind: 'character', id: 'zappy', name: 'ZAPPY' } },
  { id: 'banana12', cat: 'COMBAT', name: 'Banana Split', desc: 'Hit 12 enemies with one Bananarang throw', stat: 'bananaHits', goal: 12, reward: { kind: 'character', id: 'nana', name: 'NANA' } },
  { id: 'dmg1m', cat: 'COMBAT', name: 'Big Numbers', desc: 'Deal 1,000,000 damage in one run', stat: 'damage', goal: 1e6, reward: { kind: 'tome', id: 'wisdom', name: 'Wisdom Tome' } },
  { id: 'chonk', cat: 'COMBAT', name: 'Chonk Bonker', desc: 'Defeat King Chonk', stat: 'chonks', goal: 1, reward: { kind: 'shrine', id: 'greed', name: 'Greed Idols' } },
  { id: 'tank', cat: 'COMBAT', name: 'Built Different', desc: 'Take 1,000 damage in one run', stat: 'taken', goal: 1000, reward: { kind: 'character', id: 'tank', name: 'TANK' } },
  { id: 'nohit', cat: 'COMBAT', name: 'Untouchable', desc: 'Go 90 seconds without getting hit (after 1:00)', stat: 'nohit', goal: 90, reward: { kind: 'tome', id: 'armor', name: 'Armor Tome' } },
  { id: 'speedrun', cat: 'COMBAT', name: 'Speedrunner', desc: 'Defeat a final boss with 3:00 or more on the clock', stat: 'fastBoss', goal: 1, reward: { kind: 'perk', id: 'bossdmg', name: 'Boss Slayer' } },

  { id: 'chests6', cat: 'EXPLORATION', name: 'Treasure Hunter', desc: 'Open 6 chests in one run', stat: 'chests', goal: 6, reward: { kind: 'perk', id: 'gold20', name: 'Head Start' } },
  { id: 'shrines5', cat: 'EXPLORATION', name: 'Pilgrim', desc: 'Use 5 shrines in one run', stat: 'shrines', goal: 5, reward: { kind: 'perk', id: 'reroll', name: 'Second Opinion' } },
  { id: 'trials3', cat: 'EXPLORATION', name: 'Trial by Fire', desc: 'Win 3 Challenge Totem trials', stat: 'lifeTrials', goal: 3, scope: 'life', reward: { kind: 'perk', id: 'revive', name: 'Second Wind' } },
  { id: 'greedy', cat: 'EXPLORATION', name: 'Greedy Raptor', desc: 'Activate a Greed Idol and clear that island', stat: 'greedClear', goal: 1, reward: { kind: 'perk', id: 'gold15', name: 'Gold Digger' } },
  { id: 'level40', cat: 'EXPLORATION', name: 'Evolved', desc: 'Reach level 40 in one run', stat: 'level', goal: 40, reward: { kind: 'perk', id: 'xp10', name: 'Quick Study' } },
];

const BY_STAT = {};
for (const q of QUESTS) (BY_STAT[q.stat] ||= []).push(q);
const EMPTY = [];

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && typeof v === 'object') return v; } catch { /* blocked */ }
  return null;
}

export class Progress {
  constructor() {
    const v = load() || {};
    this.done = new Set(v.done || []);
    this.life = Object.assign({ lifeKills: 0, lifeTrials: 0, runs: 0, cleared: 0 }, v.life || {});
    this.selectedChar = v.selectedChar && CHARACTERS[v.selectedChar] ? v.selectedChar : 'rex';
    this.islandBest = v.islandBest || {};
    this.run = {};
    this.newThisRun = [];
    this.onComplete = null;
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ done: [...this.done], life: this.life, selectedChar: this.selectedChar, islandBest: this.islandBest })); } catch { /* blocked */ }
  }

  // ---------------------------------------------------------------- unlock queries
  rewards() { return QUESTS.filter(q => this.done.has(q.id)).flatMap(q => [q.reward, q.bonus].filter(Boolean)); }
  hasWeapon(id) { return BASE_WEAPONS.includes(id) || this.rewards().some(r => r.kind === 'weapon' && r.id === id); }
  hasTome(id) { return BASE_TOMES.includes(id) || this.rewards().some(r => r.kind === 'tome' && r.id === id); }
  hasChar(id) { return id === 'rex' || this.rewards().some(r => r.kind === 'character' && r.id === id); }
  hasPerk(id) { return this.rewards().some(r => r.kind === 'perk' && r.id === id); }
  hasShrine(id) { return this.rewards().some(r => r.kind === 'shrine' && r.id === id); }
  islandsUnlocked() { let n = 1; for (const r of this.rewards()) if (r.kind === 'island') n = Math.max(n, r.id); return n; }
  charReq(id) { const q = QUESTS.find(q => q.reward.kind === 'character' && q.reward.id === id); return q ? q.desc : ''; }

  // ---------------------------------------------------------------- run tracking
  startRun() { this.run = {}; this.newThisRun = []; this.life.runs++; }

  // add to a counter (run scope) or set a max; lifetime stats roll up automatically
  add(stat, v = 1) {
    this.run[stat] = (this.run[stat] || 0) + v;
    if (stat === 'kills') { this.life.lifeKills += v; this._check('lifeKills'); }
    this._check(stat);
  }
  max(stat, v) { if (v > (this.run[stat] || 0)) { this.run[stat] = v; this._check(stat); } }
  lifeAdd(stat, v = 1) { this.life[stat] = (this.life[stat] || 0) + v; this._check(stat); }

  value(q) {
    if (q.scope === 'life') return this.life[q.stat] || 0;
    if (q.stat === 'cleared') return Math.max(this.life.cleared || 0, this.run.cleared || 0);
    return this.run[q.stat] || 0;
  }

  // only quests watching `stat` (or all, when omitted) — this runs on every kill and hit
  _check(stat) {
    const list = stat ? (BY_STAT[stat] || EMPTY) : QUESTS;
    for (const q of list) {
      if (this.done.has(q.id)) continue;
      if (this.value(q) >= q.goal) {
        this.done.add(q.id);
        this.newThisRun.push(q);
        this.save();
        if (this.onComplete) this.onComplete(q);
      }
    }
  }

  // clearing island n (1-based)
  clearIsland(n) {
    this.run.cleared = Math.max(this.run.cleared || 0, n);
    this.life.cleared = Math.max(this.life.cleared || 0, n);
    this._check('cleared');
    this.save();
  }

  list() {
    return QUESTS.map(q => ({
      id: q.id, name: q.name, desc: q.desc, category: q.cat, goal: q.goal, done: this.done.has(q.id),
      progress: this.done.has(q.id) ? q.goal : Math.min(q.goal, Math.floor(this.value(q))),
      reward: q.reward, bonus: q.bonus || null,
    }));
  }
}
