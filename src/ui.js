// VELOCIBONK — UI layer. Vanilla DOM, no framework.
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

const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Chakra+Petch:ital,wght@0,500;0,600;0,700;1,600;1,700&family=Lilita+One&display=swap';

const RARITY = { common: 'COMMON', uncommon: 'UNCOMMON', rare: 'RARE', epic: 'EPIC', legendary: 'LEGENDARY' };
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
  // tomes
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
};

/** id -> inline SVG string. Unknown ids fall back to the generic star. */
export const ICONS = new Proxy(BASE_ICONS, {
  get(t, k) {
    if (k in t) return t[k];
    return typeof k === 'string' ? t.star : undefined;
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
  const key = Object.prototype.hasOwnProperty.call(BASE_ICONS, id) ? id : 'star';
  return nodeFrom(key, BASE_ICONS[key]);
};
const burstNode = () => nodeFrom('__burst', BURST);

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

const LOGO = 'VELOCIBONK'
  .split('')
  .map((ch, i) => `<span class="vb-lt${i > 5 ? ' vb-bonk' : ''}" style="--i:${i}"><span class="vb-lt-bob vb-ot" data-t="${ch}"><span class="vb-lt-f">${ch}</span></span></span>`)
  .join('');
const CHEV = `<svg viewBox="0 0 40 24" aria-hidden="true" focusable="false"><path d="M4 3 L15 12 L4 21 M20 3 L31 12 L20 21" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const HOWTO = `
<div class="vb-how">
  <section class="vb-how-col">
    <h3>CONTROLS</h3>
    <dl class="vb-keys">
      <div><dt><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></dt><dd>Move</dd></div>
      <div><dt><kbd class="w">MOUSE</kbd></dt><dd>Look — click to lock the cursor</dd></div>
      <div><dt><kbd class="w">SPACE</kbd></dt><dd>Jump / double jump — hold to auto-hop</dd></div>
      <div><dt><kbd class="w">SHIFT</kbd></dt><dd>Slide on the ground · <b>SLAM</b> when airborne</dd></div>
      <div><dt><kbd class="w">ESC</kbd></dt><dd>Pause</dd></div>
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
    <h3>SURVIVE</h3>
    <ul class="vb-rules">
      <li><b>AUTO</b><span>Weapons fire automatically</span></li>
      <li><b>CHESTS</b><span>Cost gold — walk in to open</span></li>
      <li><b>SHRINES</b><span>Stand in them for blessings</span></li>
      <li><b class="hot">BOSSES</b><span>At 3:00, 6:00 and 9:00 · FINAL SWARM at 10:00</span></li>
    </ul>
  </section>
  <div class="vb-how-callout"><span class="k">SCORE</span><span>=</span><span>KILLS</span><span>×</span><span class="m">MOMENTUM</span></div>
</div>`;

const TEMPLATE = `
<div class="vb-hud" data-r="hud" data-tier="0" aria-hidden="true">
  <div class="vb-speedlines"></div>
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
    <div class="vb-timer vb-ot" data-r="timer" data-t="00:00">00:00</div>
    <div class="vb-score"><b data-r="score">0</b><span class="k">PTS</span></div>
    <div class="vb-phase vb-empty" data-r="phase"></div>
    <div class="vb-boss" data-r="boss">
      <div class="vb-boss-name"><span class="vb-boss-ic">${BASE_ICONS.skull}</span><span data-r="bossName">BOSS</span></div>
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
  <div class="vb-over-bg"></div>
  <div class="vb-over-wrap">
    <div class="vb-over-left">
      <div class="vb-over-mode" data-r="ovMode"></div>
      <h1 class="vb-bonked vb-ot" data-t="BONKED.">BONKED.</h1>
      <div class="vb-rank"><span class="k">RANK</span><b data-r="ovRank"></b></div>
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
      <div class="vb-card-head">DAMAGE BY WEAPON</div>
      <div class="vb-dmg" data-r="ovDmg"></div>
      <div class="vb-card-head">PERSONAL BESTS</div>
      <ol class="vb-bests vb-bests-sm" data-r="ovBests"></ol>
    </div>
  </div>
</section>

<section class="vb-screen vb-title" data-r="title" aria-label="VELOCIBONK">
  <div class="vb-title-tint"></div>
  <div class="vb-title-grid">
    <div class="vb-title-main">
      <div class="vb-logo-wrap">
        <div class="vb-streaks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <h1 class="vb-logo" aria-label="VELOCIBONK">${LOGO}</h1>
        <div class="vb-tagline"><span>SPEED IS <em>DAMAGE.</em></span></div>
      </div>
      <div class="vb-challenge" data-r="challenge"><span class="vb-challenge-ic">${BASE_ICONS.challenge}</span><span data-r="challengeText"></span></div>
      <nav class="vb-menu" aria-label="Main menu">
        <button type="button" class="vb-btn vb-btn-xl vb-btn-sun" data-r="btnDaily"><span class="vb-btn-in"><span class="vb-btn-stack"><span data-r="dailyLabel">PLAY DAILY</span><small data-r="dateLabel"></small></span><span class="vb-btn-go">${CHEV}</span></span></button>
        <button type="button" class="vb-btn vb-btn-lg vb-btn-surf" data-r="btnRandom"><span class="vb-btn-in">RANDOM ISLAND</span></button>
        <div class="vb-menu-row">
          <button type="button" class="vb-btn vb-btn-md" data-r="btnHow"><span class="vb-btn-in">HOW TO PLAY</span></button>
          <button type="button" class="vb-btn vb-btn-md" data-r="btnSet"><span class="vb-btn-in">SETTINGS</span></button>
        </div>
      </nav>
    </div>
    <aside class="vb-side">
      <div class="vb-panel vb-bests-card">
        <div class="vb-card-head"><span class="vb-head-ic">${BASE_ICONS.star}</span>PERSONAL BESTS</div>
        <ol class="vb-bests" data-r="bests"></ol>
        <div class="vb-daily-note">One island per day. Same seed for everyone.</div>
      </div>
    </aside>
  </div>
  <p class="vb-footer">Every model, texture, sound and song is generated in code at load time.</p>
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
    this._last = { hp: -1, maxHp: -1, low: false, lv: -1, xq: -1, t: -1, sc: -1, k: -1, g: -1, kmh: -1, segs: -1, m10: -1, tier: -1, ram: false, ph: null, boss: false, bossName: null, bq: -1, fps: undefined };
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
    this._mm = { w: 0, dpr: 0, ctx: r.mm.getContext('2d'), ocean: null };

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
    if (this._titleOpen && k === 'Escape' && this._sheetOpen) {
      e.preventDefault();
      this._closeSheets();
    }
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

  _renderBests(ol, bests, me) {
    ol.textContent = '';
    const list = Array.isArray(bests) ? bests.slice(0, 5) : [];
    if (!list.length) {
      ol.append(el('li', 'vb-empty', 'No runs yet. Go bonk something.'));
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

    // timer / score / counters
    const t = Math.floor(s.time || 0);
    if (t !== L.t) {
      setOT(r.timer, mmss(t));
      L.t = t;
    }
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

    // phase line
    const ph = s.phase || '';
    if (ph !== L.ph) {
      r.phase.textContent = ph;
      const mm = /(\d+):(\d\d)/.exec(ph);
      const soon = /BOSS IN/i.test(ph) && mm && +mm[1] * 60 + +mm[2] <= 10;
      r.phase.className = 'vb-phase' + (!ph ? ' vb-empty' : /FIGHT|SWARM|!/i.test(ph) ? ' vb-danger' : soon ? ' vb-soon' : '');
      L.ph = ph;
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
    } else if (L.boss) {
      r.boss.classList.remove('vb-on');
      L.boss = false;
      L.bq = -1;
      L.bossName = null;
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
    if (!M.ocean) {
      M.ocean = ctx.createRadialGradient(c, c, 0, c, c, R);
      M.ocean.addColorStop(0, '#1b6f96');
      M.ocean.addColorStop(1, '#0b3656');
    }
    ctx.fillStyle = M.ocean;
    ctx.fillRect(0, 0, W, W);

    // island
    const wr = (m.worldRadius || 120) * s;
    const ix = mx(-px, -pz);
    const iy = my(-px, -pz);
    const ig = ctx.createRadialGradient(ix, iy, 0, ix, iy, wr * 1.06);
    ig.addColorStop(0, '#2f8a45');
    ig.addColorStop(0.72, '#4fae54');
    ig.addColorStop(0.86, '#8fc862');
    ig.addColorStop(0.91, '#f1d38e');
    ig.addColorStop(0.955, 'rgba(241,211,142,.55)');
    ig.addColorStop(1, 'rgba(241,211,142,0)');
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
        ctx.globalAlpha = shr[i].used ? 0.35 : 1;
        ctx.fillStyle = SURF;
        ctx.beginPath();
        ctx.moveTo(x, y - d);
        ctx.lineTo(x + d, y);
        ctx.lineTo(x, y + d);
        ctx.lineTo(x - d, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
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
    const color = item.color || (/BOSS|SWARM|DANGER|WARNING/i.test(item.text) ? HOT : /RECORD|BEST/i.test(item.text) ? VOLT : SUN);
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
    r.lu.setAttribute('data-kind', /chest/i.test(title) ? 'chest' : /shrine|bless/i.test(title) ? 'shrine' : 'level');
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
      const kind = c.kind === 'tome' ? 'TOME' : c.kind === 'weapon' ? 'WEAPON' : String(c.kind || '').toUpperCase();
      const b = el('button', 'vb-card vb-r-' + rar);
      b.type = 'button';
      b.style.setProperty('--i', i);
      const desc = Array.isArray(c.desc) ? c.desc : c.desc ? [c.desc] : [];
      b.setAttribute('aria-label', `${i + 1}: ${c.name}. ${RARITY[rar]} ${kind}. ${c.levelText || ''}. ${desc.join('. ')}`);
      const body = el('span', 'vb-card-body');
      const band = el('span', 'vb-card-band');
      band.append(el('span', 'vb-card-key', String(i + 1)), el('span', 'vb-card-rar', RARITY[rar]), el('span', 'vb-card-kind', kind));
      const ic = el('span', 'vb-card-ic');
      ic.append(burstNode(), iconNode(c.id));
      const isNew = /new/i.test(c.levelText || '');
      const lv = el('span', 'vb-card-lv' + (isNew ? ' vb-new' : ''), c.levelText || '');
      const dl = el('span', 'vb-card-desc');
      desc.forEach((line) => dl.append(descLine(line)));
      body.append(band, ic, el('span', 'vb-card-name', c.name || c.id || '???'), lv, dl);
      if (rar === 'legendary') body.append(el('span', 'vb-holo'));
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
      [
        ['TIME', mmss(s.time)],
        ['SCORE', commas(s.score)],
        ['KILLS', commas(s.kills)],
        ['LEVEL', String(s.level | 0)],
      ].forEach(([k, v]) => {
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

    r.ovMode.textContent = d.daily != null ? 'DAILY #' + d.daily : 'RANDOM ISLAND';
    r.ovRank.textContent = d.rank || 'Island Tourist';
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
    const list = all.slice(0, 6);
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

    this._renderBests(r.ovBests, d.bests, { score: d.score, time: d.time });

    r.ovShare.classList.remove('vb-on');
    r.ovShareTa.value = d.shareText || '';
    r.btnCopy.hidden = !d.shareText;
    r.copyLabel.textContent = 'COPY CHALLENGE';

    this._over = { open: true, data: d, shownAt: performance.now() };
    this._show(r.over);
    r.over.scrollTop = 0;
    this._countUp(Math.round(d.score || 0), !!d.isBest);
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
    return !!(this._lu.open || this._pauseOpen || this._over.open);
  }
}

export default UI;
