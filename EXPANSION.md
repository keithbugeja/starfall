# STARFALL: from one system to a sector

A design for expanding STARFALL from "one authored system with procedural variation" into "a
procedural sector of genuinely different star systems, with the existing system as one particularly
important place". Nothing here is implemented. The sixteen questions of the brief are answered in
order; the bug backlog is recorded at the end.

The thesis in one paragraph: every mechanic STARFALL has is local (gravity, terrain, heat, shadow,
emissions, power, cable, ping, traffic). What it lacks is not more mechanics but more *places that
make those mechanics ask different questions*. A sector is a set of places. The way to get there is
to split "what a system is" (a recipe, a few hundred bytes) from "building it" (the sim we have),
give every system one dominant trait that is chosen first and that everything else serves, and make
travel between systems a physical act built from the rules that already exist.

---

## 1. What is the sector structure?

**A sector is a flat star chart of about thirty systems, two to three hundred light-seconds across
in chart units, with the home system near the middle of one cluster.** It is a graph, not a
continuous space: nothing is simulated between stars. Systems are placed by Poisson disc sampling
and then pulled into three to five clusters of three to seven systems, joined by sparser corridors.
The drive's range (see 3) turns positions into a graph: from a typical system two to four others are
in reach, so the sector has a topology (chokepoints, dead ends, a far edge) rather than being a bag.

Layers of the sector, from the outside in:

| Level | What it is | Authored or procedural |
| --- | --- | --- |
| Sector | seed, chart positions, cluster layout, gradients (machine presence rises toward one edge, settlement density toward another), the set-piece placement | procedural from a seed; gradients and set-piece pool authored |
| System | a recipe: star(s), worlds by distance band, belts, anomalies, factions, economy tags, danger, hooks | procedural from a trait template chosen first |
| World | a body recipe: size, gravity, thermal class, atmosphere, rotation, composition, inhabitation, machine presence, interior class | procedural, constrained by the system |
| Local terrain | the equator profile as a level: motifs with sockets (exists) | procedural with authored motifs |
| Interior | levels under the ground: a geological formation generated first, void derived from it by erosion, collapse and excavation, built work cut into it (see 6) | procedural formation and processes; grammars, processes and built templates authored |

Gradients give the sector a shape you can feel without a story: the Tide is thick at one edge and
thin at the other; charter colonies cluster where the stars are kind; the corridor between is where
the pirates are. A player who has learned two clusters knows which way is home.

## 2. How many systems should a typical game expose?

**Thirty in the sector, of which a run visits ten to fifteen.** Not hundreds: a system is worth
generating only if a player can remember it, and a player remembers a system by one thing. Thirty
systems each with a dominant trait is about the number of distinct traits the templates can carry
without repeating a trait in the same cluster. A run of several hours at twenty to sixty minutes a
system reaches a third to a half of them, so the sector is never fully known in one run and two runs
with different sector seeds share nothing but the home system.

The drive and the chart meter exposure. From the home system three or four are in range of the
starter drive. Charts bought at stations reveal the trait tag and star class of systems a few jumps
out, so the player chooses between "the binary mining system" and "the dead star with the debris
disc" before committing fuel, and the sector fills in as a map of reasons rather than names.

## 3. How does interstellar travel work?

Built entirely from rules that exist. A **drive** is a module (see 8). To jump:

1. **Climb out of every well.** The drive will not engage while the local gravity from any body is
   above a threshold (about 0.02 units per second squared, which is outside every planet's sphere of
   influence and well clear of the star's near well). This is the existing `gravityAt`. Leaving a
   world is therefore a routine of minutes, and a pursuer can catch you in it.
2. **Point at the destination star.** The drive throws you along your nose. Heading error above a
   few degrees refuses to charge. The chart shows the bearing; the HUD shows the alignment as a
   landing-style readout (BEARING / DRIFT / CHARGE).
3. **Charge.** Six to twenty seconds by drive class. A charging drive is the loudest thing a ship
   does: emission signature at boost level and heat rising, so every sensor in range knows exactly
   where and when you are leaving, and a hunt can be called on the fix. Firing or boosting resets
   the charge. Anything on the cable is dropped at the moment of jump: the cable is a physical rope
   and the field is the hull's.
4. **Fuel.** The jump costs fuel from the same tank as flight, proportional to chart distance and
   to total mass (hull, modules, cargo). An extended tank and a light ship reach further. There is
   no separate drive fuel; the constraint every pilot already understands is the one that applies.
5. **Arrive** at the destination system's edge, on the line from the origin star, with the ship's
   velocity preserved and pointed inward. The whole system is laid out below and the inbound leg is
   a coast through the far field on the existing Keplerian model: minutes of falling in during which
   the player reads the system (a ping return, the traffic, what the sensors show) and picks a place.

Constraints that fall out: range is a drive class times a mass fraction; a heavy trader reaches
fewer stars per tank than a surveyor; you cannot jump from a fight in orbit; you cannot jump towing
a rock; you arrive where the geometry puts you, not where you want to be, and a system's dangerous
side is dangerous because of where its lanes come in. Deliberately not modelled: time dilation, fuel
scooping mid-jump, misjumps, jump gates. A jump is shown as the vector layer collapsing to a line
and a single flash: the 1982 presentation, not a tunnel.

**Sector time.** The system you are in runs at full simulation. Every other system has a *ledger*:
the deltas the player caused (bases destroyed, pads lost, stock sold, cores taken, names discovered,
journal entries) and a clock. On re-entry the ledger is applied and the elapsed sector time relaxes
what should relax (prices drift toward base, bases regrow guns, sieges resolve by odds, stock
recovers), then the system runs live again. Live ships and projectiles never carry across; what you
did carries.

## 4. How are systems generated so they have identities?

**Trait first, then everything in service of it.** A system template is a dominant trait plus the
constraints it imposes on the recipe. Twenty to thirty templates, each usable at most once per
cluster, some at most once per sector. Examples, written as the sentence a player would say:

- "the binary with the scorched inner world": two stars, a close-in world whose day side is lethal
  and whose night side holds the only shelter; the mines are on it because that is where the ore is.
- "the dead star with the debris disc": a white dwarf, no habitable world, a vast ring of hulls and
  rocks, salvage economy, machine tugs picking it over, pings that return too much.
- "the gas giant with six moons and a refinery war": one giant, moons in fixed roles of their own,
  two factions' stations, convoys, a blockade that moves.
- "the red dwarf that flares": four small worlds, flares every few minutes, everything lives in
  shade and under the ground; heat-shield country; cold and quiet between flares.
- "the frontier foundry": a system the Tide has taken: grid-fed bases on every world, a core works
  under one of them, no civilians, and the route home runs past it.
- "the hollow worlds": a system of low-gravity bodies honeycombed with old workings; interiors are
  the point; the surface is a lid.
- "the crossroads": nothing special about its stars, everything special about its position: three
  corridors meet, the free port sells what nobody else does, pirates wait at the lane ends.
- "the quiet one": a system with no machine presence, one sleepy colony, and one thing that should
  not be there.

From the trait the generator draws the rest by tables: star class (single, binary, red dwarf,
white dwarf, blue giant; flare rate, heat and warm radius, colour), world count by star class (one
to seven), each world's distance band and thermal class, belts and clusters, anomalies (a Fault-class
heavy body, a dust cloud that blinds sensors, a debris disc), inhabitation level (none, outpost,
colonies, ports), faction control (the Charter, the Free Ports, the Tide, nobody), machine presence
(none, patrols, bases, grid), economy tags (what it makes and lacks; see 10), danger (a number the
chart reports as a word), and zero to two hooks from the set-piece pool (see 11). Names are made from
the trait and the star class, so "KESRIS BINARY" and "THE ANVIL" are names the player can hang a
memory on, and the chart shows the trait as a two-word tag once it is known.

Identity is also enforced by contrast: no two systems in reach of each other share a star class and
a trait, and the sector's gradients decide where the templates may land.

## 5. How are planets generated so they offer substantially different play?

The current assumption to remove: worlds in fixed roles. A world's role should fall out of its
physics. The properties that already change how the ship handles are the properties to vary:

| Property | Range | What it changes in play |
| --- | --- | --- |
| Surface gravity | 1.5 to 9 | landing margins, how far a rock can be carried, whether the Kestrel can lift anything, how deep a well is to climb out of |
| Thermal class | scorched, warm, temperate, cold, frozen | whether the day side kills, how fast guns and radiators cool, whether shade matters at all |
| Atmosphere | none, thin, thick | a drag layer (the gas-giant code) that brakes, heats, hides emissions and can be scooped; thick worlds are flown, not fallen onto |
| Rotation | tidally locked, slow, fast | eternal day and night sides versus pads that move under you and a terminator that arrives |
| Terrain amplitude and motif weights | smooth to savage | approach corridors, hiding places, where a base can see |
| Composition | rock, ice, volcanic, crystal, metal | what is under the ground and what it is worth, wall fragility, palette |
| Interior grammar | none, or one or two of: fault, lava tube, collapsed cavern, layered, honeycomb, ice crevasse, volcanic, crystalline; plus built work | what kind of underground place it is, what its silhouette is, and which way through it is hard (see 6) |
| Inhabitation | none, outpost, colonies, port | traffic, fuel, pods to save, prices |
| Machine presence | none, patrol, bases, grid | sensors, guns, waves, a regulator to steal |
| Moons and rings | zero to six, ring or none | approaches, hazards, places to hide a station |

