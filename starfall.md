# Build a Complete Game: Project STARFALL

You are the lead game designer, gameplay programmer, graphics programmer and technical director for a small experimental game.

Your task is to DESIGN, IMPLEMENT, TEST AND POLISH a complete playable game.

Do not merely produce a prototype or technology demonstration. The objective is a genuinely enjoyable small game with a coherent gameplay loop, progression, challenge, atmosphere and replayability.

You have considerable compute available. Work autonomously for an extended period. Make reasonable design decisions yourself rather than repeatedly asking for clarification.

## High-Level Concept

Create an original space arcade game inspired by the mechanical ideas behind:

* Asteroids
* Gravitar
* Lunar Lander
* Defender
* Elite

Do NOT clone any of these games.

Instead, understand what makes each interesting and combine those ideas into something new:

Asteroids:

* inertia-driven spacecraft control
* immediate arcade combat
* dangerous physical objects
* mastery of movement

Gravitar:

* gravity as a gameplay mechanic
* exploration
* hazardous planetary environments
* precision flying

Lunar Lander:

* landing as a skill
* fuel and velocity management
* interaction with planetary surfaces

Defender:

* a world where events happen beyond the player's immediate location
* distress calls and threats
* prioritisation
* the feeling that the player cannot necessarily save everything

Elite:

* a larger world surrounding the immediate arcade action
* navigation
* docking
* trading/salvage/upgrades where appropriate
* the sense of inhabiting a functioning space environment

The resulting game should feel as though an extraordinarily ambitious arcade designer in approximately 1982 imagined what space games might eventually become.

It should NOT feel like a modern indie space game wearing a retro graphical skin.

## World Structure

The game takes place primarily within one dense star system rather than an enormous galaxy.

Generate an interesting system containing some combination of:

* star
* planets
* moons
* asteroid fields
* stations
* colonies
* mining installations
* abandoned structures
* enemy bases
* convoys
* civilian spacecraft
* hostile spacecraft
* anomalies or other discoveries

The exact structure is your design decision.

The system should feel alive.

Events should be capable of happening elsewhere while the player is occupied.

Examples might include attacks, distress calls, convoys encountering trouble, stations requiring assistance, enemy activity or valuable discoveries.

Do not turn this into a quest-marker checklist.

The player should frequently make decisions about what deserves their attention.

## Fundamental Gameplay Loop

Develop a strong loop approximately resembling:

LAUNCH
→ NAVIGATE
→ DISCOVER / RESPOND
→ FIGHT / RESCUE / SALVAGE / EXPLORE
→ LAND OR DOCK
→ REFUEL / REPAIR / REARM / TRADE / UPGRADE
→ CHOOSE WHAT TO DO NEXT
→ LAUNCH

This is only a starting point.

Modify it if testing reveals a better game.

## Movement

The world should be rendered in full 3D, but initially favour predominantly planar spacecraft gameplay rather than unrestricted six-degree-of-freedom simulation.

The objective is the readability and immediacy of a classic arcade game combined with a genuinely three-dimensional world.

Spacecraft movement should involve inertia.

Gravity should matter.

Massive bodies should create gravity wells that influence trajectories.

A skilled player should eventually be able to exploit gravity rather than merely fighting against it.

Flying well should itself be enjoyable.

Avoid excessive realism where realism harms the game.

This is an arcade game, not an orbital mechanics simulator.

## Landing

Landing on suitable planets, moons, asteroids or installations should be a meaningful piloting activity rather than simply pressing a Dock button.

The player should have to manage:

* velocity
* orientation
* lateral motion
* gravity
* thrust
* possibly fuel

Landing should initially be difficult but become satisfying as the player learns the spacecraft.

Different gravitational environments should feel meaningfully different.

Docking with stations may use a related but distinct mechanic.

## Combat

Combat should reward piloting skill.

Avoid combat based primarily around automatically locking targets and holding down Fire.

Weapons should interact naturally with the movement model.

