// Level-up cards: weapons + charms (internally 'tomes') with rarity rolls (luck-weighted), gated by unlocks and by the
// per-island level caps. Raw STAT boosts never cap: the Amber Obelisk offers them, and they are the
// fallback whenever a build is fully maxed, so a shrine or chest is never wasted.
import { WEAPONS, weaponUpgradeLines } from './weapons.js';

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const RMULT = { common: 1, uncommon: 1.25, rare: 1.55, epic: 2.0, legendary: 3.0 };
const pct = v => `${Math.round(v * 100)}%`;

export const TOMES = {
  might:     { name: 'Might Charm',       base: 0.14, line: v => `+${pct(v)} damage` },
  haste:     { name: 'Haste Charm',       base: 0.11, line: v => `+${pct(v)} attack speed` },
  multishot: { name: 'Multishot Charm',   base: 1, int: true, line: v => `+${v} projectile${v > 1 ? 's' : ''}` },
  size:      { name: 'Gigantism Charm',   base: 0.13, line: v => `+${pct(v)} area` },
  zoomies:   { name: 'Zoomies Charm',     base: 0.08, line: v => `+${pct(v)} move speed` },
  magnet:    { name: 'Magnet Charm',      base: 0.35, line: v => `+${pct(v)} pickup range` },
  vitality:  { name: 'Vitality Charm',    base: 25, line: v => `+${Math.round(v)} max HP` },
  regen:     { name: 'Regen Charm',       base: 0.6, line: v => `+${v.toFixed(1)} HP / sec` },
  crit:      { name: 'Crit Charm',        base: 0.07, line: v => `+${pct(v)} crit chance` },
  luck:      { name: 'Luck Charm',        base: 0.14, line: v => `+${pct(v)} luck (rarer cards)` },
  wisdom:    { name: 'Wisdom Charm',      base: 0.14, line: v => `+${pct(v)} XP gain` },
  springs:   { name: 'Springs Charm',     base: 1, int: true, line: v => `+${v} air jump · +8% jump height` },
  armor:     { name: 'Armor Charm',       base: 0.06, line: v => `-${pct(v)} damage taken` },
  momentum:  { name: 'Momentum Charm',    base: 0.2, line: v => `+${pct(v)} speed→damage conversion` },
};

// raw stat boosts (Amber Obelisk 'mutations' + maxed-build fallback). `icon` reuses a charm icon.
export const STATS = {
  power:  { name: 'Raw Power', icon: 'might', base: 0.08, line: v => `+${pct(v)} damage`, apply: (s, v) => { s.might += v; } },
  skin:   { name: 'Thick Skin', icon: 'vitality', base: 16, line: v => `+${Math.round(v)} max HP`, apply: (s, v) => { s.maxHp += v; } },
  feet:   { name: 'Quick Feet', icon: 'zoomies', base: 0.05, line: v => `+${pct(v)} move speed`, apply: (s, v) => { s.moveSpeed += v; } },
  rush:   { name: 'Adrenaline', icon: 'haste', base: 0.06, line: v => `+${pct(v)} attack speed`, apply: (s, v) => { s.haste += v; } },
  big:    { name: 'Big Energy', icon: 'size', base: 0.07, line: v => `+${pct(v)} area`, apply: (s, v) => { s.area += v; } },
  eye:    { name: 'Sharp Eye', icon: 'crit', base: 0.04, line: v => `+${pct(v)} crit chance`, apply: (s, v) => { s.crit = Math.min(1, s.crit + v); } },
  snack:  { name: 'Snack Break', icon: 'regen', base: 0.35, line: v => `+${v.toFixed(2)} HP / sec`, apply: (s, v) => { s.regen += v; } },
  claws:  { name: 'Sticky Claws', icon: 'magnet', base: 0.2, line: v => `+${pct(v)} pickup range`, apply: (s, v) => { s.magnet += v; } },
  brain:  { name: 'Big Brain', icon: 'wisdom', base: 0.07, line: v => `+${pct(v)} XP gain`, apply: (s, v) => { s.wisdom += v; } },
  slip:   { name: 'Slipstream', icon: 'momentum', base: 0.08, line: v => `+${pct(v)} speed→damage`, apply: (s, v) => { s.momentum += v; } },
  scales: { name: 'Tough Scales', icon: 'armor', base: 0.03, line: v => `-${pct(v)} damage taken`, apply: (s, v) => { s.armor = Math.min(0.7, s.armor + v); } },
  clover: { name: 'Four Leaves', icon: 'luck', base: 0.06, line: v => `+${pct(v)} luck`, apply: (s, v) => { s.luck += v; } },
};

