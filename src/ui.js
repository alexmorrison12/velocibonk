// VELOCISMASH — UI layer. Vanilla DOM, no framework.
// Everything lives under the #ui root (class .vb-root); every class is prefixed `vb-`.
// updateHUD() is called every frame: it caches element refs + last values and only writes on change.

const INK = '#140f2e';
const NIGHT = '#1f1747';
const SUN = '#FF7A1A';
const VOLT = '#FFE14D';
const SURF = '#1AE3FF';
const HOT = '#FF3D8B';
const LIME = '#8CFF5A';
const PAPER = '#FFF6E5';
const STEEL = '#D9D4E8';
const WOOD = '#EDA65E';
const GREEN = '#6BE36B';
const BLUE = '#3DA5FF';
const PURPLE = '#B45CFF';
const AMBER = '#FFB020';
const BONE = '#F3E6C4';

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Chakra+Petch:ital,wght@0,500;0,600;0,700;1,600;1,700&family=Lilita+One&display=swap';

const RARITY = { common: 'COMMON', uncommon: 'UNCOMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };
// THE ARCHIPELAGO: biome palette (c = signature colour, d = deep shade) in island order
const BIOME_ORDER = ['tropical', 'frost', 'desert', 'grave', 'volcano'];
const BIOMES = {
  tropical: { c: '#66BD48', d: '#15452B', name: 'PALM PARADISE' },
  frost: { c: '#9FD4FF', d: '#1B2A6B', name: 'FROSTBITE PEAKS' },
  desert: { c: '#F4A04A', d: '#5A2410', name: 'SUNSCORCH DUNES' },
  grave: { c: '#8A6CFF', d: '#1A1438', name: 'GLOOMHOLLOW' },
  volcano: { c: '#FF5A1F', d: '#2D0B06', name: 'MAGMA CORE' },
};
const biomeOf = (b, n) => (BIOMES[b] ? b : BIOME_ORDER[(n | 0) - 1] || 'tropical');
// minimap palettes: sea gradient + island disc stops
const MM_BIOME = {
  tropical: { sea: ['#1b6f96', '#0b3656'], land: [[0, '#2f8a45'], [0.72, '#4fae54'], [0.86, '#8fc862'], [0.91, '#f1d38e'], [0.955, 'rgba(241,211,142,.55)'], [1, 'rgba(241,211,142,0)']] },
  frost: { sea: ['#3f7fc0', '#15335e'], land: [[0, '#8fb0d8'], [0.6, '#aec6e6'], [0.84, '#cddcf0'], [0.91, '#eef5ff'], [0.955, 'rgba(238,245,255,.6)'], [1, 'rgba(238,245,255,0)']] },
  desert: { sea: ['#1e8f9a', '#0b4a5e'], land: [[0, '#cf7a42'], [0.5, '#dda05a'], [0.8, '#eab266'], [0.91, '#f7d9a0'], [0.955, 'rgba(247,217,160,.55)'], [1, 'rgba(247,217,160,0)']] },
  grave: { sea: ['#233a4f', '#0c1522'], land: [[0, '#2b2f4c'], [0.6, '#34505a'], [0.84, '#3e6a64'], [0.91, '#6a5fae'], [0.955, 'rgba(138,108,255,.45)'], [1, 'rgba(138,108,255,0)']] },
  volcano: { sea: ['#4a1a10', '#1a0705'], land: [[0, '#ffb13a'], [0.1, '#ff5a1f'], [0.2, '#5a2a20'], [0.78, '#2e1a18'], [0.88, '#ff5a1f'], [0.94, 'rgba(255,90,31,.5)'], [1, 'rgba(255,90,31,0)']] },
};
const SHRINE_MM = { blessing: '#1AE3FF', amber: '#FFB020', totem: '#FF3D8B', greed: '#FFC21A', pylon: '#B45CFF' };
// display-name fallbacks for starting weapons given as ids
const WEAPON_NAMES = {
  bat: 'The Slugger', pebble: 'Magic Pebbles', saw: 'Saw Buddies', zap: 'Zeus Juice', hotfeet: 'Hot Feet', banana: 'Bananarang', meteor: 'Sky Smash',
  aura: 'Stink Aura', quake: 'Quake Boots', lance: 'Sonic Lance', frost: 'Frost Nova', blackhole: 'Black Hole',
};
// player-facing kind labels (internal kind 'tome' is shown as CHARM; 'stat' cards come from the Amber Obelisk)
const KIND_LABEL = { weapon: 'WEAPON', tome: 'CHARM', charm: 'CHARM', character: 'RAPTOR', island: 'ISLAND', shrine: 'SHRINE', perk: 'PERK', stat: 'MUTATION', boon: 'BOON', bonus: 'BONUS' };
const CAT_ICON = { ISLANDS: 'cannon', MOVEMENT: 'zoomies', COMBAT: 'challenge', EXPLORATION: 'quest' };
const CAT_ORDER = ['ISLANDS', 'MOVEMENT', 'COMBAT', 'EXPLORATION'];
const DEFAULT_SETTINGS = { master: 0.8, music: 0.6, sfx: 0.8, sensitivity: 1, invertY: false, quality: 'high', showFps: false };
const SEGS = 24; // momentum meter segments
const MM_RANGE = 90; // metres shown from player to minimap edge
const TAU = Math.PI * 2;
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ helpers */

const f1 = (n) => Math.round(n * 10) / 10;
const polar = (cx, cy, r, a) => f1(cx + Math.cos(a) * r) + ' ' + f1(cy + Math.sin(a) * r);
function starPath(cx, cy, ro, ri, n, rot = -Math.PI / 2) {
  let d = '';
  for (let i = 0; i < n * 2; i++) d += (i ? 'L' : 'M') + polar(cx, cy, i % 2 ? ri : ro, rot + (i * Math.PI) / n);
  return d + 'Z';
}
function sawPath(cx, cy, ro, ri, n) {
  let d = '';
  const st = TAU / n;
  for (let k = 0; k < n; k++) {
    const a = k * st;
    d += (k ? 'L' : 'M') + polar(cx, cy, ro, a) + 'L' + polar(cx, cy, ri, a + st * 0.2);
  }
  return d + 'Z';
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
function commas(n) {
  n = Math.round(+n || 0);
  const neg = n < 0;
  const s = String(neg ? -n : n);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return neg ? '-' + out : out;
}
function mmss(t) {
  t = Math.max(0, Math.floor(+t || 0));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}
const mss = (t) => Math.floor(t / 60) + ':' + (t % 60 < 10 ? '0' : '') + (t % 60); // countdown "7:59"
function compact(n) {
  n = Math.round(+n || 0);
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'K';
  return commas(n);
}
const isTyping = (a) => !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
const tierOf = (m) => (m >= 4 ? 4 : m >= 3 ? 3 : m >= 2 ? 2 : m >= 1.5 ? 1 : 0);
function fmtDate(d) {
  if (d == null || d === '') return '';
  if (typeof d === 'number' || d instanceof Date) {
    const x = new Date(d);
    if (!isNaN(x)) return x.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase();
  }
  return String(d).toUpperCase();
}
function setOT(e, text) {
  // "sticker" text: the outline + hard shadow are pseudo-elements that read data-t
  e.textContent = text;
  e.setAttribute('data-t', text);
}
const isInteractive = (e) => !!e && e !== document.body && /^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(e.tagName);
function anim(e, kf, opts) {
  if (!e || !e.animate) return null;
  try {
    return e.animate(kf, typeof opts === 'number' ? { duration: REDUCED ? Math.min(opts, 120) : opts, easing: 'cubic-bezier(.2,1.4,.4,1)' } : opts);
  } catch (_) {
    return null;
  }
}
const KF_POP = [{ scale: '1.5' }, { scale: '1' }];
const KF_BUMP = [{ scale: '1.2' }, { scale: '1' }];
const KF_SHAKE = [{ translate: '-7px 0' }, { translate: '6px 0' }, { translate: '-3px 0' }, { translate: '0 0' }];
const KF_FLASH = [{ opacity: 0.9 }, { opacity: 0 }];

/* -------------------------------------------------------------------- icons */

const svg = (inner) =>
  `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${INK}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" focusable="false">${inner}</svg>`;
// thin coloured line with an ink outline (draw ink wide, colour narrow on top)
const line2 = (d, color, w = 4) => `<path d="${d}" stroke-width="${w + 4}"/><path d="${d}" stroke="${color}" stroke-width="${w}"/>`;

const HEART = 'M32 55 C14 43 6 33 6 22 C6 13 13 8 20 8 C26 8 30 12 32 16 C34 12 38 8 44 8 C51 8 58 13 58 22 C58 33 50 43 32 55 Z';
const FLAME = 'M32 4 C38 14 50 19 50 35 C50 49 42 59 32 59 C22 59 14 49 14 35 C14 25 21 21 22 12 C26 16 28 18 30 19 C30 12 30 8 32 4 Z';
const FLAME_IN = 'M32 26 C36 32 42 36 41 45 C40 51 36 55 32 55 C28 55 23 51 23 45 C23 38 30 34 32 26 Z';
const BAT_H =
  `<path d="M13 29 H27 C33 29 38 25.5 46 25.5 C54 25.5 58.5 28 58.5 32 C58.5 36 54 38.5 46 38.5 C38 38.5 33 35 27 35 H13 Z" fill="${WOOD}"/>` +
  `<rect x="12" y="28.5" width="11" height="7" rx="1.5" fill="${HOT}"/><circle cx="9" cy="32" r="4.5" fill="${WOOD}"/>`;

function ngon(cx, cy, r, n, rot = -Math.PI / 2) {
  let d = '';
  for (let i = 0; i < n; i++) d += (i ? 'L' : 'M') + polar(cx, cy, r, rot + (i * TAU) / n);
  return d + 'Z';
}
function frostNova() {
  let shards = '';
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6 + Math.PI / 12;
    shards += 'M' + polar(32, 32, 23.5, a - 0.14) + 'L' + polar(32, 32, 30.5, a) + 'L' + polar(32, 32, 23.5, a + 0.14) + 'Z';
  }
  let d = '';
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    d += 'M32 32 L' + polar(32, 32, 20.5, a) + 'M' + polar(32, 32, 19, a - 0.45) + 'L' + polar(32, 32, 12.2, a) + 'L' + polar(32, 32, 19, a + 0.45);
  }
  return `<path d="${shards}" fill="${SURF}" stroke-width="2.5"/>${line2(d, '#E6FCFF', 3.5)}<path d="${ngon(32, 32, 6.5, 6)}" fill="${SURF}" stroke-width="3"/>`;
}
// cute raptor head in profile (facing right); `under` draws behind the head, `over` on top (hats, shades)
const RHEAD = 'M14 64 C13 56 13 49 15 44 C12 34 16 22 27 18 C37 14 48 17 54 24 C58 28 61 32 60 37 C59 44 52 49 42 50 C37 51 34 55 33 64 Z';
function raptor(body, dark, belly, o = {}) {
  return svg(
    (o.under || '') +
      `<path d="${RHEAD}" fill="${body}"/><path d="M33 64 C34 56 37 52.5 42 50.5 C41 55 40.5 59 41.5 64 Z" fill="${belly}" stroke="none"/>` +
      `<path d="M17 32 L23 35 M15 40 L21 41.5 M19.5 25 L24.5 28.5" stroke="${dark}" stroke-width="3.5"/><path d="${RHEAD}"/>` +
      `<path d="M38 43 C45 44.5 52 43 57.5 39.5" stroke-width="3"/><path d="M43.5 44 L45 46.8 L46.5 44.2 Z M49.5 43.3 L50.9 45.9 L52.2 42.8 Z" fill="#fff" stroke-width="1.8"/>` +
      `<circle cx="55.5" cy="30" r="1.7" fill="${INK}" stroke="none"/><ellipse cx="47.5" cy="38" rx="3.2" ry="2" fill="#FF7FB2" opacity=".8" stroke="none"/>` +
      (o.noEye ? '' : `<ellipse cx="39" cy="31" rx="6" ry="7" fill="#fff" stroke-width="3"/><circle cx="40.8" cy="31.8" r="3.5" fill="${INK}" stroke="none"/><circle cx="42.2" cy="29.9" r="1.3" fill="#fff" stroke="none"/>`) +
      (o.over || '')
  );
}

