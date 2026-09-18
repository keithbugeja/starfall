# STARFALL

A space arcade game from a 1982 that never happened. One small star system built as a handful of
places rather than a map: real gravity wells, worlds that turn, landing on faceted terrain, docking
with spinning stations, a cable, a sensor pulse, and a machine tide spreading from a fallen star.
TypeScript + WebGL2 + Vite, no textures, no external art, all sound synthesised. This is a vibe
coding experiment using Fable 5.1.

## Play

Play online: https://keithbugeja.github.io/starfall/ (deployed from `main` by GitHub Actions).

Or locally:

```
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173), press ENTER.

`npm run build` then `npm run preview` serves the production build on http://localhost:4173.

The current build is meant for a blind play session of roughly 45 to 90 minutes. Nothing in it is
a tutorial beyond the flight manual (H); the rest is there to be noticed.

## Controls

| Key | Action |
| --- | --- |
| A / D or arrows | rotate |
| W / up | main thrust |
| Shift + thrust, or right mouse | boost (burns fuel, no weapons) |
| S / down | retro thrust (upgrade) |
| Q / E | lateral jets (upgrade) |
| Space / Ctrl / left mouse | fire |
| X | seeker missile (upgrade) |
| mouse move | steer toward the cursor |
| M | system map, set a course |
| Tab | cycle course between situations and stations |
| H | flight manual |
| 0 | mute |
| T | cable: latch the nearest thing within reach, or let go |
| R | ping: a sensor pulse; watch what comes back |
| F (hold) | transfer fuel into what you are landed on or touching |
| J | journal: what you have seen, in your own words |
| Esc | pause (in the dock: nothing; L launches) |

Gamepad: left stick turns, right trigger thrusts, A fires, B boosts, bumpers strafe, Start pauses,
Back opens the map.

## The system

The system is authored: five worlds in fixed roles, in a fixed order, with fixed places on them.
A seed changes names, terrain and timing, never what is where.

- An inner world close enough to the star that guns run hot in daylight and cool at night.
- A home world with two colonies, a mine, the harbour, a rock cluster and a moon.
- A middle world with a colony, a mine, a research station, a gun position in a crater, and a
  quiet listening post on its moon.
- A gas giant with a refinery low over its drag layer, fuel to scoop, and moons.
- The enemy world, where the Starfall core and its bases sit on one power grid.
- A belt, a strange heavy anomaly at the edge of the system, and a few things that are not on the
  map until you have been there: a shape in orbit near the harbour, a dead station near the star,
  a rock that answers a scan, a trail of wreckage, and a large silent hull that arrives some minutes
  in on a bad course.

## How it works

- Sim runs at a fixed 120 Hz on a 2D ecliptic; everything is rendered in 3D from a near top-down
  camera. Planets are oblate faceted spheroids whose equatorial terrain profile is the collision
  surface. What you see is what you hit.
- The dotted line ahead of the ship is where you will go if you do nothing. The violet arrow is
  gravity. Shots inherit your velocity and bend in gravity.
- Gravity is real around every world and deep near the star; between worlds it is nearly nothing,
  so what you leave in orbit stays in orbit.
- Landing: nose away from the ground, descend under 4.5, drift under 2.6, tilt under 27 degrees.
- Docking: enter the rotating ring through the gap, touch the hub under 7.
- The system lives whether or not you look: raids, convoys, sieges, stranded ships, rogue
  asteroids, solar flares, enemy construction. You cannot save everyone.
- The cable is a real physical rope: a taut cable is a pendulum, a load changes your handling, a yank
  over about seven units per second parts it, a steady pull never does, and pulling on a rotating
  ring or hull applies torque. Ping returns geometry and echoes, never labels.
- Worlds turn, so every place has a day and a night. Enemy bases are made of parts: a mast, radiator
  fins, and a socket with a core in it, or a feed from the world's grid. Guns need power and heat up
  when they fire. Sensors need power, something to hear, and a clear line of sight. Parts can be
  damaged; slow rocks stay where they fall. Nothing tells you what any of this is for.
- The enemy only knows what its sensors have seen. A ship with its engines off, its guns silent and
  nothing pinging is a small target; boosting, firing and scanning carry.
- The halo around your ship is how loud you are. Brackets around it mean something has you; the tone
  that falls is the moment nothing does. Things in shadow look dark and cool faster.
- Recorders found in the world play back when picked up. The journal (J) records what you saw,
  never what it means.
- The run ends when your three hulls are gone, or when you destroy the Starfall core on the
  enemy world (red on the map). Spare hulls come with score. After a win you can keep flying.

## Development

- `npm test` runs generation and stability invariants over 120 seeds (Vitest).
- `npm run playtest -- <scenario>` drives the built game in headless Chromium (needs
  `npx playwright install chromium` and a running `npm run preview`). Scenarios: idle, fly, fall,
  land, smoke, dock, combat, raid, approach, tour, keys, launches, assault, gallery, endings,
  upgrades, audio, perf, tetherphys, cut, pilgrim, signal, fault, kiln, living, stealth, brute, flareops,
  traffic, patrol, conditions, lighthouse. Screenshots land in `playtest/out/`.
- `DESIGN.md` records the design decisions and the measured numbers behind them; `starfall.md` is
  the original brief.
