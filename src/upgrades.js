// Level-up cards: weapons + tomes with rarity rolls (luck-weighted), deterministic per run seed.
import { WEAPONS, weaponUpgradeLines } from './weapons.js';

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const RMULT = { common: 1, uncommon: 1.25, rare: 1.55, epic: 2.0, legendary: 3.0 };
const pct = v => `${Math.round(v * 100)}%`;

export const TOMES = {
  might:     { name: 'Might Tome',       base: 0.14, line: v => `+${pct(v)} damage` },
  haste:     { name: 'Haste Tome',       base: 0.11, line: v => `+${pct(v)} attack speed` },
  multishot: { name: 'Multishot Tome',   base: 1, int: true, line: v => `+${v} projectile${v > 1 ? 's' : ''}` },
  size:      { name: 'Gigantism Tome',   base: 0.13, line: v => `+${pct(v)} area` },
  zoomies:   { name: 'Zoomies Tome',     base: 0.08, line: v => `+${pct(v)} move speed` },
  magnet:    { name: 'Magnet Tome',      base: 0.35, line: v => `+${pct(v)} pickup range` },
  vitality:  { name: 'Vitality Tome',    base: 25, line: v => `+${Math.round(v)} max HP` },
  regen:     { name: 'Regen Tome',       base: 0.6, line: v => `+${v.toFixed(1)} HP / sec` },
  crit:      { name: 'Crit Tome',        base: 0.07, line: v => `+${pct(v)} crit chance` },
  luck:      { name: 'Luck Tome',        base: 0.14, line: v => `+${pct(v)} luck (rarer cards)` },
  wisdom:    { name: 'Wisdom Tome',      base: 0.14, line: v => `+${pct(v)} XP gain` },
  springs:   { name: 'Springs Tome',     base: 1, int: true, line: v => `+${v} air jump · +8% jump height` },
  armor:     { name: 'Armor Tome',       base: 0.06, line: v => `-${pct(v)} damage taken` },
  momentum:  { name: 'Momentum Tome',    base: 0.2, line: v => `+${pct(v)} speed→damage conversion` },
};

export function freshStats() {
  return { might: 1, haste: 1, multishot: 0, area: 1, moveSpeed: 1, magnet: 1, maxHp: 100, regen: 0, crit: 0.05, luck: 0, wisdom: 1, extraJumps: 1, jumpMult: 1, armor: 0, momentum: 1 };
}

export function applyTome(stats, id, v) {
  switch (id) {
    case 'might': stats.might += v; break;
    case 'haste': stats.haste += v; break;
    case 'multishot': stats.multishot += v; break;
    case 'size': stats.area += v; break;
    case 'zoomies': stats.moveSpeed += v; break;
    case 'magnet': stats.magnet += v; break;
    case 'vitality': stats.maxHp += v; break;
    case 'regen': stats.regen += v; break;
    case 'crit': stats.crit = Math.min(1, stats.crit + v); break;
    case 'luck': stats.luck += v; break;
    case 'wisdom': stats.wisdom += v; break;
    case 'springs': stats.extraJumps = Math.min(5, stats.extraJumps + v); stats.jumpMult += 0.08; break;
    case 'armor': stats.armor = Math.min(0.7, stats.armor + v); break;
    case 'momentum': stats.momentum += v; break;
  }
}

function tomeValue(id, rarity) {
  const t = TOMES[id];
  if (t.int) return rarity === 'legendary' ? 2 : 1;
  return t.base * RMULT[rarity];
}

export function rollRarity(rand, luck, minIdx = 0) {
  const L = Math.max(0, luck);
  const w = [60 / (1 + L), 26, 10 * (1 + L * 0.8), 3.6 * (1 + L * 1.4), 0.9 * (1 + L * 2)];
  for (let i = 0; i < minIdx; i++) w[i] = 0;
  const tot = w.reduce((a, b) => a + b, 0);
  let r = rand() * tot;
  for (let i = 0; i < 5; i++) { r -= w[i]; if (r <= 0) return RARITIES[i]; }
  return 'common';
}

// Build 3 upgrade choices. ctx = { arsenal, tomes: Map(id->level), stats, rand, source: 'level'|'chest'|'shrine' }
export function rollChoices(ctx, count = 3) {
  const { arsenal, tomes, stats, rand, source } = ctx;
  const cands = [];
  if (source !== 'shrine') {
    for (const w of arsenal.list) if (w.level < WEAPONS[w.id].max) cands.push({ kind: 'weapon', id: w.id, weight: 1.35 });
    if (arsenal.list.length < 5) for (const id of Object.keys(WEAPONS)) if (!arsenal.get(id)) cands.push({ kind: 'weapon', id, weight: 0.95, fresh: true });
  }
  for (const [id, lv] of tomes) if (lv < 5) cands.push({ kind: 'tome', id, weight: 1.15 });
  if (tomes.size < 6) for (const id of Object.keys(TOMES)) if (!tomes.has(id)) cands.push({ kind: 'tome', id, weight: 0.8, fresh: true });

  const out = [];
  const minIdx = source === 'chest' ? 2 : source === 'shrine' ? 1 : 0;
  while (out.length < count && cands.length) {
    const tot = cands.reduce((a, c) => a + c.weight, 0);
    let r = rand() * tot, pick = 0;
    for (let i = 0; i < cands.length; i++) { r -= cands[i].weight; if (r <= 0) { pick = i; break; } }
    const c = cands.splice(pick, 1)[0];
    const rarity = rollRarity(rand, stats.luck, minIdx);
    out.push(describe(c, rarity, arsenal, tomes));
  }
  if (!out.length) {
    out.push({ kind: 'bonus', id: 'gold', name: 'Bag of Gold', rarity: 'rare', levelText: 'BONUS', desc: ['+60 gold'] });
    out.push({ kind: 'bonus', id: 'heal', name: 'Big Snack', rarity: 'uncommon', levelText: 'BONUS', desc: ['Fully heal'] });
    out.push({ kind: 'bonus', id: 'score', name: 'Style Points', rarity: 'epic', levelText: 'BONUS', desc: ['+25,000 score'] });
  }
  return out;
}

function describe(c, rarity, arsenal, tomes) {
  if (c.kind === 'weapon') {
    const W = WEAPONS[c.id];
    const w = arsenal.get(c.id);
    const bonus = (RMULT[rarity] - 1) * (w ? 0.3 : 0.5);
    const desc = w ? [...weaponUpgradeLines(c.id, w.level)] : [W.desc];
    if (bonus > 0) desc.push(`+${pct(bonus)} bonus damage`);
    return { kind: 'weapon', id: c.id, name: W.name, rarity, levelText: w ? `LV ${w.level} → ${w.level + 1}` : 'NEW!', desc, bonus };
  }
  const T = TOMES[c.id];
  const lv = tomes.get(c.id) || 0;
  const value = tomeValue(c.id, rarity);
  return { kind: 'tome', id: c.id, name: T.name, rarity, levelText: lv ? `LV ${lv} → ${lv + 1}` : 'NEW!', desc: [T.line(value)], value };
}
