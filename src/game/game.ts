// Game: owns the engine objects and the world, runs the fixed-step loop, camera, rendering and screens.
import { AudioSystem } from '../engine/audio';
import { Camera } from '../engine/camera';
import { drawTextWorld } from '../engine/font';
import { createGL } from '../engine/gl';
import { emptyControls, Input, type Controls } from '../engine/input';
import { LineBatch, LineRenderer } from '../engine/lines';
import { angleDiff, clamp, damp, hashString, lerp, mat4Ortho, mat4TRS, Rng, TAU, type V2 } from '../engine/math';
import { MeshRenderer, type GpuMesh } from '../engine/mesh';
import { ParticleSystem, StaticPoints } from '../engine/particles';
import { PostPipeline } from '../engine/post';
import { buildAsteroidMesh, buildPickupMesh, buildPlanetMesh, buildShipMesh, buildStarMesh, buildStationMesh } from '../gen/meshes';
import { generateSystem } from '../gen/system';
import { aiFire, pruneShips, updateAi } from '../sim/ai';
import { maxTerrainRadius, terrainNormalAt, terrainRadiusAt, updateOrbits, type Body } from '../sim/bodies';
import { updateDirector } from '../sim/director';
import { applyModule, collide, fireWeapon, gravityAt, LAND_VN, predictTrajectory, stepAsteroids, stepPickups, stepProjectiles, stepShip, type Trajectory } from '../sim/physics';
import { stationContact, undock, updateStations } from '../sim/stations';
import { applyUpgrades } from '../sim/upgrades';
import { comm, sfx, SIM_DT, type Ship, type ShipKind, type World } from '../sim/world';
import { drawFlightHud, navPos, type NavTarget } from './hud';
import { drawDeath, drawDocked, drawGameOver, drawHelp, drawMap, drawPause, drawTitle } from './ui';

interface ExplosionFx { x: number; y: number; t0: number; size: number; color: number[]; }

export type GameMode = 'title' | 'flight' | 'docked' | 'map' | 'help' | 'gameover' | 'pause';

