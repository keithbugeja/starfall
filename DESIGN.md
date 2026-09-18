# STARFALL — internal design document

Authoritative brief: `starfall.md` (read-only). This file records the decisions made to build it,
updated to reflect the game as shipped.

## One-line pitch
You are the last patrol pilot of a dense star system. Fly a small inertial craft through real
gravity wells, answer distress calls you cannot all answer, land on faceted worlds, dock with
spinning stations, and put out the machine tide spreading from a fallen star.

## Core (smallest strong loop)
Rotate + thrust flight with inertia, in a planar world rendered in 3D, inside gravity wells,
with a visible predicted trajectory. Everything hangs off that: landing is "arrive with the
right velocity and orientation", combat is "shots inherit your motion and bend in gravity",
navigation is "ride or fight the wells". The run ends when the three hulls are gone or the
enemy core is dark; both endings show a debrief, and a win lets you keep flying.

## Space
- Sim is 2D (x, y on the ecliptic) at a fixed 120 Hz. Render maps sim (x, y) -> world (x, 0, -y).
  Near top-down perspective camera, world-fixed orientation (north up). It leads the ship by
  velocity, zooms out with speed, and near a surface it frames ship and ground together and
  flattens its tilt so the planet rim cannot hide the ship. No roll.
- Planets and moons are oblate faceted spheroids (y scale 0.32). The equatorial terrain profile
  is the collision polygon and the mesh's equator ring matches it exactly: what you see is what
  you hit. Gas giants have no surface, a crushing atmosphere, a fuel-scoop layer, and a flat ring.
- Scale: ship ~1 unit, planets 55–190, star 200–250, outer orbit ~4000.

## Gravity
- Per body: a = GM / r^2 clamped near the centre, faded to zero across the outer quarter of the
  sphere of influence (planets 7 radii, moons 4.5, star 22). The star is a gentle pull everywhere
  (about 0.5 at the home world) and a killer inside two radii.
- Projectiles, pods, salvage, asteroids and AI all obey it. Belts orbit the star; clusters orbit
  planets. "The Fault" is a tiny body with a brutal well guarding rich ore and a unique module.
- HUD shows the net gravity arrow and a 9-second predicted trajectory that stops at impact and
  marks it with an X (green if survivable, red if not). This is what makes gravity readable.
- Coasting is Newtonian: the soft speed cap (60, 135 boosting) only applies while under power, so
  burn-and-coast and slingshot gains survive. Fuel is spent on manoeuvring and landing, not transit.

## Ship (Kestrel)
- Controls: rotate, main thrust, boost (hold Shift: big thrust, fuel burn, no weapons), retro and
  lateral jets as upgrades, fire, seeker (upgrade), map, cycle course, manual, pause. Mouse steers
  toward the cursor; left button fires, right boosts. Gamepad mapped.
- Resources: hull 100, fuel 100, cargo 8, weapon heat. Three hulls per run; a spare every score
  milestone (8000, 20000, then doubling). Death returns you to the last station with cargo lost.

## Landing / docking
- Land on any pad or flat-enough terrain: descent < 4.5, drift < 2.6, heading within 27° of the
  surface normal (struts widen all three by 40%). Harder impacts damage by energy; wrong-side
  touchdowns hurt. Colonies refuel and repair for free and take rescued pods; mines refuel and load
  ore; derelicts yield one unique module after a salvage crew works for seven seconds.
- Stations rotate (0.2–0.27 rad/s) with a 60° gap in the ring; enter through the gap and touch the
  hub under 7 relative. Bouncing off the ring or hub costs hull. Stations orbit their world at
  least 1.3 radii above the surface and clear of moons; the harbour sits at ~2.9 radii. Leaving
  through a gap that faces the world gets a slow, sideways exit and a warning.

## Combat
- Player weapons: pulse (default), scatter, rail (ignores gravity), mass driver (falls hard, recoil),
  seekers (secondary, homing, limited). All inherit velocity; heat limits sustained fire.
- Enemies behave differently: Wasp (fast strafing runs, breaks off and returns), Lancer (matches
  velocity, holds range, fires bursts, retreats to repair below a quarter hull), Reaver (comes in
  high over a colony, descends, hovers four seconds, lifts a pod and runs for the core; killing it
  drops the pod, which falls home or can be caught slowly), Sentinel (base turret with a horizon
  check), Dreadnought (besieges stations with gravity-bent shells and turrets, escorted).
- Stations shoot back a little (range 100). Terrain blocks every shot. A lead pip shows where a
  pulse round would meet the nearest enemy.

## World
- One generated system per seed: star, 5–6 worlds with roles (inner volcanic/desert, home rock,
  mid desert/crystal, gas giant with rings and moons, optional outer ice, enemy world with the
  Starfall core and two bases), moons, a main belt, a home cluster, the Fault's debris ring,
  three stations (harbour, refinery, research array) with different shops and prices, colonies,
  mines and derelicts. Named by a curated generator. Generation invariants are unit-tested over
  120 seeds; the sim is soak-tested for minutes.
- Civilian freighters and shuttles travel between pads and stations, queue for the gap and dock.