const BASE_ICONS = {
  // weapons
  bat: svg(`<g transform="rotate(-45 32 32)">${BAT_H}</g><path d="M55 13 L61 14 M51 7 L52 1 M58 7 L62 3" stroke="${VOLT}" stroke-width="3.5"/>`),
  pebble: svg(
    `<path d="M32 3 V10 M32 54 V61 M3 32 H10 M54 32 H61 M11.5 11.5 L16.5 16.5 M52.5 11.5 L47.5 16.5 M11.5 52.5 L16.5 47.5 M52.5 52.5 L47.5 47.5" stroke="${VOLT}" stroke-width="4"/>` +
      `<circle cx="32" cy="32" r="16" fill="${SURF}"/><circle cx="32" cy="32" r="9" fill="#BFF8FF" stroke="none"/><circle cx="27" cy="27" r="4" fill="#fff" stroke="none"/>`
  ),
  saw: svg(`<path d="${sawPath(32, 32, 29, 20, 14)}" fill="${STEEL}"/><circle cx="32" cy="32" r="11" fill="${HOT}"/><circle cx="32" cy="32" r="4" fill="${INK}"/>`),
  zap: svg(`<path d="M38 3 L13 37 H30 L23 61 L51 25 H34 L43 3 Z" fill="${VOLT}"/><path d="M35 11 L24 27" stroke="#fff" stroke-width="3"/>`),
  hotfeet: svg(
    `<path d="${FLAME}" fill="${SUN}"/><path d="${FLAME_IN}" fill="${VOLT}" stroke="none"/>` +
      `<ellipse cx="32" cy="45" rx="8" ry="10" fill="${PAPER}" stroke-width="3"/><circle cx="24.5" cy="31" r="3" fill="${PAPER}" stroke-width="2.5"/>` +
      `<circle cx="30" cy="28" r="3.2" fill="${PAPER}" stroke-width="2.5"/><circle cx="36" cy="28" r="3" fill="${PAPER}" stroke-width="2.5"/><circle cx="40.5" cy="31.5" r="2.6" fill="${PAPER}" stroke-width="2.5"/>`
  ),
  banana: svg(
    `<path d="M40 7 A24 24 0 0 1 58 24" stroke="${SURF}" stroke-width="3.5"/>` +
      `<path d="M8 17 C11 43 34 57 57 46 C53 43 50.5 40 49.5 36 C34 42 20 32 18 15 C15 12 10 12 8 17 Z" fill="${VOLT}"/>` +
      `<path d="M13 23 C17 38 28 47 43 47" stroke="#E8A80C" stroke-width="3"/><circle cx="11" cy="15" r="3.2" fill="#7A4B22" stroke-width="2.5"/><circle cx="55.5" cy="44.5" r="3" fill="#7A4B22" stroke-width="2.5"/>`
  ),
  meteor: svg(
    `<path d="M24 31 L53 3 L46 21 L61 15 L39 44 Z" fill="${SUN}"/><path d="M31 32 L48 15 L44 26 L54 23 L39 39 Z" fill="${VOLT}" stroke="none"/>` +
      `<path d="M23 25 C33 23 43 32 41 44 C39 56 26 61 16 55 C8 49 7 37 13 30 C16 27 19 26 23 25 Z" fill="#7B6A9E"/>` +
      `<circle cx="19" cy="40" r="3.6" fill="#5A4A7A" stroke="none"/><circle cx="30" cy="49" r="2.6" fill="#5A4A7A" stroke="none"/><circle cx="31" cy="35" r="2" fill="#5A4A7A" stroke="none"/>`
  ),
  aura: svg(
    `<path d="M22 17 C19 14 25 11 22 6 M33 15 C30 12 36 9 33 4 M44 17 C41 14 47 11 44 6" stroke="${LIME}" stroke-width="3.5"/>` +
      `<path d="M14 52 C6 52 5 40 13 38 C11 28 22 23 29 29 C32 20 46 20 48 30 C57 29 60 40 54 44 C58 50 53 54 48 52 Z" fill="${LIME}"/>` +
      `<path d="M22 40 L27 42 M42 40 L37 42" stroke-width="3"/><path d="M27 48 C30 45 34 45 37 48" stroke-width="3"/>`
  ),
  quake: svg(
    `<path d="M4 44 L10 46 M3 35 L9 38 M60 40 L55 42" stroke="${VOLT}" stroke-width="3.5"/>` +
      `<path d="M21 6 H38 V32 L50 36 C56 38 58 42 58 46 V48 H16 V28 C16 22 20 20 21 14 Z" fill="${SUN}"/><path d="M21 14 H38" stroke-width="3"/>` +
      `<rect x="13" y="47" width="48" height="8" rx="2.5" fill="${PAPER}"/><path d="M14 61 L20 57 L26 61 L32 57 L38 61 L44 57 L50 61" stroke="${VOLT}" stroke-width="3"/>`
  ),
  lance: svg(
    `<g transform="rotate(-35 32 32)"><path d="M1 26 H9 M0 38 H7" stroke="${SURF}" stroke-width="3.5"/>` +
      `<rect x="8" y="28" width="38" height="8" rx="3" fill="${SURF}"/><path d="M44 21 L63 32 L44 43 Z" fill="${PAPER}"/>` +
      `<ellipse cx="20" cy="32" rx="3.5" ry="11" stroke="${VOLT}" stroke-width="3"/><ellipse cx="31" cy="32" rx="3" ry="8.5" stroke="${VOLT}" stroke-width="3"/></g>`
  ),
  // charms (internal kind 'tome')
  might: svg(
    `<path d="M52 9 L58 3 M55 18 H62 M46 6 L47 1" stroke="${VOLT}" stroke-width="3.5"/><rect x="20" y="44" width="24" height="15" rx="3" fill="${HOT}"/>` +
      `<rect x="11" y="15" width="40" height="31" rx="9" fill="${SUN}"/><path d="M21 15 V27 M31 15 V27 M41 15 V27" stroke-width="3.5"/><path d="M11 31 C19 29 28 31 30 38" stroke-width="3.5"/>`
  ),
  haste: svg(
    `${line2('M3 22 H15', SURF, 3.5)}${line2('M2 32 H13', SURF, 3.5)}${line2('M5 42 H15', SURF, 3.5)}<path d="M34 5 H44 M39 5 V11"/>` +
      `<circle cx="39" cy="33" r="21" fill="${PAPER}"/><circle cx="39" cy="33" r="15" stroke="${SURF}" stroke-width="3"/><path d="M39 22 V33 L47 39" stroke-width="4.5"/>`
  ),
  multishot: svg(
    ['-32', '0', '32']
      .map((a, i) => `<g transform="rotate(${a} 32 58)">${line2('M32 57 V22', PAPER, 3.5)}<path d="M24 24 L32 8 L40 24 Z" fill="${[SUN, VOLT, SURF][i]}"/></g>`)
      .join('')
  ),
  size: svg(
    `${line2('M22 22 L11 11 M42 22 L53 11 M22 42 L11 53 M42 42 L53 53', PAPER, 3.5)}` +
      `<path d="M4 20 V4 H20 Z M60 20 V4 H44 Z M4 44 V60 H20 Z M60 44 V60 H44 Z" fill="${VOLT}"/><rect x="21" y="21" width="22" height="22" rx="3" fill="${SURF}"/>`
  ),
  zoomies: svg(
    `${line2('M2 25 H11', SURF, 3.5)}${line2('M4 34 H12', SURF, 3.5)}${line2('M2 43 H10', SURF, 3.5)}` +
      `<path d="M19 16 C25 16 27 25 35 26 L46 28 C55 30 61 35 61 42 V46 H15 V21 C15 18 17 16 19 16 Z" fill="${HOT}"/>` +
      `<path d="M27 23 L31 19 M33 26 L37 22" stroke="${PAPER}" stroke-width="3"/><path d="M16 36 C24 36 30 40 37 40" stroke="${PAPER}" stroke-width="3"/>` +
      `<rect x="13" y="44" width="50" height="9" rx="4" fill="${PAPER}"/>`
  ),
  magnet: svg(
    `<path d="M19 12 V32 A13 13 0 0 0 45 32 V12" stroke-width="22" stroke-linecap="butt"/><path d="M19 12 V32 A13 13 0 0 0 45 32 V12" stroke="${HOT}" stroke-width="14" stroke-linecap="butt"/>` +
      `<rect x="11" y="5" width="16" height="10" rx="1.5" fill="${STEEL}" stroke-width="3.5"/><rect x="37" y="5" width="16" height="10" rx="1.5" fill="${STEEL}" stroke-width="3.5"/>` +
      `<path d="M3 26 L8 28 M56 28 L61 26 M4 38 L8 37 M56 37 L60 38" stroke="${SURF}" stroke-width="3"/>`
  ),
  vitality: svg(`<path d="${HEART}" fill="${HOT}"/><path d="M14 20 C14 16 17 14 21 14" stroke="#fff" stroke-width="3.5"/>`),
  regen: svg(`<path d="${HEART}" fill="${LIME}"/><path d="M28 19 H36 V27 H44 V35 H36 V43 H28 V35 H20 V27 H28 Z" fill="${PAPER}" stroke-width="3"/>`),
  crit: svg(
    `<circle cx="32" cy="32" r="22" fill="${PAPER}"/><circle cx="32" cy="32" r="14" fill="${HOT}"/><circle cx="32" cy="32" r="6" fill="${PAPER}"/>` +
      line2('M32 2 V14 M32 50 V62 M2 32 H14 M50 32 H62', VOLT, 3.5)
  ),
  luck: svg(
    `${line2('M33 38 C37 47 43 53 52 58', GREEN, 4)}<circle cx="23" cy="22" r="10" fill="${GREEN}"/><circle cx="41" cy="22" r="10" fill="${GREEN}"/>` +
      `<circle cx="23" cy="40" r="10" fill="${GREEN}"/><circle cx="41" cy="40" r="10" fill="${GREEN}"/><circle cx="32" cy="31" r="7.5" fill="#46BE4C" stroke="none"/>` +
      `<path d="M18 19 C19 16 22 15 24 15" stroke="#fff" stroke-width="3"/>`
  ),
  wisdom: svg(
    `<path d="M6 15 C14 11 24 11 32 17 C40 11 50 11 58 15 V52 C50 48 40 48 32 54 C24 48 14 48 6 52 Z" fill="${PAPER}"/><path d="M32 17 V54"/>` +
      `<path d="M11 24 C16 22 22 22 27 24 M11 32 C16 30 22 30 27 32 M11 40 C16 38 22 38 27 40 M37 24 C42 22 48 22 53 24 M37 32 C42 30 48 30 53 32" stroke="${PURPLE}" stroke-width="3"/>` +
      `<path d="${starPath(49, 44, 8, 3, 4)}" fill="${VOLT}" stroke-width="2.5"/>`
  ),
  springs: svg(
    `${line2('M18 50 L46 44 L18 37 L46 30 L18 23 L46 17', VOLT, 5)}<rect x="11" y="6" width="42" height="8" rx="2.5" fill="${STEEL}"/><rect x="11" y="50" width="42" height="8" rx="2.5" fill="${STEEL}"/>`
  ),
  armor: svg(
    `<path d="M32 5 L54 13 V30 C54 44 44 54 32 59 C20 54 10 44 10 30 V13 Z" fill="${BLUE}"/><path d="M32 12 L47 17.5 V30 C47 40 41 47 32 51 Z" fill="${SURF}" stroke="none"/>` +
      `<path d="${starPath(32, 31, 10, 4.2, 5)}" fill="${VOLT}" stroke-width="3"/>`
  ),
  momentum: svg(
    `<path d="M5 47 A27 27 0 0 1 59 47 Z" fill="${NIGHT}"/>` +
      `<path d="M13 46 A19 19 0 0 1 18.6 32.6" stroke="${SURF}" stroke-width="7" stroke-linecap="butt"/>` +
      `<path d="M18.6 32.6 A19 19 0 0 1 32 27" stroke="${VOLT}" stroke-width="7" stroke-linecap="butt"/>` +
      `<path d="M32 27 A19 19 0 0 1 45.4 32.6" stroke="${SUN}" stroke-width="7" stroke-linecap="butt"/>` +
      `<path d="M45.4 32.6 A19 19 0 0 1 51 46" stroke="${HOT}" stroke-width="7" stroke-linecap="butt"/>` +
      `${line2('M32 46 L46 29', PAPER, 3.5)}<circle cx="32" cy="46" r="5" fill="${SUN}" stroke-width="3"/><path d="M5 47 H59"/>`
  ),
  // misc
  skull: svg(
    `<path d="M32 6 C17 6 9 16 9 29 C9 37 13 42 19 44 V52 C19 55 21 57 24 57 H40 C43 57 45 55 45 52 V44 C51 42 55 37 55 29 C55 16 47 6 32 6 Z" fill="${PAPER}"/>` +
      `<ellipse cx="23" cy="30" rx="6" ry="7" fill="${INK}" stroke="none"/><ellipse cx="41" cy="30" rx="6" ry="7" fill="${INK}" stroke="none"/>` +
      `<path d="M32 37 L28.5 43 H35.5 Z" fill="${INK}" stroke-width="2"/><path d="M27 50 V57 M32 50 V57 M37 50 V57" stroke-width="3"/>`
  ),
  coin: svg(
    `<circle cx="32" cy="32" r="25" fill="${VOLT}"/><circle cx="32" cy="32" r="17" fill="#FFC21A" stroke-width="3"/>` +
      `<path d="${starPath(32, 33, 10, 4.5, 5)}" fill="${VOLT}" stroke-width="3"/><path d="M15 23 C17 18 21 14 26 12" stroke="#fff" stroke-width="3.5"/>`
  ),
  heal: svg(`<path d="M24 7 H40 V24 H57 V40 H40 V57 H24 V40 H7 V24 H24 Z" fill="${LIME}"/><path d="M29 12 V27" stroke="#fff" stroke-width="3"/>`),
  star: svg(`<path d="${starPath(32, 34, 28, 12.5, 5)}" fill="${VOLT}"/><path d="M29 19 L26 27" stroke="#fff" stroke-width="3"/>`),
  fire: svg(`<path d="${FLAME}" fill="${SUN}"/><path d="${FLAME_IN}" fill="${VOLT}" stroke="none"/>`),
  ram: svg(
    `${line2('M3 20 H17 M2 32 H14 M4 44 H16', SURF, 3.5)}<path d="${starPath(38, 32, 25, 13, 9, -0.2)}" fill="${VOLT}"/>` +
      `<path d="${starPath(38, 32, 13, 7, 7, 0.3)}" fill="${HOT}" stroke-width="3"/>`
  ),
  challenge: svg(`<g transform="rotate(-45 32 32)">${BAT_H}</g><g transform="rotate(-135 32 32)">${BAT_H}</g>`),

  /* ---------------- THE ARCHIPELAGO ---------------- */
  // weapons
  frost: svg(frostNova()),
  blackhole: svg(
    `<path d="M50 7 L52 3 M56 12 L60 10 M8 52 L4 55" stroke="${SURF}" stroke-width="3"/>` +
      `<ellipse cx="32" cy="34" rx="29" ry="11.5" transform="rotate(-16 32 34)" fill="${PURPLE}"/>` +
      `<ellipse cx="32" cy="34" rx="20" ry="6.2" transform="rotate(-16 32 34)" fill="${HOT}" stroke="none"/>` +
      `<circle cx="32" cy="31" r="14.5" fill="#0B0820"/><circle cx="32" cy="31" r="10" stroke="#3A2A7A" stroke-width="2.5"/>` +
      line2('M4.1 42 A29 11.5 -16 0 0 59.9 26', SUN, 4) +
      `<path d="M13 41.5 C24 44.5 40 41 51 32" stroke="${VOLT}" stroke-width="2.2"/><circle cx="25" cy="25" r="2" fill="#fff" stroke="none"/>`
  ),
  // shrines
  blessing: svg(
    `${line2('M32 1.5 V7 M6 14 L11 18 M58 14 L53 18', VOLT, 3.2)}<path d="M20 11 H44 L55 25 L32 58 L9 25 Z" fill="${SURF}"/>` +
      `<path d="M20 11 L26 25 L32 11 Z" fill="#BFF8FF" stroke="none"/><path d="M9 25 H55 M20 11 L26 25 L32 58 L38 25 L44 11 M26 25 L32 11 L38 25" stroke-width="3"/>` +
      `<path d="M14 26 L25 44" stroke="#fff" stroke-width="3"/>`
  ),
  // Amber Obelisk: faceted glowing amber crystal with a tiny fossil (ammonite) trapped inside
  amber: svg(
    `<circle cx="32" cy="32" r="27" fill="${AMBER}" opacity=".2" stroke="none"/>${line2('M8 18 L13 21.5 M56 18 L51 21.5 M5 34 H11 M59 34 H53', VOLT, 3)}` +
      `<rect x="14" y="53" width="36" height="8.5" rx="2.5" fill="#7B6A9E"/><path d="M18 57.5 H46" stroke="#5A4A7A" stroke-width="2.5"/>` +
      `<path d="M21 54 L24 17 L32 3.5 L40 17 L43 54 Z" fill="${AMBER}"/>` +
      `<path d="M32 3.5 L40 17 L43 54 H32 L32 21 Z" fill="#E8820F" stroke="none"/><path d="M24 17 L32 3.5 V21 Z" fill="#FFE39A" stroke="none"/>` +
      `<path d="M21 54 L24 17 L32 3.5 L40 17 L43 54 Z"/><path d="M24 17 L32 21 L40 17 M32 21 V27 M32 47 V54" stroke="#9A4E05" stroke-width="2.4"/>` +
      `<circle cx="32" cy="37" r="7.5" fill="#FFCB5C" stroke="none" opacity=".75"/>` +
      `<path d="M32.4 37.6 C31 38.2 30 36.8 31 35.8 C32.4 34.6 34.6 35.8 34.4 37.8 C34.2 40.4 30.8 41.4 28.9 39.6 C26.6 37.3 27.8 33.2 31.2 32.6 C35 32 38 34.8 37.8 38.4" stroke="#6B3405" stroke-width="2"/>` +
      `<path d="M27 24 L25.3 44" stroke="#fff" stroke-width="2.6"/><path d="M36.5 8.5 L38.5 12" stroke="#fff" stroke-width="2"/>`
  ),
  totem: svg(
    `<path d="M24 16 L2 9 L7 18 L2 24.5 L22 26 Z M40 16 L62 9 L57 18 L62 24.5 L42 26 Z" fill="${SUN}"/>` +
      `<rect x="19" y="7" width="26" height="54" rx="4" fill="${WOOD}"/><path d="M19 12.5 H45 M19 39 H45" stroke-width="3.5"/>` +
      `<path d="M23 16.5 L30 19.5 M41 16.5 L34 19.5" stroke-width="3.5"/><circle cx="27" cy="23.5" r="2.6" fill="${INK}" stroke="none"/><circle cx="37" cy="23.5" r="2.6" fill="${INK}" stroke="none"/>` +
      `<rect x="24.5" y="28.5" width="15" height="6.5" rx="1" fill="${HOT}" stroke-width="3"/><path d="M29.5 28.5 V35 M34.5 28.5 V35" stroke-width="2"/>` +
      `<circle cx="27" cy="46" r="4" fill="${PAPER}" stroke-width="3"/><circle cx="37" cy="46" r="4" fill="${PAPER}" stroke-width="3"/><circle cx="27.8" cy="46.4" r="1.6" fill="${INK}" stroke="none"/><circle cx="37.8" cy="46.4" r="1.6" fill="${INK}" stroke="none"/>` +
      `<path d="M25 54 C29 57 35 57 39 54" stroke-width="3.5"/>`
  ),
  greed: svg(
    `<ellipse cx="13" cy="56" rx="9" ry="4.5" fill="${VOLT}"/><ellipse cx="51" cy="56" rx="9" ry="4.5" fill="${VOLT}"/>` +
      `<path d="M16 59 C15 45 17 31 22 23 C25 17 28 14 32 14 C36 14 39 17 42 23 C47 31 49 45 48 59 Z" fill="#FFC21A"/>` +
      `<path d="M22 21 L17.5 6 L26.5 13.5 L32 2.5 L37.5 13.5 L46.5 6 L42 21 C36 18.5 28 18.5 22 21 Z" fill="${VOLT}"/>` +
      `<circle cx="26" cy="32" r="3.8" fill="${HOT}" stroke-width="2.5"/><circle cx="38" cy="32" r="3.8" fill="${HOT}" stroke-width="2.5"/>` +
      `<path d="M22 41 C27 48 37 48 42 41 Z" fill="${INK}" stroke-width="3"/><path d="M26 42.8 H38" stroke="#fff" stroke-width="2"/>` +
      `<path d="M20.5 52 C19.5 44 20.5 35 23.5 29" stroke="#fff" stroke-width="3"/>`
  ),
  pylon: svg(
    `${line2('M10 30 C5.5 37 5.5 45 10 52 M54 30 C58.5 37 58.5 45 54 52', SURF, 3)}${line2('M16 36 C14 40 14 44 16 48 M48 36 C50 40 50 44 48 48', SURF, 2.5)}` +
      `<path d="M23.5 61 L27 31 H37 L40.5 61 Z" fill="${STEEL}"/><path d="M26 41 H38 M25 51 H39" stroke="${PURPLE}" stroke-width="3"/>` +
      `<path d="M21 6 V15 A11 11 0 0 0 43 15 V6" stroke-width="15" stroke-linecap="butt"/><path d="M21 6 V15 A11 11 0 0 0 43 15 V6" stroke="${HOT}" stroke-width="8" stroke-linecap="butt"/>` +
      `<rect x="14.5" y="2" width="13" height="7.5" rx="1.5" fill="${STEEL}" stroke-width="3"/><rect x="36.5" y="2" width="13" height="7.5" rx="1.5" fill="${STEEL}" stroke-width="3"/>`
  ),
  // characters: raptor head portraits
  rex: raptor('#2EC4B6', '#138A80', '#C8F7EC', {
    over:
      `<path d="M14.5 27 C13.5 15 22 7 33 7 C43 7 50.5 12 52.5 20 L61.5 21.5 C63 23.5 62 25.5 59.5 25.5 L15 27.5 Z" fill="${SUN}"/>` +
      `<path d="M21 15.5 C24 11.8 29 10 34 10" stroke="#FFC78A" stroke-width="3"/><circle cx="24" cy="21.5" r="3" fill="${INK}" stroke="none"/>`,
  }),
  zappy: raptor('#3DA5FF', '#1F6FC2', '#D2ECFF', {
    over:
      `<path d="M20 19 C23 11 20.5 5 12 1.5 C23 0.5 34 5 41 11 C44 14 45.5 16.5 46 19 Z" fill="${PURPLE}"/>` +
      `<ellipse cx="33.5" cy="20" rx="20" ry="4.6" transform="rotate(-9 33.5 20)" fill="${PURPLE}"/>` +
      `<path d="${starPath(30.5, 12, 4.6, 2, 5)}" fill="${VOLT}" stroke-width="2"/>${line2('M59 4 L55 10.5 H60 L56 17', VOLT, 2.5)}`,
  }),
  nana: raptor('#F7C531', '#D39A00', '#FFF4C2', {
    over:
      `<path d="M11.5 26 C13.5 12 30 4.5 48.5 9.5 C52.5 10.5 53.5 14.5 50.5 15.2 C35.5 12.5 23 17.5 17 28.5 Z" fill="#FFEE70"/>` +
      `<path d="M15.5 21 C20 13 32 9.5 44 10.8" stroke="#E8A80C" stroke-width="2.5"/><circle cx="51.8" cy="12.6" r="2.7" fill="#7A4B22" stroke-width="2"/>` +
      `<path d="M11.5 26 L7.5 28.5" stroke-width="6"/><path d="M11.5 26 L7.5 28.5" stroke="#8CC63F" stroke-width="2.5"/>`,
  }),
  blaze: raptor('#FF6A3D', '#C2381A', '#FFD6BE', {
    under:
      `<path d="M16 27 C11 20 12 12 17 6 C17 12 20 15 23 16 C22 9 26 3.5 32 1 C30 8 33 12 37 13.5 C38 9.5 41 7 45 6 C43 11 45 15 48 18 L22 24 Z" fill="${SUN}"/>` +
      `<path d="M21 21 C19 17 20 13.5 22 11 C23 14 25 16 28 17 C27.5 13 29.5 10 32.5 8.5 C32.5 12.5 34.5 15 38 16.5 Z" fill="${VOLT}" stroke="none"/>`,
    over:
      `<path d="M16.5 23.5 L30 20.5" stroke-width="7"/><path d="M16.5 23.5 L30 20.5" stroke="${HOT}" stroke-width="3"/>` +
      `<circle cx="36.5" cy="18.5" r="7.5" fill="${STEEL}"/><circle cx="36.5" cy="18.5" r="4.4" fill="${SURF}" stroke-width="2.5"/><path d="M34.2 16.8 L36 15" stroke="#fff" stroke-width="2"/>`,
  }),
  tank: raptor('#8A9A3B', '#5E6B22', '#DDE6AE', {
    over:
      `<path d="M21 12.5 C15 4.5 7 4 2.5 9 C7.5 9 10.5 12 11.5 16 C8.5 16 5.5 18 4.5 22 C10.5 19 15.5 19 19.5 21 Z" fill="${HOT}"/>` +
      `<path d="M13 31.5 C12 18 21 9 33 9 C44 9 51 15 53 23.5 L53 26.5 L14 32.5 Z" fill="${STEEL}"/>` +
      `<path d="M25.5 13.5 C35 9.5 46 12 52 19 L53 23 C45 18 35 16 26.5 18.5 Z" fill="#B3ACC8"/><path d="M33 14.5 H45" stroke-width="2"/>` +
      `<circle cx="18" cy="25.5" r="1.8" fill="${INK}" stroke="none"/><circle cx="19.6" cy="19" r="1.8" fill="${INK}" stroke="none"/><path d="M17 14.5 C19 12.5 22 11 25 10.5" stroke="#fff" stroke-width="2.5"/>`,
  }),
  goldie: raptor('#FFC21A', '#D18A00', '#FFF1B8', {
    noEye: true,
    over:
      `<path d="M20 18 L17.5 4 L26 10.5 L32 1.5 L38 10.5 L46.5 5 L44 19 C36 16 28 16 20 18 Z" fill="${VOLT}"/>` +
      `<circle cx="32" cy="12.5" r="2.3" fill="${HOT}" stroke-width="1.8"/><circle cx="24.5" cy="14.3" r="1.8" fill="${SURF}" stroke-width="1.6"/><circle cx="39.5" cy="13.8" r="1.8" fill="${SURF}" stroke-width="1.6"/>` +
      `<path d="M15.5 30.5 L30 28.5" stroke-width="3.5"/><path d="M29.5 26.5 H50 C50 33 47.5 37 41.5 37 C35.5 37 29.5 33.5 29.5 26.5 Z" fill="${INK}" stroke-width="3"/>` +
      `<path d="M33.5 29.5 L38 29.5 M44 29.5 L46 29.5" stroke="#fff" stroke-width="2"/>`,
  }),
  // islands (prefixed: plain 'frost' is the Frost Nova weapon)
  'island-tropical': svg(
    `${line2('M3 56 C7 53 11 59 15 56 M49 56 C53 53 57 59 61 56', SURF, 3)}<path d="M9 54 C15 44 49 44 55 54 Z" fill="#F1DB9C"/>` +
      `<path d="M31 51 C30 41 31 31 37 22" stroke-width="9"/><path d="M31 51 C30 41 31 31 37 22" stroke="${WOOD}" stroke-width="4.5"/>` +
      `<path d="M37 22 C31 13 20 13 12 20 C21 19 29 20 37 22 Z M37 22 C38 12 47 6.5 57 9.5 C49.5 12.5 43.5 16 37 22 Z M37 22 C45.5 18 55.5 21 59.5 30.5 C51.5 26 44 24 37 22 Z M37 22 C31 24.5 25 30 23.5 37.5 C29 30.5 33 26.5 37 22 Z" fill="${GREEN}"/>` +
      `<circle cx="34.5" cy="25.5" r="2.9" fill="#7A4B22" stroke-width="2.5"/><circle cx="39.5" cy="26" r="2.9" fill="#7A4B22" stroke-width="2.5"/>`
  ),
  'island-frost': svg(
    `<path d="M3 57 L20 27 L28 38 L40 13 L61 57 Z" fill="#A9C4E6"/><path d="M40 13 L61 57 H45 L47 33 Z" fill="#7F9CC7" stroke="none"/><path d="M3 57 L20 27 L28 38 L40 13 L61 57 Z"/>` +
      `<path d="M40 13 L48.8 31.5 L44.2 29.5 L40.5 33.8 L36.5 28.5 L32.6 30.8 Z M20 27 L25.3 36.4 L22.6 35.2 L19.6 38.2 L16.6 34.2 Z" fill="#fff" stroke-width="3"/>` +
      `<path d="${starPath(13, 13, 7, 2.2, 4)}" fill="#E6FCFF" stroke-width="2.5"/><path d="${starPath(55, 22, 4, 1.4, 4)}" fill="#E6FCFF" stroke-width="2"/>`
  ),
  'island-desert': svg(
    `<circle cx="44" cy="19" r="11.5" fill="${VOLT}"/><path d="M40 13 C42 11.5 44 11 46 11" stroke="#fff" stroke-width="3"/>` +
      `<path d="M22 46 C32 33 47 31 62 40 V58 H22 Z" fill="#E59E4F"/><path d="M2 58 C9 43 26 40 40 50 C46 54 54 54 62 52 V58 Z" fill="#F7C97F"/>` +
      `<path d="M16 52 V29 C16 25 22 25 22 29 V36 H25 V31.5 C25 28.5 29 28.5 29 31.5 V37.5 C29 40 27.5 41.5 25 41.5 H22 V52 Z M16 41 H13 C11 41 10 40 10 38 V33 C10 30 14 30 14 33 V36 H16" fill="${GREEN}"/>`
  ),
  'island-grave': svg(
    `<path d="M49 4 C41 6.5 38 16.5 43 23 C47 28 55 28 59 23.5 C53 24 47 20 46 14 C45.5 10 46.5 6.5 49 4 Z" fill="#FFF3C4"/>` +
      `<path d="M3 58 C8 46 22 42 34 44 C46 46 56 50 61 58 Z" fill="#3E6A64"/>` +
      `<path d="M20 50 V27 C20 18.5 37 18.5 37 27 V50 Z" fill="#B7B0C8"/><path d="M28.5 26.5 V41 M23.5 31.5 H33.5" stroke-width="3.5"/>` +
      `<path d="M43 45 V36.5 C43 30.5 54 30.5 54 36.5 V46 L51.3 43.8 L48.5 46 L45.7 43.8 Z" fill="${PAPER}" stroke-width="3"/>` +
      `<circle cx="46.7" cy="37.3" r="1.4" fill="${INK}" stroke="none"/><circle cx="50.5" cy="37.3" r="1.4" fill="${INK}" stroke="none"/>` +
      `<path d="M9 52 L11 47.5 L13 52 M55 54 L57 49.5 L59 54" stroke="${PURPLE}" stroke-width="2.5"/>`
  ),
  'island-volcano': svg(
    `<circle cx="27" cy="10" r="6.5" fill="#7B6A9E"/><circle cx="37" cy="7" r="5.5" fill="#7B6A9E"/><circle cx="31" cy="15" r="4.5" fill="#7B6A9E" stroke="none"/>` +
      `<path d="M3 59 L23 25 H41 L61 59 Z" fill="#5A2A20"/><path d="M41 25 L61 59 H47 L37 32 Z" fill="#3A1812" stroke="none"/><path d="M3 59 L23 25 H41 L61 59 Z"/>` +
      `<path d="M23 25 H41 L38.5 31 L36 36.5 L33.8 30.5 L31 43 L28 30.5 L26 34 Z" fill="${SUN}" stroke-width="3"/><path d="M26 26 H38" stroke="${VOLT}" stroke-width="2.5"/>` +
      `<circle cx="16" cy="18" r="2" fill="${VOLT}" stroke="none"/><circle cx="48" cy="15" r="2.4" fill="${SUN}" stroke="none"/><circle cx="52" cy="24" r="1.6" fill="${VOLT}" stroke="none"/>`
  ),
  // misc
  portal: svg(
    `<ellipse cx="32" cy="33" rx="22.5" ry="28.5" fill="#6B5AA8"/><ellipse cx="32" cy="34" rx="15.5" ry="21" fill="${PURPLE}"/>` +
      `<ellipse cx="32" cy="35" rx="9" ry="13" fill="#E3B8FF" stroke="none" opacity=".55"/>` +
      line2('M32 35 C35.5 35 36.5 30.5 33 29 C28 27 24.5 32.5 26 37 C28.5 43.5 38 44 41 36.5 C43.5 28 37 19.5 28.5 21', SURF, 3) +
      `<path d="M12.5 21 L15.5 23 M10.5 33 H14 M12.5 45 L15.5 43 M51.5 21 L48.5 23 M53.5 33 H50 M51.5 45 L48.5 43" stroke="${VOLT}" stroke-width="2.5"/>`
  ),
  lock: svg(
    `<path d="M20 30 V20 C20 12 25.5 7 32 7 C38.5 7 44 12 44 20 V30" stroke-width="11"/><path d="M20 30 V20 C20 12 25.5 7 32 7 C38.5 7 44 12 44 20 V30" stroke="${STEEL}" stroke-width="5"/>` +
      `<rect x="12" y="27" width="40" height="31" rx="6" fill="${VOLT}"/><path d="M17.5 33 V41" stroke="#fff" stroke-width="3"/>` +
      `<circle cx="32" cy="40" r="4.6" fill="${INK}" stroke="none"/><path d="M30 42 L28.8 50.5 H35.2 L34 42 Z" fill="${INK}" stroke="none"/>`
  ),
  trophy: svg(
    `${line2('M17 13 H8.5 C8.5 25 13 30.5 20 31.5 M47 13 H55.5 C55.5 25 51 30.5 44 31.5', VOLT, 4)}` +
      `<path d="M16 5.5 H48 V20 C48 31 41 38 32 38 C23 38 16 31 16 20 Z" fill="${VOLT}"/><path d="M22 10.5 V21" stroke="#fff" stroke-width="3.5"/>` +
      `<path d="${starPath(33, 20, 7.5, 3.3, 5)}" fill="${SUN}" stroke-width="2.5"/><path d="M28 37 H36 L37.5 46.5 H26.5 Z" fill="#FFC21A"/>` +
      `<rect x="18.5" y="46" width="27" height="12" rx="2.5" fill="${SUN}"/><path d="M25 52 H39" stroke="${PAPER}" stroke-width="2.5"/>`
  ),
  quest: svg(
    `<rect x="15" y="9" width="34" height="44" rx="3" fill="${PAPER}"/><path d="M21 21 H43 M21 28 H43 M21 35 H33" stroke="#B9A98A" stroke-width="3"/>` +
      `<rect x="10" y="5" width="44" height="9" rx="4.5" fill="${WOOD}"/><rect x="10" y="49" width="44" height="9" rx="4.5" fill="${WOOD}"/>` +
      `<circle cx="44.5" cy="40.5" r="9" fill="${HOT}"/><path d="M44.5 35.5 V41.5" stroke="#fff" stroke-width="3.5"/><circle cx="44.5" cy="45.6" r="1.9" fill="#fff" stroke="none"/>`
  ),
  perk: svg(
    `<path d="M22 40 L16 61 L24 56 L29 62 L32 44 Z M42 40 L48 61 L40 56 L35 62 L32 44 Z" fill="${HOT}"/>` +
      `<path d="${ngon(32, 27, 23, 6)}" fill="${PURPLE}"/><path d="${ngon(32, 27, 15.5, 6)}" fill="#8E3FE0" stroke="none"/>` +
      line2('M22.5 31 L32 21.5 L41.5 31 M22.5 39 L32 29.5 L41.5 39', VOLT, 4)
  ),
  // THE LOST WORLD: fossil gate (T-rex skull), launch cannon, meteor crater
  fossil: svg(
    `<path d="M12 40.5 L50 38.5 C55 38.5 56.5 43 52.5 45.8 C44.5 50.8 29 52.8 19 50.8 C13.5 49.8 11 46 12 40.5 Z" fill="#D9C697"/>` +
      `<path d="M21 41 L23.2 36.4 L25.4 40.8 Z M29.5 40.6 L31.7 36 L33.9 40.3 Z M38 40 L40.2 35.6 L42.4 39.7 Z" fill="#fff" stroke-width="2"/>` +
      `<path d="M5 33 C4 21 13 11.5 27 10.5 C39 9.5 51 13.5 57 20.5 C60.5 24.5 60.5 30 56.5 32.5 C47 35.2 33 36.6 20 37.6 C13 38.1 6 37.6 5 33 Z" fill="${BONE}"/>` +
      `<path d="M9 31 C8.5 24 11.5 18.5 17 15" stroke="#CDB98A" stroke-width="3"/><path d="M14 20 L17.5 23.5 L15.5 27" stroke="#B8A273" stroke-width="2"/>` +
      `<path d="M25 37.4 L27.2 42.6 L29.4 37.1 Z M33.5 36.8 L35.7 41.8 L37.9 36.4 Z M42 35.9 L44.2 40.6 L46.4 35.3 Z M50 34.4 L51.9 38.6 L53.8 33.6 Z" fill="#fff" stroke-width="2"/>` +
      `<path d="M35 21.5 C39 18 46 18.5 48.5 22 C45.5 26 38.5 26.5 35 21.5 Z" fill="#5A4636" stroke-width="2.5"/><ellipse cx="54.5" cy="22.5" rx="2" ry="1.5" fill="#5A4636" stroke="none"/>` +
      `<ellipse cx="24" cy="23" rx="6.8" ry="6.3" fill="${INK}" stroke-width="2.5"/><circle cx="24.4" cy="23.6" r="3.6" fill="${AMBER}" stroke="none"/><circle cx="25.6" cy="22.2" r="1.4" fill="${VOLT}" stroke="none"/>`
  ),
  cannon: svg(
    `${line2('M54 3 L56 8 M61 11 L57 13', VOLT, 3)}` +
      `<g transform="rotate(-32 30 38)"><path d="M12 34 C7 33 4.5 29 5.5 24.5" stroke-width="3.5"/>` +
      `<rect x="11" y="28" width="40" height="19" rx="8" fill="${SURF}"/><rect x="45" y="24.5" width="11" height="26" rx="3.5" fill="${BLUE}"/>` +
      `<rect x="23" y="27" width="6" height="21" rx="1.5" fill="${VOLT}" stroke-width="3"/><path d="M15 33 H42" stroke="#fff" stroke-width="3"/>` +
      `<ellipse cx="56" cy="37.5" rx="2.2" ry="8" fill="${INK}" stroke="none"/><path d="${starPath(5.5, 22.5, 5.5, 2.4, 6)}" fill="${VOLT}" stroke-width="2"/></g>` +
      `<circle cx="31" cy="48" r="11" fill="${WOOD}"/><path d="M31 38 V58 M21 48 H41 M24 41 L38 55 M38 41 L24 55" stroke="#B8702E" stroke-width="2.5"/>` +
      `<circle cx="31" cy="48" r="11"/><circle cx="31" cy="48" r="3.8" fill="${HOT}" stroke-width="2.5"/><path d="M4 60 H60" stroke-width="3.5"/>`
  ),
  crater: svg(
    `${line2('M13 17 L17.5 23 M51 17 L46.5 23 M32 5 V13', VOLT, 3)}` +
      `<ellipse cx="32" cy="48" rx="29" ry="12" fill="#8A6A52"/><path d="M7 45 C12 40.5 19 38.5 26 38" stroke="#B89478" stroke-width="3"/>` +
      `<ellipse cx="32" cy="47" rx="20" ry="7" fill="#3A1812"/><ellipse cx="32" cy="47.5" rx="15" ry="4.4" fill="${SUN}" stroke="none"/>` +
      `<path d="M20.5 43 C18.5 33 24.5 25 33 25 C41.5 25 46 33 43.5 42 C41 48.5 23 49.5 20.5 43 Z" fill="#7B6A9E"/>` +
      `<path d="M25.5 34 L29.5 37.5 L27.5 42.5 M35 30 L37 35 L41 36.5" stroke="${VOLT}" stroke-width="2.5"/><circle cx="28" cy="30" r="2.2" fill="#9D8CC0" stroke="none"/>` +
      `<circle cx="9" cy="37" r="2.6" fill="#8A6A52" stroke-width="2.5"/><circle cx="56" cy="38.5" r="2" fill="#8A6A52" stroke-width="2.5"/>`
  ),
  check: svg(`<circle cx="32" cy="32" r="26" fill="${LIME}"/><path d="M18.5 33 L28 42.5 L46 22" stroke-width="9"/><path d="M18.5 33 L28 42.5 L46 22" stroke="#fff" stroke-width="3.5"/>`),
};
// plain island-name aliases ('frost' stays the weapon; use 'island-frost' for the island)
for (const b of ['tropical', 'desert', 'grave', 'volcano']) BASE_ICONS[b] = BASE_ICONS['island-' + b];
// stat / reward id aliases so Amber Obelisk stat cards etc. get a sensible icon
const ICON_ALIAS = {
  damage: 'might', dmg: 'might', attackspeed: 'haste', cooldown: 'haste', projectiles: 'multishot', area: 'size', speed: 'zoomies',
  movespeed: 'zoomies', pickup: 'magnet', hp: 'vitality', maxhp: 'vitality', health: 'vitality', heal: 'heal', crit: 'crit', xp: 'wisdom',
  jump: 'springs', gold: 'coin', greedidol: 'greed', shrine: 'blessing', island: 'portal', boss: 'skull', obelisk: 'amber', amberobelisk: 'amber', mutation: 'amber', ambermutation: 'amber',
  meteorcrater: 'crater', launchcannon: 'cannon', fossilgate: 'fossil', fossilecho: 'fossil', fossilboon: 'fossil', boon: 'fossil', charm: 'wisdom',
};
const iconKey = (id) => {
  if (typeof id !== 'string') return 'star';
  if (Object.prototype.hasOwnProperty.call(BASE_ICONS, id)) return id;
  const a = ICON_ALIAS[id.toLowerCase().replace(/[^a-z]/g, '')];
  return a && BASE_ICONS[a] ? a : 'star';
};