export class Game {
  gl: WebGL2RenderingContext;
  meshes: MeshRenderer;
  lines: LineRenderer;
  particles: ParticleSystem;
  post: PostPipeline;
  camera = new Camera();
  input: Input;
  audio = new AudioSystem();
  world!: World;
  worldLines = new LineBatch(8192);
  hudLines = new LineBatch(8192);
  private ortho = new Float32Array(16);
  private tmpM = new Float32Array(16);
  private starMesh!: GpuMesh;
  private planetMeshes = new Map<number, GpuMesh>();
  private asteroidMeshes: GpuMesh[] = [];
  private asteroidMeshesSmall: GpuMesh[] = [];
  private shipMeshes = new Map<ShipKind, GpuMesh>();
  private pickupMeshes = new Map<string, GpuMesh>();
  private stationMeshes = new Map<number, GpuMesh>();
  private starfield!: StaticPoints;
  private accumulator = 0;
  private lastFrame = 0;
  private fx: ExplosionFx[] = [];
  trajectory: Trajectory = { pts: new Float32Array(600), count: 0, impact: false, impactBody: null, impactX: 0, impactY: 0, impactSpeed: 0 };
  camPos: V2 = { x: 0, y: 0 };
  camHeight = 80;
  camTilt = 0.3;
  manual = false;       // test harness: sim only advances via step()
  frameTime = 0;
  frameCount = 0;
  mouseSteer = false;
  lastControls: Controls = emptyControls();
  dpr = 1;
  renderTime = 0;
  // screens
  mode: GameMode = 'title';
  menuIndex = 0;
  helpReturn: GameMode = 'title';
  mapReturn: GameMode = 'flight';
  mapZoom = 1;
  mapPan: V2 = { x: 0, y: 0 };
  navTarget: NavTarget | null = null;
  seedText = 'STARFALL';
  seedDirty = false;
  highScore = 0;
  overlayDim = 0;
  respawnTimer = 0;
  deathTime = -1;
  private fade = 1;
  private titleOrbit = 0;
  muted = false;

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = createGL(canvas);
    this.input = new Input(canvas);
    this.meshes = new MeshRenderer(this.gl);
    this.lines = new LineRenderer(this.gl);
    this.particles = new ParticleSystem(this.gl, 6000);
    this.resize();
    this.post = new PostPipeline(this.gl, this.camera.viewportW, this.camera.viewportH);
    window.addEventListener('resize', () => this.resize());
    this.starfield = new StaticPoints(this.gl, makeStarfield(777));
    for (const k of ['pod', 'ore', 'salvage', 'fuel', 'module', 'wreck']) this.pickupMeshes.set(k, this.meshes.create(buildPickupMesh(k), 64));
    for (let i = 0; i < 10; i++) this.asteroidMeshes.push(this.meshes.create(buildAsteroidMesh(1000 + i, false), 64));
    for (let i = 0; i < 6; i++) this.asteroidMeshesSmall.push(this.meshes.create(buildAsteroidMesh(2000 + i, true), 64));
    for (const k of ['kestrel', 'wasp', 'lancer', 'reaver', 'freighter', 'dreadnought', 'shuttle', 'sentinel'] as ShipKind[]) this.shipMeshes.set(k, this.meshes.create(buildShipMesh(k), 16));
    try { this.highScore = parseInt(localStorage.getItem('starfall.highscore') ?? '0', 10) || 0; } catch { /* ignore */ }
    try { const s = localStorage.getItem('starfall.seed'); if (s) this.seedText = s; } catch { /* ignore */ }
    const unlock = () => { this.audio.unlock(); };
    window.addEventListener('keydown', unlock);
    canvas.addEventListener('mousedown', unlock);
    this.newGame(hashString(this.seedText), this.seedText);
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(320, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(240, Math.floor(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.camera.viewportW = w; this.camera.viewportH = h;
    this.camera.aspect = w / h;
    mat4Ortho(this.ortho, 0, w, h, 0, -1, 1);
    if (this.post) this.post.resize(w, h);
  }

  newGame(seed: number, seedName: string): void {
    this.world = generateSystem(seed, seedName);
    for (const m of this.planetMeshes.values()) this.meshes.meshes.delete(m);
    this.planetMeshes.clear();
    for (const m of this.stationMeshes.values()) this.meshes.meshes.delete(m);
    this.stationMeshes.clear();
    if (this.starMesh) this.meshes.meshes.delete(this.starMesh);
    for (const b of this.world.bodies) {
      if (b.kind === 'star') this.starMesh = this.meshes.create(buildStarMesh(b.radius, b.seed), 1);
      else this.planetMeshes.set(b.id, this.meshes.create(buildPlanetMesh(b), 1));
    }
    for (const st of this.world.stations) this.stationMeshes.set(st.id, this.meshes.create(buildStationMesh(st, st.id * 7 + this.world.seed), 1));
    this.particles.clear();
    this.fx.length = 0;
    const p = this.world.player;
    this.camPos.x = p.pos.x; this.camPos.y = p.pos.y;
    this.camHeight = 80;
    this.navTarget = null;
    this.menuIndex = 0;
    this.respawnTimer = 0;
    this.deathTime = -1;
    this.mapZoom = 1; this.mapPan.x = 0; this.mapPan.y = 0;
  }

  /** From the title: start playing the generated system. */
  beginPatrol(): void {
    if (this.seedDirty || hashString(this.seedText) !== this.world.seed) {
      this.newGame(hashString(this.seedText || 'STARFALL'), this.seedText || 'STARFALL');
      this.seedDirty = false;
    }
    try { localStorage.setItem('starfall.seed', this.seedText); } catch { /* ignore */ }
    this.mode = 'docked';
    this.menuIndex = 0;
    sfx(this.world, 'dock');
  }

  restart(newSystem: boolean): void {
    if (newSystem) {
      const rng = new Rng((Date.now() ^ this.world.seed) >>> 0);
      this.seedText = ['KAEL', 'VORN', 'ORME', 'HELL', 'TARN', 'ZAR', 'LUM', 'RIG', 'ANDR', 'BELL'][rng.int(10)] + '-' + rng.intRange(100, 999);
      this.seedDirty = true;
    }
    this.newGame(hashString(this.seedText), this.seedText);
    this.mode = 'title';
  }

  launch(): void {
    const p = this.world.player;
    if (!p.docked) return;
    undock(this.world, p);
    this.mode = 'flight';
    this.camHeight = 50;
  }

  start(): void {
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(now: number): void {
    const t0 = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    this.input.pollGamepad();
    const simRuns = (this.mode === 'flight' || this.mode === 'docked' || this.mode === 'gameover') && !this.manual;
    if (simRuns) {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= SIM_DT && steps < 12) {
        this.simTick(SIM_DT);
        this.accumulator -= SIM_DT;
        steps++;
      }
      if (steps >= 12) this.accumulator = 0;
    } else {
      this.accumulator = 0;
    }
    this.handleGlobalKeys();
    this.render(dt);
    this.input.endFrame();
    this.frameTime = performance.now() - t0;
    this.frameCount++;
  }

  private handleGlobalKeys(): void {
    const inp = this.input;
    if (inp.wasPressed('Digit0')) { this.muted = !this.muted; this.audio.setMuted(this.muted); }
    if (this.mode === 'flight') {
      if (inp.wasPressed('KeyM') || inp.wasPressed('GP8')) { this.mapReturn = 'flight'; this.mode = 'map'; sfx(this.world, 'ui'); }
      else if (inp.wasPressed('KeyH') || inp.wasPressed('F1')) { this.helpReturn = 'flight'; this.mode = 'help'; }
      else if (inp.wasPressed('Escape') || inp.wasPressed('KeyP') || inp.wasPressed('GP9')) { this.mode = 'pause'; }
      else if (inp.wasPressed('Tab') || inp.wasPressed('KeyN') || inp.wasPressed('GP3')) this.cycleNav();
      else if (inp.wasPressed('KeyC')) this.navTarget = null;
    }
  }

  cycleNav(): void {
    const w = this.world;
    const list: NavTarget[] = [];
    for (const e of w.events) if (!e.resolved && !e.failed) list.push({ name: e.label.split(':')[0].slice(0, 20), event: e });
    for (const st of w.stations) if (st.alive) list.push({ name: st.name, station: st });
    if (!list.length) { this.navTarget = null; return; }
    let idx = -1;
    if (this.navTarget) idx = list.findIndex(n => (n.event && n.event === this.navTarget!.event) || (n.station && n.station === this.navTarget!.station));
    idx = (idx + 1) % (list.length + 1);
    this.navTarget = idx === list.length ? null : list[idx];
    sfx(w, 'ui');
  }

  /** Compose the player's controls including mouse steering. */
  playerControls(): Controls {
    const c = this.input.controls();
    if (this.input.override) return c;
    if (this.mode !== 'flight') return emptyControls();
    const p = this.world.player;
    const keyTurn = c.turn !== 0;
    const now = performance.now();
    if (keyTurn) this.mouseSteer = false;
    else if (now - this.input.mouseMovedAt < 1500 || (this.input.mouseButtons & 3)) this.mouseSteer = true;
    if (this.mouseSteer && !keyTurn) {
      const sp = this.camera.simToScreen(p.pos.x, p.pos.y);
      if (sp) {
        const dx = this.input.mouseX * this.dpr - sp[0], dy = -(this.input.mouseY * this.dpr - sp[1]);
        if (Math.hypot(dx, dy) > 12) {
          const want = Math.atan2(dy, dx);
          const diff = angleDiff(p.angle, want);
          c.turn = clamp(diff * 3.5, -1, 1);
        }
      }
    }
    return c;
  }

  simTick(dt: number): void {
    const w = this.world;
    const c = this.playerControls();
    this.lastControls = c;
    updateOrbits(w.bodies, w.time, dt);
    updateStations(w, dt);
    updateDirector(w, dt);
    const p = w.player;
    // player
    stepShip(w, p, c, dt);
    if (p.fireCooldown > 0) p.fireCooldown -= dt;
    if (c.fire && p.alive && !p.landed && !p.docked && !p.boosting && this.mode === 'flight') fireWeapon(w, p, p.weapon);
    if (this.input.wasPressed('KeyX') || this.input.wasPressed('GP2')) {
      if (p.secondary && p.alive && !p.docked && !p.landed) {
        const tgt = nearestEnemyShip(w, 400);
        const cd = p.fireCooldown; p.fireCooldown = 0;
        if (p.secondary.ammo > 0) { fireWeapon(w, p, p.secondary, tgt); } else sfx(w, 'deny');
        p.fireCooldown = Math.max(cd, 0.2);
      }
    }
    // AI ships
    for (const s of w.ships) {
      if (s === p || !s.alive) continue;
      const ac = updateAi(w, s, dt);
      stepShip(w, s, ac, dt);
      aiFire(w, s);
    }
    stepProjectiles(w, dt);
    stepAsteroids(w, dt);
    stepPickups(w, dt);
    collide(w, dt);
    for (const s of w.ships) {
      if (!s.alive || s.docked) continue;
      for (const st of w.stations) {
        if (stationContact(w, s, st) && s === p) { this.mode = 'docked'; this.menuIndex = 0; }
      }
    }
    this.landedServices(dt);
    pruneShips(w);
    this.checkDeath(dt);
    // consume sim-side effects
    for (const e of w.explosions) this.spawnExplosion(e.pos.x, e.pos.y, e.size, e.color);
    w.explosions.length = 0;
    const g: V2 = { x: 0, y: 0 };
    const gm = gravityAt(w, p.pos.x, p.pos.y, g);
    this.audio.update(w, dt, gm, p.pos.x, p.pos.y);
    w.screenShake = Math.max(0, w.screenShake - dt * 2.2);
    // rebuild body meshes changed by the director (new bases)
    for (const b of w.bodies) {
      const bb = b as Body & { meshDirty?: boolean };
      if (bb.meshDirty) {
        bb.meshDirty = false;
        const old = this.planetMeshes.get(b.id);
        if (old) this.meshes.meshes.delete(old);
        this.planetMeshes.set(b.id, this.meshes.create(buildPlanetMesh(b), 1));
      }
    }
    if (w.score > this.highScore) { this.highScore = Math.floor(w.score); try { localStorage.setItem('starfall.highscore', String(this.highScore)); } catch { /* ignore */ } }
    w.time += dt;
    w.tick++;
  }

  /** Refuel, repair, load ore and strip derelicts while landed on a pad. */
  private landedServices(dt: number): void {
    const w = this.world;
    const p = w.player;
    if (!p.landed || !p.alive) return;
    const pad = p.landed.pad;
    if (!pad || !pad.alive) return;
    if (pad.kind === 'colony' || pad.kind === 'mine' || pad.kind === 'outpost') {
      if (p.fuel < p.fuelMax) p.fuel = Math.min(p.fuelMax, p.fuel + 7 * dt);
      if (pad.kind === 'colony' && p.hull < p.hullMax) p.hull = Math.min(p.hullMax, p.hull + 4 * dt);
      if (!pad.visited) { pad.visited = true; w.score += 100; comm(w, pad.name, pad.kind === 'colony' ? 'WELCOME, KESTREL. FUEL AND REPAIRS ARE ON US.' : 'PAD CLEAR. ORE IS YOURS TO CARRY.', [0.6, 1, 0.7], 1); }
      // deliver a towed pod
      if (p.towing) {
        const pod = p.towing;
        pod.alive = false; p.towing = null;
        w.rescued++; w.score += 400; w.credits += 150;
        if (pod.home === pad) pad.population++;
        comm(w, pad.name, 'POD RECEIVED. THE COLONISTS ARE SAFE. +150 CR', [0.6, 1, 0.7], 2);
        sfx(w, 'success');
      }
      if (pad.kind === 'mine') {
        pad.spawnTimer -= dt;
        if (pad.spawnTimer <= 0 && pad.stock > 0 && p.cargo.ore + p.cargo.salvage < p.cargo.capacity) {
          pad.spawnTimer = 1.5;
          pad.stock--; p.cargo.ore++;
          sfx(w, 'pickup', null, 0.5);
        }
      }
    } else if (pad.kind === 'derelict') {
      if (pad.stock > 0) {
        pad.spawnTimer += dt;
        if (pad.spawnTimer > 7) {
          pad.stock = 0;
          const modules = ['ancientcore', 'coldfusion', 'gyros', 'phase', 'seekers'];
          const names: Record<string, string> = { ancientcore: 'ANCIENT DRIVE CORE (BOOST +40%, BURN -40%)', coldfusion: 'COLD FUSION CELL (FUEL BURN HALVED)', gyros: 'MILITARY GYROS (TURN RATE +40%)', phase: 'PHASE LATTICE (SHIELD + HULL)', seekers: 'SEEKER RACK (12 MISSILES)' };
          const id = modules[pad.id % modules.length];
          applyModule(w, p, id);
          w.score += 800; w.credits += 200;
          comm(w, pad.name, `SALVAGE COMPLETE: ${names[id]}. +200 CR`, [1, 0.9, 0.5], 2);
          w.audioEvents.push({ kind: 'module', pos: null, volume: 1, param: 0 });
        }
      }
    }
  }

  private checkDeath(dt: number): void {
    const w = this.world;
    const p = w.player;
    if (p.alive) return;
    if (this.deathTime < 0) {
      this.deathTime = w.time;
      w.lives--;
      this.respawnTimer = 4;
      sfx(w, 'death');
      if (w.lives <= 0) { w.gameOver = true; }
      if (this.mode === 'docked') this.mode = 'flight';
    }
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      if (w.gameOver) { this.mode = 'gameover'; return; }
      // respawn at the last station
      const st = w.respawnStation && w.respawnStation.alive ? w.respawnStation : w.stations.find(s => s.alive) ?? null;
      p.alive = true;
      p.hull = p.hullMax; p.fuel = p.fuelMax; p.heat = 0; p.overheated = false; p.shield = 0;
      p.cargo.ore = 0; p.cargo.salvage = 0; p.towing = null; p.landed = null;
      p.vel.x = 0; p.vel.y = 0; p.angVel = 0;
      p.lastDamageSource = '';
      this.deathTime = -1;
      if (st) {
        p.docked = st; p.pos.x = st.pos.x; p.pos.y = st.pos.y;
        this.mode = 'docked'; this.menuIndex = 0;
        comm(w, st.name, 'REPLACEMENT HULL ISSUED. TRY NOT TO LOSE THIS ONE.', [0.6, 0.9, 1], 1);
      } else {
        // no station left: respawn in orbit around the home world
        const b = w.bodies.find(x => x.kind === 'planet') ?? w.bodies[1];
        const r = b.radius * 3;
        p.pos.x = b.pos.x + r; p.pos.y = b.pos.y;
        const v = Math.sqrt(b.mass / r);
        p.vel.x = b.vel.x; p.vel.y = b.vel.y + v;
        p.invuln = 4;
        this.mode = 'flight';
      }
      this.camPos.x = p.pos.x; this.camPos.y = p.pos.y;
    }
  }

  spawnExplosion(x: number, y: number, size: number, color: number[]): void {
    const w = this.world;
    this.fx.push({ x, y, t0: w.time, size, color });
    const n = Math.floor(10 + size * 22);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (2 + Math.random() * 14) * size;
      const up = (Math.random() - 0.5) * 6 * size;
      this.particles.spawn(x, 0.2, -y, Math.cos(a) * sp, up, -Math.sin(a) * sp, 0.4 + Math.random() * 0.9 * size,
        color[0] * (0.8 + Math.random() * 0.5), color[1] * (0.6 + Math.random() * 0.5), color[2] * 0.6, 0.35 + size * 0.25, 1.5);
    }
  }

