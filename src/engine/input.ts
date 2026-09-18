// Keyboard, mouse and gamepad input. Raw state plus a composed Controls struct for the sim.

export interface Controls {
  turn: number;    // -1..1, positive = counter-clockwise (left)
  thrust: number;  // 0..1
  retro: number;   // 0..1
  strafe: number;  // -1..1, positive = starboard (right of heading)
  fire: boolean;
  boost: boolean;
}

export function emptyControls(): Controls {
  return { turn: 0, thrust: 0, retro: 0, strafe: 0, fire: false, boost: false };
}

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  released = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  mouseDX = 0;
  mouseDY = 0;
  mouseButtons = 0;
  mousePressed = 0;
  mouseMovedAt = -1e9; // ms timestamp of last mouse move
  wheel = 0;
  typed: string[] = [];
  gamepadIndex = -1;
  gpButtons: number[] = [];
  gpAxes: number[] = [];
  gpPrevButtons: number[] = [];
  anyInputAt = 0;
  /** When set, the sim reads these controls instead of the composed ones (test harness). */
  override: Controls | null = null;
  overridePressed = new Set<string>();

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', e => {
      if (e.repeat) { if (isGameKey(e.code)) e.preventDefault(); return; }
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this.anyInputAt = performance.now();
      if (e.key.length === 1) this.typed.push(e.key);
      if (isGameKey(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => {
      this.keys.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouseButtons = 0; });
    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      const nx = e.clientX - r.left, ny = e.clientY - r.top;
      this.mouseDX += nx - this.mouseX; this.mouseDY += ny - this.mouseY;
      this.mouseX = nx; this.mouseY = ny;
      this.mouseMovedAt = performance.now();
    });
    canvas.addEventListener('mousedown', e => {
      this.mouseButtons |= (1 << e.button);
      this.mousePressed |= (1 << e.button);
      this.anyInputAt = performance.now();
      canvas.focus();
      e.preventDefault();
    });
    window.addEventListener('mouseup', e => { this.mouseButtons &= ~(1 << e.button); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => { this.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
    window.addEventListener('gamepadconnected', e => { this.gamepadIndex = (e as GamepadEvent).gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = -1; });
  }

  pollGamepad(): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    if (this.gamepadIndex >= 0) gp = pads[this.gamepadIndex] ?? null;
    if (!gp) { for (const p of pads) if (p) { gp = p; this.gamepadIndex = p.index; break; } }
    this.gpPrevButtons = this.gpButtons;
    if (!gp) { this.gpButtons = []; this.gpAxes = []; return; }
    this.gpButtons = gp.buttons.map(b => b.value);
    this.gpAxes = Array.from(gp.axes);
    for (let i = 0; i < this.gpButtons.length; i++) {
      if (this.gpButtons[i] > 0.5 && !((this.gpPrevButtons[i] ?? 0) > 0.5)) {
        this.pressed.add('GP' + i);
        this.anyInputAt = performance.now();
      }
    }
    for (const a of this.gpAxes) if (Math.abs(a) > 0.3) this.anyInputAt = performance.now();
  }

  down(code: string): boolean { return this.keys.has(code); }
  /** Consume a press so later handlers in the same frame do not react to it. */
  consume(code: string): void { this.pressed.delete(code); this.overridePressed.delete(code); }
  /** Edge-triggered: true on the frame the key went down. Also accepts test-harness injections. */
  wasPressed(code: string): boolean { return this.pressed.has(code) || this.overridePressed.has(code); }
  gpButton(i: number): number { return this.gpButtons[i] ?? 0; }
  gpAxis(i: number): number { const v = this.gpAxes[i] ?? 0; return Math.abs(v) < 0.15 ? 0 : v; }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.overridePressed.clear();
    this.mousePressed = 0;
    this.wheel = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.typed.length = 0;
  }

  /** Compose flight controls from keyboard and gamepad (mouse steering is added by the game). */
  controls(): Controls {
    if (this.override) return this.override;
    const c = emptyControls();
    let turn = 0;
    if (this.down('KeyA') || this.down('ArrowLeft')) turn += 1;
    if (this.down('KeyD') || this.down('ArrowRight')) turn -= 1;
    turn -= this.gpAxis(0);
    c.turn = Math.max(-1, Math.min(1, turn));
    let thrust = (this.down('KeyW') || this.down('ArrowUp')) ? 1 : 0;
    thrust = Math.max(thrust, this.gpButton(7), this.gpButton(0) > 0.5 ? 0 : 0, -this.gpAxis(1));
    c.thrust = Math.min(1, thrust);
    let retro = (this.down('KeyS') || this.down('ArrowDown')) ? 1 : 0;
    retro = Math.max(retro, this.gpButton(6), this.gpAxis(1));
    c.retro = Math.min(1, retro);
    let strafe = 0;
    if (this.down('KeyE')) strafe += 1;
    if (this.down('KeyQ')) strafe -= 1;
    if (this.gpButton(5) > 0.5) strafe += 1;
    if (this.gpButton(4) > 0.5) strafe -= 1;
    c.strafe = Math.max(-1, Math.min(1, strafe));
    c.fire = this.down('Space') || this.down('ControlLeft') || this.down('ControlRight') || (this.mouseButtons & 1) !== 0 || this.gpButton(0) > 0.5 || this.gpButton(2) > 0.5;
    c.boost = this.down('ShiftLeft') || this.down('ShiftRight') || (this.mouseButtons & 2) !== 0 || this.gpButton(1) > 0.5;
    return c;
  }
}

function isGameKey(code: string): boolean {
  return code === 'Space' || code === 'Tab' || code.startsWith('Arrow') || code === 'ShiftLeft' || code === 'ShiftRight';
}