export function freshStats() {
  return { might: 1, haste: 1, multishot: 0, area: 1, moveSpeed: 1, magnet: 1, maxHp: 100, regen: 0, crit: 0.05, luck: 0, wisdom: 1, extraJumps: 1, jumpMult: 1, armor: 0, momentum: 1, gold: 1 };
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

export function applyStat(stats, key, v) { STATS[key]?.apply(stats, v); }

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

export function statChoices(rand, luck, count = 3, minIdx = 1) {
  const keys = Object.keys(STATS);
  const out = [];
  while (out.length < count && keys.length) {
    const k = keys.splice((rand() * keys.length) | 0, 1)[0];
    const S = STATS[k], rarity = rollRarity(rand, luck, minIdx), value = S.base * RMULT[rarity];
    out.push({ kind: 'stat', id: S.icon, stat: k, name: S.name, rarity, levelText: 'STAT', desc: [S.line(value), 'Never caps'], value });
  }
  return out;
}

// Build upgrade choices.
// ctx = { arsenal, tomes: Map, stats, rand, source: 'level'|'chest'|'shrine'|'amber'|'trial'|'boon', wcap, tcap, unlocked: { weapon(id), tome(id) }, slots: { weapons, tomes } }
export function rollChoices(ctx, count = 3) {
  const { arsenal, tomes, stats, rand, source } = ctx;
  const wcap = ctx.wcap || 7, tcap = ctx.tcap || 5;
  const canW = ctx.unlocked?.weapon || (() => true), canT = ctx.unlocked?.tome || (() => true);
  const minIdx = source === 'trial' ? 3 : source === 'chest' ? 2 : source === 'shrine' || source === 'amber' ? 1 : 0;
  if (source === 'amber') return statChoices(rand, stats.luck, count, minIdx);
  const cands = [];
  if (source !== 'shrine') {
    for (const w of arsenal.list) if (w.level < wcap) cands.push({ kind: 'weapon', id: w.id, weight: 1.35 });
    if (arsenal.list.length < (ctx.slots?.weapons || 5)) for (const id of Object.keys(WEAPONS)) if (!arsenal.get(id) && canW(id)) cands.push({ kind: 'weapon', id, weight: 0.95, fresh: true });
  }
  for (const [id, lv] of tomes) if (lv < tcap) cands.push({ kind: 'tome', id, weight: 1.15 });
  if (tomes.size < (ctx.slots?.tomes || 6)) for (const id of Object.keys(TOMES)) if (!tomes.has(id) && canT(id)) cands.push({ kind: 'tome', id, weight: 0.8, fresh: true });

  const out = [];
  while (out.length < count && cands.length) {
    const tot = cands.reduce((a, c) => a + c.weight, 0);
    let r = rand() * tot, pick = 0;
    for (let i = 0; i < cands.length; i++) { r -= cands[i].weight; if (r <= 0) { pick = i; break; } }
    const c = cands.splice(pick, 1)[0];
    const rarity = rollRarity(rand, stats.luck, minIdx);
    out.push(describe(c, rarity, arsenal, tomes));
  }
  // fully maxed (or nearly): top up with raw stat boosts so every pick still matters
  if (out.length < count) out.push(...statChoices(rand, stats.luck, count - out.length, Math.max(1, minIdx)));
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

// FOSSIL BOONS: unique run-long powers, only granted by beating a Fossil Echo. Each can be taken once.
export const BOONS = {
  pocket:  { name: 'Extra Pocket', icon: 'perk', desc: ['+1 weapon slot (6 weapons)'] },
  rush:    { name: 'Raptor Rush', icon: 'momentum', desc: ['Momentum drains 60% slower'] },
  shell:   { name: 'Amber Shell', icon: 'armor', desc: ['Blocks one hit every 10 seconds'] },
  echo:    { name: 'Echo Strike', icon: 'crit', desc: ['15% of weapon hits land twice'] },
  leech:   { name: 'Life Leech', icon: 'regen', desc: ['Every smash heals 0.35 HP'] },
  fortune: { name: 'Fossil Fortune', icon: 'coin', desc: ['+40% gold · chests cost 30% less'] },
  apex:    { name: 'Apex Predator', icon: 'skull', desc: ['+30% damage to bosses'] },
};

export function boonChoices(rand, owned, count = 3) {
  const keys = Object.keys(BOONS).filter(k => !owned[k]);
  const out = [];
  while (out.length < count && keys.length) {
    const k = keys.splice((rand() * keys.length) | 0, 1)[0], B = BOONS[k];
    out.push({ kind: 'boon', id: B.icon, boon: k, name: B.name, rarity: 'legendary', levelText: 'BOON', desc: [...B.desc, 'Lasts the whole run'] });
  }
  return out;
}
