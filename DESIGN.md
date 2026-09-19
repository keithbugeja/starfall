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

## The system as places (content pass)
The system is authored, not rolled: five worlds in fixed roles, in a fixed order, with fixed places on them.
Seeds change names, terrain noise, phases and small details, never what is where.
- **Inner world** (volcanic, ~1050 out). A colony and a mine inside the star's warm zone: guns in daylight
  there run hot and jam in seconds; the night side cools. Noon comes round every ten to twenty minutes.
- **The Lighthouse** (2.6 star radii, a slow rail inside the deep well, unnamed until found). A dead sun
  station whose vane faces the star and casts a real shadow: nothing behind it is scorched, not even in a
  flare. A deck on the dark side, a recorder, an empty socket. Fed a core and scanned three times on the
  peak, its array stills the whole tide for five minutes.
- **Home world** (~1900). Two colonies, a mine, the harbour at 3.4 radii, a rock cluster at half the well
  between the Slipway and the harbour, a moon with a mine riding high at 4.6 radii. **The Slipway**
  (unnamed until found): a dead cruiser in a 130-unit orbit below the harbour, an unnamed circle on the
  map and a shape against the world from the launch corridor, with a full fuel
  bunker you can land on, a stern tank that fires if you fill it, a recorder, and 120 units of mass on the
  cable. Pushed into the world it breaks up on whatever lies beneath.
- **Mid world** (~2800). Colony, mine, THE KILN in its crater, the research station at four radii, and
  THE RELAY on its moon: a mast, a plant, a core and no guns. Its mast hears you and its launches go
  where it last heard you.
- **Gas giant** (~4200). The refinery low over the drag layer, a mine and a derelict on its moons, fuel to
  scoop, and an atmosphere nothing hostile will follow you into.
- **The belt** (between the mid world and the giant, slow now). **HOLLOW**, unnamed until found, with
  Kestrel Seven's cave and a trail of its pieces pointing at the mouth from three hundred units out.
- **Enemy world** (~5700). The Starfall core, KILO and LIMA on the world's grid, THE CUT, BASE MIKE on the
  moon with its own plant.
- **The Fault** (past the enemy world, at the edge). Its ring hugs it now (42 to 100 units) so passing
  worlds cannot strip it; the lens and the beat are as before.
- **The Pilgrim** appears five minutes in, beyond the outermost world on the clearest line, already falling
  at 18 units per second, and hits the star six to seven minutes later unless someone changes that.

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
- Per body: a = GM / r^2 (linear inside the body), faded to zero across the outer quarter of the sphere
  of influence (planets 5 radii, the giant 5.5, moons 4.5). The star has a deep near well that ends at
  3 radii and a weak far field with no fade; every planet's rail is Keplerian in that far field, so rocks,
  pods and hulls keep station with the world they orbit. Orbits are spaced so no two wells overlap:
  planets on rails never fall toward each other, and anything free around them would be stripped if
  they did (measured: a whole cluster gone in ten minutes).
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

## The systemic layer (power, heat, sensors, structures)
The same rules for everything, so that solutions can be invented rather than found.
- **Power** (`power.ts`). A source is a socket on a body that seats a core (a prop that keeps the
  tide's beat). Sockets accept any core. A source feeds everything on its body within its reach: the
  Cut's socket feeds the whole enemy world; a base's plant feeds 48 units of surface. Consumers are
  guns, sensors, wave launches, gun regrowth, structure rebuilding and the base glyphs. Loose cores
  are drawn into any unbroken socket within six units. A cracked housing ejects its core for good.
- **Heat** (`sense.ts`, `physics.ts`). Every gun heats when it fires; at 1.0 it jams until it cools
  to 0.3. Ships cool at 0.35 per second in shadow and 0.245 in sunlight; landed guns cool through
  their base's radiator at 0.06 + 0.5 x (1 - sunlight), or 0.03 without one. The star adds heat inside
  its danger radius; a flare adds 0.16 per second to anything in sunlight. A base's guns in daylight
  jam after about fourteen shots and stay jammed twelve seconds; on the night side they never jam;
  with the fins shot off they jam after six and stay down twenty-four.
- **Sensors** (`sense.ts`). A sensor sees a ship when distance < range x sqrt(signature) and the line
  of sight is clear of terrain polygons, cave walls and rocks of size two or more. Signature: 0.12
  coasting, +0.9 under thrust (+2.2 boosting), +1 for a shot in the last 1.5 s, +3 for a ping in the
  last 2.5 s, +0.4 x heat, +1 for anything carrying the tide's beat (a powered gun, a core on the
  cable). A base's mast gives its guns 260 units; without it a gun sees 80. Wasps 320, lancers 300.
  A target unsensed for three seconds is lost: the ship goes to where it last saw you. The player's
  radar, lead pip and seekers obey the same rule. A gun holds its fire on a ship carrying a live
  core: it reads as friendly.