A world on the scorched band with fast rotation and a worked interior is a place where you work at
night in the tunnels and get out before the sun; the same interior on a frozen tidally locked world
is a place where the cold never ends and the radiators never need shade. That is the difference the
brief asks for: not colour, but which of the existing rules is in charge.

The system recipe constrains the draw: star class sets the bands' thermal classes; the trait can pin
one world ("the scorched inner world") and leave the rest to the tables; inhabitation follows
habitability unless the trait says otherwise. The home system keeps its five worlds as an authored
recipe under the same schema.

## 6. How do planetary, local and interior spaces become rich enough to explore?

Three layers, each with its own grammar, all reusing the same sim.

**Surface (exists).** Motifs with sockets: valleys, ridges, craters, canyons, shelves, excavations,
mouths. Extend with world-class motif weights (a cratered airless world, a volcanic one with lava
lows that are heat sources, an ice world with crevasse fields) and with settlement sockets that
follow inhabitation.

**Interior as the level unit, generated formation first.** The current complexes prove the rendering
(rock and void, walls, bright edges) and the physics (openings, shelves, interior gravity, resting
objects). Play-testing also shows what they get wrong: they are blobs joined by corridors, the
construction is visible, and one looks like another however it is populated. That vocabulary is not
sufficient and is retired as the way interiors are made. Rooms are no longer placed. **The rock is
generated first as a geological formation; the traversable space is what erosion, collapse and
excavation did to it.** Chambers, ledges, blockages and entrances are then *found* in the result, not
authored into it, and content sockets hang off what was found.

The pipeline, per world:

1. **Choose grammars** from composition, thermal class, gravity and the system trait: one, sometimes
   two that cut across each other (a fault system through old lava tubes; built workings following a
   vein along a fault).
2. **Generate the formation** in the body's local frame: a structural model, not a void model. Faults
   are families of long planes with orientations and offsets. Tubes are flow paths that followed the
   ancient surface. Strata are concentric bands of differing hardness. A honeycomb is a cellular
   lattice. Crevasses are parallel cracks across a stress direction. A volcanic system is a chamber
   with conduits and dykes. A crystalline body is a cluster of growth cavities.
3. **Apply processes** that turn formation into void, each a small rule with parameters: *erosion*
   widens along soft rock and along paths, more at the bottom than the top; *collapse* fails thin
   roofs and intersections into halls and drops rubble; *excavation* cuts benches and drives
   galleries along seams; *intrusion* cuts built work into natural void; *infill* leaves bridges,
   breakdown piles and wedged blocks where the process would leave them.
4. **Derive the level**: the union of void as polygons (the openings rule already handles overlap),
   solid inclusions (pillars, bridges, piles, built walls) as solid polygons inside void (an addition
   to the walls system, see 15), chambers found by a distance transform where the void is wide,
   ledges found where a wall's normal points outward (the landing rule), entrances found where void
   meets the surface, blockages found where the void narrows below ship width and made real as rocks
   or breachable walls.
5. **Validate** as today (openings, reachability, roof, nothing embedded) plus a grammar signature
   test on the wall edges (orientation histogram, curvature, horizontal dominance, cell angles), so a
   fault system that came out looking like a blob is rejected, and a silhouette count so no world is
   only corridors.

Eight natural grammars. Each is described by what it is, what a player sees from the silhouette
alone, how one moves through it, and what it makes hard:

| Grammar | Formation and process | Silhouette | Topology and the hard part |
| --- | --- | --- | --- |
| **Fault / fissure** | two or three families of long planar cracks with en-echelon offsets and acute branches; erosion widens them unevenly; intersections collapse into chambers | long straight edges at a few consistent angles, sharp Y and X junctions, stepped offsets | a few long throughways crossing, tight dead-end tips; chambers only where cracks meet; ledges are the offset steps; wedged blocks in the narrows |
| **Lava tube** | sinuous tubes of near-constant width following old flows roughly parallel to the surface, braiding and rejoining, stacked at depths; roofs fail into skylights | smooth rounded corridors, meanders, braids, round holes to the sky | a braided network with few chambers (the braids and the breakdowns under skylights); entrances are skylights; the hard part is that most of it runs sideways and the exits are above you |
| **Collapsed cavern** | one large roof failure over a void; breakdown piles and tilted slabs remain inside as solid islands; side passages where the failure ran | one big jagged shape full of debris, open to the sky | a hub with islands to fly around and short radial passages; the entrance is the collapse itself; the hard part is the rubble, which can be moved |
| **Layered / terraced** | concentric strata of differing hardness; erosion removes soft bands into long flat galleries at several depths; hard bands break at chimneys | horizontal bands, stepped profiles, stairs of shelves | stacked levels with few chimneys between; ledges everywhere; the hard part is vertical: gravity, landing on the next terrace, finding the one chimney down |
| **Honeycomb** | a cellular lattice of small chambers with thin walls, many breached; low-gravity bodies and anything the Tide has worked | repeated polygonal cells like foam | a maze of many loops and dead cells; the hard part is orientation, and walls thin enough to shoot through (a breachable wall opens when destroyed) |
| **Ice crevasse** | parallel wedge cracks, wide at the surface and narrowing with depth; bridges span them at various depths; moulins drop between them; melt tunnels join their bottoms | tall narrow V shapes, bridges across, vertical shafts | mostly vertical: down a crevasse, under a bridge, along a melt tunnel, up the next; the hard part is that the way down is wide and the way along is narrow, and ice walls are pale and fragile |
| **Volcanic** | a bulbous chamber with conduits to the surface and thin radial dykes; a caldera at the top | a bulb with chimneys radiating from it | hub and spokes, vertical; the caldera is the obvious way in and the dykes the hidden ones; the hard part is heat: lava floors are heat sources and the chamber is warm |
| **Crystalline** | clusters of polyhedral growth cavities joined by narrow throats; facets everywhere | angular, many-sided cavities with short edges at sharp angles | clusters of rooms behind throats; pings ring; walls are bright and some reflect shots; the hard part is that every room is a firing gallery |

**Built work cuts into geology, it does not float in it.** Mines follow veins, and veins follow
faults, so a mine is a fault system with benches, galleries and a hoist room excavated along it. A
fortress occupies a collapsed cavern and adds cut walls, gun galleries with lines of fire down the
old passages, a plant room whose core feeds the doors (a door is a wall segment that is open only
while its socket is fed: the power rule doing level design), and a way in through the workings the
builders never sealed. A refinery sits in a lava tube where the gas is. A vault is one crystalline
cavity with its throat walled. A tomb is a terrace nobody cut. Built vocabulary is straight edges,
right angles, doors, pillars and benches; it is recognisable against any of the eight natural
grammars precisely because none of them is straight in the same way.

Sizes: a formation spans the world's interior between six units under the surface and a third of
the radius, sixty to two hundred and fifty units across, with two to five entrances of the kind the
grammar gives (a crack, a skylight, a collapse, a caldera, a chimney). A world may hold one large
formation and one small, or two that intersect. The mesh builder, the void mask and the openings
rule are already per body and take any polygon; the addition is solid polygons and the formation
model itself.

**Situations, not loot.** The content rule stays: every room is a physical situation using existing
systems (a gun that cannot cool without its fins, a dormant post that wakes when fed, a rock that
blocks the way until towed, a hull to salvage, a core to take that turns something else off). New
situations the sector adds: a door that needs power from a core you must bring, a refinery that
sells fuel only while its plant runs, a stranded ship that can be fuelled but whose pilot cannot fly
walls (so you tow it out), a machine tug that is stealing what you came for.

## 7. What ship classes and configurations exist?

Hulls are sidegrades, not a ladder. Each hull is a mass, a thrust, a turn rate, a power budget, a
heat budget, a number of mounts and a bay, and the physics turns those into feel. Six hulls:

| Hull | Poses the problem | Mass | Thrust | Power | Mounts | Cargo | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| KESTREL | do everything, excel at nothing | 1.0 | 14 | 3 | 1 | 8 | the ship you have |
| SWIFT | outrun and outturn, but everything is thin | 0.7 | 20 | 2 | 1 | 2 | interceptor; cannot tow much; small tank |
| HAULER | mass is the enemy: plan every burn | 2.6 | 16 | 4 | 1 | 40 | trader; landing needs struts and retro; slingshots pay |
| SURVEYOR | go far and see far, fight nothing | 1.3 | 12 | 5 | 1 | 10 | long drive, big tank, best sensors and ping |
| MULE | lift and pull: the cable is the weapon | 1.8 | 18 | 4 | 1 | 12 | winch, strong retro, tows size-three rocks and hulls |
| LANCE | take hits and keep firing | 1.9 | 15 | 6 | 2 | 6 | armour, cooling, two weapons; poor range |