  // ------------------------------------------------------------------ camera
  updateCamera(dt: number): void {
    const w = this.world;
    const p = w.player;
    let tx: number, ty: number, height: number, tiltTarget = 0.3;
    if (this.mode === 'title') {
      // slow drift around the harbour
      this.titleOrbit += dt * 0.05;
      const st = w.stations[0];
      tx = st.pos.x + Math.cos(this.titleOrbit) * 30; ty = st.pos.y + Math.sin(this.titleOrbit) * 30;
      height = 90;
    } else if (p.docked) {
      const st = p.docked;
      tx = st.pos.x; ty = st.pos.y; height = 46; tiltTarget = 0.35;
    } else {
      const speed = Math.hypot(p.vel.x, p.vel.y);
      const lead = clamp(speed * 0.45, 0, 55);
      const dir = speed > 0.5 ? { x: p.vel.x / speed, y: p.vel.y / speed } : { x: 0, y: 0 };
      tx = p.pos.x + dir.x * lead; ty = p.pos.y + dir.y * lead;
      let alt = 1e9;
      let groundDir = { x: 0, y: 0 };
      for (const b of w.bodies) {
        if (b.kind === 'star') continue;
        const dx = p.pos.x - b.pos.x, dy = p.pos.y - b.pos.y;
        const d = Math.hypot(dx, dy);
        if (d < maxTerrainRadius(b) + 130) {
          const a = d - terrainRadiusAt(b, Math.atan2(dy, dx));
          if (a < alt) { alt = a; groundDir = { x: -dx / (d || 1), y: -dy / (d || 1) }; }
        }
      }
      height = 58 + speed * 0.85;
      if (alt < 110) {
        const k = 1 - clamp(alt / 110, 0, 1);
        // frame both the ship and the ground: look part-way toward the surface, zoom to fit
        const toward = Math.min(alt * 0.55, 50);
        tx = lerp(tx, p.pos.x + dir.x * lead * 0.3 + groundDir.x * toward, k);
        ty = lerp(ty, p.pos.y + dir.y * lead * 0.3 + groundDir.y * toward, k);
        const fit = clamp(alt * 1.3 + 34, 40, 140);
        height = lerp(height, Math.max(fit, 36 + speed * 0.4), k);
        tiltTarget = lerp(0.3, 0.06, k);
      }
      // near a station: frame it
      for (const st of w.stations) {
        const d = Math.hypot(st.pos.x - p.pos.x, st.pos.y - p.pos.y);
        if (d < st.radius * 3) { const k = 1 - d / (st.radius * 3); height = Math.max(height, lerp(height, 62, k)); }
      }
      height = clamp(height, 30, 210);
      if (!p.alive) height = 70;
    }
    this.camTilt = damp(this.camTilt, tiltTarget, 2.0, dt);
    const rate = p.landed ? 3 : 4.5;
    this.camPos.x = damp(this.camPos.x, tx, rate, dt);
    this.camPos.y = damp(this.camPos.y, ty, rate, dt);
    this.camHeight = damp(this.camHeight, height, 2.5, dt);
    const shake = w.screenShake;
    const sx = shake > 0 ? (Math.random() - 0.5) * shake * 1.6 : 0;
    const sy = shake > 0 ? (Math.random() - 0.5) * shake * 1.6 : 0;
    const cx = this.camPos.x + sx, cy = this.camPos.y + sy;
    const h = this.camHeight;
    this.camera.target = [cx, 0, -cy];
    this.camera.eye = [cx, h, -cy + h * this.camTilt];
    this.camera.near = Math.max(1, h * 0.05);
    this.camera.far = h * 60 + 4000;
    this.camera.update();
  }