/** id -> inline SVG string. Unknown ids fall back to the generic star. */
export const ICONS = new Proxy(BASE_ICONS, {
  get(t, k) {
    if (k in t) return t[k];
    return typeof k === 'string' ? t[iconKey(k)] : undefined;
  },
});

const BURST = `<svg class="vb-burst" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><path d="${starPath(50, 50, 49, 36, 16)}" fill="currentColor" stroke="${INK}" stroke-width="4" stroke-linejoin="round"/></svg>`;
const _tpl = new Map();
function nodeFrom(key, html) {
  let t = _tpl.get(key);
  if (!t) {
    t = document.createElement('template');
    t.innerHTML = html;
    _tpl.set(key, t);
  }
  return t.content.firstChild.cloneNode(true);
}
const iconNode = (id) => {
  const key = iconKey(id);
  return nodeFrom(key, BASE_ICONS[key]);
};
const burstNode = () => nodeFrom('__burst', BURST);
function rewardIcon(rw) {
  if (!rw) return 'star';
  const id = rw.id;
  const has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(BASE_ICONS, k);
  switch (rw.kind) {
    case 'island':
      return 'island-' + (BIOMES[id] ? id : BIOME_ORDER[(+id | 0) - 1] || 'tropical');
    case 'perk':
      return has(id) ? id : 'perk';
    case 'shrine':
      return has(id) ? id : 'blessing';
    case 'character':
      return has(id) ? id : 'rex';
    case 'weapon':
      return has(id) ? id : 'bat';
    case 'boon':
      return has(id) ? id : 'fossil';
    case 'charm':
    case 'tome':
      return has(id) ? id : iconKey(id) !== 'star' ? iconKey(id) : 'wisdom';
  }
  return iconKey(id);
}
function islandMedal(biome, n, status) {
  const md = el('span', 'vb-md');
  md.style.setProperty('--bc', BIOMES[biome].c);
  md.style.setProperty('--bd', BIOMES[biome].d);
  md.append(iconNode('island-' + biome));
  if (n != null) md.append(el('span', 'vb-md-n', String(n)));
  if (status) {
    const st = el('span', 'vb-md-st');
    st.append(iconNode(status));
    md.append(st);
  }
  return md;
}

function flameStrip(seed, hmin, hvar) {
  // fat tongues that lean backwards (to the left) like they're being dragged by speed
  const n = 9;
  const step = 200 / n;
  let d = '';
  for (let i = 0; i < n; i++) {
    const r = ((i * 7 + seed * 5) % 6) / 5;
    const cx = (i + 0.5) * step + (r - 0.5) * step * 0.3;
    const hw = step * 0.78;
    const h = hmin + r * hvar;
    const lean = hw * 0.55;
    const y = 40 - h;
    d +=
      `M${f1(cx - hw)} 40 C${f1(cx - hw)} ${f1(40 - h * 0.45)} ${f1(cx - hw * 0.25 - lean * 0.4)} ${f1(40 - h * 0.72)} ${f1(cx - lean)} ${f1(y)}` +
      ` C${f1(cx + hw * 0.15)} ${f1(40 - h * 0.7)} ${f1(cx + hw)} ${f1(40 - h * 0.42)} ${f1(cx + hw)} 40 Z`;
  }
  return d;
}
const FLAMES = [
  ['b', HOT, flameStrip(1, 24, 12)],
  ['m', SUN, flameStrip(2, 17, 11)],
  ['f', VOLT, flameStrip(3, 10, 8)],
]
  .map(
    ([k, c, d]) =>
      `<svg class="vb-fl vb-fl-${k}" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path d="${d}" fill="${c}" stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`
  )
  .join('');

function descLine(text) {
  const d = el('span', 'vb-desc-line');
  const s = String(text);
  const m = /^[+\-−×x]?\d[\d.,]*%?/.exec(s);
  if (m) d.append(el('b', null, m[0]), document.createTextNode(s.slice(m[0].length)));
  else d.textContent = s;
  return d;
}