Modules by category, each with a mass, a power draw and a heat term, so a configuration is a
budget, not a list:

- **Engines:** stock, tuned (thrust up, burn up), efficient (burn down, thrust down), heavy (for
  haulers: thrust up, mass up).
- **Manoeuvring:** retro, lateral jets, gyros, landing struts.
- **Drive:** short (three chart units, quick charge), long (six, slow charge), quiet (short, low
  emission while charging), none (a hull can sell its drive for cargo).
- **Tank:** standard, extended, twin (for the surveyor and hauler).
- **Cargo:** rack, bay, pod clamps (pods outside the hull: cheap and vulnerable).
- **Armour:** plating, ablative (burns off, light), none.
- **Cooling:** stock, fins (more shots before a jam, larger signature), cold sink (a store that
  absorbs heat then must be shed in shade).
- **Sensors:** stock, long range, passive array (hears more, emits nothing), ping amplifier.
- **Power:** a plant class sets the budget; a bigger plant weighs more and glows more.
- **Weapons:** the existing six, plus a mining laser (slow, cuts rocks to ore in place), a flak gun
  (short range, kills missiles and darters), a lance (the enemy's own, salvaged).
- **Missiles:** seekers, decoys (a hot flare that sensors chase), mines (drift in the far field).
- **Cable:** stock, winch (reel in under load), long line, grapple (latches structures and hulls).
- **Specialised:** heat shield, grav dampers, scoop, chart reader, salvage crew, cold storage
  (pods survive longer), a regulator seat (carry a core powered so it keeps its beat).

Configurations enable approaches because the physics is the arbiter: a Swift with a quiet drive and
a passive array is a smuggler that goes where the guns are jammed; a Mule with a winch and a grapple
tows a wreck out of a fortress; a Lance with fins and a cold sink fights the Kiln at noon; a Hauler
with a long drive and twin tanks makes the one trade run that pays. None of them is the best ship.

## 8. How does equipment progression work?

Progression is **access and knowledge, not a ladder**. Money buys modules, but which modules are for
sale depends on where you are: the harbour sells the basics, a refinery sells tanks and engines, a
research station sells sensors and drives, a free port sells salvaged enemy gear, and some things are
not for sale anywhere and are only found (a regulator seat in a tomb, a quiet drive in a smuggler's
wreck, a lance from a killed lancer). Hulls are bought at ports and the old hull is sold; the sector
has three ports that sell hulls and each sells two.

Reputation with the Charter and with the Free Ports opens shops and prices; the Tide has no shop.
Losing a hull loses its modules, so a fitted ship is something to protect; spare hulls remain the
arcade frame (see 15) but a hull is a hull, not a life: the replacement is a stock Kestrel at the
last station unless insurance was paid, which is the credits sink that makes trade matter.

## 9. How is enemy variety expanded?

An enemy class is **archetype × doctrine × faction**, built as data over the one AI. Archetypes are
movement problems; doctrines are decision problems; faction sets weapons, sensors and looks.

Archetypes (the piloting problem each poses):

- **Darter** (wasp): more acceleration than you; cannot be outrun, must be out-turned or led into
  terrain or a wall of your own shots.
- **Lancer**: fast straight passes; the problem is the pass geometry, not the ship.
- **Brute** (reaver): mass and momentum; being rammed is the damage; gravity is your friend.
- **Picket**: a sensor ship that never closes; it holds you in its brackets and calls the hunt; kill
  it, blind it, or go cold.
- **Seeker boat**: keeps distance and throws missiles that bend in gravity; the problem is the
  missile, which decoys and terrain solve.
- **Sapper**: slow, terrain-hugging, carries a builder; the problem is finding it before its base is
  up.
- **Tender**: refuels and cools the others; kill it and the wing's heat problem becomes yours to
  exploit.
- **Tug**: latches onto what is on your cable, on your pad, or in your wreck field and takes it;
  the cable rules apply to it too.
- **Boarder**: latches onto freighters and shuttles and flies them away; a civilian you can save by
  cutting the cable with a shot.
- **Gun platform** (sentinel): landed, powered, heat-bound; the Kiln's grammar, everywhere.
- **Leviathan** (dreadnought): the mass that does not care; the problem is the escort.

Doctrines, each using an existing rule:

- **Pursuit** beyond the well, until heat or fuel says stop.
- **Interception** along your predicted trajectory under gravity (they cut the orbit, not the chord).
- **Ambush**: engines off in shadow, emitting nothing, until you are inside the cone; the sensor rule
  used against you.
- **Retreat**: go cold and drift when jammed or hurt; come back when cool.
- **Formation**: a picket at range, two darters on the picket's fix, a tender behind the limb.
- **Terrain**: hug below a base's horizon; use canyons; wait in a mouth.
- **Strategic role**: guard, raid, blockade a lane end, escort a convoy, pick over a debris field,
  hunt on a fix, hold a chokepoint.

Factions: the **Tide** (machines: cold, grid-fed, sensor-driven, ambush and interception); **pirates**
(human hulls, ambush at lane ends, boarders and tugs, retreat when hurt); **militia** (patrol, escort,
intercept anything that fires near a colony, including you). Civilians get their own archetypes too:
freighters, shuttles, tankers that burn when shot, liners full of pods, prospectors that cut rocks,
tugs that haul wrecks, couriers that run the lanes fast, and a stranded anything.

Looks follow the archetype: a picket is a mast on a hull, a tug is all cable and winch, a boarder
has arms; the vector aesthetic makes silhouettes readable at range, which is the point.

## 10. How does trade become meaningful without becoming tedious?

**Six goods, prices from geography and disruption, knowledge that decays.**

| Good | Made by | Wanted by |
| --- | --- | --- |
| ORE | mines, prospectors, rocks you cut | refineries |
| CRYSTAL | crystal worlds, the Fault's ring | research stations, the Tide (it does not pay) |
| FUEL | refineries near giants, scoops | everyone, most where there is no giant |
| PARTS | refineries from ore, salvage, wrecks | colonies, ports, repairs |
| GRAIN | temperate colonies | every colony that is not temperate, outposts |
| CORES | the Tide's works, remnants | anything with an empty socket, research stations, the black market |

Each station has a stock and a base price for what it makes and wants; price moves with stock (low
stock, high price) and stock moves with the traffic the director already runs: convoys deliver,
raids destroy, sieges stop deliveries, a blockade at a lane end starves a system, a destroyed
refinery removes a producer until it is rebuilt. The player sells into a stock and moves the price;
a Hauler load moves it a lot. Distance and danger are the margin: the fuel to get there and the odds
of being intercepted are what the profit pays for.

Price knowledge is what the player has seen: the dock screen shows last-known prices per system
with an age, recorders and comms leak rumours ("GRAIN IS GOLD AT KESRIS SINCE THE RAID"), and a chart
reader module buys fresher data. There is no market screen, no futures, no contracts, no graphs: a
row per good in the dock menu, buy and sell, and the journal noting what you saw.

Trade creates reasons to travel because the goods are where the geography puts them: grain grows on
temperate worlds, fuel comes from giants, cores come from the Tide. And trade creates risk because
the cargo is mass (the Hauler cannot run from a lancer) and because the lanes into a rich system are
where the pirates sit.

## 11. How does exploration remain surprising after many hours?

Layers of rarity, with rough frequencies per system:

| Layer | Frequency | Examples |
| --- | --- | --- |
| Ordinary places | every system | colonies, mines, ports, shelters, workings, wreck fields |
| Uncommon situations | most systems, from the director | a siege in progress, a stranded liner, a burning refinery, a convoy under attack, a machine construction |
| Rare structures | one in three systems | a sun station of the Lighthouse's kind, a machine foundry, a drift of dead hulls, an array that keeps the beat, a station cut into a moon |
| Strange phenomena | one in four | a dust cloud that blinds sensors, a flare star, a body of the Fault's kind, a rogue world on no rail, a ring that is all hulls, a magnetic anomaly that bends shots |
| Derelicts | one in two | hulls with bunkers, tanks and drives (the Slipway's grammar), each with a recorder |
| Unusual worlds | one in four | hollow, honeycombed, tidally locked with a twilight strip, a world with a machine core, an ice world of crevasses |
| Remnants | one in five | tombs, vaults, regulator sockets that fit nothing of ours, arrays that point at the floor |
| Authored set pieces | eight to twelve placed per sector from a pool of twenty | see below |

The set-piece pool is semi-authored: each is a template with a fixed idea and procedural placement
and fill, used at most once per sector, hidden by the same rule as HOLLOW and the Slipway (unnamed
until found or pinged). Examples: THE ARK (the Pilgrim's destination, a colony ship in a decaying
orbit around a dead star); THE FOUNDRY (where the Tide makes cores: the only place a regulator can
be bought, at a price the Tide sets); THE STILL (a system where the tide's beat stops and every
powered thing goes quiet); THE SHIPYARD (a hull for sale that is for sale nowhere else); THE
OBSERVATORY (a chart that reveals every trait in the sector); THE WRECK OF THE FIRST (a hull the size
of a station with an interior); THE CHOIR (three arrays in three systems that answer the same ping).
Not all appear, so no run sees the whole pool.

Not everything is marked. The chart shows a system's trait once known and its danger as a word; it
never shows what is under the ground, what is in the ring, or what answers a ping. A player enters a
system, the sensors return something the tag did not promise, and the plan changes. That is the loop
the brief asks for, and it costs the generator only a table and the discipline to keep the chart
ignorant.

## 12. What remains authored?

- The home system as an authored recipe: five worlds, the harbour, the Kiln, the Relay, the Cut, the
  Slipway, the Lighthouse, HOLLOW, the Pilgrim, the Fault. The Starfall arc stays there.
- System trait templates (twenty to thirty), each a sentence and a set of constraints.
- The set-piece pool (twenty templates).
- The eight natural interior grammars, the process rules (erosion, collapse, excavation, intrusion, infill), the built templates (mine, fortress, refinery, vault, tomb) and their vocabulary; surface motifs.
- Hulls, modules, weapons, enemy archetypes and doctrines, civilian classes, factions, goods.
- The presentation: palettes by star and world class, glyphs for traits, the jump flash, the chart.
- The rule that nothing is marked and the journal records only what was seen.

The Starfall story may extend past the home system (the Foundry is where the cores come from; the
Still is where they stop; the Ark is where the Pilgrim was going) but no system depends on it, and a
player who never touches the arc still has a sector to live in.

## 13. What becomes procedural?

Sector layout and clusters, gradients, which templates land where, every system recipe that is not
the home's, every world that is not authored, terrain, every interior formation and everything derived
from it (the void, the chambers, the ledges, the entrances, the blockages, the fill), station markets
and their stocks, events per system (the director, as now), prices and rumours, the placement and fill of
set pieces, names.

## 14. Which existing systems can be reused directly?

Almost all of the sim, unchanged in kind: flight and gravity, terrain and landing, docking, cable
physics, ping, heat and shadow, sensors and emissions, power and structures, the director and its
events, traffic, the journal, recorders, the planet generator (motifs, sockets, complexes), the
rock-and-void rendering, the harness and the test invariants. The current `generateSystem` becomes
the home system's authored recipe. Stations and pads, upgrades UI (extended to a fitting screen),
the map (extended with a sector layer), the HUD landing and heat readouts (extended with the drive
readout). The gas-giant drag layer becomes the atmosphere model for thick-atmosphere worlds.

## 15. What architectural changes are required?

- **A `Sector` above `World`.** Seed, chart positions, system recipes, per-system ledgers, sector
  time, set-piece placement. `World` is built from a recipe plus a ledger on entry and discarded on
  exit. Fields that move up out of `World`: credits, score, discovered, journal, lives, threat per
  system (into the ledger), the player ship.
- **A `PlayerState` that outlives any `World`:** hull class, modules, cargo, fuel, credits,
  reputation, chart knowledge (prices seen and their age, traits known), journal.
- **Recipes and instantiation.** `generateSystem(seed)` splits into `recipe(sectorSeed, index)` and
  `instantiate(recipe, ledger)`. Fixed roles, `PlanetPlan`, the pad placement blocks and the Kiln,
  Relay, Slipway and Lighthouse authoring move into the home recipe.
- **Determinism by construction.** Every system draws from its own seed (sector seed plus index) and
  every body from `makeBodyRng`, so adding a world in one system never reshuffles another. The
  shared-stream hazard hit twice this month is a design rule now.
- **Save and load.** A run spanning systems and hours cannot live in a tab. Sector, PlayerState and
  ledgers serialise to local storage; the World is regenerated. Required infrastructure, not a feature.
- **Data tables replace enums:** `ShipKind` becomes a `ShipClass` table (hull and archetype
  parameters) with doctrine modules over the one AI; `UPGRADES` becomes a module table with mass,
  power and heat terms and a fitting screen with budgets; `Cargo` becomes a map of goods; stations
  get a `Market`.
- **The jump.** A drive state on the ship, the gravity and heading gates, the charge timer with its
  emissions and heat, the drop of the cable, the transition, the arrival placement in the far field.
- **The chart.** The map gains a sector layer (stars, tags, danger words, ranges, last-known prices)
  and pans when zoomed, which is also the first item of the backlog.
- **Formation-first interiors.** A formation model per grammar (fault families, flow paths, strata,
  lattice, stress cracks, chamber and conduits, growth clusters), the process rules that derive void
  from it, and feature detection (chambers by distance transform, ledges by normal, entrances by
  surface contact, blockages by width) replace the chamber-graph builder; the chamber-graph code is
  retired. **Solid polygons** join the walls system: pillars, bridges, breakdown piles and built walls
  are polygons inside void whose inside is rock, with closed edges facing outward; collision, the
  openings rule, the void mask and the wall mesh treat them as the inverse of a passage. **Breachable
  walls**: a thin wall segment flagged breachable becomes an opening when its integrity is shot away
  (the fragile-wall rule with a consequence). **Doors**: wall segments open while a socket is fed.
  **Heat sources** underground: a wall tag that makes the existing ambient heat rule apply near lava.
  **Reflective walls**: a wall tag under which shots bounce, for crystalline cavities. The level size
  goes up by three; the mesh builder and the void mask are already per body and will take it.
- **Run frame.** The three-hull run and the core-kill ending become the home system's own arc; the
  sector has no ending and no game over beyond losing the last hull without the credits to replace it.

## 16. What is the smallest implementation slice that can prove this larger game works?

**Slice one: two systems and a jump.**

- The home system as an authored recipe under the new schema, unchanged in play.
- One generated neighbour with one trait ("the red dwarf that flares": three small worlds, a mine
  on the scorched one, a free port, no Tide), built by `instantiate(recipe, ledger)`.
- A short drive bought at the harbour; the four gates (out of the well, aligned, charged with
  emissions and heat, fuel by distance and mass); the cable drop; the flash; arrival at the edge on
  the line from the origin star; the inbound coast.
- A `PlayerState` that crosses the jump (hull, modules, cargo, fuel, credits, journal).
- A ledger for each of the two systems: bases destroyed, pads lost, stock sold, names discovered,
  applied on return with elapsed-time relaxation of one thing (prices).
- Two goods with different prices in the two systems (ore cheap at the mine, parts dear at the
  port; the reverse at home), sold from the dock menu.
- A chart with two stars, a bearing, a range circle, a trait tag and last-known prices.
- Save and load of the sector and player state.

What it proves: that a `World` can be built from a recipe and thrown away; that the player and their
consequences persist; that travel is a physical act the sensors and heat rules make interesting; that
a system with one trait reads as a place; that a price difference is a reason to make the trip. What
it leaves out on purpose: hulls, modules beyond the drive, enemy archetypes, interiors beyond the
current ones, factions, the set-piece pool, more than two goods.

**Slice two: a cluster.** Six systems from six templates in reach of each other; two hulls (Swift
and Hauler) and the fitting screen with mass, power and heat budgets; three enemy archetypes (picket,
tug, ambusher in shadow) as data over the AI; all six goods; one set piece placed; the sector layer of
the chart with danger words; and the first two formation-first interior grammars (fault and lava tube)
with solid polygons, replacing the chamber-graph builder on the worlds that get them, so the
silhouette test can be judged by a human before the other six grammars are written. That is the point at which a play-tester can say whether the sector
feels like a universe.

The regression floor for both slices is the existing test suite and scenarios (generation
invariants over 120 seeds, the stability soak, the Cut, Pilgrim, Signal, Lighthouse, Kiln, planets and
gunpost scenarios), all of which must keep passing in the home system.

---

## Appendix: bug backlog (recorded, not the focus of this pass)

- The system map cannot pan when zoomed.
- The debris-field marker sometimes points to empty space.
- Cave entrances still render poorly.
- Interiors remain too small and sparse, and the blob-corridor-blob construction is visually obvious
  and repetitive (play-test finding; addressed by design in section 6, not yet implemented).
- Civilian terrain impacts (about a third of civilian losses are ground impacts and collisions).
- Previously recorded simulation and pathfinding issues: the launch-and-fly landing autopilot in the
  playtest driver dies to the harbour ring and freighters; the Slipway crosses approach columns; the
  follower autopilot tows a small rock out of a complex on about half its tries and stalls on a
  size-two rock; rock aiming is unsolved by decision; enemy construction can carve a base pad over a
  cave mouth on a cut world because the validator runs only at generation; the wall-rescue safety net
  fires about once per autopilot cave tour at junctions and overhang bends.
