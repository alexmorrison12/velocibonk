// The Archipelago: five islands, each a distinct biome with its own terrain shape, palette, sky,
// liquid, props, ambience, final boss and music. A run hops island to island through portals.

export const ISLAND_TIME = 480; // 8:00 countdown per island

const C = (hex) => hex; // (colors stay as hex strings; THREE.Color parses them)

export const ISLANDS = [
  {
    n: 1, id: 'tropical', name: 'PALM PARADISE', subtitle: 'Sun, sand and a lot of smashing',
    boss: 'tiki', bossName: 'TIKI TITAN', bossTitle: 'GUARDIAN OF PALM PARADISE', miniName: 'KING CHONK',
    sky: { top: C('#3E7BE0'), mid: C('#8EC8FF'), horizon: C('#FFD6A8'), sun: C('#FFF3C4'), sunDir: [-0.55, 0.62, -0.56], sunSize: 900, stars: 0, aurora: 0 },
    fog: { color: C('#F4D8B8'), near: 80, far: 460 },
    light: { sky: C('#D6ECFF'), ground: C('#8C6A4C'), hemi: 1.3, sun: C('#FFF1D6'), sunI: 2.35, exposure: 1.05 },
    terrain: {
      shape: 'tropical',
      sand: C('#F1DB9C'), wet: C('#C9AE72'), a: C('#66BD48'), b: C('#86CC52'), c: C('#4B9E44'),
      rockA: C('#A39785'), rockB: C('#857B6D'), cliff: C('#C9A27A'), seabed: C('#D6C089'), peak: C('#CFC6B6'),
    },
    liquid: { kind: 0, shallow: C('#3FE0D0'), deep: C('#1560BD'), far: C('#2A6FD6'), foam: C('#FFFFFF') },
    clouds: { bottom: C('#F3B6C8'), top: C('#FFFDF8') },
    stacks: { top: C('#63B84A'), bottom: C('#9C8A78') },
    props: [
      ['palm', 110, { minH: 1.0, maxH: 5, minR: 12, avoid2: 5, minSlope: 0.75, shadow: true }, 1, 0.8, 1.25],
      ['roundtree', 150, { minH: 3, maxH: 24, minR: 16, avoid2: 5, minSlope: 0.8, shadow: true }, 1, 0.8, 1.4],
      ['pine', 130, { minH: 9, maxH: 45, minR: 20, avoid2: 5, minSlope: 0.72, shadow: true }, 1, 0.8, 1.5],
      ['rock', 170, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 2.2],
      ['bush', 220, { minH: 1.8, minR: 6, avoid2: 3, minSlope: 0.75 }, 0, 0.7, 1.4],
      ['flower', 320, { minH: 2, minR: 3, avoid2: 2, minSlope: 0.8 }, 0, 0.8, 1.5],
      ['mushroom', 90, { minH: 2, minR: 8, avoid2: 2, minSlope: 0.8 }, 0, 0.8, 1.6],
      ['grass', 4200, { minH: 1.6, minR: 2, minSlope: 0.78 }, 0, 0.7, 1.5],
      ['crystal', 36, { minH: 12, minR: 40, avoid2: 6, minSlope: 0.6, shadow: true }, 0.8, 0.8, 1.8],
    ],
    grassTint: [1, 1, 1],
    ambient: 'tropical',
    grade: { tint: '#ffffff', saturation: 1, contrast: 1, vignetteColor: '#000000', haze: 0 },
    friction: 1,
    color: '#66BD48',
  },
  {
    n: 2, id: 'frost', name: 'FROSTBITE PEAKS', subtitle: 'The ice is slippery. Use it.',
    boss: 'yeti', bossName: 'YETI KING', bossTitle: 'TYRANT OF THE FROZEN PEAKS', miniName: 'FROST CHONK',
    sky: { top: C('#22306E'), mid: C('#6E8FE0'), horizon: C('#FFD9E6'), sun: C('#FFE6CF'), sunDir: [0.7, 0.36, -0.6], sunSize: 700, stars: 0.35, aurora: 1 },
    fog: { color: C('#D8E2F5'), near: 70, far: 430 },
    light: { sky: C('#D4E2FF'), ground: C('#7080A8'), hemi: 1.2, sun: C('#FFE2C8'), sunI: 2.05, exposure: 1.0 },
    terrain: {
      shape: 'frost',
      sand: C('#CFE6F5'), wet: C('#A9CBE3'), a: C('#EEF3FA'), b: C('#E0E9F5'), c: C('#CFDCEE'),
      rockA: C('#71809B'), rockB: C('#56627A'), cliff: C('#9FB8DA'), seabed: C('#8FB8D6'), peak: C('#FFFFFF'),
    },
    liquid: { kind: 1, shallow: C('#CFF4FF'), deep: C('#5FA8DE'), far: C('#2F6FBF'), foam: C('#FFFFFF') },
    clouds: { bottom: C('#B7C3EE'), top: C('#FFFFFF') },
    stacks: { top: C('#F4F8FF'), bottom: C('#6F7E99') },
    props: [
      ['snowpine', 190, { minH: 1.5, maxH: 40, minR: 14, avoid2: 5, minSlope: 0.7, shadow: true }, 1, 0.8, 1.5],
      ['icespire', 45, { minH: 3, minR: 24, avoid2: 6, minSlope: 0.55, shadow: true }, 0.8, 0.8, 1.6],
      ['snowrock', 150, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 2.1],
      ['icecrystal', 50, { minH: 4, minR: 20, avoid2: 5, minSlope: 0.6, shadow: true }, 0.8, 0.8, 1.7],
      ['snowman', 28, { minH: 2, minR: 14, avoid2: 5, minSlope: 0.85, shadow: true }, 0.6, 0.9, 1.3],
      ['frozenbush', 170, { minH: 1.8, minR: 6, avoid2: 3, minSlope: 0.75 }, 0, 0.7, 1.4],
      ['grass', 1600, { minH: 1.6, minR: 2, minSlope: 0.78 }, 0, 0.6, 1.2],
    ],
    grassTint: [1.25, 1.35, 1.6],
    ambient: 'snow',
    grade: { tint: '#EAF2FF', saturation: 0.96, contrast: 1.05, vignetteColor: '#1B2A6B', haze: 0 },
    friction: 0.45,
    color: '#9FD4FF',
  },
  {
    n: 3, id: 'desert', name: 'SUNSCORCH DUNES', subtitle: 'Every dune is a launch ramp',
    boss: 'worm', bossName: 'DUNE DEVOURER', bossTitle: 'THE SAND THAT HUNGERS', miniName: 'DUNE CHONK',
    sky: { top: C('#6A3A9A'), mid: C('#F0704E'), horizon: C('#FFCB70'), sun: C('#FFF0B8'), sunDir: [-0.82, 0.3, 0.48], sunSize: 420, stars: 0, aurora: 0 },
    fog: { color: C('#F0A870'), near: 60, far: 410 },
    light: { sky: C('#FFD7AA'), ground: C('#A0552D'), hemi: 1.25, sun: C('#FFD49A'), sunI: 2.55, exposure: 1.02 },
    terrain: {
      shape: 'desert',
      sand: C('#F7D9A0'), wet: C('#D9B27A'), a: C('#F4C57A'), b: C('#EAB266'), c: C('#DDA05A'),
      rockA: C('#B5553A'), rockB: C('#8E3F2B'), cliff: C('#D0763F'), seabed: C('#D9B27A'), peak: C('#F7D9A0'),
    },
    liquid: { kind: 0, shallow: C('#44E8C8'), deep: C('#138A7C'), far: C('#1E6FA8'), foam: C('#FFF4D8') },
    clouds: { bottom: C('#E07A8A'), top: C('#FFDDB0') },
    stacks: { top: C('#E08D4F'), bottom: C('#8E3F2B') },
    props: [
      ['saguaro', 130, { minH: 2, maxH: 40, minR: 14, avoid2: 5, minSlope: 0.8, shadow: true }, 0.7, 0.8, 1.35],
      ['mesarock', 40, { minH: 1, minR: 30, avoid2: 8, minSlope: 0.5, shadow: true }, 0.9, 0.8, 1.5],
      ['barrelcactus', 110, { minH: 1.5, minR: 8, avoid2: 3, minSlope: 0.8 }, 0.6, 0.7, 1.4],
      ['skull', 28, { minH: 1.5, minR: 16, avoid2: 5, minSlope: 0.8, shadow: true }, 0.7, 0.8, 1.5],
      ['desertshrub', 170, { minH: 1.5, minR: 6, avoid2: 2, minSlope: 0.75 }, 0, 0.7, 1.4],
      ['deadpalm', 45, { minH: 0.8, maxH: 6, minR: 12, avoid2: 5, minSlope: 0.75, shadow: true }, 1, 0.8, 1.2],
      ['rock', 70, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 1.8],
      ['grass', 800, { minH: 1.6, minR: 2, minSlope: 0.8 }, 0, 0.6, 1.2],
    ],
    grassTint: [1.9, 1.45, 0.6],
    ambient: 'sand',
    grade: { tint: '#FFEAD2', saturation: 1.1, contrast: 1.07, vignetteColor: '#5A1F10', haze: 0.55 },
    friction: 1,
    color: '#F4A04A',
  },
  {
    n: 4, id: 'grave', name: 'GLOOMHOLLOW', subtitle: 'Something is watching from the fog',
    boss: 'lich', bossName: 'THE GRAVELORD', bossTitle: 'KEEPER OF A THOUSAND GRAVES', miniName: 'GLOOM CHONK',
    sky: { top: C('#0E0A24'), mid: C('#2A1A55'), horizon: C('#3F7A80'), sun: C('#EAF2FF'), sunDir: [0.3, 0.5, 0.81], sunSize: 260, stars: 1, aurora: 0, moon: 1 },
    fog: { color: C('#34466C'), near: 44, far: 300 },
    light: { sky: C('#8A90F0'), ground: C('#34503E'), hemi: 1.45, sun: C('#C8D6FF'), sunI: 1.9, exposure: 1.25 },
    terrain: {
      shape: 'grave',
      sand: C('#56493E'), wet: C('#3A3230'), a: C('#4A8070'), b: C('#3E705E'), c: C('#5A9070'),
      rockA: C('#6E6C82'), rockB: C('#504E64'), cliff: C('#5E5674'), seabed: C('#2A3A32'), peak: C('#8A86A2'),
      dirt: C('#5A4A70'),
    },
    liquid: { kind: 3, shallow: C('#4A9A62'), deep: C('#18402C'), far: C('#1A2E40'), foam: C('#A8FFC0') },
    clouds: { bottom: C('#3A3064'), top: C('#7070A2') },
    stacks: { top: C('#33604F'), bottom: C('#504E64') },
    props: [
      ['deadtree', 150, { minH: 1, maxH: 40, minR: 14, avoid2: 5, minSlope: 0.7, shadow: true }, 0.8, 0.8, 1.4],
      ['tombstone', 240, { minH: 1, minR: 10, avoid2: 3, minSlope: 0.8, shadow: true }, 0.7, 0.8, 1.3],
      ['cross', 90, { minH: 1, minR: 10, avoid2: 3, minSlope: 0.8, shadow: true }, 0, 0.8, 1.3],
      ['pumpkin', 80, { minH: 1, minR: 8, avoid2: 3, minSlope: 0.8, shadow: true }, 0.6, 0.8, 1.6],
      ['glowshroom', 130, { minH: 0.6, minR: 6, avoid2: 2, minSlope: 0.75 }, 0, 0.8, 1.6],
      ['fence', 60, { minH: 1, minR: 14, avoid2: 5, minSlope: 0.85, shadow: true }, 0, 0.9, 1.1],
      ['rock', 60, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 1.8],
      ['grass', 1800, { minH: 0.8, minR: 2, minSlope: 0.78 }, 0, 0.7, 1.4],
    ],
    grassTint: [0.55, 0.75, 0.7],
    ambient: 'wisps',
    grade: { tint: '#CCD4FF', saturation: 0.92, contrast: 1.1, vignetteColor: '#1A0A30', haze: 0 },
    friction: 1,
    color: '#8A6CFF',
  },
  {
    n: 5, id: 'volcano', name: 'MAGMA CORE', subtitle: 'The floor is lava. Literally.',
    boss: 'dragon', bossName: 'MAGMAW', bossTitle: 'THE INFERNO AT THE END OF THE WORLD', miniName: 'MAGMA CHONK',
    sky: { top: C('#140608'), mid: C('#4A1410'), horizon: C('#E8662E'), sun: C('#FF9A5C'), sunDir: [-0.2, 0.62, 0.76], sunSize: 380, stars: 0.2, aurora: 0 },
    fog: { color: C('#3C1C16'), near: 60, far: 380 },
    light: { sky: C('#D8B4A8'), ground: C('#3A2420'), hemi: 1.5, sun: C('#FFD8BC'), sunI: 2.3, exposure: 1.12 },
    terrain: {
      shape: 'volcano',
      sand: C('#2C2224'), wet: C('#1A1416'), a: C('#4A3E44'), b: C('#3C3238'), c: C('#564A50'),
      rockA: C('#5A4E4E'), rockB: C('#342A2C'), cliff: C('#4E3A36'), seabed: C('#3A1410'), peak: C('#5E5252'),
      glow: [1.0, 0.33, 0.03],
    },
    liquid: { kind: 2, shallow: C('#FFC23A'), deep: C('#FF4A0A'), far: C('#B8200A'), foam: C('#FFF2A0') },
    clouds: { bottom: C('#2A1614'), top: C('#6A4A48') },
    stacks: { top: C('#2E262A'), bottom: C('#1A1416') },
    props: [
      ['charredtree', 110, { minH: 1, maxH: 40, minR: 14, avoid2: 5, minSlope: 0.7, shadow: true }, 0.8, 0.8, 1.4],
      ['obsidian', 90, { minH: 1, minR: 14, avoid2: 5, minSlope: 0.55, shadow: true }, 0.8, 0.8, 1.8],
      ['lavarock', 150, { minH: 0.5, minR: 10, avoid2: 5, minSlope: 0.55, shadow: true }, 0.9, 0.6, 2.0],
      ['embercrystal', 50, { minH: 3, minR: 20, avoid2: 6, minSlope: 0.6, shadow: true }, 0.8, 0.8, 1.7],
      ['bonepile', 40, { minH: 1, minR: 12, avoid2: 4, minSlope: 0.8 }, 0, 0.8, 1.5],
      ['vent', 45, { minH: 1, minR: 16, avoid2: 5, minSlope: 0.75, shadow: true }, 0.7, 0.8, 1.4],
      ['grass', 700, { minH: 1.6, minR: 2, minSlope: 0.8 }, 0, 0.6, 1.2],
    ],
    grassTint: [0.45, 0.42, 0.42],
    ambient: 'embers',
    grade: { tint: '#FFF2EA', saturation: 1.06, contrast: 1.1, vignetteColor: '#2A0800', haze: 0.35 },
    friction: 1,
    color: '#FF5A1F',
  },
];

// Level caps grow with each island you reach — your build keeps scaling as the run goes deeper.
export const weaponCap = (island) => 5 + 2 * island;   // 7, 9, 11, 13, 15
export const tomeCap = (island) => 4 + island;         // 5, 6, 7, 8, 9

// Island k's seed is derived from the run seed, so a Daily is the same 5-island chain for everyone.
export function islandSeed(runSeed, n) {
  let h = (runSeed ^ Math.imul(n, 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