- **Structures** (`structures.ts`). Plant (integrity 160, armour 40), radiator (30, 0), mast (60, 5).
  Armour is a per-hit threshold: a pulse never marks a plant; a size-two rock at 20 u/s (energy 1600)
  cracks it. Ships and rocks collide with them; destroyed ones leave debris pickups. Powered bases
  rebuild lost fins and masts over a couple of minutes; nobody rebuilds a plant.
- **Rocks rest.** An asteroid that meets a surface under 7 u/s normal speed stays where it fell and
  rides the world's rotation. Faster, or rogue, it shatters. The Kestrel cannot lift any rock in a
  planet's gravity (a size-one rock outweighs its spare thrust), so rocks are placed by dropping them.
- **Worlds turn.** Planets and moons rotate at 0.005 to 0.011 rad/s (a day of ten to twenty minutes),
  derived from the body seed so layouts are unchanged. Pads, structures, landed ships and fissures
  turn with them; rogue rocks lead the surface velocity.
- **Journal** (`journal.ts`). Keyed, deduplicated observations written only when the pilot was there
  to see them, in the pilot's words, mixing the useful, the useless and the coincidental. Never a
  conclusion or an objective.
- **The Kiln** (`installations.ts`). A base placed in a shallow crater (floor -3, rims +5 at 11-24
  units) sixty units along the surface from the mid world's colony, on the terminator at generation.
  Two guns, a plant with its own core, fins and a mast: the same kit every base gets. Nothing about
  it is scripted; the approaches that work (bait the guns in daylight, take the core during the jam,
  coast in dark, hide behind the rim, drop a rock on the housing, wait for a flare) fall out of the
  rules above. The belt is now generated between adjacent orbits so that a world never sweeps
  through it; before that fix the enemy world took three rocks a minute.

## Operational geography (deepening pass)
The map is fixed; the practical map moves with light, heat, emissions and what the tide has seen.
- **The tide's picture** (`World.contact`). Enemy sensors that acquire the player write one fix: position,
  velocity, time, who. Waves and hunter packs go to that fix, dead-reckoned up to twelve seconds, and only
  while it is fresh (45 s for waves, 90 s for hunts); with no fix they prowl a colony. Hunters that lose
  contact search where the target would be if it kept going. Nothing in the director reads the player's
  true position any more.
- **Emissions are what is emitted.** Engine emission scales with actual output (a tuned engine and a boost
  show further than a stock burn); the muzzle flash scales with the weapon's heat per shot (pulse 1.0,
  mass driver 2.2, rail 3.0 for 1.5 s). Heat stays in the signature, so a ship that has just fought is
  visible before it cools. There is no stealth statistic and no cloak: a quiet ship is one that emits less.
- **Perception without numbers.** Ships, rocks and pickups inside a shadow cone are drawn dimmed; the heat
  bar turns blue in shadow and pulses above 0.75; a halo around the player's marker grows with the square
  root of its signature; brackets and a soft tick mark that an enemy sensor holds the player, and a falling
  tone marks the moment none does; enemy ships tint hot and flicker when jammed; a jamming gun vents a puff.
- **Traffic as evidence.** Civilians approaching a pad within 160 units of a live powered base come in low
  so the ground hides them; shuttles shot down leave salvage for fifteen minutes, so a bad approach shows
  its history in wreckage.
