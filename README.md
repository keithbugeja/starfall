# STARFALL

A space arcade game from a 1982 that never happened. One dense star system, real gravity wells,
landing on faceted worlds, docking with spinning stations, and a machine tide spreading from a
fallen star. TypeScript + WebGL2 + Vite, no textures, no external art, all sound synthesised.

## Play

Play online: https://keithbugeja.github.io/starfall/ (deployed from `main` by GitHub Actions).

Or locally:

```
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173), press ENTER.

`npm run build` then `npm run preview` serves the production build on http://localhost:4173.

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

## How it works

- Sim runs at a fixed 120 Hz on a 2D ecliptic; everything is rendered in 3D from a near top-down
  camera. Planets are oblate faceted spheroids whose equatorial terrain profile is the collision
  surface. What you see is what you hit.
- The dotted line ahead of the ship is where you will go if you do nothing. The violet arrow is
  gravity. Shots inherit your velocity and bend in gravity.
- Landing: nose away from the ground, descend under 4.5, drift under 2.6, tilt under 27 degrees.
- Docking: enter the rotating ring through the gap, touch the hub under 7.
- The system lives whether or not you look: raids, convoys, sieges, stranded ships, rogue
  asteroids, solar flares, enemy construction. You cannot save everyone.
- The cable is a real physical rope: a taut cable is a pendulum, a load changes your handling, a yank
  over about seven units per second parts it, a steady pull never does, and pulling on a rotating
  ring or hull applies torque. Ping returns geometry and echoes, never labels.
- Worlds turn. Every installation has a day and a night, and a crater rim or a moon can hide a
  ship from a gun. Enemy bases are made of parts: a mast that sees far, radiator fins that shed the
  heat of the guns (well in shadow, badly in sunlight), and either a local plant with a core in its
  socket or a feed from the world's grid. Guns need power and jam when hot; sensors need power,
  emissions and a clear line of sight; a ship coasting with its engines off is a small target for
  any sensor, and a ping is a very loud one. Cores fit any socket. Parts have integrity and armour:
  fins die to small arms, an armoured housing does not, but a rock falling from height cracks it.
  Slow rocks stay where they fall. Nothing tells you which of these to use.
- The journal (J) records what you saw, never what it means.
- Three hand-built situations exist in every system. They are not marked. Look for a crack in the
  enemy world, a large silent hull that arrives on a bad course, and a signal you can hear before
  you can see it. A fourth, a gun position in a crater within reach of a colony, is built from the
  same parts as every other base and is only different in where it stands.
- The run ends when your three hulls are gone, or when you destroy the Starfall core on the
  enemy world (red on the map). Spare hulls come with score. After a win you can keep flying.

## Development

- `npm test` runs generation and stability invariants (Vitest).
- `npm run playtest -- <scenario>` drives the built game in headless Chromium (needs
  `npx playwright install chromium` and a running `npm run preview`). Scenarios: idle, fly, fall,
  land, smoke, dock, combat, raid, approach, tour, keys, launches, assault, gallery, endings,
  upgrades, audio, perf, tetherphys, cut, pilgrim, signal, fault. Screenshots land in `playtest/out/`.
- `DESIGN.md` records the design decisions; `starfall.md` is the original brief.