Enemy behaviour should be readable but capable of producing interesting encounters.

Different enemies should behave differently rather than simply having different hit-point values.

Use the physical environment where useful.

Asteroids, gravity wells, installations and terrain should be capable of affecting combat.

## Visual Direction

The game is rendered using deliberately primitive 3D graphics.

STRICT RULE:

NO TEXTURES.

Do not use texture maps for ships, planets, terrain, UI elements or effects.

Do not use external artwork.

Do not generate raster artwork.

All visible elements must be produced from:

* polygon geometry
* lines
* points
* particles
* procedural geometry
* text

The aesthetic should resemble an impossible high-end arcade machine from the early 1980s.

Use simple low-poly models.

Use flat-shaded polygons.

Use deliberately limited colour palettes.

Consider quantised lighting with only a small number of illumination levels.

Avoid modern physically based rendering.

Avoid visual realism.

The star may act as a strong directional or positional light source, producing dramatic changes in illumination across polygon faces.

Planets should appear as large faceted objects.

Asteroids should be irregular procedural polyhedra.

Ships should have distinctive silhouettes using surprisingly little geometry.

Stations should be bold geometric constructions.

Terrain should consist of simple polygon meshes.

The graphical limitations should produce visual identity rather than merely imitate old hardware.

## Vector Graphics

Although the world uses flat-shaded polygons, retain vector graphics as an important part of the visual language.

Vectors are particularly appropriate for:

* HUD
* targeting
* navigation
* trajectory indicators
* radar
* velocity vectors
* gravity indicators
* docking guidance
* weapon effects
* distant objects
* explosions
* communication indicators

Consider having distant objects initially appear as vector representations before resolving into polygonal objects as the player approaches.

Vector effects may include controlled bloom, phosphor persistence or subtle instability where aesthetically appropriate.

Do not overdo CRT effects to the point that readability suffers.

## Scale

Create a convincing transition between scales.

For example:

At extreme distance, a planet might be little more than a point or circle.

As the player approaches, it becomes visibly spherical.

Closer still, its faceted polygon structure becomes apparent.

Eventually terrain and installations become visible.

The player should be able to approach and potentially land without an obvious traditional level transition if technically practical.

Do not implement realistic astronomical scale.

Compress distances and velocities aggressively to produce enjoyable gameplay.

## Procedural Generation

Procedural generation is strongly encouraged.

Suitable candidates include:

* star systems
* planets
* moons
* asteroid shapes
* asteroid fields
* terrain
* stations
* ships
* installations
* encounters
* events
* names
* missions
* economic conditions

However:

PROCEDURAL GENERATION IS NOT A SUBSTITUTE FOR DESIGN.

Generated content must create meaningful gameplay differences.

Do not generate thousands of meaningless objects merely because you can.

One memorable star system is preferable to a million boring ones.

## Simulation

Build enough systemic interaction that unexpected situations can occur.

Possible systems include:

* gravity
* orbital or pseudo-orbital movement
* factions
* traffic
* station economies
* fuel
* damage
* salvage
* distress events
* enemy expansion
* resource movement
* civilian shipping

Choose systems based upon their contribution to gameplay.

Do not implement complexity purely for its own sake.

Emergent interaction is desirable.

Spreadsheet simulation is not.

## Progression

Give the player reasons to continue playing.

Possible progression includes:

* improved spacecraft systems
* different weapons
* improved thrusters
* additional fuel capacity
* improved sensors
* stronger hull
* specialised equipment
* reputation
* access to dangerous regions
* discovery

Avoid turning progression into a conventional loot treadmill.

Upgrades should preferably change capabilities or create interesting trade-offs rather than simply increasing numbers.

## Technology

Implement the game using:

* TypeScript
* WebGL2
* Vite

Do NOT use:

* Three.js
* Babylon.js
* Unity
* Godot
* Phaser
* an external game engine

Build a small renderer appropriate to this specific game.