  // ------------------------------------------------------------------ render
  render(dt: number): void {
    const gl = this.gl;
    const w = this.world;
    this.resize();
    this.updateCamera(dt);
    this.particles.update(this.mode === 'map' || this.mode === 'help' || this.mode === 'pause' ? 0 : dt);
    const cam = this.camera;
    const star = w.star;
    this.overlayDim = 0;

    // ---- world layer
    this.post.beginWorld();
    this.starfield.draw(cam.viewProj, cam.projScale);
    const m = this.tmpM;
    for (const b of w.bodies) {
      const mesh = b.kind === 'star' ? this.starMesh : this.planetMeshes.get(b.id);
      if (!mesh) continue;
      mat4TRS(m, b.pos.x, 0, -b.pos.y, b.spinAngle, 0, 0, 1, 1, 1);
      mesh.add(m, 1, 1, 1, b.kind === 'star' ? 1 : 0);
    }
    for (const a of w.asteroids) {
      if (!a.alive) continue;
      const list = a.size === 1 ? this.asteroidMeshesSmall : this.asteroidMeshes;
      const mesh = list[a.variant % list.length];
      const s = a.spinAngle;
      mat4TRS(m, a.pos.x, 0, -a.pos.y, s * a.spinAxis[1], s * a.spinAxis[0], s * a.spinAxis[2], a.radius, a.radius, a.radius);
      mesh.add(m, a.rich ? 1.25 : 1, a.rich ? 1.1 : 1, a.rich ? 0.55 : 1, a.rogue ? 0.15 : 0);
    }
    for (const s of w.ships) {
      if (!s.alive || s.docked) continue;
      if (s === w.player && this.mode === 'title') continue;
      const mesh = this.shipMeshes.get(s.kind);
      if (!mesh) continue;
      const roll = s.landed ? 0 : clamp(-s.angVel * 0.22 + s.strafing * 0.3, -0.6, 0.6);
      const y = s.landed ? 0.3 : 0.0;
      mat4TRS(m, s.pos.x, y, -s.pos.y, s.angle, 0, roll, 1, 1, 1);
      const hitFlash = w.time - s.lastDamageTime < 0.08 ? 1 : 0;
      const inv = s.invuln > 0 ? 0.5 + 0.5 * Math.sin(w.time * 30) : 0;
      mesh.add(m, 1 + hitFlash, 1 + hitFlash + inv * 0.3, 1 + hitFlash + inv * 0.6, hitFlash * 0.8);
    }
    for (const p of w.pickups) {
      if (!p.alive) continue;
      const mesh = this.pickupMeshes.get(p.kind);
      if (!mesh) continue;
      mat4TRS(m, p.pos.x, 0, -p.pos.y, w.time * p.spin, 0, p.kind === 'pod' || p.kind === 'wreck' ? 0 : w.time * 0.7, 1, 1, 1);
      mesh.add(m, 1, 1, 1, p.kind === 'module' ? 0.5 + 0.4 * Math.sin(w.time * 5) : 0);
    }
    for (const st of w.stations) {
      const mesh = this.stationMeshes.get(st.id);
      if (!mesh || !st.alive) continue;
      mat4TRS(m, st.pos.x, 0, -st.pos.y, st.angle, 0, 0, 1, 1, 1);
      const hit = st.siege > 0 ? 0.3 + 0.3 * Math.sin(w.time * 8) : 0;
      mesh.add(m, 1 + hit, 1, 1, 0);
    }
    this.meshes.flush(cam.viewProj, [star.pos.x, 0, -star.pos.y], [cam.eye[0], cam.eye[1], cam.eye[2]], 0.22);

    // ---- vector layer
    this.post.beginVector();
    this.worldLines.clear();
    this.hudLines.clear();
    if (this.mode === 'flight' || this.mode === 'gameover') this.drawWorldVectors();
    if (this.mode === 'flight' || this.mode === 'pause' || (this.mode === 'help' && this.helpReturn === 'flight')) {
      if (w.player.alive) drawFlightHud(this);
      else drawDeath(this);
    }
    switch (this.mode) {
      case 'title': drawTitle(this); break;
      case 'docked': drawDocked(this); break;
      case 'map': drawMap(this); break;
      case 'help': drawHelp(this); break;
      case 'gameover': drawGameOver(this); break;
      case 'pause': drawPause(this); break;
      default: break;
    }
    this.lines.draw(this.worldLines, cam.viewProj, cam.viewportW, cam.viewportH);
    this.particles.draw(cam.viewProj, cam.projScale);
    this.lines.draw(this.hudLines, this.ortho, cam.viewportW, cam.viewportH);

    // ---- post
    this.post.flicker = 0.97 + Math.random() * 0.05;
    const targetFade = 1 - this.overlayDim;
    this.fade = damp(this.fade, targetFade, 12, dt);
    this.post.fade = this.fade * (w.flare.active ? 1 + 0.25 * w.flare.intensity : 1);
    // world-space vector lines (limbs, pads, HUD in the world) share the vector layer with the overlay text,
    // so they are drawn dimmer by hand: overlays clear the world-line batch instead
    this.post.vecFade = 1;
    this.post.finish(w.time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.renderTime = performance.now();
  }

  private drawWorldVectors(): void {
    const w = this.world;
    const L = this.worldLines;
    const p = w.player;
    const upp = this.camera.unitsPerPixel();

    // planet limbs and pads
    for (const b of w.bodies) {
      if (b.kind === 'star') {
        const n = 36;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * TAU + w.time * 0.02;
          const r0 = b.radius * 1.02, r1 = b.radius * (1.12 + 0.06 * Math.sin(w.time * 1.7 + i * 2.1)) * (w.flare.active ? 1.3 : 1);
          L.seg(b.pos.x + Math.cos(a) * r0, 0, -(b.pos.y + Math.sin(a) * r0), b.pos.x + Math.cos(a) * r1, 0, -(b.pos.y + Math.sin(a) * r1), 1.4, 0.9, 0.4, 0.5, 1.5);
        }
        // heat haze: faint rings out to the danger radius so the star is felt before it is seen
        for (let k = 1; k <= 3; k++) {
          const r = b.radius * (1 + k * 0.3) + Math.sin(w.time * 0.8 + k) * 3;
          L.circleWorld(b.pos.x, 0.05, -b.pos.y, r, 64, 1.2, 0.6, 0.2, 0.16 / k, 1.2);
        }
        continue;
      }
      const pal = b.palette.high;
      const isFault = b.name === 'THE FAULT';
      const alpha = isFault ? 0.6 : 0.28;
      L.circleWorld(b.pos.x, 0.05, -b.pos.y, b.radius, Math.min(96, b.segments), isFault ? 0.8 : pal[0], isFault ? 0.4 : pal[1], isFault ? 1 : pal[2], alpha, 1.2);
      if (isFault) {
        // pulsing rings to warn about the well
        for (let k = 1; k <= 3; k++) {
          const r = b.radius * (1 + k * 1.5) + Math.sin(w.time * 2 - k) * 3;
          L.circleWorld(b.pos.x, 0.05, -b.pos.y, r, 48, 0.8, 0.4, 1, 0.25 / k, 1);
        }
      }
      // name label when zoomed out
      if (upp > 0.45 && b.kind !== 'moon') drawTextWorld(L, b.name, b.pos.x, 0.3, -(b.pos.y - b.radius - upp * 14), upp * 10, pal[0], pal[1], pal[2], 0.55, 'center', 1.2);
      for (const pad of b.pads) {
        const col = padColor(pad.kind, pad.alive);
        const seg = b.segments;
        const a0 = (pad.segIndex / seg) * TAU, a1 = ((pad.segIndex + 1) / seg) * TAU;
        const r0 = b.terrain[pad.segIndex], r1 = b.terrain[(pad.segIndex + 1) % seg];
        const x0 = b.pos.x + Math.cos(a0) * r0, y0 = b.pos.y + Math.sin(a0) * r0;
        const x1 = b.pos.x + Math.cos(a1) * r1, y1 = b.pos.y + Math.sin(a1) * r1;
        const blink = 0.55 + 0.45 * Math.sin(w.time * 3 + pad.id);
        L.seg(x0, 0.3, -y0, x1, 0.3, -y1, col[0], col[1], col[2], 0.9, 2.2);
        const n = terrainNormalAt(b, pad.angle);
        for (const [x, y] of [[x0, y0], [x1, y1]]) {
          L.seg(x, 0.3, -y, x + n.x * 1.6, 0.3, -(y + n.y * 1.6), col[0], col[1], col[2], blink, 1.5);
        }
        if (pad.kind === 'enemybase' || pad.kind === 'core') {
          // base structure: a hostile glyph and health ring
          const cx = b.pos.x + Math.cos(pad.angle) * (pad.height + 2), cy = b.pos.y + Math.sin(pad.angle) * (pad.height + 2);
          if (pad.alive) {
            L.circleWorld(cx, 0.3, -cy, pad.kind === 'core' ? 5 : 3.2, 8, col[0], col[1], col[2], 0.5 + 0.3 * Math.sin(w.time * 6), 1.5);
            if (pad.kind === 'core') L.circleWorld(cx, 0.3, -cy, 8 + Math.sin(w.time * 3) * 1.5, 12, 1, 0.3, 0.6, 0.35, 1.2);
          }
        }
        if (upp < 0.35) {
          const lx = b.pos.x + Math.cos(pad.angle) * (pad.height + 9), ly = b.pos.y + Math.sin(pad.angle) * (pad.height + 9);
          const label = pad.kind === 'colony' ? `${pad.name} ${pad.population}` : pad.kind === 'mine' ? `${pad.name} ORE ${pad.stock}` : pad.kind === 'enemybase' || pad.kind === 'core' ? `${pad.name} ${pad.alive ? Math.ceil(pad.enemyHealth) : 'DESTROYED'}` : pad.name;
          drawTextWorld(L, label, lx, 0.3, -ly, upp * 11, col[0], col[1], col[2], 0.8, 'center', 1.2);
        }
      }
    }

    // ai thrust flames
    for (const s of w.ships) {
      if (!s.alive || s === p || s.docked || s.thrusting <= 0) continue;
      const cx = Math.cos(s.angle), cy = Math.sin(s.angle);
      const len = (s.boosting ? 4 : 1.5 + s.thrusting) * s.radius * (0.8 + Math.random() * 0.4);
      const col = s.faction === 'enemy' ? [1.0, 0.4, 0.3] : [0.8, 0.9, 1.0];
      const ex = s.pos.x - cx * s.radius * 0.9, ey = s.pos.y - cy * s.radius * 0.9;
      L.seg(ex, 0, -ey, ex - cx * len, 0, -(ey - cy * len), col[0], col[1], col[2], 0.8, 2);
    }

    // player: marker, thrust, trajectory, gravity
    if (p.alive && !p.docked) {
      const cx = Math.cos(p.angle), cy = Math.sin(p.angle);
      {
        const ms = Math.max(2.4, upp * 13);
        const nx = p.pos.x + cx * ms, ny = p.pos.y + cy * ms;
        const lx = p.pos.x - cx * ms * 0.7 - cy * ms * 0.75, ly = p.pos.y - cy * ms * 0.7 + cx * ms * 0.75;
        const rx = p.pos.x - cx * ms * 0.7 + cy * ms * 0.75, ry = p.pos.y - cy * ms * 0.7 - cx * ms * 0.75;
        const a = clamp((upp - 0.12) * 4, 0.15, 0.7);
        L.seg(nx, 0.4, -ny, lx, 0.4, -ly, 0.6, 0.95, 1.0, a, 1.3);
        L.seg(nx, 0.4, -ny, rx, 0.4, -ry, 0.6, 0.95, 1.0, a, 1.3);
        L.seg(lx, 0.4, -ly, p.pos.x - cx * ms * 0.45, 0.4, -(p.pos.y - cy * ms * 0.45), 0.6, 0.95, 1.0, a, 1.3);
        L.seg(rx, 0.4, -ry, p.pos.x - cx * ms * 0.45, 0.4, -(p.pos.y - cy * ms * 0.45), 0.6, 0.95, 1.0, a, 1.3);
      }
      if (p.thrusting > 0 && p.fuel > 0) {
        const len = (p.boosting ? 5.5 : 2.2 + p.thrusting * 1.4) * (0.8 + Math.random() * 0.4);
        for (const side of [-0.45, 0.45]) {
          const ex = p.pos.x - cx * 1.1 - cy * side, ey = p.pos.y - cy * 1.1 + cx * side;
          const col = p.boosting ? [0.6, 0.8, 1.0] : [1.0, 0.75, 0.35];
          L.seg(ex, 0, -ey, ex - cx * len, 0, -(ey - cy * len), col[0], col[1], col[2], 0.9, 2.5);
          if (this.mode === 'flight') this.particles.spawn(ex, 0, -ey, -cx * len * 6 + p.vel.x + (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2, cy * len * 6 - p.vel.y + (Math.random() - 0.5) * 4, 0.25 + Math.random() * 0.2, col[0], col[1] * 0.8, col[2] * 0.5, 0.35, 3);
        }
      }
      if (p.retroing > 0 && p.fuel > 0) {
        const ex = p.pos.x + cx * 1.0, ey = p.pos.y + cy * 1.0;
        L.seg(ex, 0, -ey, ex + cx * 1.4, 0, -(ey + cy * 1.4), 1, 0.8, 0.4, 0.8, 2);
      }
      if (p.strafing !== 0 && p.fuel > 0) {
        const sx = cy * p.strafing, sy = -cx * p.strafing;
        const ex = p.pos.x - sx * 0.9, ey = p.pos.y - sy * 0.9;
        L.seg(ex, 0, -ey, ex - sx * 1.3, 0, -(ey - sy * 1.3), 1, 0.8, 0.4, 0.8, 2);
      }
      if (!p.landed) {
        predictTrajectory(w, p.pos.x, p.pos.y, p.vel.x, p.vel.y, p.stats.gravMul, 9, 1 / 20, this.trajectory);
        const T = this.trajectory;
        let px = p.pos.x, py = p.pos.y;
        for (let i = 0; i < T.count; i++) {
          const x = T.pts[i * 2], y = T.pts[i * 2 + 1];
          if (i % 3 === 0) {
            const f = 1 - i / T.count;
            const mx = (px + x) / 2, my = (py + y) / 2;
            L.seg(mx, 0.1, -my, x, 0.1, -y, 0.5, 0.9, 1.0, 0.16 + 0.45 * f, 1.6);
          }
          px = x; py = y;
        }
        if (T.impact) {
          const s = upp * 7;
          const c = T.impactBody?.kind === 'gas' ? [0.5, 0.8, 1.0] : T.impactBody?.kind === 'star' ? [1, 0.6, 0.2] : T.impactSpeed > LAND_VN * p.stats.landTol ? [1, 0.35, 0.3] : [0.5, 1, 0.6];
          L.seg(T.impactX - s, 0.2, -(T.impactY - s), T.impactX + s, 0.2, -(T.impactY + s), c[0], c[1], c[2], 0.9, 1.5);
          L.seg(T.impactX - s, 0.2, -(T.impactY + s), T.impactX + s, 0.2, -(T.impactY - s), c[0], c[1], c[2], 0.9, 1.5);
        }
        const g: V2 = { x: 0, y: 0 };
        const gm = gravityAt(w, p.pos.x, p.pos.y, g) * p.stats.gravMul;
        if (gm > 0.05) {
          const len = Math.min(18, 2 + gm * 2.2) * upp * 6;
          const gx = g.x / gm * p.stats.gravMul, gy = g.y / gm * p.stats.gravMul;
          const ax = p.pos.x + gx * (2.2 * upp * 6), ay = p.pos.y + gy * (2.2 * upp * 6);
          const bx = p.pos.x + gx * len, by = p.pos.y + gy * len;
          const col = gm > p.stats.thrust * 0.8 ? [1, 0.4, 0.6] : [0.85, 0.45, 1.0];
          L.seg(ax, 0.1, -ay, bx, 0.1, -by, col[0], col[1], col[2], 0.85, 1.6);
          const hx = -gy, hy = gx;
          const hs = 1.2 * upp * 6;
          L.seg(bx, 0.1, -by, bx - gx * hs + hx * hs * 0.7, 0.1, -(by - gy * hs + hy * hs * 0.7), col[0], col[1], col[2], 0.85, 1.6);
          L.seg(bx, 0.1, -by, bx - gx * hs - hx * hs * 0.7, 0.1, -(by - gy * hs - hy * hs * 0.7), col[0], col[1], col[2], 0.85, 1.6);
        }
        // course line to the nav target
        if (this.navTarget) {
          const np = navPos(this.navTarget);
          const dx = np.x - p.pos.x, dy = np.y - p.pos.y;
          const d = Math.hypot(dx, dy) || 1;
          const ux = dx / d, uy = dy / d;
          const start = Math.max(3, upp * 20);
          for (let k = 0; k < 6; k++) {
            const r0 = start + k * upp * 14, r1 = r0 + upp * 6;
            if (r1 > d) break;
            L.seg(p.pos.x + ux * r0, 0.1, -(p.pos.y + uy * r0), p.pos.x + ux * r1, 0.1, -(p.pos.y + uy * r1), 1, 1, 1, 0.35 - k * 0.04, 1.2);
          }
        }
      }
    }

    // projectiles
    for (const pr of w.projectiles) {
      const sp = Math.hypot(pr.vel.x, pr.vel.y) || 1;
      const len = Math.min(3.5, sp * 0.03);
      const dx = pr.vel.x / sp * len, dy = pr.vel.y / sp * len;
      L.seg(pr.pos.x - dx, 0.1, -(pr.pos.y - dy), pr.pos.x + dx * 0.3, 0.1, -(pr.pos.y + dy * 0.3), pr.color[0], pr.color[1], pr.color[2], 1, pr.kind === 'mass' ? 3.5 : pr.kind === 'seeker' ? 3 : 2.2);
      if (pr.kind === 'seeker') this.particles.spawn(pr.pos.x, 0.1, -pr.pos.y, 0, 0, 0, 0.3, 1, 0.6, 0.9, 0.3, 0);
    }
    // explosion rings
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const e = this.fx[i];
      const t = (w.time - e.t0) / (0.35 + e.size * 0.15);
      if (t >= 1) { this.fx.splice(i, 1); continue; }
      const r = (0.5 + t * 6) * e.size;
      const a = (1 - t) * 0.9;
      L.circleWorld(e.x, 0.2, -e.y, r, 20, e.color[0], e.color[1], e.color[2], a, 2);
    }
    // pickups: subtle vector halo and labels for special ones
    for (const pk of w.pickups) {
      if (!pk.alive) continue;
      if (pk.kind === 'module') { L.circleWorld(pk.pos.x, 0.2, -pk.pos.y, 2 + Math.sin(w.time * 4) * 0.4, 12, 1, 0.9, 0.4, 0.6, 1.3); if (upp < 0.4) drawTextWorld(L, pk.name, pk.pos.x, 0.3, -(pk.pos.y + 4), upp * 10, 1, 0.9, 0.4, 0.8); }
      else if (pk.kind === 'pod') L.circleWorld(pk.pos.x, 0.2, -pk.pos.y, 1.6, 10, 0.5, 1, 0.6, 0.5 + 0.3 * Math.sin(w.time * 6), 1.2);
      else if (pk.kind === 'wreck') L.circleWorld(pk.pos.x, 0.2, -pk.pos.y, 4, 12, 0.6, 0.85, 0.6, 0.3, 1);
    }
    // stranded shuttle marker
    for (const s of w.ships) {
      if (!s.alive || s.faction !== 'civ') continue;
      if (s.ai?.mode === 'drift') L.circleWorld(s.pos.x, 0.2, -s.pos.y, 3 + Math.sin(w.time * 5), 12, 1, 0.95, 0.5, 0.6, 1.3);
    }
  }
}

