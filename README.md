# STARFALL

A space arcade game from a 1982 that never happened. One dense star system, real gravity wells,
landing on faceted worlds, docking with spinning stations, and a machine tide spreading from a
fallen star. TypeScript + WebGL2 + Vite, no textures, no external art, all sound synthesised.

## Play

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
| Esc | pause |

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

## Development

- `npm test` runs generation and stability invariants (Vitest).
- `npm run playtest -- <scenario>` drives the built game in headless Chromium (needs
  `npx playwright install chromium` and a running `npm run preview`). Scenarios: idle, fly, fall,
  land, smoke, dock, combat, raid, approach. Screenshots land in `playtest/out/`.
- `DESIGN.md` records the design decisions; `starfall.md` is the original brief.