Use WebGL2 directly.

Keep rendering, simulation and gameplay reasonably separated architecturally.

Use shaders where appropriate.

Possible rendering features include:

* flat shading
* simple directional/positional illumination
* quantised illumination
* line rendering
* particles
* bloom
* phosphor persistence
* subtle vector glow

Do not allow rendering technology to consume the entire project.

Gameplay is more important.

## Controls

Controls must feel excellent.

Support keyboard and mouse at minimum.

Gamepad support is desirable.

Keep the number of required controls reasonable.

The player should be able to learn basic flight quickly while discovering considerable depth through inertia, gravity and precision manoeuvring.

Provide clear control instructions within the game.

## Audio

Audio may use procedural WebAudio synthesis.

Do not rely upon downloaded audio assets.

Simple synthesised effects are appropriate for:

* thrust
* weapons
* explosions
* warnings
* docking
* UI
* communications
* impacts

A restrained procedural ambient soundscape or simple synthesised music is acceptable if it contributes meaningfully to the atmosphere.

Silence is preferable to irritating procedural music.

## Game Design Process

Before implementing the full game:

1. Analyse the concept.
2. Identify the smallest strong gameplay core.
3. Design the major systems.
4. Write a concise internal design document.
5. Establish a sensible implementation architecture.
6. Implement the core game.
7. Play it.
8. Identify weaknesses.
9. Improve it.
10. Repeat.

Do not spend excessive time writing documentation.

The purpose of the design document is to help you build a better game.

## Iteration Is Mandatory

A functioning build is NOT completion.

Once the major systems exist, repeatedly play and critically evaluate the game.

Specifically ask:

* Is flying intrinsically enjoyable?
* Is gravity interesting or merely annoying?
* Is landing satisfying?
* Is combat readable?
* Are enemies interesting?
* Are decisions meaningful?
* Does exploration create curiosity?
* Are there periods where nothing interesting happens?
* Is navigation tedious?
* Does progression alter gameplay?
* Is the UI understandable?
* Is the visual style coherent?
* Is the player given too much information?
* Is the player given too little information?
* Does the game become repetitive?
* Is there anything implemented that should simply be removed?

Fix problems you identify.

Do not respond to weak gameplay merely by adding more content.

Prefer improving existing mechanics.

REMOVE systems that do not improve the game.

## Testing

Continuously run the project.

Use automated tests where they are genuinely useful.

More importantly, test actual gameplay.

Inspect rendering output.

Watch for:

* numerical instability
* collision problems
* broken procedural generation
* impossible landing situations
* spawning inside objects
* camera problems
* unreadable HUD elements
* runaway difficulty
* long periods without interaction
* degenerate generated systems
* poor performance

Fix problems rather than merely documenting them.

## Scope Management

You are expected to make scope decisions yourself.

If a planned feature threatens completion, simplify or remove it.

Prioritise, roughly:

1. Excellent flight
2. Interesting gravity
3. Good combat
4. Satisfying landing/docking
5. A world worth navigating
6. Dynamic events
7. Progression
8. Visual polish
9. Additional content

A small excellent game is preferable to a large mediocre game.

## Creative Authority

You have substantial creative authority.

The inspirations and ideas above establish the intended direction, not an immutable specification.

If, during development and testing, you discover that a mechanic does not work, change it.

If you discover an unexpectedly enjoyable interaction, explore it.

If two systems combine into something interesting, exploit that interaction.

Do not ask for approval for ordinary design decisions.

Do not blindly implement every idea in this prompt.

Design the game.

## Desired Result

When development is complete, I should be able to clone/open the project, install dependencies, run it and immediately play.

The finished result should feel like discovering an obscure and extraordinarily ambitious arcade game from an alternate 1980s timeline:

simple enough to understand,

difficult to master,

visually unmistakable,

systemically surprising,

and compelling enough that after dying I immediately want another attempt.

Now begin by designing the game, then implement it.

Do not stop at the first working version.
