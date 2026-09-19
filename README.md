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
| V (in the map) | sector chart: pick a star to jump to |
| G (hold) | charge the jump drive: clear of every well, nose on the bearing |
| F2 (title) | continue the saved run; the run saves at every dock and every arrival |
| Esc | pause (in the dock: nothing; L launches) |

Gamepad: left stick turns, right trigger thrusts, A fires, B boosts, bumpers strafe, Start pauses,
Back opens the map.

## The sector

The home system is one star in a sector. This build holds two: home, and a neighbour four chart
units away that is a red dwarf that flares, with a scorched inner world and a mine on it, a rock
world with a colony, an ice world, a free port, and no Tide. The harbour's yard lists a short jump
drive first, at 900 credits: the opening debris field, the first raid and a mine run or two pay for
it, and rewards only pay for what you did. A jump
is built from the rules you already fly by: climb clear of every well, put the nose on the bearing
the chart gives, hold G for eight seconds while the drive charges (loud on every sensor, hot in
your own guns), and the cable drops as you go. It costs fuel from the same tank, by distance and by
the mass you carry. You arrive at the edge of the next system on the line from the star you left,
falling in. What you did in a system stays done when you come back, and its orbits have moved on.
Stations trade ore and salvage from a stock: prices follow the stock, and what a place paid the
last time you looked is on the chart. The run saves itself at every dock and every arrival.

## The system

The home system is authored: five worlds in fixed roles, in a fixed order, with fixed places on them.
A seed changes names, terrain and timing, never what is where at system scale. The ground of the
home and inner worlds is generated: their equators are cut as levels (valleys, ridges, craters,
canyons, shelves, old excavations) and under them lie complexes of chambers and halls joined by broad
passages with the odd squeeze, shafts down to worked benches, tunnels with a mouth at each end, and
shelters under the rim. Every chamber has a shelf to land on. What is in them is placed by the same
rules as everything else: workings and boulders, stranded hulls, fuel dumps, old plants with a core
still seated, gun positions on a shelf, dormant positions with an empty socket, dead arrays, rubble to
tow, recorders. Nothing in them is marked. Under the ground the world is drawn as rock and void.

- An inner world close enough to the star that guns run hot in daylight and cool at night; under its
  ground it is always cold.
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
  traffic, patrol, conditions, lighthouse, planets (the cut worlds: screenshots and a flight through
  every chamber of the biggest complex; `PLANET_SEED` picks the seed, `CAVE_SPEED` the speed), tow (haul
  a rock out of a complex), gunpost (sit in a gun chamber), padcheck (every pad on the cut worlds
  approached from above), voidprobe, launchcheck, landone, jump (buy the drive, climb out, charge,
  jump to the neighbour, dock and trade at its port, jump home, continue the saved run), earn (a
  fresh game flown by a scripted pilot until it buys the drive: debris, mine runs, wasps; prints the
  credit timeline and income by source; `EARN_MINUTES` caps it, `EARN_FIGHT=1` lets it take raids),
  script (`SF_SCRIPT=<file.mjs>` runs an ad-hoc module against the harness). Screenshots
  land in `playtest/out/`.
- `DESIGN.md` records the design decisions and the measured numbers behind them; `starfall.md` is
  the original brief.