function nearestEnemyShip(w: World, range: number): Ship | null {
  const p = w.player;
  let best: Ship | null = null, bd = range;
  for (const s of w.ships) {
    if (!s.alive || s.faction !== 'enemy' || s.docked) continue;
    const d = Math.hypot(s.pos.x - p.pos.x, s.pos.y - p.pos.y);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** Background stars: a wide, deep point cloud far below the sim plane so it parallaxes slowly. */
function makeStarfield(seed: number): Float32Array {
  const rng = new Rng(seed);
  const n = 2600;
  const out = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    const depth = 900 + rng.next() * 2200;
    const spread = 9000 + depth * 2.5;
    out[o] = (rng.next() - 0.5) * spread;
    out[o + 1] = -depth;
    out[o + 2] = (rng.next() - 0.5) * spread;
    const t = rng.next();
    const bright = 0.2 + Math.pow(rng.next(), 3) * 0.8;
    const warm = t < 0.2;
    out[o + 3] = bright * (warm ? 1.0 : 0.75);
    out[o + 4] = bright * (warm ? 0.85 : 0.8);
    out[o + 5] = bright * (warm ? 0.6 : 1.0);
    out[o + 6] = 1;
    out[o + 7] = (1.2 + rng.next() * 2.0) * depth / 300;
  }
  return out;
}

export function padColor(kind: string, alive: boolean): number[] {
  if (!alive) return [0.45, 0.4, 0.4];
  switch (kind) {
    case 'colony': return [0.4, 0.95, 1.0];
    case 'mine': return [1.0, 0.7, 0.3];
    case 'derelict': return [0.6, 0.85, 0.6];
    case 'enemybase': return [1.0, 0.3, 0.3];
    case 'outpost': return [0.7, 0.8, 1.0];
    case 'core': return [1.0, 0.2, 0.5];
  }
  return [1, 1, 1];
}

export { applyUpgrades };
export type { Ship, Body };