- **Navigation.** Civilians, reavers and hunting wasps route around a world that lies across their line to
  a destination (a rolling waypoint a quarter turn ahead around the limb, side kept steady) instead of
  flying into it, and civilians never dive at a pad faster than they can stop. Before this, half the
  shuttles sent to the colony beside the Kiln died on the terrain whether the Kiln was lit or not.
- **Pathologies fixed.** Things inside caves and fissures settle on the floor instead of swinging through
  the hollow's centre (interior gravity is linear, so without floor friction a body oscillates). Belt rocks
  born inside a world's well are culled. The Fault now rides a Keplerian orbit so its ring is not torn
  away by the frame mismatch.
- Fixed in the content pass: the star's far field and Keplerian rails (see Gravity); the home cluster,
  the Fault's ring and a free hull in home orbit now hold station over thirty minutes. Ships only damage
  machinery above 500 units of impact energy (a ram, not a bump). Civilians, reavers and hunters detour
  around worlds and the star.

## Worlds as levels (procedural planets pass)
Human play found ordinary planets empty: a refuelling stop, not a place. The fixed-geography rule was
revoked for the ground itself; what is where at system scale is still authored.
- **The profile is a level.** The home and inner worlds are cut at about five units per facet (two ship
  lengths; 88 to 120 segments) instead of ten, so ridges, craters and canyons read at flying scale. A pad
  now flattens as many segments as its width needs (`Pad.segCount`) and its collision, colour and label
  cover the whole run.