/* ----------------------------------------------------------------- template */

const LOGO = 'VELOCISMASH'
  .split('')
  .map((ch, i) => `<span class="vb-lt${i > 5 ? ' vb-smash' : ''}" style="--i:${i}"><span class="vb-lt-bob vb-ot" data-t="${ch}"><span class="vb-lt-f">${ch}</span></span></span>`)
  .join('');
const CHEV = `<svg viewBox="0 0 40 24" aria-hidden="true" focusable="false"><path d="M4 3 L15 12 L4 21 M20 3 L31 12 L20 21" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const HOW_SHRINES = [
  ['coin', 'CHEST', 'Costs gold — walk in to open'],
  ['blessing', 'BLESSING', 'Stand in it for a free charm'],
  ['amber', 'AMBER OBELISK', 'Mutation: a raw stat that never caps'],
  ['totem', 'CHALLENGE TOTEM', 'Timed kill trial → epic loot'],
  ['greed', 'GREED IDOL', 'More gold & XP, tougher foes'],
  ['pylon', 'MAGNET PYLON', 'Pulls in every gem'],
]
  .map(([ic, k, t]) => `<li><span class="vb-how-ic">${BASE_ICONS[ic]}</span><b>${k}</b><span>${t.replace('&', '&amp;')}</span></li>`)
  .join('');
const HOWTO = `
<div class="vb-how">
  <section class="vb-how-col">
    <h3>CONTROLS</h3>
    <dl class="vb-keys">
      <div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Move</dd></div>
      <div><dt><kbd class="w">MOUSE</kbd></dt><dd>Look — click to lock the cursor</dd></div>
      <div><dt><kbd class="w">SPACE</kbd></dt><dd>Jump / double jump — hold to auto-hop</dd></div>
      <div><dt><kbd class="w">SHIFT</kbd></dt><dd>Slide · <b>SLAM</b> in the air (for crowds, not bosses)</dd></div>
      <div><dt><kbd class="w">ESC</kbd></dt><dd>Pause · weapons fire on their own</dd></div>
    </dl>
  </section>
  <section class="vb-how-col">
    <h3>GO FAST</h3>
    <ul class="vb-rules">
      <li><b>BHOP</b><span>Jump the instant you land to keep (and build) speed</span></li>
      <li><b>HILLS</b><span>Slide downhill to accelerate</span></li>
      <li><b>PADS</b><span>Jump pads &amp; boost pads launch you</span></li>
      <li><b class="hot">×2+</b><span>Momentum ×2 or more = <em>RAM</em> enemies instead of taking damage</span></li>
    </ul>
  </section>
  <section class="vb-how-col">
    <h3>ISLAND RUN</h3>
    <ul class="vb-rules">
      <li><b>8:00</b><span>Every island runs on a countdown</span></li>
      <li><b class="mag">CRATER</b><span>Stand in the <em class="mag">METEOR CRATER</em> (minimap) to summon the boss early for bonus score</span></li>
      <li><b class="hot">0:00</b><span>The boss lands anyway; the <em>EXTINCTION</em> wave hunts you until it dies</span></li>
      <li><b class="win">CANNON</b><span>Win, then stand in the <em class="win">LAUNCH CANNON</em> to fire to the next island. First clears unlock it for good</span></li>
      <li><b class="bone">FOSSIL</b><span>The <em class="bone">FOSSIL GATE</em> wakes a Fossil Echo of the boss. Beat it: Fossil Boon + 2 free chests</span></li>
    </ul>
  </section>
  <section class="vb-how-shr">
    <h3>SHRINES &amp; LOOT</h3>
    <ul>${HOW_SHRINES}</ul>
  </section>
  <div class="vb-how-callout"><span class="k">SCORE</span><span>=</span><span>KILLS</span><span>×</span><span class="m">MOMENTUM</span></div>
  <p class="vb-how-q"><span class="vb-how-ic">${BASE_ICONS.quest}</span><span><b>QUESTS</b> unlock weapons, charms, raptors and perks. Check the board on the title screen.</span></p>
</div>`;

const TEMPLATE = `
<div class="vb-bi" data-r="bi" aria-hidden="true">
  <div class="vb-bi-bar vb-bi-t"></div><div class="vb-bi-bar vb-bi-b"></div>
  <div class="vb-bi-card">
    <div class="vb-bi-stripe"></div>
    <div class="vb-bi-row"><span class="vb-bi-ic">${BASE_ICONS.skull}</span><span class="vb-bi-title" data-r="biTitle"></span></div>
    <div class="vb-bi-name vb-ot" data-r="biName" data-t=""></div>
    <div class="vb-bi-warn">FINAL BOSS</div>
  </div>
</div>
<div class="vb-hud" data-r="hud" data-tier="0" aria-hidden="true">
  <div class="vb-speedlines"></div>
  <div class="vb-swarmglow"></div>
  <div class="vb-vignette"></div>
  <div class="vb-hitflash" data-r="hitflash"></div>
  <div class="vb-tl">
    <div class="vb-hp" data-r="hpWrap">
      <div class="vb-hp-ic">${BASE_ICONS.vitality}</div>
      <div class="vb-bar vb-bar-hp">
        <div class="vb-bar-ghost" data-r="hpGhost"></div>
        <div class="vb-bar-fill" data-r="hpFill"></div>
        <div class="vb-bar-txt"><span class="k">HP</span><b data-r="hpNum">100</b><span class="m">/<span data-r="hpMax">100</span></span></div>
      </div>
    </div>
    <div class="vb-xp">
      <div class="vb-lv" data-r="lvWrap"><span class="k">LV</span><b data-r="lvNum">1</b></div>
      <div class="vb-bar vb-bar-xp"><div class="vb-bar-fill" data-r="xpFill"></div></div>
    </div>
  </div>
  <div class="vb-tc">
    <div class="vb-isl" data-r="isl"><i class="vb-isl-dot"></i><span data-r="islText"></span></div>
    <div class="vb-timer vb-ot" data-r="timer" data-t="00:00">00:00</div>
    <div class="vb-score"><b data-r="score">0</b><span class="k">PTS</span></div>
    <div class="vb-phase vb-empty" data-r="phase"></div>
    <div class="vb-trial" data-r="trial">
      <div class="vb-trial-top"><span class="vb-trial-k">${BASE_ICONS.totem}TRIAL</span><span class="vb-trial-l" data-r="trialLabel"></span><b data-r="trialCount"></b><span class="vb-trial-t" data-r="trialTime"></span></div>
      <div class="vb-trial-bar"><i data-r="trialFill"></i></div>
    </div>
    <div class="vb-boss" data-r="boss">
      <div class="vb-boss-name"><span class="vb-boss-ic">${BASE_ICONS.skull}</span><span data-r="bossName">BOSS</span><span class="vb-boss-rage" data-r="bossRage">ENRAGED</span></div>
      <div class="vb-boss-bar"><div class="vb-boss-ghost" data-r="bossGhost"></div><div class="vb-boss-fill" data-r="bossFill"></div><div class="vb-boss-segs"></div></div>
    </div>
  </div>
  <div class="vb-tr">
    <div class="vb-mm" data-r="mmWrap"><canvas data-r="mm"></canvas><div class="vb-mm-ring"></div></div>
    <div class="vb-counters">
      <div class="vb-count vb-count-k" data-r="killsWrap">${BASE_ICONS.skull}<b data-r="kills">0</b></div>
      <div class="vb-count vb-count-g" data-r="goldWrap">${BASE_ICONS.coin}<b data-r="gold">0</b></div>
    </div>
  </div>
  <div class="vb-bl">
    <div class="vb-slots vb-slots-w" data-r="wSlots"></div>
    <div class="vb-slots vb-slots-t" data-r="tSlots"></div>
  </div>
  <div class="vb-bc">
    <div class="vb-mom" data-r="mom">
      <div class="vb-mom-flames">${FLAMES}</div>
      <div class="vb-mom-panel">
        <div class="vb-mom-top">
          <span class="vb-mom-kmh" data-r="kmh">0</span><span class="vb-mom-unit">KM/H</span>
          <span class="vb-mom-lab">MOMENTUM</span>
        </div>
        <div class="vb-mom-segs" data-r="segs"></div>
        <div class="vb-mom-track"><div class="vb-mom-tfill" data-r="momFill"></div><i class="r" style="left:20%"></i><i style="left:60%"></i></div>
      </div>
      <div class="vb-mom-mult" data-r="multWrap"><span class="vb-mom-x vb-ot" data-t="×">×</span><span class="vb-mom-n vb-ot" data-r="mult" data-t="1.0">1.0</span></div>
      <div class="vb-mom-ram" data-r="ramBadge">${BASE_ICONS.fire}<span>RAM!</span></div>
    </div>
  </div>
  <div class="vb-fps" data-r="fps"></div>
</div>
<div class="vb-prompt" data-r="prompt" role="status"></div>
<div class="vb-announce" data-r="announce" aria-live="polite"></div>
<div class="vb-qpop" data-r="qpop" aria-live="polite"></div>
<section class="vb-isle" data-r="isle" aria-live="polite">
  <div class="vb-isle-bg"></div>
  <div class="vb-isle-warp"></div>
  <div class="vb-isle-in">
    <div class="vb-isle-step" data-r="isleStep"></div>
    <div class="vb-isle-md" data-r="isleMd"></div>
    <h2 class="vb-isle-name vb-ot" data-r="isleName" data-t=""></h2>
    <div class="vb-isle-sub" data-r="isleSub"></div>
    <div class="vb-isle-caps" data-r="isleCaps"><span class="k">LEVEL CAPS</span><span data-r="isleCapsText"></span></div>
    <ol class="vb-isle-dots" data-r="isleDots"></ol>
  </div>
</section>

<section class="vb-screen vb-modal vb-lu" data-r="lu" role="dialog" aria-modal="true" aria-labelledby="vb-lu-title" data-kind="level">
  <div class="vb-dim"></div>
  <div class="vb-lu-rays"></div>
  <div class="vb-lu-inner">
    <div class="vb-lu-head">
      <h2 class="vb-lu-title vb-ot" id="vb-lu-title" data-r="luTitle" data-t="LEVEL UP!">LEVEL UP!</h2>
      <div class="vb-lu-sub" data-r="luSub"></div>
    </div>
    <div class="vb-cards" data-r="cards"></div>
    <div class="vb-lu-foot"><button type="button" class="vb-btn vb-btn-md vb-btn-volt" data-r="btnReroll"><span class="vb-btn-in" data-r="rerollLabel">REROLL (R)</span></button></div>
  </div>
</section>

<section class="vb-screen vb-modal vb-pause" data-r="pause" role="dialog" aria-modal="true" aria-label="Paused">
  <div class="vb-dim"></div>
  <div class="vb-panel vb-pause-panel">
    <h2 class="vb-h vb-ot" data-t="PAUSED">PAUSED</h2>
    <div class="vb-psums" data-r="pauseSum"></div>
    <div class="vb-pbuild" data-r="pauseBuild"></div>
    <div class="vb-pause-btns">
      <button type="button" class="vb-btn vb-btn-lg vb-btn-sun" data-r="btnResume"><span class="vb-btn-in">RESUME</span></button>
      <button type="button" class="vb-btn vb-btn-md" data-r="btnPauseSet" aria-expanded="false"><span class="vb-btn-in">SETTINGS</span></button>
      <div class="vb-inline-set" data-r="pauseSet"></div>
      <button type="button" class="vb-btn vb-btn-md vb-btn-hot" data-r="btnQuit"><span class="vb-btn-in" data-r="quitLabel">QUIT TO MENU</span></button>
    </div>
    <div class="vb-hint"><kbd>ENTER</kbd> RESUME</div>
  </div>
</section>

<section class="vb-screen vb-modal vb-over" data-r="over" role="dialog" aria-modal="true" aria-label="Game over">
  <div class="vb-over-bg"><div class="vb-over-rays"></div><div class="vb-confetti" data-r="confetti"></div></div>
  <div class="vb-over-wrap">
    <div class="vb-over-left">
      <div class="vb-over-mode" data-r="ovMode"></div>
      <h1 class="vb-smashed vb-ot" data-r="ovHead" data-t="SMASHED.">SMASHED.</h1>
      <div class="vb-rank"><span class="k">RANK</span><b data-r="ovRank"></b></div>
      <div class="vb-ov-isl" data-r="ovIsl"></div>
      <div class="vb-over-score">
        <div class="k">FINAL SCORE</div>
        <div class="vb-over-num vb-ot" data-r="ovScore" data-t="0">0</div>
        <div class="vb-newbest" data-r="ovBest">${BURST}<span class="vb-ot" data-t="NEW BEST!">NEW BEST!</span></div>
      </div>
      <div class="vb-chal-res" data-r="ovChal"></div>
      <div class="vb-stats" data-r="ovStats"></div>
      <div class="vb-over-btns">
        <button type="button" class="vb-btn vb-btn-lg vb-btn-sun" data-r="btnAgain"><span class="vb-btn-in">PLAY AGAIN</span></button>
        <button type="button" class="vb-btn vb-btn-md vb-btn-surf" data-r="btnCopy"><span class="vb-btn-in" data-r="copyLabel">COPY CHALLENGE</span></button>
        <button type="button" class="vb-btn vb-btn-md" data-r="btnMenu"><span class="vb-btn-in">MAIN MENU</span></button>
      </div>
      <div class="vb-share" data-r="ovShare"><div class="k" data-r="ovShareMsg">Clipboard is blocked here — copy this:</div><textarea data-r="ovShareTa" readonly rows="3" spellcheck="false"></textarea></div>
    </div>
    <div class="vb-over-right vb-panel">
      <div class="vb-ov-rewards" data-r="ovRewards"></div>
      <div class="vb-card-head">DAMAGE BY WEAPON</div>
      <div class="vb-dmg" data-r="ovDmg"></div>
      <div class="vb-card-head">PERSONAL BESTS</div>
      <ol class="vb-bests vb-bests-sm" data-r="ovBests"></ol>
    </div>
  </div>
</section>

<section class="vb-screen vb-title" data-r="title" aria-label="VELOCISMASH">
  <div class="vb-title-tint"></div>
  <div class="vb-title-grid">
    <div class="vb-title-main">
      <div class="vb-logo-wrap">
        <div class="vb-streaks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <h1 class="vb-logo" aria-label="VELOCISMASH">${LOGO}</h1>
        <div class="vb-tagline"><span>SPEED IS <em>DAMAGE.</em></span></div>
      </div>
      <div class="vb-challenge" data-r="challenge"><span class="vb-challenge-ic">${BASE_ICONS.challenge}</span><span data-r="challengeText"></span></div>
      <div class="vb-arch" data-r="arch" hidden>
        <div class="vb-arch-head"><span>THE ARCHIPELAGO</span><b data-r="archCount"></b></div>
        <ol class="vb-arch-list" data-r="archList"></ol>
      </div>
      <nav class="vb-menu" aria-label="Main menu">
        <button type="button" class="vb-btn vb-btn-xl vb-btn-sun" data-r="btnDaily"><span class="vb-btn-in"><span class="vb-btn-stack"><span data-r="dailyLabel">PLAY DAILY</span><small data-r="dateLabel"></small></span><span class="vb-btn-go">${CHEV}</span></span></button>
        <button type="button" class="vb-btn vb-btn-lg vb-btn-surf" data-r="btnRandom"><span class="vb-btn-in">RANDOM ISLAND</span></button>
        <div class="vb-menu-row">
          <button type="button" class="vb-btn vb-btn-md vb-btn-volt vb-btn-quests" data-r="btnQuests" hidden><span class="vb-btn-in"><span class="vb-btn-ic">${BASE_ICONS.trophy}</span>QUESTS<span class="vb-badge" data-r="questBadge"></span></span></button>
          <button type="button" class="vb-btn vb-btn-md" data-r="btnHow"><span class="vb-btn-in">HOW TO PLAY</span></button>
          <button type="button" class="vb-btn vb-btn-md" data-r="btnSet"><span class="vb-btn-in">SETTINGS</span></button>
        </div>
      </nav>
    </div>
    <div class="vb-chars" data-r="chars" role="group" aria-label="Choose your raptor" hidden>
      <div class="vb-chars-label"><span data-r="charLabel">CHOOSE YOUR RAPTOR</span><span class="vb-chars-keys"><kbd>←</kbd><kbd>→</kbd></span></div>
      <div class="vb-char-row">
        <button type="button" class="vb-char-arrow vb-prev" data-r="charPrev" aria-label="Previous raptor"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 3 L6 12 L16 21 Z"/></svg></button>
        <div class="vb-char-plate" data-r="charPlate" aria-live="polite">
          <div class="vb-char-pic" data-r="charPic"></div>
          <div class="vb-char-info">
            <div class="vb-char-top"><span class="vb-char-name vb-ot" data-r="charName" data-t=""></span><span class="vb-char-title" data-r="charTitle"></span><span class="vb-char-tag" data-r="charTag"></span></div>
            <div class="vb-char-line" data-r="charPassiveRow"><span class="k">PASSIVE</span><span class="vb-char-clamp" data-r="charPassive"></span></div>
            <div class="vb-char-line" data-r="charStartRow"><span class="k">STARTS WITH</span><span class="vb-char-wic" data-r="charStartIc"></span><span data-r="charStart"></span></div>
            <div class="vb-char-req" data-r="charReqRow"><span class="vb-char-lock">${BASE_ICONS.lock}</span><span data-r="charReq"></span></div>
          </div>
        </div>
        <button type="button" class="vb-char-arrow vb-next" data-r="charNext" aria-label="Next raptor"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3 L18 12 L8 21 Z"/></svg></button>
      </div>
      <div class="vb-char-dots" data-r="charDots"></div>
    </div>
    <aside class="vb-side">
      <div class="vb-panel vb-bests-card">
        <div class="vb-card-head"><span class="vb-head-ic">${BASE_ICONS.star}</span>PERSONAL BESTS</div>
        <ol class="vb-bests" data-r="bests"></ol>
        <div class="vb-daily-note">One island per day. Same seed for everyone.</div>
      </div>
    </aside>
    <p class="vb-footer">Every model, texture, sound and song is generated in code at load time.</p>
  </div>
  <div class="vb-sheet" data-r="howSheet" role="dialog" aria-modal="true" aria-label="How to play">
    <div class="vb-panel vb-sheet-panel">
      <h2 class="vb-h vb-ot" data-t="HOW TO PLAY">HOW TO PLAY</h2>
      ${HOWTO}
      <div class="vb-sheet-foot"><button type="button" class="vb-btn vb-btn-md vb-btn-sun" data-r="howBack"><span class="vb-btn-in">GOT IT</span></button></div>
    </div>
  </div>
  <div class="vb-sheet" data-r="setSheet" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="vb-panel vb-sheet-panel vb-sheet-narrow">
      <h2 class="vb-h vb-ot" data-t="SETTINGS">SETTINGS</h2>
      <div data-r="titleSet"></div>
      <div class="vb-sheet-foot"><button type="button" class="vb-btn vb-btn-md vb-btn-sun" data-r="setBack"><span class="vb-btn-in">DONE</span></button></div>
    </div>
  </div>
