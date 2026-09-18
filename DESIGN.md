# STARFALL — internal design document

Authoritative brief: `starfall.md` (read-only). This file records the decisions made to build it.

## One-line pitch
You are the last patrol pilot of a dense, dying star system. Fly a small inertial craft through
real gravity wells, answer distress calls you cannot all answer, land on faceted worlds, dock with
spinning stations, and push back a machine tide spreading from a fallen star fragment.

## Core (smallest strong loop)
Rotate + thrust flight with inertia, in a planar world rendered in 3D, inside gravity wells,
with a visible predicted trajectory. Everything else hangs off that: landing is "arrive with
the right velocity and orientation", combat is "shots inherit your motion and bend in gravity",
navigation is "ride or fight the wells".

## Space
- Sim is 2D (x, y on the ecliptic). Render maps sim (x, y) -> world (x, 0, -y). Camera is near
  top-down, world-fixed orientation (north up), perspective, zooms out with speed and in near
  surfaces. No roll. A gravity-aligned camera is an experiment for later, not a default.
- Planets/moons are oblate faceted spheroids. Their equatorial height profile h(theta) IS the
  collision surface, and the mesh's equator ring matches it exactly, so what you see is what you hit.
- Compressed scale: ship ~1 unit. Planet radius 40–140. Star radius ~220. System radius ~4500.

## Gravity
- Per body: a = GM / r^2 clamped, faded to zero at the body's sphere of influence. Star has a
  broad gentle well; planets have strong local wells; moons small ones.
- Projectiles obey gravity. Pods and salvage obey gravity. AI obeys gravity.
- HUD shows the net gravity vector and a predicted trajectory (integrated ahead, stops at impact).
  This is what makes gravity exploitable rather than annoying.

## Ship
- Controls: turn, main thrust, weak retro (upgrade), boost (cruise mode: high thrust, no fire,
  fuel burn), fire, map, dock/land assist readouts. Keyboard + mouse steer; gamepad.
- Resources: hull, fuel, cargo. Fuel burns on thrust; running dry means gravity wins.

## Landing / docking
- Land on pads: normal speed < ~4, tangential < ~2.5, upright within ~25 deg. Terrain contact
  outside tolerance damages by impact energy. Flat terrain landing allowed at tighter tolerance.
- Stations rotate; the docking slot is a bay you must enter along its axis, slowly, while it
  comes around. HUD gives corridor guidance.

## Combat
- Pulse cannon shots inherit ship velocity. Enemies: Wasp (fast strafer, swarms), Lancer
  (pursuer that matches velocity and fires bursts), Reaver (abducts colony pods, Defender lander
  analog: kill it and catch the falling pod), Bastion turrets at enemy bases, Dreadnought
  (slow heavy shells bent by gravity, escorted).
- Environment: asteroids split and drift; gravity bends every shot; terrain blocks fire.

## World
- One generated system per seed: star, 4–6 planets (rock/ice/volcanic/desert/gas giant), moons,
  1–2 belts, 2–3 stations, colonies + mines on surfaces, derelicts, one anomaly, an enemy
  foothold on the far side that expands over time.
- Civilian traffic (freighters between colonies and stations) exists whether or not you look.

## Events (director)
Raids on colonies, convoys attacked, station sieges, stranded ships, base construction, rogue
asteroid on a collision course, salvage discoveries, solar flares. Events are timed, expire, and
have consequences. Comms tell you; the map shows you; you choose.

## Progression
Credits from bounties, salvage, rescues, trade. Upgrades change capability with trade-offs
(retro thrusters, lateral thrusters, heavy hull, grav dampers, fuel tank, weapons, sensors,
tractor, heat shield). Lives: 3 hulls; extra at score milestones. Run ends when hulls are gone or
the enemy core is destroyed.

## Rendering
WebGL2, no textures, no external art. Instanced flat-shaded meshes with 4-band quantised lighting
from the star. Lines are screen-space expanded quads (HUD, trajectory, text, weapons, map).
Stroke font for all text. Particles as points. Post: bloom + phosphor persistence on the vector
layer, vignette. Framebuffer render targets are used for post-processing; that is not texture
mapping of artwork and is within the brief's intent.

## Testing
Fixed 120 Hz sim, seeded RNG everywhere in sim/gen. `window.__sf` harness: seed, step N ticks,
inject controls, dump state. Playwright scripts under `playtest/` run scenarios and screenshots.
Vitest for gen invariants and physics.
