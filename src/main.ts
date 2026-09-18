import { Game } from './game/game';
import { SIM_DT } from './sim/world';
import { hashString } from './engine/math';
import type { Controls } from './engine/input';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
let game: Game;
try {
  game = new Game(canvas);
} catch (e) {
  document.body.innerHTML = `<pre style="color:#f88;font:14px monospace;padding:20px;white-space:pre-wrap">STARFALL could not start.\n\n${(e as Error).message}\n\nThis game needs a browser with WebGL2.</pre>`;
  throw e;
}
canvas.focus();

// Test harness (used by playtest scripts). Harmless for players.
const harness = {
  game,
  step(n: number): void { for (let i = 0; i < n; i++) game.simTick(SIM_DT); },
  manual(on: boolean): void { game.manual = on; },
  controls(c: Partial<Controls> | null): void {
    if (!c) { game.input.override = null; return; }
    game.input.override = { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false, ...c };
  },
  press(code: string): void { game.input.overridePressed.add(code); },
  mode(m: string): void { game.mode = m as typeof game.mode; },
  /** Skip the title and station: put the player in flight just outside the harbour. */
  launch(): void { game.mode = 'docked'; game.launch(); },
  nav(name: string): void {
    const w = game.world;
    const st = w.stations.find(s => s.name === name);
    const b = w.bodies.find(s => s.name === name);
    game.navTarget = st ? { name, station: st } : b ? { name, body: b } : null;
  },
  newGame(seed: string | number): void { game.newGame(typeof seed === 'number' ? seed : hashString(seed), String(seed)); },
  state(): unknown {
    const w = game.world;
    const p = w.player;
    return {
      time: w.time,
      tick: w.tick,
      player: {
        x: p.pos.x, y: p.pos.y, vx: p.vel.x, vy: p.vel.y, angle: p.angle, hull: p.hull, fuel: p.fuel,
        alive: p.alive, landed: p.landed ? { body: p.landed.body.name, pad: p.landed.pad?.name ?? null } : null,
        docked: p.docked ? p.docked.name : null, speed: Math.hypot(p.vel.x, p.vel.y),
        cargo: p.cargo, heat: p.heat, lastDamageSource: p.lastDamageSource,
      },
      bodies: w.bodies.map(b => ({ name: b.name, kind: b.kind, x: b.pos.x, y: b.pos.y, r: b.radius, pads: b.pads.map(pd => ({ name: pd.name, kind: pd.kind, angle: pd.angle, alive: pd.alive, pop: pd.population })) })),
      stations: w.stations.map(s => ({ name: s.name, x: s.pos.x, y: s.pos.y, angle: s.angle, alive: s.alive })),
      ships: w.ships.filter(s => s.alive).map(s => ({ kind: s.kind, faction: s.faction, x: s.pos.x, y: s.pos.y, hull: s.hull, mode: s.ai?.mode ?? null })),
      asteroids: w.asteroids.length,
      projectiles: w.projectiles.length,
      pickups: w.pickups.filter(p => p.alive).map(p => ({ kind: p.kind, x: p.pos.x, y: p.pos.y })),
      events: w.events.map(e => ({ kind: e.kind, label: e.label, timer: e.timer, resolved: e.resolved, failed: e.failed, phase: e.phase })),
      comms: w.comms.slice(-8).map(c => `${c.from}: ${c.text}`),
      score: w.score, credits: w.credits, lives: w.lives, threat: w.threat, kills: w.kills, gameOver: w.gameOver,
      frameTime: game.frameTime, frameCount: game.frameCount,
      cam: { x: game.camPos.x, y: game.camPos.y, h: game.camHeight },
      mode: game.mode,
      nav: game.navTarget?.name ?? null,
      pads: w.pads.map(pd => ({ name: pd.name, kind: pd.kind, body: pd.body.name, alive: pd.alive, pop: pd.population, stock: pd.stock, hp: pd.enemyHealth })),
    };
  },
};
(window as unknown as { __sf: typeof harness }).__sf = harness;

game.start();
