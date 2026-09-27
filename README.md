# VELOCIBONK

![VELOCIBONK — speed is damage](docs/og.jpg)

**[Play it in your browser →](https://alexmorrison12.github.io/velocibonk/)**

A 3D survivors roguelite where speed is damage. Bhop, slide and slam across a procedurally generated island while your auto-weapons shred the horde. The faster you move, the harder everything hits: your momentum multiplies every hit and every point, and at ×2 you enter RAM mode and plow straight through them.

## Features

- **Momentum combat.** Bunny-hopping, downhill slides, launches off hill crests, jump and boost pads, and ground-slams all raise a ×1–×8 damage and score multiplier.
- **Build crafting.** 10 auto-weapons, 14 stat tomes, rarity-rolled upgrade cards, chests, shrines and elite enemies.
- **Bosses.** Three bosses at 3:00, 6:00 and 9:00 with shockwaves you have to jump over, then a Final Swarm at 10:00 that never stops.
- **Daily island.** Everyone gets the same seeded island each day.
- **Global leaderboard.** Today's top 10 and an all-time board on the title screen. Hit **BEAT IT** on any row to play that run's island with its score as your target, and post your own score from the game-over screen.
- **Challenge links.** The game-over screen also copies a link with your score. Friends who open it play the same island and try to beat it.
- **Ghost racing.** Your best run on each island replays as a ghost the next time you play it.
- **Hordes.** 1,500+ enemies on screen, animated on the GPU with instanced meshes.
- **Fully procedural.** Every model, texture, sound effect and song is generated in code at load time. The whole game ships as a single ~900 KB HTML file.

## Controls

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Look (click to lock the cursor). Q/E or the arrow keys also turn |
| Space | Jump / double jump. Hold to auto-hop |
| Shift, C or right mouse | Slide on the ground. Slam when airborne |
| Esc or P | Pause |
| 1 / 2 / 3, R | Pick an upgrade card, reroll |

## Build

```bash
npm install
npm run build
```

`npm run build` writes `docs/index.html`, which GitHub Pages serves, plus a standalone `dist/index.html` you can open directly. `npm run dev` builds an unminified copy and serves it at http://localhost:5173.

## Code

three.js r186, bundled with esbuild. No other runtime dependencies.

| File | What it does |
|---|---|
| `src/main.js` | Game loop, spawn director, scoring, daily seeds, challenge links, ghosts |
| `src/world.js` | Island terrain, water, sky, props, pads, chests, shrines |
| `src/player.js` | Momentum character controller and procedural animation |
| `src/enemies.js` | Horde simulation (typed arrays + spatial hash), instanced rendering, bosses |
| `src/weapons.js`, `src/upgrades.js`, `src/pickups.js` | Weapons, level-up cards, XP and gold |
| `src/models.js` | Procedural low-poly models |
| `src/audio.js` | Web Audio synthesized sound effects and adaptive music |
| `src/fx.js` | Particles, damage numbers, speed lines and post-processing |
| `src/ui.js`, `src/ui.css` | HUD and menus |
| `src/leaderboard.js` | Global leaderboard client (Supabase: scores are read and written only through two Postgres functions that validate and rate-limit submissions) |

Built with [Claude Code](https://claude.com/claude-code).