- **Motifs with sockets.** `src/gen/planet.ts` lays motifs along the circumference from a per-role catalogue
  with caps: valleys, ridges, craters (floor and rims, like the Kiln's), canyons, shelves, excavations
  (stepped industrial cuts), fissures, shaft heads, tunnels under a ridge, overhangs. Each motif offers
  sockets with a preference list (a crater floor wants a colony, a wreck field or an old plant; a canyon
  floor a mine, a hidden pad or a cave mouth; a crest a dead mast or a beacon; a shelf a settlement or a
  depot). The authored colonies and mines take sockets first; the dressing spends a per-role budget on the
  rest. Home: inhabited and industrial (settlements, works, depots, machinery, wreck fields, an old plant
  still keeping a core). Inner: thermal (depots and caches in the shade, a plant behind a rim, cooked
  hulls, more ridges and overhangs, no settlements).
- **Caves are the Cut's geometry generalised.** A passage is a polygon in the body's local frame; passages
  overlap, and where they do, the shared stretches of outline are openings, not walls: every outline is
  split where another outline crosses it, then an edge whose midpoint (nudged either way) lies inside
  another passage is open. Every wall query (ships, shots, rocks, pickups, landing guidance) now looks at
  every passage the point is in. The grammar: an entry from a mouth, a walk with bends that stays under
  the ground and away from pads, chambers, junctions, branches, and a branch that climbs out again
  through a second mouth when a clean one exists; shafts straight down to a gallery, some with walls
  that shed rubble when shot; tunnels open at both ends; overhangs as shallow side shelters. Rooms take a
  buried plant with a core in its socket, caches of cells and salvage, stranded hulls, rubble, ore
  pockets or recorders; every hole holds at least a fuel cell. Under the ground is shade at any hour.
- **Validation, not hope.** `validatePlanet` runs in the 120-seed test and the harness (`__sf.geo()`):
  outlines simple; every open edge leads into another passage or out of the ground; every passage
  reachable from a mouth; no wall breaks the surface away from a mouth; no pad in a passage, no wall
  taller than 9% of R within nine units of a pad, no mouth under a pad; nothing embedded in ground or
  wall; no rock in a mouth. Mouths keep clear of pads, other mouths, shallow passages and surface content.
  Sixty seeds: zero problems. A safety net remains: a ship, rock or pickup found deep under the ground of
  a body with passages but in no passage, within twelve units of one, is moved into it and logged
  (`wall-rescue`, with the passage's name). Five seeds soaked for twenty minutes each with the director
  on: no rescues on the cut worlds (one seed showed four at the Cut before the twelve-unit limit, none
  after). The autopilot cave tours trip it about once per tour at a junction or an overhang bend: a
  hitch, not a fall through the floor, and the log says where.
- **Measured.** Per cut world: about thirteen motifs, five pads (two colonies or one, a mine, and one to
  five of settlement, depot, works, hidden derelict), three to four mouths, five passages, five rooms,
  and eight to twenty placed things. The follower autopilot flies the main passage of the biggest cave on
  every seed tried (nine of nine networks over five seeds). Every pad on the cut worlds is landable from
  forty units up (28 of 28 over three seeds). Frame time 2 to 6 ms with the cut worlds on screen. Twenty
  simulated minutes per seed with the director on, five seeds: no blow-ups, placed rocks and cave pickups
  all still in place; civilian losses 22 to 26 per twenty minutes, about a third of them ground impacts
  and collisions, which is the known cost of rougher ground near pads.
- **Not done.** Only the home and inner worlds are cut; the catalogue has weights for the mid and enemy
  worlds (gun sockets on crests, excavations) but they are not applied. No procedural quests: recorders
  say what the place was, never what to do. Rock aiming is still unsolved. The old landing autopilot in
  the playtest driver dies to the harbour ring and freighters on the way out, so `padcheck` (approach
  from forty units up) is the pad test, not `land`.

## Underground as arcade levels (interior pass)
Human play liked the ground and not the caves: holes cut in the dome, corridors too narrow to turn in,
a cache at the end. The interior grammar and its rendering were rebuilt; the terrain motifs stayed.
- **Two views of a body with passages.** From outside the dome is whole except its mouths: a passage is
  cut from the dome only within twelve units of the rim, walled there, and drawn as a bright notch; the
  network behind it is invisible until a ping's sweep lights it through the rock. Under the ground the
  dome is not drawn at all. The rock is one flat slab at 2.6 units above the flight plane bounded by
  the equator profile; every passage polygon is drawn into the depth buffer just above it first, so the
  slab has holes exactly where the void is; the void shows a dark floor and walls extruded from the floor
  to the slab, and every solid edge is drawn as a bright line at the slab. The slab is drawn last, so
  ships, pads and machinery on the surface are hidden by it for free. The slab carries an emissive tint
  so the night side stays readable. Entering (in a passage, below the rim) and leaving (above the rim
  by six) switch the view with a short dip to black; the camera goes straight down and frames a chamber.
- **Chambers, not corridors.** A complex is a graph: an entry throat, a first chamber under it, then
  rooms (radius 11 to 16) and halls (17 to 26, capped by the world's size) grown sideways and down, a
  spanning tree of passages, one or two loops, and a second way out from the shallowest far chamber when
  the ground above it is clear. Chambers are rough blobs cut flat on the deep side, so every one has a
  shelf whose normal is radial: a landing floor under the interior gravity. Shafts go straight down to a
  long low bench with galleries off it; shelters are one room under the rim; tunnels are two chambers
  with a mouth at each end. Dimensions come from the ship: a reversal from eight units a second costs
  ten units, a towed rock spans eleven with the cable; broad passages are 13 to 18 wide, squeezes 6.6 to
  8.4 wide and never first, never twice off one chamber, never more than the broad ways. Passages are
  polygons that overlap the chambers they join, and the openings rule does the doorways.
- **Situations, one per chamber, no two alike in a complex.** Workings (ore on the floor, rubble, walls
  that shed rubble when shot, and a boulder wedged in the squeeze beyond, too big for a Kestrel to pass
  until it is shot or towed); a stranded hull with salvage and a black box; a fuel dump with a bulk tank;
  a live plant with a core seated; a gun position on the shelf with its fins and plant beside it, fed by
  its own core, which is the Kiln's grammar under the ground; a dormant position with an empty socket
  that wakes if someone seats a core; three dead masts and a beacon; rubble to tow. Interior posts are
  pads on a floor: polar angle and height point at the shelf, they flatten nothing, launch nothing, do
  not drive the threat, and stay off the map until the pilot has been in the same passages near them.
  Rationed: one gun position, one dormant one, one live plant and one array per world.
- **Physics.** The floor drag inside passages applies only to what rests on a wall, so a rock on a cable
  flies free through the void; the leak safety net and the openings rule are unchanged.
- **Measured (120 seeds).** Per cut world: 1.1 complexes, 5.7 chambers (0.8 halls), 3.9 passages of which
  0.6 squeezes, 2.7 mouths; chamber radius median 13.5, quartiles 11.8 and 15.7; passage half width
  median 7.5, minimum 3.3; 197 of 451 networks have a second way out; no validation problem in 240
  worlds and every world has a multi-chamber complex. The follower flies every chamber of the biggest
  complex at 5, 7 and 9 units a second with no hull loss on seed 2024 and 12 hull on one seed; no wall
  rescues in any tour. A gun position hits a ship hovering in its chamber for 90 in ten seconds; a
  dormant one is silent. Twenty simulated minutes on three seeds with the director on: no rescues, no
  blow-ups, every placed rock, cave pickup and interior sentinel still where it was. Frame time under
  3 ms underground.
- **Not done.** Live stranded shuttles under the ground (their AI cannot fly walls) are wreck pickups.
  The follower autopilot tows a small rock out of a complex on about half its tries and stalls on a
  size-two rock; a human test of towing is still needed. Only the home and inner worlds are cut.

## The sector, slice one (two systems and a jump)
EXPANSION.md's smallest slice, built to see whether the larger structure improves the game.
- **Architecture.** A `Sector` (recipes, ledgers keyed by name, the sector clock, the player's state)
  sits above the `World`; a world is built from a recipe and its ledger on entry and thrown away on
  exit. The compromise against the design: `credits`, `score`, `lives`, `journal`, `discovered` and the
  player ship stay on the `World` as the live copy and are transferred through `PlayerState` at each
  jump, rather than moving up; nothing that reads them had to change. `generateSystem` is the home
  recipe unchanged; the neighbour has its own generator and its own seed, so neither reshuffles the
  other. Orbits and spins are advanced by the sector clock on entry. Director state is per world and
  its opening beats and timers are ledgered. Every world starts at time zero.
- **The jump** is four gates and a charge: gravity under 0.02 (outside every planet's sphere of
  influence, clear of the star's near well), nose within seven degrees of the chart bearing, fuel for
  five per chart unit times the mass multiplier, the cable in; eight seconds of charge that add a
  signature of about 3 (a ping is 3) and heat faster than the ship sheds it. Arrival is at 97% of the
  destination's system radius on the line from the origin star, 30 units a second inward.
- **Measured (seed 2024).** From the harbour the well gate opens after 2 s of boost: the harbour sits
  at 3.4 radii and the sphere of influence ends at 5, so the climb is short; from a pad it is the
  whole climb. Signature 0.12 coasting, 3.4 charging. Fuel for the trip at stock mass with the drive:
  22 of 100. Arrival at the neighbour 2200 units out: 1.2 minutes of coasting to the port, 20 s
  boosting; arrival home is 6400 units out, 3.5 minutes coasting, 50 s boosting. The port sells ore
  at 18 and pays 63 for salvage; the home refinery pays 38 for ore and sells salvage at 28; a hold of
  eight ore clears about 150 credits a trip before fuel, sixteen with the rack about 300.
- **What is ledgered and what is not.** Destroyed bases and cores (and their machinery), lost pads,
  discovered names, threat, the director's opening and timers, station stocks (relaxing over ten
  minutes away), the Pilgrim's state (a Pilgrim in flight when you leave is lost), whether the Cut's
  regulator is gone, thruster tank fuel. Not ledgered: loose pickups and cores, wrecks, rocks moved,
  live ships, projectiles, the Lighthouse's cooldown, the stillness. A pod on the cable does not jump.
- **Goods.** The design's ore and parts are the game's ore and salvage; the names stayed.
- **Tests.** Forty seeds of the neighbour sane and valid; the jump out and back with a base destroyed,
  a note taken, a name learned, all true on return; the gates; markets; a saved run restored. The
  browser scenario runs the whole loop and continues the saved run.

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