## Director (events)
- Scripted opening: a debris field beside the harbour at 16 s (teaches pickups and selling), a
  one-reaver raid on the nearest colony at ~66 s (teaches combat and pods). Then a weighted random
  schedule every 30–100 s: raids (prefer colonies far from you), convoys under attack, sieges
  (threat > 4), stranded shuttles falling into wells (refuel by gentle contact), enemy base
  construction (a new pad is carved and the planet mesh rebuilt), rogue asteroids on 60–90 s
  collision courses with their predicted path drawn, debris fields, solar flares (28 s warning,
  22 s of radiation unless in shadow, landed or docked), hunter packs.
- Events expire and have consequences: pods taken into the core, colonies going silent when their
  integrity fails, stations destroyed. Rewards only for outcomes the player caused.
- Threat rises with time and living bases; bases launch waves; far, idle enemies go home. Killing
  bases thins raids; killing the core secures the system.

## Progression
Credits from bounties, event rewards, ore and salvage sales. Upgrades change capability with a
stated trade-off (mass, burn, heat) and are spread across the three stations so shopping is a
navigation decision. Five unique modules only come from derelicts and the Fault.

## The vocabulary (vertical-slice pass)
- **Cable** (T). A spring-damper rope, stiffness 120, just under critical damping, no push, parts
  above 90 units of force or 4 units of stretch. Latches the nearest pickup, asteroid, ship, station
  ring point or tetherable hull within 7 units; rest length is the latch distance (2.5–11). Loads
  are real masses: crates 0.3, pods 0.5, the regulator 0.7, wrecks 2.5, rocks radius squared times
  two, ships mass times radius squared, stations and hulls take torque at the attachment point
  (station inertia 60 R squared; the Pilgrim 300 units of mass and a deliberately high inertia).
  Pods are now towed on the cable instead of snapping to the ship.
- **Ping** (R). A ring at 150 units per second to 460 units. Terrain edges flash as it sweeps them,
  fissure walls flash for 2.6 seconds, dense objects blink, hollow bodies echo, enemies notice.
- **Transfer** (F held). Fuel from the ship into a thruster tank you are landed on, or a stranded
  ship you are touching. Six per second.
- **Interiors**. Fissures are counter-clockwise outlines in a body's local frame with an open mouth
  edge; inside one the walls are the surface and the polar profile is ignored; the dome mesh is cut
  and the walls extruded down to a dark floor over bedrock. Gravity inside a body falls off
  linearly toward the centre.
- **Free and rotating bodies.** A body can ride gravity instead of rails, spin, carry pads and
  thrusters that turn with it, and be landed on with the surface velocity accounted for.

## The three slices
- **The Cut.** A 50-unit fissure into the enemy world: shaft, dogleg, throat, chamber, regulator in a
  magnetic socket. Carrying the regulator out (0.7 mass, two to three and a half units of weight
  depending on depth) darkens every sentinel on that world for as long as it is away. Shooting it
  shoves it a unit or two and the socket pulls it back.
- **Pilgrim.** A 120-unit hull spawned at 3400 units on a numerically fitted plunge to a 250-unit
  periapsis. Three thruster tanks: bow port and stern port make a couple (one alone spins the hull
  and drifts it to starboard), the stern main pushes along the axis. Forty fuel per tank; the ship
  carries a hundred. Towing works at about two and a half times the fuel cost and needs no landing.
- **The signal / the Fault.** A hollow rock in the belt whose black box blips faster as you close,
  echoes to a ping, and holds a cave with fragile walls, a dead Kestrel and a three-line log. The
  Fault, the core, sentinels and the regulator all keep a three-second beat. Three on-beat pings
  still every enemy for a minute; three off-beat pings call every enemy into the Fault's well.

## Rendering
WebGL2, no textures, no external art. Instanced flat-shaded meshes with four-band quantised
lighting from the star plus a faint camera fill. Lines are screen-space expanded quads with a
bright core (HUD, stroke-font text, trajectories, weapons, map). Particles as points. Post: a
separate vector layer with phosphor persistence and two-scale bloom, world-only fade under
overlays, vignette, faint scan modulation, 3% flicker. Framebuffer render targets are used for
post-processing; that is not texture mapping of artwork and is within the brief's intent.

## Audio
Everything synthesised with WebAudio after the first gesture: thrust noise, weapon tones, filtered
noise explosions, alarms, docking and success chimes, comm blips, a restrained drone, and a
gravity hum whose pitch and level follow the local field. No music.

## Testing
`window.__sf` harness: seed, step N ticks, inject controls or key presses, teleport, force
events, spawn enemies, dump state. Playwright scenarios under `playtest/` drive autopilots for
landing, docking, dogfights, raids, base assaults, real keyboard/mouse input, launch safety
surveys, and screenshot galleries. Vitest covers generation and stability.

## Deviations from first plan
- Coasting speed cap removed (kept only under power) after measuring that boost-and-coast died.
- Harbour moved from 3.4 to ~2.9 radii and clear of moons after launch surveys showed drifts into
  moons and the asteroid cluster.
- Sentinels cut from 13 to ~4 damage per second after a scripted assault died in seven seconds.
- Gravity-aligned camera roll never built; the fixed-north camera with ground framing was enough.