</section>
<section class="vb-screen vb-modal vb-qs" data-r="qs" role="dialog" aria-modal="true" aria-labelledby="vb-qs-title">
  <div class="vb-dim" data-r="qsDim"></div>
  <div class="vb-panel vb-qs-panel">
    <div class="vb-qs-head">
      <h2 class="vb-h vb-ot" id="vb-qs-title" data-t="QUESTS">QUESTS</h2>
      <div class="vb-qs-sum"><div class="vb-qs-num"><b data-r="qsDone">0</b><span data-r="qsTotal">/0</span><small>COMPLETE</small></div><div class="vb-qs-bar"><i data-r="qsFill"></i></div></div>
    </div>
    <div class="vb-qs-body" data-r="qsBody" tabindex="0" aria-label="Quest list"></div>
    <div class="vb-qs-foot"><button type="button" class="vb-btn vb-btn-md vb-btn-sun" data-r="qsBack"><span class="vb-btn-in">BACK</span></button><span class="vb-hint"><kbd class="w">ESC</kbd> CLOSE</span></div>
  </div>
</section>
<div class="vb-toasts" data-r="toasts" aria-live="polite"></div>
`;

/* ----------------------------------------------------------------------- UI */

export class UI {
  constructor(root, handlers) {
    this.root = root || document.getElementById('ui') || document.body;
    this.h = handlers || {};
    this.settings = { ...DEFAULT_SETTINGS };
    /** m/s at which the momentum meter's segment bar is full. Tweak to your speed range. */
    this.speedRef = 40;
    this._uid = 0;
    this._injectFonts();
    for (const k of Object.keys(BASE_ICONS)) iconNode(k); // pre-parse icon templates (no innerHTML at runtime)
    burstNode();

    this.root.classList.add('vb-root');
    this.root.innerHTML = TEMPLATE;
    const r = (this.r = {});
    this.root.querySelectorAll('[data-r]').forEach((n) => (r[n.getAttribute('data-r')] = n));

    // momentum segments
    this._segEls = [];
    for (let i = 0; i < SEGS; i++) {
      const s = el('i');
      s.style.setProperty('--k', (i / (SEGS - 1)).toFixed(3));
      r.segs.append(s);
      this._segEls.push(s);
    }
    // loadout slots
    this._wSlots = [];
    this._tSlots = [];
    for (let i = 0; i < 5; i++) this._addSlot(r.wSlots, this._wSlots);
    for (let i = 0; i < 6; i++) this._addSlot(r.tSlots, this._tSlots);

    // state
    this._last = {
      hp: -1, maxHp: -1, low: false, lv: -1, xq: -1, t: -1, tMode: -1, tSt: -1, sc: -1, k: -1, g: -1, kmh: -1, segs: -1, m10: -1, tier: -1, ram: false,
      ph: null, swarm: false, isl: null, trial: false, trLab: null, trP: -1, trG: -1, trT: -2, boss: false, bossName: null, bq: -1, rage: false, fps: undefined,
    };
    this._lastS = null;
    this._hudOn = false;
    this._titleOpen = false;
    this._pauseOpen = false;
    this._lu = { open: false, shownAt: 0, picked: false, n: 0, rerolls: 0 };
    this._over = { open: false, data: null, shownAt: 0 };
    this._cardEls = [];
    this._ann = { queue: [], cur: null, el: null, timer: 0, endAt: 0 };
    this._toasts = [];
    this._prompt = null;
    this._rl = Object.create(null);
    this._mm = { w: 0, dpr: 0, ctx: r.mm.getContext('2d'), ocean: null, biome: null };
    this._ch = { list: [], view: 0, sel: null, dots: [] };
    this._qsOpen = false;
    this._qp = { queue: [], cur: null, el: null, timer: 0, endAt: 0 };
    // victory confetti (static nodes, animated only while .vb-victory is on)
    const CONF = [VOLT, SUN, SURF, HOT, LIME, PAPER];
    for (let i = 0; i < 26; i++) {
      const c = el('i');
      c.style.cssText = `--x:${((i * 37) % 100) + (i % 3)}%;--d:${(((i * 53) % 29) / 10).toFixed(1)}s;--s:${(2.6 + ((i * 17) % 13) / 5).toFixed(1)}s;--r:${(i * 47) % 360}deg;--c:${CONF[i % CONF.length]}`;
      r.confetti.append(c);
    }

    // settings (two instances: title sheet + pause inline) sharing this.settings
    this._syncSettings = [this._buildSettings(r.titleSet), this._buildSettings(r.pauseSet)];
    this._mergeSettings(null);

    this._wire();
  }

  /* ------------------------------------------------------------ setup */

  _injectFonts() {
    if (typeof document === 'undefined' || document.getElementById('vb-fonts')) return;
    const head = document.head || document.documentElement;
    const pre = (href, cross) => {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = href;
      if (cross) l.crossOrigin = 'anonymous';
      head.appendChild(l);
    };
    pre('https://fonts.googleapis.com');
    pre('https://fonts.gstatic.com', true);
    const link = document.createElement('link');
    link.id = 'vb-fonts';
    link.rel = 'stylesheet';
    link.href = FONT_HREF;
    head.appendChild(link);
  }

  _call(name, ...args) {
    const f = this.h && this.h[name];
    if (typeof f === 'function') {
      try {
        return f(...args);
      } catch (e) {
        console.error('[ui] handler ' + name + ' threw', e);
      }
    }
    return undefined;
  }

  _wire() {
    const r = this.r;
    const click = (btn, fn) =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        fn(e);
      });
    // title
    click(r.btnDaily, () => this._titleOpen && (this._blur(), this._call('onStart', 'daily')));
    click(r.btnRandom, () => this._titleOpen && (this._blur(), this._call('onStart', 'random')));
    click(r.btnHow, () => this._openSheet(r.howSheet, r.howBack));
    click(r.btnQuests, () => this._titleOpen && this._call('onOpenQuests'));
    click(r.charPrev, () => this._cycleChar(-1));
    click(r.charNext, () => this._cycleChar(1));
    click(r.qsBack, () => this._closeQuests());
    r.qsDim.addEventListener('click', () => this._closeQuests());
    click(r.btnSet, () => this._openSheet(r.setSheet, r.setBack));
    click(r.howBack, () => this._closeSheets(r.btnHow));
    click(r.setBack, () => this._closeSheets(r.btnSet));
    for (const sh of [r.howSheet, r.setSheet]) sh.addEventListener('click', (e) => e.target === sh && this._closeSheets());
    // level up
    click(r.btnReroll, () => this._reroll());
    // pause
    click(r.btnResume, () => this._pauseOpen && (this._blur(), this._call('onResume')));
    click(r.btnPauseSet, () => this._setPauseSettingsOpen(!this._pauseSetOpen));
    click(r.btnQuit, () => this._quit());
    // game over
    const ready = () => this._over.open && performance.now() - this._over.shownAt > 600;
    click(r.btnAgain, () => ready() && (this._blur(), this._call('onRestart')));
    click(r.btnMenu, () => ready() && (this._blur(), this._call('onQuit')));
    click(r.btnCopy, () => this._copyShare());
    r.ovShareTa.addEventListener('focus', () => r.ovShareTa.select());

    this._onKey = this._onKey.bind(this);
    window.addEventListener('keydown', this._onKey);
    let raf = 0;
    this._onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this._mmResize());
    };
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
    cancelAnimationFrame(this._cuRaf);
    clearTimeout(this._qp.timer);
    clearTimeout(this._biT);
    clearTimeout(this._biT2);
    this.root.innerHTML = '';
    this.root.classList.remove('vb-root');
  }

  _blur() {
    const a = document.activeElement;
    if (a && a !== document.body && this.root.contains(a) && a.blur) a.blur();
  }

  _show(e) {
    clearTimeout(e._vbT);
    e.classList.remove('vb-leaving');
    e.classList.add('vb-on');
  }

  _hide(e) {
    if (!e.classList.contains('vb-on')) return;
    if (e.contains(document.activeElement)) document.activeElement.blur();
    e.classList.add('vb-leaving');
    clearTimeout(e._vbT);
    e._vbT = setTimeout(() => e.classList.remove('vb-on', 'vb-leaving'), REDUCED ? 60 : 200);
  }

  _onKey(e) {
    const k = e.key;
    if (this._qsOpen) {
      if (k === 'Escape') {
        e.preventDefault();
        this._closeQuests();
      }
      return;
    }
    if (this._over.open) return; // native button focus handles Enter/Space
    if (this._pauseOpen) {
      if ((k === 'Enter' || k === ' ' || k === 'Spacebar') && !e.repeat && !isInteractive(document.activeElement)) {
        e.preventDefault();
        this._call('onResume');
      }
      return;
    }
    if (this._lu.open) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
      const n = m ? +m[1] : k >= '1' && k <= '9' && k.length === 1 ? +k : 0;
      if (n) {
        e.preventDefault();
        this._pick(n - 1);
      } else if (k === 'r' || k === 'R' || e.code === 'KeyR') {
        e.preventDefault();
        this._reroll();
      }
      return;
    }
    if (!this._titleOpen) return;
    if (this._sheetOpen) {
      if (k === 'Escape') {
        e.preventDefault();
        this._closeSheets();
      }
      return;
    }
    // character selector: ←/→ or A/D, only on the bare title (never while typing or with modifiers)
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || this._ch.list.length < 2) return;
    const d = k === 'ArrowLeft' || e.code === 'KeyA' ? -1 : k === 'ArrowRight' || e.code === 'KeyD' ? 1 : 0;
    if (!d) return;
    e.preventDefault();
    if (!e.repeat || this._rate('char', 170)) this._cycleChar(d);
  }

  /* ------------------------------------------------------------ settings */

  _buildSettings(mount) {
    const ctl = {};
    const wrap = el('div', 'vb-set');
    const pct = (v) => Math.round(v * 100) + '%';
    const row = (label, forId) => {
      const r = el('div', 'vb-set-row');
      const lab = el(forId ? 'label' : 'span', 'vb-set-lab', label);
      if (forId) lab.htmlFor = forId;
      r.append(lab);
      wrap.append(r);
      return r;
    };
    const range = (key, label, min, max, step, fmt) => {
      const id = 'vb-s-' + key + '-' + ++this._uid;
      const r = row(label, id);
      const input = el('input', 'vb-range');
      input.type = 'range';
      input.id = id;
      input.min = min;
      input.max = max;
      input.step = step;
      const out = el('output', 'vb-set-val');
      const paint = (v) => {
        out.textContent = fmt(v);
        input.style.setProperty('--p', (clamp01((v - min) / (max - min)) * 100).toFixed(1) + '%');
      };
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.settings[key] = v;
        paint(v);
        this._emitSettings();
      });
      r.append(input, out);
      ctl[key] = (v) => {
        input.value = v;
        paint(parseFloat(input.value));
      };
    };
    const toggle = (key, label) => {
      const r = row(label);
      const b = el('button', 'vb-switch');
      b.type = 'button';
      b.setAttribute('role', 'switch');
      b.setAttribute('aria-label', label);
      const out = el('span', 'vb-set-val');
      const set = (v) => {
        b.setAttribute('aria-checked', v ? 'true' : 'false');
        out.textContent = v ? 'ON' : 'OFF';
      };
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = !this.settings[key];
        this.settings[key] = v;
        set(v);
        this._emitSettings();
      });
      r.append(b, out);
      ctl[key] = (v) => set(!!v);
    };
    const seg = (key, label, opts) => {
      const r = row(label);
      const g = el('div', 'vb-seg');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', label);
      const btns = opts.map(([val, text]) => {
        const b = el('button', null, text);
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.settings[key] = val;
          set(val);
          this._emitSettings();
        });
        g.append(b);
        return [val, b];
      });
      const set = (v) => btns.forEach(([val, b]) => b.setAttribute('aria-pressed', val === v ? 'true' : 'false'));
      r.append(g, el('span', 'vb-set-val'));
      ctl[key] = set;
    };
    range('master', 'MASTER', 0, 1, 0.01, pct);
    range('music', 'MUSIC', 0, 1, 0.01, pct);
    range('sfx', 'SFX', 0, 1, 0.01, pct);
    range('sensitivity', 'MOUSE SENS', 0.2, 3, 0.05, (v) => v.toFixed(2) + '×');
    toggle('invertY', 'INVERT Y');
    seg('quality', 'GRAPHICS', [
      ['high', 'HIGH'],
      ['low', 'LOW'],
    ]);
    toggle('showFps', 'SHOW FPS');
    mount.append(wrap);
    return (s) => {
      for (const k in ctl) ctl[k](s[k]);
    };
  }

  _mergeSettings(s) {
    const S = this.settings;
    if (s && typeof s === 'object') for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] != null) S[k] = s[k];
    for (const k of ['master', 'music', 'sfx', 'sensitivity']) if (!(+S[k] >= 0)) S[k] = DEFAULT_SETTINGS[k];
    S.quality = /^l/i.test(String(S.quality)) ? 'low' : 'high';
    S.invertY = !!S.invertY;
    S.showFps = !!S.showFps;
    this._syncSettings.forEach((f) => f(S));
  }

  _emitSettings() {
    this._call('onSettings', { ...this.settings });
  }

  /* --------------------------------------------------------------- title */

  showTitle(o = {}) {
    const r = this.r;
    this._mergeSettings(o.settings);
    r.dailyLabel.textContent = o.dailyNumber != null ? 'PLAY DAILY #' + o.dailyNumber : 'PLAY DAILY';
    r.dateLabel.textContent = o.dateLabel ? String(o.dateLabel).toUpperCase() : 'TODAY’S ISLAND';
    const c = o.challenge;
    if (c && c.score != null) {
      const who = c.name ? ' FROM ' + String(c.name).toUpperCase().slice(0, 24) : '';
      const where = c.daily != null ? ' on Daily #' + c.daily : '';
      r.challengeText.textContent = `CHALLENGE${who} — beat ${commas(c.score)}${where}`;
      r.challenge.classList.add('vb-on');
    } else r.challenge.classList.remove('vb-on');
    this._renderBests(r.bests, o.bests, null);
    this._renderArch(o.islands);
    const q = o.quests;
    r.btnQuests.hidden = !q;
    if (q) {
      const done = Math.max(0, q.done | 0);
      const total = Math.max(0, q.total | 0);
      r.questBadge.textContent = done + '/' + total;
      r.btnQuests.classList.toggle('vb-all', total > 0 && done >= total);
      r.btnQuests.setAttribute('aria-label', `Quests: ${done} of ${total} complete`);
    }
    this._setChars(o.characters, o.selectedChar);
    this._closeSheets();
    this._titleOpen = true;
    this._show(r.title);
    setTimeout(() => {
      if (this._titleOpen && !this._sheetOpen && !isInteractive(document.activeElement)) r.btnDaily.focus({ preventScroll: true });
    }, 50);
  }

  hideTitle() {
    this._titleOpen = false;
    this._closeSheets();
    if (this._qsOpen) this.hideQuests();
    this._hide(this.r.title);
  }

  _openSheet(sheet, focusBtn) {
    this._closeSheets();
    sheet.classList.add('vb-on');
    this._sheetOpen = sheet;
    setTimeout(() => focusBtn && focusBtn.focus({ preventScroll: true }), 30);
  }

  _closeSheets(refocus) {
    const was = this._sheetOpen;
    this.r.howSheet.classList.remove('vb-on');
    this.r.setSheet.classList.remove('vb-on');
    this._sheetOpen = null;
    if (was && was.contains(document.activeElement)) document.activeElement.blur();
    if (refocus && this._titleOpen) refocus.focus({ preventScroll: true });
  }

  /* ------------------------------------------------ title: archipelago strip */

  _renderArch(list) {
    const r = this.r;
    const L = Array.isArray(list) ? list.filter(Boolean).slice(0, 5) : [];
    r.arch.hidden = !L.length;
    r.archList.textContent = '';
    if (!L.length) return;
    const cleared = L.filter((x) => x.cleared).length;
    r.archCount.textContent = cleared + '/' + L.length + ' CLEARED';
    const next = L.findIndex((x) => x.unlocked !== false && !x.cleared);
    L.forEach((x, i) => {
      const n = x.n || i + 1;
      const b = biomeOf(x.biome, n);
      const locked = x.unlocked === false && !x.cleared;
      const li = el('li', 'vb-arch-i ' + (x.cleared ? 'vb-cleared' : locked ? 'vb-locked' : 'vb-open') + (i === next ? ' vb-next' : ''));
      li.style.setProperty('--bc', BIOMES[b].c);
      const name = String(x.name || BIOMES[b].name).toUpperCase();
      li.append(islandMedal(b, n, x.cleared ? 'check' : locked ? 'lock' : null), el('span', 'vb-arch-name', name));
      if (x.best != null && !locked) li.append(el('span', 'vb-arch-best', compact(x.best)));
      const st = x.cleared ? 'cleared' : locked ? 'locked' : 'unlocked';
      li.title = `Island ${n}: ${name} — ${st}${x.best != null ? ' · best ' + commas(x.best) : ''}`;
      li.setAttribute('aria-label', li.title);
      r.archList.append(li);
    });
  }

  /* ---------------------------------------------- title: character selector */

  _setChars(list, selected) {
    const r = this.r;
    const C = this._ch;
    C.list = Array.isArray(list) ? list.filter((c) => c && c.id != null) : [];
    r.chars.hidden = !C.list.length;
    r.title.classList.toggle('vb-has-chars', !!C.list.length);
    r.charDots.textContent = '';
    C.dots = [];
    if (!C.list.length) return;
    let i = C.list.findIndex((c) => c.id === selected && c.unlocked !== false);
    if (i < 0) i = Math.max(0, C.list.findIndex((c) => c.unlocked !== false));
    C.sel = C.list[i].unlocked !== false ? C.list[i].id : null;
    C.dots = C.list.map((c, k) => {
      const locked = c.unlocked === false;
      const b = el('button', 'vb-char-dot' + (locked ? ' vb-locked' : ''));
      b.type = 'button';
      b.setAttribute('aria-label', locked ? `${c.secret ? 'Secret raptor' : c.name || c.id} (locked)` : String(c.name || c.id));
      b.append(iconNode(c.id));
      if (locked) {
        const lk = el('span', 'vb-dot-lock');
        lk.append(iconNode('lock'));
        b.append(lk);
      }
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._viewChar(k, true, k > C.view ? 1 : -1);
      });
      r.charDots.append(b);
      return b;
    });
    this._viewChar(i, false, 0);
  }

  _cycleChar(d) {
    const C = this._ch;
    const n = C.list.length;
    if (!this._titleOpen || n < 2) return;
    this._viewChar((C.view + d + n) % n, true, d);
  }

  _viewChar(i, user, dir) {
    const r = this.r;
    const C = this._ch;
    const c = C.list[i];
    if (!c) return;
    C.view = i;
    const locked = c.unlocked === false;
    const secret = locked && !!c.secret;
    r.charPlate.classList.toggle('vb-locked', locked);
    r.charPic.textContent = '';
    r.charPic.append(iconNode(c.id));
    if (locked) {
      const lk = el('span', 'vb-pic-lock');
      lk.append(iconNode('lock'));
      r.charPic.append(lk);
    }
    const name = secret ? '???' : String(c.name || c.id).toUpperCase();
    setOT(r.charName, name);
    r.charName.classList.toggle('vb-long', name.length > 7);
    r.charTag.textContent = locked ? 'LOCKED' : i + 1 + ' / ' + C.list.length;
    r.charTitle.textContent = secret ? 'SECRET RAPTOR' : String(c.title || '').toUpperCase();
    r.charPassive.textContent = secret ? '???' : String(c.passive || '—');
    const starts = Array.isArray(c.start) ? c.start : c.start ? [c.start] : [];
    r.charStartIc.textContent = '';
    const names = starts.map((w) => {
      const s = String(w);
      const id = WEAPON_NAMES[s] ? s : starts.length === 1 && c.startId ? c.startId : Object.keys(WEAPON_NAMES).find((k) => WEAPON_NAMES[k].toLowerCase() === s.toLowerCase());
      if (id && r.charStartIc.childNodes.length < 2) r.charStartIc.append(iconNode(id));
      return WEAPON_NAMES[s] || s;
    });
    r.charStart.textContent = names.join(' + ');
    r.charStartRow.hidden = locked || !names.length;
    r.charPassiveRow.hidden = locked;
    r.charReqRow.hidden = !locked;
    r.charReq.textContent = locked ? (c.req ? String(c.req) : 'Keep playing to unlock') : '';
    const cur = locked ? C.list.find((x) => x.id === C.sel) : null;
    r.charLabel.textContent = cur ? 'LOCKED · PLAYING AS ' + String(cur.name || cur.id).toUpperCase() : 'CHOOSE YOUR RAPTOR';
    r.chars.classList.toggle('vb-peek', locked);
    r.chars.setAttribute('data-char', String(c.id));
    for (let k = 0; k < C.dots.length; k++) {
      C.dots[k].classList.toggle('vb-on', k === i);
      C.dots[k].setAttribute('aria-current', k === i ? 'true' : 'false');
    }
    if (!locked && c.id !== C.sel) {
      C.sel = c.id;
      if (user) this._call('onSelectCharacter', c.id);
    }
    for (let k = 0; k < C.dots.length; k++) C.dots[k].classList.toggle('vb-sel', C.list[k].id === C.sel);
    if (user && dir) anim(r.charPlate, [{ translate: (dir > 0 ? 0.9 : -0.9) + 'em 0', opacity: 0.35 }, { translate: '0 0', opacity: 1 }], REDUCED ? 60 : 260);
  }

  /* -------------------------------------------------------------- quests */

  /** Full quest sheet. list: [{ id, name, desc, category, progress, goal, done, reward, bonus? }] */
  showQuests(list) {
    const r = this.r;
    const L = Array.isArray(list) ? list.filter(Boolean) : [];
    const done = L.filter((q) => q.done).length;
    r.qsDone.textContent = done;
    r.qsTotal.textContent = '/' + L.length;
    r.qsFill.style.transform = 'scaleX(' + (L.length ? done / L.length : 0).toFixed(3) + ')';
    const groups = new Map();
    for (const q of L) {
      const c = String(q.category || q.cat || 'OTHER').toUpperCase();
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(q);
    }
    const rank = (c) => (CAT_ORDER.indexOf(c) + 1 || 99);
    const cats = [...groups.keys()].sort((a, b) => rank(a) - rank(b));
    r.qsBody.textContent = '';
    if (!L.length) r.qsBody.append(el('div', 'vb-empty', 'No quests yet.'));
    for (const c of cats) {
      const qs = groups.get(c);
      const sec = el('section', 'vb-qs-cat');
      const h = el('h3', 'vb-qs-cat-h');
      const ic = el('span', 'vb-qs-cat-ic');
      ic.append(iconNode(CAT_ICON[c] || 'quest'));
      h.append(ic, el('span', null, c), el('b', null, qs.filter((q) => q.done).length + '/' + qs.length));
      const ul = el('ul', 'vb-qs-list');
      qs.forEach((q) => ul.append(this._questRow(q, c)));
      sec.append(h, ul);
      r.qsBody.append(sec);
    }
    this._qsOpen = true;
    this._show(r.qs);
    r.qsBody.scrollTop = 0;
    setTimeout(() => this._qsOpen && !isTyping(document.activeElement) && r.qsBack.focus({ preventScroll: true }), 30);
  }

  hideQuests() {
    if (!this._qsOpen) return;
    this._qsOpen = false;
    this._hide(this.r.qs);
    if (this._titleOpen && !this._sheetOpen) setTimeout(() => this._titleOpen && !this._qsOpen && this.r.btnQuests.focus({ preventScroll: true }), 30);
  }

  _closeQuests() {
    if (!this._qsOpen) return;
    this.hideQuests();
    this._call('onCloseQuests');
  }

  _questRow(q, cat) {
    const goal = Math.max(1, +q.goal || 1);
    const prog = q.done ? goal : Math.max(0, Math.min(goal, Math.floor(+q.progress || 0)));
    const li = el('li', 'vb-q' + (q.done ? ' vb-done' : prog > 0 ? ' vb-going' : ''));
    const ic = el('span', 'vb-q-ic');
    ic.append(iconNode(q.done ? 'trophy' : q.icon || CAT_ICON[cat] || 'quest'));
    if (q.done) {
      const ck = el('span', 'vb-q-ck');
      ck.append(iconNode('check'));
      ic.append(ck);
    }
    const main = el('div', 'vb-q-main');
    const top = el('div', 'vb-q-top');
    top.append(el('b', 'vb-q-name', String(q.name || q.id || 'Quest')), el('span', 'vb-q-state', q.done ? 'DONE' : compact(prog) + ' / ' + compact(goal)));
    const bar = el('div', 'vb-q-bar');
    const fill = el('i');
    fill.style.transform = 'scaleX(' + (prog / goal).toFixed(3) + ')';
    bar.append(fill);
    const rw = el('div', 'vb-q-rw');
    const rewards = [q.reward, q.bonus].filter(Boolean);
    if (rewards.length) rw.append(el('span', 'k', q.done ? 'UNLOCKED:' : 'UNLOCKS:'));
    rewards.forEach((x, k) => {
      if (k) rw.append(el('span', 'vb-q-plus', '+'));
      const chip = el('span', 'vb-q-chip');
      chip.append(iconNode(rewardIcon(x)), el('span', null, String(x.name || x.id)));
      chip.title = KIND_LABEL[x.kind] || '';
      rw.append(chip);
    });
    main.append(top, el('p', 'vb-q-desc', String(q.desc || '')), bar);
    if (rewards.length) main.append(rw);
    li.append(ic, main);
    return li;
  }

  /** In-game celebration banner. Queues; never blocks input. */
  questComplete(q = {}) {
    if (this._over.open) return; // the game-over screen lists them (questsDone)
    const Q = this._qp;
    Q.queue.push({ name: String(q.name || 'Quest'), rewards: [q.reward, q.bonus].filter(Boolean) });
    if (Q.queue.length > 8) Q.queue.shift();
    if (!Q.cur) this._qpNext();
    else if (Q.el && Q.endAt - performance.now() > 1500) {
      clearTimeout(Q.timer);
      Q.endAt = performance.now() + 1500;
      Q.timer = setTimeout(() => this._qpOut(), 1500);
    }
  }

  _qpNext() {
    const Q = this._qp;
    const item = Q.queue.shift();
    if (!item) {
      Q.cur = null;
      return;
    }
    Q.cur = item;
    const e = el('div', 'vb-qp');
    const ic = el('span', 'vb-qp-ic');
    ic.append(burstNode(), iconNode('trophy'));
    const body = el('div', 'vb-qp-body');
    const head = el('div', 'vb-qp-k');
    head.append(el('span', null, 'QUEST COMPLETE'), el('b', 'vb-qp-name', item.name));
    body.append(head);
    if (item.rewards.length) {
      const rw = el('div', 'vb-qp-rw');
      rw.append(el('span', 'k', 'UNLOCKED:'));
      item.rewards.forEach((x, i) => {
        if (i) rw.append(el('span', 'k', '+'));
        const c = el('span', 'vb-qp-chip');
        c.append(iconNode(rewardIcon(x)), el('b', null, String(x.name || x.id)));
        rw.append(c);
      });
      body.append(rw);
    }
    e.append(ic, body, el('span', 'vb-qp-shine'));
    this.r.qpop.textContent = '';
    this.r.qpop.append(e);
    Q.el = e;
    const dur = Q.queue.length ? 2600 : 3500;
    Q.endAt = performance.now() + dur;
    Q.timer = setTimeout(() => this._qpOut(), dur);
  }

  _qpOut() {
    const Q = this._qp;
    const e = Q.el;
    Q.el = null;
    if (!e) return this._qpNext();
    e.classList.add('vb-out');
    Q.timer = setTimeout(() => {
      e.remove();
      this._qpNext();
    }, REDUCED ? 60 : 320);
  }

  /* ------------------------------------------------- island intro / boss intro */

  /** Full-screen arrival card. { n, name, biome, subtitle, caps, total? } — the game hides it (~2.5 s). */
  showIslandIntro(o = {}) {
    const r = this.r;
    const e = r.isle;
    const total = Math.max(1, o.total | 0 || 5);
    const n = Math.max(1, o.n | 0 || 1);
    const b = biomeOf(o.biome, n);
    e.style.setProperty('--bc', BIOMES[b].c);
    e.style.setProperty('--bd', BIOMES[b].d);
    e.setAttribute('data-biome', b);
    r.isleStep.textContent = `ISLAND ${n} / ${total}`;
    r.isleMd.textContent = '';
    r.isleMd.append(iconNode('island-' + b));
    const name = String(o.name || BIOMES[b].name).toUpperCase();
    setOT(r.isleName, name);
    r.isleName.classList.toggle('vb-long', name.length > 12);
    r.isleSub.textContent = o.subtitle ? String(o.subtitle) : '';
    r.isleSub.hidden = !o.subtitle;
    r.isleCapsText.textContent = o.caps ? String(o.caps).toUpperCase() : '';
    r.isleCaps.hidden = !o.caps;
    r.isleDots.textContent = '';
    for (let i = 1; i <= total; i++) {
      const d = el('li', i < n ? 'vb-past' : i === n ? 'vb-cur' : '');
      d.style.setProperty('--dc', BIOMES[BIOME_ORDER[i - 1]] ? BIOMES[BIOME_ORDER[i - 1]].c : PAPER);
      r.isleDots.append(d);
    }
    clearTimeout(e._vbT);
    e.classList.remove('vb-on', 'vb-leaving');
    void e.offsetWidth; // restart the entrance animation
    e.classList.add('vb-on');
  }

  hideIslandIntro() {
    const e = this.r.isle;
    if (!e.classList.contains('vb-on') || e.classList.contains('vb-leaving')) return;
    e.classList.add('vb-leaving');
    clearTimeout(e._vbT);
    e._vbT = setTimeout(() => e.classList.remove('vb-on', 'vb-leaving'), REDUCED ? 60 : 420);
  }

  /** Cinematic letterbox + name card. { name, title, duration? } Auto-hides after ~2.4 s. */
  bossIntro(o = {}) {
    const r = this.r;
    const e = r.bi;
    clearTimeout(this._biT);
    clearTimeout(this._biT2);
    r.biTitle.textContent = String(o.title || 'FINAL BOSS').toUpperCase();
    const warn = e.querySelector('.vb-bi-warn');
    if (warn) warn.textContent = String(o.tag || 'FINAL BOSS').toUpperCase();
    const name = String(o.name || 'BOSS').toUpperCase();
    setOT(r.biName, name);
    r.biName.classList.toggle('vb-long', name.length > 11);
    e.classList.remove('vb-on', 'vb-out');
    void e.offsetWidth;
    e.classList.add('vb-on');
    const dur = Math.max(0.8, o.duration ?? 2.4) * 1000;
    this._biT = setTimeout(() => this.hideBossIntro(), dur);
  }

  hideBossIntro() {
    const e = this.r.bi;
    clearTimeout(this._biT);
    if (!e.classList.contains('vb-on') || e.classList.contains('vb-out')) return;
    e.classList.add('vb-out');
    clearTimeout(this._biT2);
    this._biT2 = setTimeout(() => e.classList.remove('vb-on', 'vb-out'), REDUCED ? 60 : 450);
  }

  _renderBests(ol, bests, me, max = 5) {
    ol.textContent = '';
    const list = Array.isArray(bests) ? bests.slice(0, max) : [];
    if (!list.length) {
      ol.append(el('li', 'vb-empty', 'No runs yet. Go smash something.'));
      return;
    }
    let marked = false;
    list.forEach((b, i) => {
      const li = el('li', 'vb-best');
      if (!marked && me && Math.round(b.score) === Math.round(me.score) && Math.floor(b.time) === Math.floor(me.time)) {
        li.classList.add('vb-me');
        marked = true;
      }
      const meta = [mmss(b.time), commas(b.kills) + ' KO', b.daily != null ? 'DAILY #' + b.daily : 'RANDOM'];
      const date = fmtDate(b.date);
      if (date) meta.push(date);
      li.append(el('span', 'vb-best-rank', String(i + 1)), el('span', 'vb-best-score', commas(b.score)), el('span', 'vb-best-meta', meta.join(' · ')));
      ol.append(li);
    });
  }

  /* ----------------------------------------------------------------- HUD */

  showHUD(on) {
    this._hudOn = !!on;
    this.r.hud.classList.toggle('vb-on', this._hudOn);
    if (this._hudOn) this._mmResize();
    else this.setPrompt(null);
  }

  _addSlot(container, arr) {
    const s = el('div', 'vb-slot vb-empty');
    const ic = el('div', 'vb-slot-ic');
    const pips = el('div', 'vb-slot-pips');
    s.append(ic, pips);
    container.append(s);
    arr.push({ el: s, ic, pips, id: null, level: -1, max: -1, pipEls: [] });
  }

  _slots(container, arr, items) {
    const n = items ? items.length : 0;
    while (arr.length < n) this._addSlot(container, arr);
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      const it = i < n ? items[i] : null;
      if (!it) {
        if (c.id !== null) {
          c.el.className = 'vb-slot vb-empty';
          c.ic.textContent = '';
          c.pips.textContent = '';
          c.id = null;
          c.level = c.max = -1;
          c.pipEls = [];
        }
        continue;
      }
      if (it.id !== c.id) {
        c.ic.textContent = '';
        c.ic.append(iconNode(it.id));
        c.el.classList.remove('vb-empty');
        c.id = it.id;
        c.level = c.max = -1;
        anim(c.el, KF_POP, 420);
      }
      const max = Math.max(1, it.maxLevel | 0);
      if (max !== c.max) {
        c.pips.textContent = '';
        c.pipEls = [];
        c.pips.classList.toggle('vb-num', max > 8);
        if (max <= 8) for (let p = 0; p < max; p++) c.pipEls.push(c.pips.appendChild(el('i')));
        c.max = max;
        c.level = -1;
      }
      const lv = it.level | 0;
      if (lv !== c.level) {
        if (max > 8) c.pips.textContent = lv >= max ? 'MAX' : 'LV' + lv;
        else for (let p = 0; p < c.pipEls.length; p++) c.pipEls[p].classList.toggle('on', p < lv);
        c.el.classList.toggle('vb-max', lv >= max);
        if (c.level > 0 && lv > c.level) anim(c.el, KF_BUMP, 300);
        c.level = lv;
      }
    }
  }

  _setSegs(n) {
    const s = this._segEls;
    for (let i = 0; i < SEGS; i++) {
      s[i].classList.toggle('on', i < n);
      s[i].classList.toggle('pk', i === n - 1);
    }
  }

  _rate(key, ms) {
    const now = performance.now();
    if (now - (this._rl[key] || 0) < ms) return false;
    this._rl[key] = now;
    return true;
  }

  updateHUD(s) {
    if (!s) return;
    this._lastS = s;
    const L = this._last;
    const r = this.r;

    // HP
    const maxHp = Math.max(1, Math.round(s.maxHp || 1));
    const hp = Math.max(0, Math.min(maxHp, Math.ceil(s.hp || 0)));
    if (hp !== L.hp || maxHp !== L.maxHp) {
      const ratio = hp / maxHp;
      const tf = 'scaleX(' + ratio.toFixed(4) + ')';
      r.hpFill.style.transform = tf;
      r.hpGhost.style.transform = tf;
      r.hpNum.textContent = hp;
      if (maxHp !== L.maxHp) r.hpMax.textContent = maxHp;
      if (L.hp >= 0 && maxHp === L.maxHp) {
        if (hp < L.hp && this._rate('hurt', 140)) {
          anim(r.hitflash, KF_FLASH, { duration: 320, easing: 'ease-out' });
          anim(r.hpWrap, KF_SHAKE, 260);
        } else if (hp > L.hp + maxHp * 0.04 && this._rate('heal', 300)) anim(r.hpWrap, KF_BUMP, 320);
      }
      const low = hp > 0 && ratio <= 0.3;
      if (low !== L.low) {
        r.hud.classList.toggle('vb-lowhp', low);
        L.low = low;
      }
      L.hp = hp;
      L.maxHp = maxHp;
    }

    // level + xp
    const lv = s.level | 0;
    if (lv !== L.lv) {
      r.lvNum.textContent = lv;
      if (L.lv > 0 && lv > L.lv) anim(r.lvWrap, KF_POP, 450);
      L.lv = lv;
    }
    const xq = Math.round(clamp01(s.xpNext > 0 ? s.xp / s.xpNext : 0) * 400);
    if (xq !== L.xq) {
      r.xpFill.classList.toggle('vb-snap', xq < L.xq);
      r.xpFill.style.transform = 'scaleX(' + xq / 400 + ')';
      L.xq = xq;
    }

    // timer: island countdown when timeLeft is given, else elapsed run time
    if (s.timeLeft != null && isFinite(s.timeLeft)) {
      const t = Math.max(0, Math.ceil(s.timeLeft));
      if (t !== L.t || L.tMode !== 1) {
        setOT(r.timer, mss(t));
        const st = t === 0 ? 3 : t < 10 ? 2 : t < 60 ? 1 : 0;
        if (st !== L.tSt || L.tMode !== 1) {
          r.timer.className = 'vb-timer vb-ot vb-cd' + ['', ' vb-urgent', ' vb-urgent vb-crit', ' vb-zero'][st];
          if (st === 3 && L.tSt >= 0 && L.tSt < 3) anim(r.timer, KF_POP, 450);
          L.tSt = st;
        }
        L.t = t;
        L.tMode = 1;
      }
    } else {
      const t = Math.floor(s.time || 0);
      if (t !== L.t || L.tMode !== 0) {
        setOT(r.timer, mmss(t));
        if (L.tMode !== 0) r.timer.className = 'vb-timer vb-ot';
        L.t = t;
        L.tMode = 0;
        L.tSt = -1;
      }
    }
    const isl = s.island;
    const ik = isl ? (isl.n | 0) + '|' + (isl.name || '') + '|' + (isl.biome || '') : '';
    if (ik !== L.isl) {
      if (isl) {
        const b = biomeOf(isl.biome, isl.n);
        r.islText.textContent = `ISLAND ${isl.n | 0 || 1} · ${String(isl.name || BIOMES[b].name).toUpperCase()}`;
        r.isl.style.setProperty('--bc', BIOMES[b].c);
        r.isl.classList.add('vb-on');
      } else r.isl.classList.remove('vb-on');
      L.isl = ik;
    }

    // score / counters
    const sc = Math.round(s.score || 0);
    if (sc !== L.sc) {
      r.score.textContent = commas(sc);
      L.sc = sc;
    }
    const k = Math.round(s.kills || 0);
    if (k !== L.k) {
      r.kills.textContent = commas(k);
      L.k = k;
    }
    const g = Math.round(s.gold || 0);
    if (g !== L.g) {
      r.gold.textContent = commas(g);
      if (L.g >= 0 && g > L.g && this._rate('gold', 180)) anim(r.goldWrap, KF_BUMP, 260);
      L.g = g;
    }

    // momentum meter
    const spd = s.speed || 0;
    const kmh = Math.round(spd * 3.6);
    if (kmh !== L.kmh) {
      r.kmh.textContent = kmh;
      L.kmh = kmh;
    }
    const segs = Math.round(clamp01(spd / this.speedRef) * SEGS);
    if (segs !== L.segs) {
      this._setSegs(segs);
      L.segs = segs;
    }
    const m10 = Math.round(Math.max(1, s.momentum || 1) * 10);
    if (m10 !== L.m10) {
      setOT(r.mult, (m10 / 10).toFixed(1));
      r.momFill.style.transform = 'scaleX(' + clamp01((m10 / 10 - 1) / 5).toFixed(3) + ')';
      L.m10 = m10;
    }
    const tier = tierOf(m10 / 10);
    if (tier !== L.tier) {
      r.hud.setAttribute('data-tier', tier);
      if (L.tier >= 0 && tier > L.tier) anim(r.multWrap, KF_POP, 420);
      L.tier = tier;
    }
    const ram = !!s.ram;
    if (ram !== L.ram) {
      r.hud.classList.toggle('vb-ram', ram);
      if (ram) anim(r.ramBadge, KF_POP, 400);
      L.ram = ram;
    }

    // phase line (the EXTINCTION wave after 0:00 overrides it)
    const swarm = !!s.swarm;
    const ph = swarm ? 'EXTINCTION — SMASH THE BOSS' : s.phase || '';
    if (ph !== L.ph || swarm !== L.swarm) {
      r.phase.textContent = ph;
      const mm = /(\d+):(\d\d)/.exec(ph);
      const soon = /BOSS IN/i.test(ph) && mm && +mm[1] * 60 + +mm[2] <= 10;
      r.phase.className = 'vb-phase' + (swarm ? ' vb-danger vb-swarm' : !ph ? ' vb-empty' : /FIGHT|SWARM|EXTINCTION|!/i.test(ph) ? ' vb-danger' : soon ? ' vb-soon' : '');
      if (swarm !== L.swarm) r.hud.classList.toggle('vb-swarming', swarm);
      L.ph = ph;
      L.swarm = swarm;
    }

    // challenge-totem trial
    const tr = s.trial;
    if (tr) {
      if (!L.trial) {
        r.trial.classList.add('vb-on');
        L.trial = true;
      }
      const lab = String(tr.label || '').toUpperCase();
      if (lab !== L.trLab) {
        r.trialLabel.textContent = lab;
        L.trLab = lab;
      }
      const goal = Math.max(1, Math.round(+tr.goal || 1));
      const pr = Math.max(0, Math.min(goal, Math.floor(+tr.progress || 0)));
      if (pr !== L.trP || goal !== L.trG) {
        r.trialCount.textContent = pr + '/' + goal;
        r.trialFill.style.transform = 'scaleX(' + (pr / goal).toFixed(3) + ')';
        r.trial.classList.toggle('vb-won', pr >= goal);
        L.trP = pr;
        L.trG = goal;
      }
      const tt = tr.timeLeft != null && isFinite(tr.timeLeft) ? Math.max(0, Math.ceil(tr.timeLeft)) : -1;
      if (tt !== L.trT) {
        r.trialTime.textContent = tt >= 0 ? mss(tt) : '';
        r.trial.classList.toggle('vb-hurry', tt >= 0 && tt <= 5 && pr < goal);
        L.trT = tt;
      }
    } else if (L.trial) {
      r.trial.classList.remove('vb-on', 'vb-hurry', 'vb-won');
      L.trial = false;
      L.trLab = null;
      L.trP = L.trG = -1;
      L.trT = -2;
    }

    // boss bar
    const b = s.boss;
    if (b) {
      if (!L.boss) {
        r.boss.classList.add('vb-on');
        L.boss = true;
      }
      if (b.name !== L.bossName) {
        r.bossName.textContent = b.name || 'BOSS';
        L.bossName = b.name;
      }
      const bq = Math.round(clamp01(b.maxHp > 0 ? b.hp / b.maxHp : 0) * 500);
      if (bq !== L.bq) {
        const tf = 'scaleX(' + bq / 500 + ')';
        r.bossFill.style.transform = tf;
        r.bossGhost.style.transform = tf;
        L.bq = bq;
      }
      const rage = (s.bossPhase | 0) >= 2 || (b.phase | 0) >= 2;
      if (rage !== L.rage) {
        r.boss.classList.toggle('vb-enraged', rage);
        if (rage) anim(r.bossRage, KF_POP, 420);
        L.rage = rage;
      }
    } else if (L.boss) {
      r.boss.classList.remove('vb-on', 'vb-enraged');
      L.boss = false;
      L.bq = -1;
      L.bossName = null;
      L.rage = false;
    }

    // loadout
    this._slots(r.wSlots, this._wSlots, s.weapons);
    this._slots(r.tSlots, this._tSlots, s.tomes);

    // fps
    if (s.fps == null) {
      if (L.fps !== null) {
        r.fps.classList.remove('vb-on');
        L.fps = null;
      }
    } else {
      const f = Math.round(s.fps);
      if (f !== L.fps) {
        if (L.fps == null) r.fps.classList.add('vb-on');
        r.fps.textContent = f + ' FPS';
        L.fps = f;
      }
    }
  }

  /* ------------------------------------------------------------- minimap */

  _mmResize() {
    const M = this._mm;
    const w = this.r.mmWrap.clientWidth || 170;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === M.w && dpr === M.dpr) return;
    M.w = w;
    M.dpr = dpr;
    const px = Math.round(w * dpr);
    this.r.mm.width = px;
    this.r.mm.height = px;
    M.ocean = null;
  }

  updateMinimap(m) {
    if (!this._hudOn || !m) return;
    const M = this._mm;
    if (!M.w || (window.devicePixelRatio || 1) !== M.dpr) this._mmResize();
    const ctx = M.ctx;
    if (!ctx) return;
    const W = M.w;
    const c = W / 2;
    const R = c - 1;
    const k = W / 170; // marker scale
    const s = R / MM_RANGE;
    const h = m.heading || 0;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const px = m.px || 0;
    const pz = m.pz || 0;
    // world (x,z) -> map: forward (sin h, cos h) points up, player's right (-cos h, sin h) points right
    const mx = (dx, dz) => c + (-dx * cos + dz * sin) * s;
    const my = (dx, dz) => c - (dx * sin + dz * cos) * s;
    const R2 = MM_RANGE * MM_RANGE;
    const now = performance.now();

    ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.clip();
    const bio = MM_BIOME[m.biome] || MM_BIOME.tropical;
    if (!M.ocean || M.biome !== bio) {
      M.ocean = ctx.createRadialGradient(c, c, 0, c, c, R);
      M.ocean.addColorStop(0, bio.sea[0]);
      M.ocean.addColorStop(1, bio.sea[1]);
      M.biome = bio;
    }
    ctx.fillStyle = M.ocean;
    ctx.fillRect(0, 0, W, W);

    // island
    const wr = (m.worldRadius || 120) * s;
    const ix = mx(-px, -pz);
    const iy = my(-px, -pz);
    const ig = ctx.createRadialGradient(ix, iy, 0, ix, iy, wr * 1.06);
    for (const [o, col] of bio.land) ig.addColorStop(o, col);
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ix, iy, wr * 1.06, 0, TAU);
    ctx.fill();

    // range ring + view cone
    ctx.strokeStyle = 'rgba(255,246,229,.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(c, c, R * 0.5, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,246,229,.10)';
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.closePath();
    ctx.fill();

    // pads
    const pads = m.pads;
    if (pads && pads.length) {
      ctx.fillStyle = VOLT;
      ctx.beginPath();
      for (let i = 0; i < pads.length; i++) {
        const dx = pads[i].x - px;
        const dz = pads[i].z - pz;
        if (dx * dx + dz * dz > R2) continue;
        const x = mx(dx, dz);
        const y = my(dx, dz);
        ctx.moveTo(x + 2.4 * k, y);
        ctx.arc(x, y, 2.4 * k, 0, TAU);
      }
      ctx.fill();
    }

    // enemies (one path, one fill)
    const en = m.enemies;
    const n = Math.min(m.enemyCount | 0, en ? en.length >> 1 : 0);
    if (n) {
      const es = 2.6 * k;
      ctx.fillStyle = HOT;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const dx = en[i * 2] - px;
        const dz = en[i * 2 + 1] - pz;
        if (dx * dx + dz * dz > R2) continue;
        ctx.rect(mx(dx, dz) - es / 2, my(dx, dz) - es / 2, es, es);
      }
      ctx.fill();
    }

    // shrines (diamonds)
    const shr = m.shrines;
    if (shr && shr.length) {
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = INK;
      for (let i = 0; i < shr.length; i++) {
        const dx = shr[i].x - px;
        const dz = shr[i].z - pz;
        if (dx * dx + dz * dz > R2) continue;
        const x = mx(dx, dz);
        const y = my(dx, dz);
        const d = 5 * k;
        const kind = shr[i].kind;
        ctx.globalAlpha = shr[i].used ? 0.35 : 1;
        ctx.fillStyle = SHRINE_MM[kind] || SURF;
        ctx.beginPath();
        if (kind === 'amber') {
          ctx.moveTo(x, y - d * 1.3); // obelisk: pointed tip, tapering shaft
          ctx.lineTo(x + d * 0.5, y - d * 0.6);
          ctx.lineTo(x + d * 0.62, y + d);
          ctx.lineTo(x - d * 0.62, y + d);
          ctx.lineTo(x - d * 0.5, y - d * 0.6);
        } else if (kind === 'totem') {
          ctx.moveTo(x, y - d * 1.1); // upward spike
          ctx.lineTo(x + d, y + d * 0.8);
          ctx.lineTo(x - d, y + d * 0.8);
        } else if (kind === 'greed') {
          ctx.arc(x, y, d * 0.95, 0, TAU); // coin
        } else if (kind === 'pylon') {
          for (let q = 0; q < 6; q++) ctx[q ? 'lineTo' : 'moveTo'](x + Math.cos(q * 1.0472) * d, y + Math.sin(q * 1.0472) * d); // hexagon
        } else {
          ctx.moveTo(x, y - d); // blessing: diamond
          ctx.lineTo(x + d, y);
          ctx.lineTo(x, y + d);
          ctx.lineTo(x - d, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (kind === 'amber') {
          ctx.fillStyle = '#FFF1B8'; // inner glint
          ctx.fillRect(x - d * 0.28, y - d * 0.45, d * 0.2, d * 1.1);
        } else if (kind === 'greed') {
          ctx.fillStyle = INK;
          ctx.fillRect(x - d * 0.42, y - d * 0.3, d * 0.3, d * 0.3);
          ctx.fillRect(x + d * 0.12, y - d * 0.3, d * 0.3, d * 0.3);
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore(); // end clip — edge indicators may sit on the rim

    // chests (gold squares, off-range unopened ones clamp to the rim)
    const ch = m.chests;
    if (ch && ch.length) {
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = INK;
      const cs = 6 * k;
      for (let i = 0; i < ch.length; i++) {
        const dx = ch[i].x - px;
        const dz = ch[i].z - pz;
        let x = mx(dx, dz);
        let y = my(dx, dz);
        const out = dx * dx + dz * dz > R2;
        if (out) {
          if (ch[i].opened) continue;
          const a = Math.atan2(y - c, x - c);
          x = c + Math.cos(a) * (R - 6 * k);
          y = c + Math.sin(a) * (R - 6 * k);
        }
        ctx.globalAlpha = ch[i].opened ? 0.3 : out ? 0.85 : 1;
        ctx.fillStyle = ch[i].opened ? '#9c8a4a' : '#FFC21A';
        ctx.fillRect(x - cs / 2, y - cs / 2, cs, cs);
        ctx.strokeRect(x - cs / 2, y - cs / 2, cs, cs);
      }
      ctx.globalAlpha = 1;
    }

    // portals: meteor crater (molten rock, pulses while active), launch cannon (cyan up-arrow, pulses),
    // fossil gate (bone skull, dim when inactive). 'boss'/'exit' are legacy aliases of meteor/cannon.
    // Off-range ones clamp to the rim.
    const po = m.portals;
    if (po && po.length) {
      for (let i = 0; i < po.length; i++) {
        const p = po[i];
        if (!p) continue;
        const dx = p.x - px;
        const dz = p.z - pz;
        let x = mx(dx, dz);
        let y = my(dx, dz);
        if (dx * dx + dz * dz > (MM_RANGE - 6) * (MM_RANGE - 6)) {
          const a = Math.atan2(y - c, x - c);
          x = c + Math.cos(a) * (R - 8 * k);
          y = c + Math.sin(a) * (R - 8 * k);
        }
        const kind = p.kind === 'exit' || p.kind === 'cannon' ? 'cannon' : p.kind === 'fossil' ? 'fossil' : 'meteor';
        const pr = 6.5 * k;
        const on = !!p.active;
        if (on) {
          const pulse = REDUCED || kind === 'fossil' ? 1 : 1 + 0.3 * (0.5 + 0.5 * Math.sin(now / 180 + i));
          ctx.fillStyle = kind === 'cannon' ? 'rgba(26,227,255,.36)' : kind === 'fossil' ? 'rgba(255,176,32,.26)' : 'rgba(255,106,26,.42)';
          ctx.beginPath();
          ctx.arc(x, y, (kind === 'fossil' ? 9.5 : 11) * k * pulse, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = on ? 1 : kind === 'fossil' ? 0.42 : 0.6;
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = INK;
        ctx.lineJoin = 'round';
        if (kind === 'meteor') {
          // crater rim + molten rock
          ctx.fillStyle = '#5A2A20';
          ctx.beginPath();
          ctx.ellipse(x, y + pr * 0.25, pr * 1.05, pr * 0.72, 0, 0, TAU);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = on ? SUN : '#B8643A';
          ctx.beginPath();
          ctx.arc(x, y - pr * 0.08, pr * 0.62, 0, TAU);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = on ? VOLT : '#E0A070';
          ctx.lineWidth = 1.4 * k;
          ctx.beginPath();
          ctx.moveTo(x - pr * 0.3, y - pr * 0.35);
          ctx.lineTo(x - pr * 0.02, y - pr * 0.08);
          ctx.lineTo(x - pr * 0.18, y + pr * 0.22);
          ctx.moveTo(x + pr * 0.12, y - pr * 0.42);
          ctx.lineTo(x + pr * 0.32, y - pr * 0.12);
          ctx.stroke();
        } else if (kind === 'cannon') {
          ctx.fillStyle = SURF;
          ctx.beginPath();
          ctx.arc(x, y, pr, 0, TAU);
          ctx.fill();
          ctx.stroke();
          // chunky up-arrow ("launch")
          const bob = REDUCED || !on ? 0 : Math.sin(now / 140) * 0.9 * k;
          ctx.beginPath();
          ctx.moveTo(x, y - pr * 0.72 + bob);
          ctx.lineTo(x + pr * 0.58, y - pr * 0.02 + bob);
          ctx.lineTo(x + pr * 0.24, y - pr * 0.02 + bob);
          ctx.lineTo(x + pr * 0.24, y + pr * 0.6 + bob);
          ctx.lineTo(x - pr * 0.24, y + pr * 0.6 + bob);
          ctx.lineTo(x - pr * 0.24, y - pr * 0.02 + bob);
          ctx.lineTo(x - pr * 0.58, y - pr * 0.02 + bob);
          ctx.closePath();
          ctx.fillStyle = PAPER;
          ctx.lineWidth = 1.3 * k;
          ctx.fill();
          ctx.stroke();
        } else {
          // bone-ivory skull with amber eyes
          ctx.fillStyle = BONE;
          ctx.beginPath();
          ctx.arc(x, y - pr * 0.15, pr * 0.82, Math.PI * 0.88, Math.PI * 2.12);
          ctx.lineTo(x + pr * 0.5, y + pr * 0.85);
          ctx.lineTo(x - pr * 0.5, y + pr * 0.85);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = on ? AMBER : INK;
          ctx.beginPath();
          ctx.arc(x - pr * 0.33, y - pr * 0.1, pr * 0.22, 0, TAU);
          ctx.arc(x + pr * 0.33, y - pr * 0.1, pr * 0.22, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.1 * k;
          ctx.beginPath();
          ctx.moveTo(x - pr * 0.18, y + pr * 0.52);
          ctx.lineTo(x - pr * 0.18, y + pr * 0.85);
          ctx.moveTo(x + pr * 0.18, y + pr * 0.52);
          ctx.lineTo(x + pr * 0.18, y + pr * 0.85);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    // boss
    if (m.boss) {
      const dx = m.boss.x - px;
      const dz = m.boss.z - pz;
      let x = mx(dx, dz);
      let y = my(dx, dz);
      if (dx * dx + dz * dz > (MM_RANGE - 6) * (MM_RANGE - 6)) {
        const a = Math.atan2(y - c, x - c);
        x = c + Math.cos(a) * (R - 8 * k);
        y = c + Math.sin(a) * (R - 8 * k);
      }
      const pulse = REDUCED ? 1 : 1 + 0.35 * (0.5 + 0.5 * Math.sin(now / 150));
      ctx.fillStyle = 'rgba(255,61,139,.35)';
      ctx.beginPath();
      ctx.arc(x, y, 10 * k * pulse, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ff2d55';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(x, y, 6.5 * k, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = PAPER;
      ctx.fillRect(x - 3.4 * k, y - 2.4 * k, 2.4 * k, 2.4 * k);
      ctx.fillRect(x + 1 * k, y - 2.4 * k, 2.4 * k, 2.4 * k);
      ctx.fillRect(x - 1.6 * k, y + 1.6 * k, 3.2 * k, 1.4 * k);
    }

    // north marker (world -Z)
    const nx = c - sin * (R - 8 * k);
    const ny = c + cos * (R - 8 * k);
    ctx.font = `700 ${Math.round(10 * k)}px "Chakra Petch", "Arial Narrow", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = INK;
    ctx.strokeText('N', nx, ny);
    ctx.fillStyle = VOLT;
    ctx.fillText('N', nx, ny);

    // player arrow
    ctx.save();
    ctx.translate(c, c);
    ctx.scale(k, k);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------- announce / toast / prompt */

  announce(text, opts = {}) {
    const A = this._ann;
    const item = { text: String(text), sub: opts.sub ? String(opts.sub) : '', color: opts.color || '', dur: Math.max(0.6, opts.duration ?? 2.2) * 1000 };
    if ((A.cur && A.cur.text === item.text) || A.queue.some((q) => q.text === item.text)) return;
    A.queue.push(item);
    if (A.queue.length > 3) A.queue.shift();
    if (!A.cur) this._annNext();
    else if (A.el && A.endAt - performance.now() > 800) {
      // something is waiting: cut the current one short (but let it land first)
      clearTimeout(A.timer);
      A.endAt = performance.now() + 700;
      A.timer = setTimeout(() => this._annOut(), 700);
    }
  }

  _annNext() {
    const A = this._ann;
    const item = A.queue.shift();
    if (!item) {
      A.cur = null;
      return;
    }
    A.cur = item;
    const color = item.color || (/BOSS|SWARM|EXTINCTION|METEOR|DANGER|WARNING/i.test(item.text) ? HOT : /RECORD|BEST/i.test(item.text) ? VOLT : SUN);
    const wrap = el('div', 'vb-ann');
    wrap.style.setProperty('--ac', color);
    const t = el('div', 'vb-ann-t vb-ot');
    setOT(t, item.text);
    wrap.append(el('div', 'vb-ann-band'), t);
    if (item.sub) wrap.append(el('div', 'vb-ann-sub', item.sub));
    this.r.announce.textContent = '';
    this.r.announce.append(wrap);
    A.el = wrap;
    A.endAt = performance.now() + item.dur;
    A.timer = setTimeout(() => this._annOut(), item.dur);
  }

  _annOut() {
    const A = this._ann;
    const e = A.el;
    A.el = null;
    if (!e) return this._annNext();
    e.classList.add('vb-out');
    setTimeout(() => {
      e.remove();
      this._annNext();
    }, REDUCED ? 60 : 260);
  }

  toast(text, opts = {}) {
    text = String(text);
    const dur = Math.max(0.5, opts.duration ?? 2) * 1000;
    for (const t of this._toasts) {
      if (t.text === text && !t.leaving) {
        t.count++;
        t.n.textContent = '×' + t.count;
        anim(t.el, KF_BUMP, 220);
        clearTimeout(t.timer);
        t.timer = setTimeout(() => this._toastOut(t), dur);
        return;
      }
    }
    const e = el('div', 'vb-toast');
    const color = opts.color || (/HEAL|HP|\+\d+ ?HP/i.test(text) ? LIME : /GOLD|COIN/i.test(text) ? VOLT : /CHEST/i.test(text) ? SUN : /SHRINE|BLESS/i.test(text) ? SURF : /BOSS|DANGER/i.test(text) ? HOT : VOLT);
    e.style.setProperty('--tc', color);
    if (opts.icon) {
      const ic = el('span', 'vb-toast-ic');
      ic.append(iconNode(opts.icon));
      e.append(ic);
    }
    const n = el('span', 'vb-toast-n');
    e.append(el('span', 'vb-toast-t', text), n);
    this.r.toasts.append(e);
    const t = { text, el: e, n, count: 1, leaving: false, timer: 0 };
    t.timer = setTimeout(() => this._toastOut(t), dur);
    this._toasts.push(t);
    const live = this._toasts.filter((x) => !x.leaving);
    if (live.length > 5) this._toastOut(live[0]);
  }

  _toastOut(t) {
    if (t.leaving) return;
    t.leaving = true;
    clearTimeout(t.timer);
    t.el.classList.add('vb-out');
    setTimeout(() => {
      t.el.remove();
      const i = this._toasts.indexOf(t);
      if (i >= 0) this._toasts.splice(i, 1);
    }, REDUCED ? 60 : 240);
  }

  setPrompt(text) {
    const t = text == null || text === '' ? null : String(text);
    if (t === this._prompt) return;
    this._prompt = t;
    const p = this.r.prompt;
    if (t) {
      p.textContent = t;
      p.classList.toggle('vb-warn', /NOT ENOUGH|CAN'?T|CANNOT|NEED|LOCKED/i.test(t));
      p.classList.add('vb-on');
    } else p.classList.remove('vb-on');
  }

  /* ------------------------------------------------------------ level up */

  showLevelUp(d = {}) {
    const r = this.r;
    const choices = Array.isArray(d.choices) ? d.choices : [];
    const title = String(d.title || 'LEVEL UP!');
    const kind = /chest/i.test(title) ? 'chest' : /boon|fossil/i.test(title) ? 'boon' : /amber|mutation/i.test(title) ? 'amber' : /shrine|bless/i.test(title) ? 'shrine' : 'level';
    r.lu.setAttribute('data-kind', kind);
    setOT(r.luTitle, title);
    r.luSub.textContent = '';
    r.luSub.append(el('span', null, choices.length > 1 ? 'PICK ONE' : 'TAKE IT'));
    choices.forEach((_, i) => r.luSub.append(el('kbd', null, String(i + 1))));
    r.luSub.append(el('span', 'vb-lu-or', 'OR CLICK'));
    this._renderCards(choices);
    const rr = d.rerolls == null ? null : Math.max(0, d.rerolls | 0);
    r.btnReroll.hidden = rr == null;
    r.btnReroll.disabled = !(rr > 0);
    r.rerollLabel.textContent = rr > 0 ? `REROLL (R) ×${rr}` : 'NO REROLLS';
    this._lu = { open: true, shownAt: performance.now(), picked: false, n: choices.length, rerolls: rr || 0 };
    this._show(r.lu);
  }

  hideLevelUp() {
    this._lu.open = false;
    this._hide(this.r.lu);
  }

  _renderCards(choices) {
    const wrap = this.r.cards;
    wrap.textContent = '';
    wrap.classList.remove('vb-has-pick');
    this._cardEls = choices.map((c, i) => {
      const rar = RARITY[c.rarity] ? c.rarity : 'common';
      const boon = c.kind === 'boon';
      const kind = KIND_LABEL[c.kind] || String(c.kind || '').toUpperCase();
      const rarText = boon ? 'FOSSIL' : RARITY[rar];
      const b = el('button', 'vb-card vb-r-' + rar + (boon ? ' vb-boon' : ''));
      b.type = 'button';
      b.style.setProperty('--i', i);
      const desc = Array.isArray(c.desc) ? c.desc : c.desc ? [c.desc] : [];
      b.setAttribute('aria-label', `${i + 1}: ${c.name}. ${rarText} ${kind}. ${c.levelText || ''}. ${desc.join('. ')}`);
      const body = el('span', 'vb-card-body');
      const band = el('span', 'vb-card-band');
      band.append(el('span', 'vb-card-key', String(i + 1)), el('span', 'vb-card-rar', rarText), el('span', 'vb-card-kind', kind));
      const ic = el('span', 'vb-card-ic');
      ic.append(burstNode(), iconNode(iconKey(c.id) !== 'star' ? c.id : c.kind === 'perk' ? 'perk' : c.kind === 'stat' ? 'amber' : boon ? 'fossil' : c.id));
      const isNew = /new/i.test(c.levelText || '');
      const lv = el('span', 'vb-card-lv' + (isNew ? ' vb-new' : ''), c.levelText || '');
      const dl = el('span', 'vb-card-desc');
      desc.forEach((line) => dl.append(descLine(line)));
      body.append(band, ic, el('span', 'vb-card-name', c.name || c.id || '???'), lv, dl);
      if (boon) body.append(el('span', 'vb-holo vb-holo-amber'));
      else if (rar === 'legendary') body.append(el('span', 'vb-holo'));
      b.append(body);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._pick(i);
      });
      wrap.append(b);
      return b;
    });
  }

  _pick(i) {
    const L = this._lu;
    if (!L.open || L.picked || performance.now() - L.shownAt < 350 || i < 0 || i >= L.n) return;
    L.picked = true;
    const card = this._cardEls[i];
    if (card) {
      card.classList.add('vb-picked');
      this.r.cards.classList.add('vb-has-pick');
    }
    this._blur();
    this._call('onPick', i);
  }

  _reroll() {
    const L = this._lu;
    if (!L.open || L.picked || performance.now() - L.shownAt < 350) return;
    if (!(L.rerolls > 0)) {
      anim(this.r.btnReroll, KF_SHAKE, 260);
      return;
    }
    L.shownAt = performance.now(); // debounce until the lead re-shows with fresh choices
    this._blur();
    this._call('onReroll');
  }

  /* --------------------------------------------------------------- pause */

  showPause(settings) {
    const r = this.r;
    this._mergeSettings(settings);
    const s = this._lastS;
    r.pauseSum.textContent = '';
    r.pauseBuild.textContent = '';
    if (s) {
      const sums = [
        ['TIME', mmss(s.time)],
        ['SCORE', commas(s.score)],
        ['KILLS', commas(s.kills)],
        ['LEVEL', String(s.level | 0)],
      ];
      if (s.island) sums.unshift(['ISLAND', (s.island.n | 0 || 1) + '/5']);
      r.pauseSum.style.setProperty('--n', sums.length);
      sums.forEach(([k, v]) => {
        const c = el('div', 'vb-psum');
        c.append(el('span', 'k', k), el('b', null, v));
        r.pauseSum.append(c);
      });
      [...(s.weapons || []), ...(s.tomes || [])].forEach((it) => {
        const t = el('span', 'vb-pb');
        t.title = `${it.name} — LV ${it.level}/${it.maxLevel}`;
        t.append(iconNode(it.id), el('b', null, it.level >= it.maxLevel ? 'MAX' : String(it.level)));
        r.pauseBuild.append(t);
      });
    }
    this._setPauseSettingsOpen(false);
    this._disarmQuit();
    this._pauseOpen = true;
    this._show(r.pause);
    setTimeout(() => this._pauseOpen && !isInteractive(document.activeElement) && r.btnResume.focus({ preventScroll: true }), 30);
  }

  hidePause() {
    this._pauseOpen = false;
    this._disarmQuit();
    this._hide(this.r.pause);
  }

  _setPauseSettingsOpen(open) {
    this._pauseSetOpen = !!open;
    this.r.pauseSet.classList.toggle('vb-on', this._pauseSetOpen);
    this.r.btnPauseSet.setAttribute('aria-expanded', this._pauseSetOpen ? 'true' : 'false');
  }

  _quit() {
    if (!this._pauseOpen) return;
    if (!this._quitArmed) {
      this._quitArmed = true;
      this.r.quitLabel.textContent = 'SURE? CLICK AGAIN';
      this.r.btnQuit.classList.add('vb-armed');
      clearTimeout(this._quitT);
      this._quitT = setTimeout(() => this._disarmQuit(), 2800);
      return;
    }
    this._disarmQuit();
    this._blur();
    this._call('onQuit');
  }

  _disarmQuit() {
    clearTimeout(this._quitT);
    this._quitArmed = false;
    this.r.quitLabel.textContent = 'QUIT TO MENU';
    this.r.btnQuit.classList.remove('vb-armed');
  }

  /* ----------------------------------------------------------- game over */

  showGameOver(d = {}) {
    const r = this.r;
    if (this._lu.open) this.hideLevelUp();
    if (this._pauseOpen) this.hidePause();
    this.setPrompt(null);
    this.hideBossIntro();
    const Q = this._qp;
    clearTimeout(Q.timer);
    Q.queue.length = 0;
    Q.cur = Q.el = null;
    r.qpop.textContent = '';

    r.ovMode.textContent = d.daily != null ? 'DAILY #' + d.daily : 'RANDOM ISLAND';
    r.ovRank.textContent = d.rank || 'Island Tourist';
    const vic = !!d.victory;
    r.over.classList.toggle('vb-victory', vic);
    r.over.setAttribute('aria-label', vic ? 'Victory' : 'Game over');
    const head = String(d.headline || (vic ? 'ISLAND CLEARED!' : 'SMASHED.')).toUpperCase();
    setOT(r.ovHead, head);
    r.ovHead.classList.toggle('vb-long', head.length > 9);
    r.ovHead.classList.toggle('vb-xlong', head.length > 15);
    this._renderOverIslands(d);
    const hasRewards = this._renderRewards(d.unlocks, d.questsDone);
    setOT(r.ovScore, '0');
    r.ovBest.classList.remove('vb-on');

    // challenge result
    const ch = d.challenge;
    r.ovChal.className = 'vb-chal-res';
    r.ovChal.textContent = '';
    if (ch && ch.target != null) {
      const diff = commas(Math.abs(ch.diff || 0));
      r.ovChal.classList.add('vb-on', ch.won ? 'vb-won' : 'vb-lost');
      r.ovChal.append(
        iconNode('challenge'),
        el('span', null, ch.won ? `CHALLENGE CRUSHED! Beat ${commas(ch.target)} by +${diff}` : `CHALLENGE FAILED — ${diff} short of ${commas(ch.target)}`)
      );
    }

    // stats
    const stats = [
      ['TIME', mmss(d.time)],
      ['KILLS', commas(d.kills)],
      ['LEVEL', String(d.level ?? 0)],
      ['TOP SPEED', String(Math.round((d.topSpeed || 0) * 3.6)), 'KM/H'],
      ['MAX MOMENTUM', '×' + (Math.max(1, d.maxMomentum || 1)).toFixed(1)],
      ['BOSS KILLS', commas(d.bossKills)],
    ];
    r.ovStats.textContent = '';
    stats.forEach(([k, v, u], i) => {
      const t = el('div', 'vb-stat');
      t.style.setProperty('--i', i);
      const vv = el('div', 'vb-stat-v', v);
      if (u) vv.append(el('small', null, u));
      t.append(el('div', 'vb-stat-k', k), vv);
      r.ovStats.append(t);
    });

    // damage per weapon
    const all = (Array.isArray(d.damageByWeapon) ? d.damageByWeapon : []).filter((w) => w && w.dmg > 0).sort((a, b) => b.dmg - a.dmg);
    const total = all.reduce((a, w) => a + w.dmg, 0) || 1;
    const list = all.slice(0, hasRewards ? 4 : 6);
    const max = list.length ? list[0].dmg : 1;
    r.ovDmg.textContent = '';
    if (!list.length) r.ovDmg.append(el('div', 'vb-empty', 'No damage dealt. Pacifist run?'));
    list.forEach((w, i) => {
      const row = el('div', 'vb-dmg-row');
      row.style.setProperty('--i', i);
      const ic = el('span', 'vb-dmg-ic');
      ic.append(iconNode(w.id));
      const mid = el('div', 'vb-dmg-mid');
      const top = el('div', 'vb-dmg-top');
      top.append(el('span', 'vb-dmg-name', w.name || w.id), el('span', 'vb-dmg-val', commas(w.dmg) + ' · ' + Math.round((w.dmg / total) * 100) + '%'));
      const track = el('div', 'vb-dmg-track');
      const fill = el('div', 'vb-dmg-fill');
      fill.style.setProperty('--w', (w.dmg / max).toFixed(3));
      track.append(fill);
      mid.append(top, track);
      row.append(ic, mid);
      r.ovDmg.append(row);
    });

    this._renderBests(r.ovBests, d.bests, { score: d.score, time: d.time }, hasRewards ? 3 : 5);

    r.ovShare.classList.remove('vb-on');
    r.ovShareTa.value = d.shareText || '';
    r.btnCopy.hidden = !d.shareText;
    r.copyLabel.textContent = 'COPY CHALLENGE';

    this._over = { open: true, data: d, shownAt: performance.now() };
    this._show(r.over);
    r.over.scrollTop = 0;
    this._countUp(Math.round(d.score || 0), !!d.isBest);
  }

  _renderOverIslands(d) {
    const box = this.r.ovIsl;
    box.textContent = '';
    if (d.islandsCleared == null && d.islandReached == null) {
      box.classList.remove('vb-on');
      return;
    }
    box.classList.add('vb-on');
    const cl = Math.max(0, Math.min(5, d.islandsCleared | 0));
    const re = Math.max(cl, Math.min(5, d.islandReached | 0));
    const ol = el('ol', 'vb-ovi-list');
    for (let i = 1; i <= 5; i++) {
      const li = el('li', i <= cl ? 'vb-cleared' : i === re ? 'vb-reached' : 'vb-far');
      li.append(islandMedal(BIOME_ORDER[i - 1], null, i <= cl ? 'check' : null));
      ol.append(li);
    }
    const txt = el('div', 'vb-ovi-txt');
    txt.append(el('b', null, cl + '/5'), el('span', null, cl === 1 ? 'ISLAND CLEARED' : 'ISLANDS CLEARED'));
    if (re > cl) txt.append(el('small', null, 'FELL ON ISLAND ' + re));
    box.append(ol, txt);
  }

  _renderRewards(unlocks, quests) {
    const box = this.r.ovRewards;
    box.textContent = '';
    const U = Array.isArray(unlocks) ? unlocks.filter(Boolean) : [];
    const Q = Array.isArray(quests) ? quests.filter(Boolean) : [];
    box.classList.toggle('vb-on', !!(U.length || Q.length));
    const head = (icon, text) => {
      const h = el('div', 'vb-card-head vb-rw-head');
      const hi = el('span', 'vb-head-ic');
      hi.append(iconNode(icon));
      h.append(hi, document.createTextNode(text));
      return h;
    };
    if (U.length) {
      const g = el('div', 'vb-rw-grid');
      U.slice(0, 8).forEach((u, i) => {
        const c = el('div', 'vb-rw');
        c.style.setProperty('--i', i);
        const ic = el('span', 'vb-rw-ic');
        ic.append(burstNode(), iconNode(rewardIcon(u)));
        const t = el('span', 'vb-rw-t');
        t.append(el('small', null, KIND_LABEL[u.kind] || String(u.kind || 'UNLOCK').toUpperCase()), el('b', null, String(u.name || u.id)));
        c.append(ic, t);
        g.append(c);
      });
      box.append(head('star', U.length > 1 ? 'NEW UNLOCKS!' : 'NEW UNLOCK!'), g);
    }
    if (Q.length) {
      const ul = el('ul', 'vb-rw-qs');
      Q.slice(0, 10).forEach((q, i) => {
        const li = el('li');
        li.style.setProperty('--i', i);
        li.append(iconNode('check'), el('span', null, String(typeof q === 'string' ? q : q.name || q.id || '')));
        ul.append(li);
      });
      box.append(head('trophy', 'QUESTS COMPLETED'), ul);
    }
    return !!(U.length || Q.length);
  }

  hideGameOver() {
    this._over.open = false;
    cancelAnimationFrame(this._cuRaf);
    this._hide(this.r.over);
  }

  _countUp(target, isBest) {
    cancelAnimationFrame(this._cuRaf);
    const r = this.r;
    const start = performance.now() + (REDUCED ? 0 : 500);
    const dur = REDUCED ? 250 : Math.min(2200, 700 + Math.log10(target + 1) * 230);
    r.ovScore.classList.add('vb-counting');
    let last = -1;
    const step = (now) => {
      if (!this._over.open) return;
      const t = clamp01((now - start) / dur);
      const v = Math.round(target * (1 - Math.pow(1 - t, 3)));
      if (v !== last) {
        setOT(r.ovScore, commas(v));
        last = v;
      }
      if (t < 1) {
        this._cuRaf = requestAnimationFrame(step);
        return;
      }
      r.ovScore.classList.remove('vb-counting');
      anim(r.ovScore, KF_POP, 420);
      if (isBest) r.ovBest.classList.add('vb-on');
      setTimeout(() => this._over.open && !isInteractive(document.activeElement) && r.btnAgain.focus({ preventScroll: true }), 300);
    };
    this._cuRaf = requestAnimationFrame(step);
  }

  _copyShare() {
    const r = this.r;
    const text = (this._over.data && this._over.data.shareText) || '';
    if (!text) return;
    const ok = () => {
      r.copyLabel.textContent = 'COPIED!';
      r.btnCopy.classList.add('vb-done');
      this.toast('Challenge copied — send it to a friend', { color: SURF });
      clearTimeout(this._copyT);
      this._copyT = setTimeout(() => {
        r.copyLabel.textContent = 'COPY CHALLENGE';
        r.btnCopy.classList.remove('vb-done');
      }, 1800);
    };
    const fallback = () => {
      r.ovShareTa.value = text;
      r.ovShare.classList.add('vb-on');
      r.ovShareTa.focus({ preventScroll: true });
      r.ovShareTa.select();
      let copied = false;
      try {
        copied = document.execCommand && document.execCommand('copy');
      } catch (_) {
        copied = false;
      }
      r.ovShareMsg.textContent = copied ? 'Copied! (Here it is too, just in case.)' : 'Clipboard is blocked here — select and copy this:';
      if (copied) ok();
      else r.copyLabel.textContent = 'COPY IT BELOW';
    };
    let p = null;
    try {
      // must be called synchronously inside the click handler
      p = navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : null;
    } catch (_) {
      p = null;
    }
    if (p && p.then) p.then(ok, fallback);
    else fallback();
    this._call('onCopyShare', text);
  }

  /* --------------------------------------------------------------- state */

  get isModalOpen() {
    return !!(this._lu.open || this._pauseOpen || this._over.open || this._qsOpen);
  }
}

export default UI;
