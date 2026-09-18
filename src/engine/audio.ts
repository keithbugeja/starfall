// Procedural WebAudio: thrust, weapons, explosions, warnings, docking, UI, comms, a restrained drone,
// and a gravity hum that rises with the local field. No samples. Everything is synthesised.
import { clamp } from './math';
import type { AudioEvent, World } from '../sim/world';

export class AudioSystem {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private thrustGain!: GainNode;
  private thrustFilter!: BiquadFilterNode;
  private droneGain!: GainNode;
  private droneFilter!: BiquadFilterNode;
  private humOsc!: OscillatorNode;
  private humGain!: GainNode;
  private alarmUntil = 0;
  private lastCommAt = -10;
  private lastHitAt = -10;
  private lastScoopAt = -10;
  enabled = false;
  volume = 0.8;
  muted = false;

  /** Must be called from a user gesture. */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp);
      comp.connect(ctx.destination);
      // noise buffer
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      // thrust loop
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      this.thrustFilter = ctx.createBiquadFilter();
      this.thrustFilter.type = 'bandpass'; this.thrustFilter.frequency.value = 380; this.thrustFilter.Q.value = 0.8;
      this.thrustGain = ctx.createGain(); this.thrustGain.gain.value = 0;
      src.connect(this.thrustFilter); this.thrustFilter.connect(this.thrustGain); this.thrustGain.connect(this.master);
      src.start();
      // drone
      this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0;
      this.droneFilter = ctx.createBiquadFilter(); this.droneFilter.type = 'lowpass'; this.droneFilter.frequency.value = 160; this.droneFilter.Q.value = 2;
      for (const [f, type] of [[55, 'sawtooth'], [55.6, 'triangle'], [82.5, 'triangle']] as [number, OscillatorType][]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = 0.3;
        o.connect(g); g.connect(this.droneFilter); o.start();
      }
      this.droneFilter.connect(this.droneGain); this.droneGain.connect(this.master);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05;
      const lfoG = ctx.createGain(); lfoG.gain.value = 60;
      lfo.connect(lfoG); lfoG.connect(this.droneFilter.frequency); lfo.start();
      // gravity hum
      this.humOsc = ctx.createOscillator(); this.humOsc.type = 'sine'; this.humOsc.frequency.value = 45;
      this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
      this.humOsc.connect(this.humGain); this.humGain.connect(this.master); this.humOsc.start();
      this.enabled = true;
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  private noise(dur: number, gain: number, filterType: BiquadFilterType, f0: number, f1: number, q = 1, pan = 0, when = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    src.connect(flt); flt.connect(g); g.connect(p); p.connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, pan = 0, when = 0, attack = 0.005): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    o.connect(g); g.connect(p); p.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /** Consume the world's audio events and update continuous sounds. */
  update(w: World, dt: number, gMag: number, listenerX: number, listenerY: number): void {
    if (!this.enabled || !this.ctx) { w.audioEvents.length = 0; return; }
    const ctx = this.ctx;
    const p = w.player;
    const now = ctx.currentTime;
    // thrust
    const thr = p.alive && !p.docked && p.fuel > 0 ? (p.boosting ? 1.0 : p.thrusting * 0.7 + Math.abs(p.strafing) * 0.3 + p.retroing * 0.3) : 0;
    const target = Math.min(1, thr) * 0.22;
    this.thrustGain.gain.setTargetAtTime(target, now, 0.05);
    this.thrustFilter.frequency.setTargetAtTime(p.boosting ? 900 : 380 + p.thrusting * 120, now, 0.1);
    // drone: quieter while docked, gone at title
    this.droneGain.gain.setTargetAtTime(p.docked ? 0.05 : 0.09, now, 1.5);
    // gravity hum: pitch and volume follow the field
    const g = clamp(gMag / 8, 0, 1);
    this.humGain.gain.setTargetAtTime(p.docked || p.landed ? 0 : g * 0.13, now, 0.2);
    this.humOsc.frequency.setTargetAtTime(38 + g * 50, now, 0.3);
    // heat / low fuel / hull alarms
    const alarm = p.alive && !p.docked && (p.hull < p.hullMax * 0.25 || (p.fuel < p.fuelMax * 0.12 && p.fuel > 0));
    if (alarm && now > this.alarmUntil) { this.tone('square', 660, 660, 0.09, 0.05); this.tone('square', 520, 520, 0.09, 0.05, 0, 0.14); this.alarmUntil = now + 1.4; }
    for (const e of w.audioEvents) this.play(e, listenerX, listenerY);
    w.audioEvents.length = 0;
    void dt;
  }

  private play(e: AudioEvent, lx: number, ly: number): void {
    const ctx = this.ctx!;
    let vol = e.volume;
    let pan = 0;
    if (e.pos) {
      const dx = e.pos.x - lx, dy = e.pos.y - ly;
      const d = Math.hypot(dx, dy);
      vol *= clamp(1 - d / 420, 0, 1);
      pan = clamp(dx / 250, -0.8, 0.8);
      if (vol < 0.02) return;
    }
    const now = ctx.currentTime;
    switch (e.kind) {
      case 'fire_pulse': this.tone('square', 900, 260, 0.09, 0.09 * vol, pan); break;
      case 'fire_scatter': this.noise(0.12, 0.18 * vol, 'bandpass', 1800, 400, 1, pan); this.tone('square', 600, 200, 0.08, 0.06 * vol, pan); break;
      case 'fire_rail': this.tone('sine', 2400, 300, 0.28, 0.12 * vol, pan); this.noise(0.15, 0.1 * vol, 'highpass', 3000, 800, 1, pan); break;
      case 'fire_mass': this.tone('sine', 140, 40, 0.25, 0.25 * vol, pan); this.noise(0.2, 0.2 * vol, 'lowpass', 900, 100, 1, pan); break;
      case 'fire_seeker': this.tone('sawtooth', 300, 1200, 0.35, 0.08 * vol, pan); break;
      case 'fire_lance': this.tone('sawtooth', 700, 320, 0.11, 0.06 * vol, pan); break;
      case 'explode': this.noise(0.55, 0.5 * vol, 'lowpass', 2600, 90, 0.7, pan); this.tone('sine', 90, 28, 0.4, 0.3 * vol, pan); break;
      case 'bigboom': this.noise(1.4, 0.7 * vol, 'lowpass', 1800, 60, 0.7, pan); this.tone('sine', 70, 20, 1.2, 0.4 * vol, pan); this.noise(0.3, 0.3 * vol, 'highpass', 2000, 4000, 1, pan, 0.1); break;
      case 'rockbreak': this.noise(0.3, 0.35 * vol, 'lowpass', 1400, 200, 0.8, pan); this.tone('triangle', 160, 60, 0.15, 0.1 * vol, pan); break;
      case 'rockhit': this.noise(0.08, 0.2 * vol, 'bandpass', 900, 300, 1, pan); break;
      case 'hit': this.noise(0.06, 0.2 * vol, 'bandpass', 2200, 600, 1.5, pan); break;
      case 'hitme': if (now - this.lastHitAt > 0.08) { this.lastHitAt = now; this.noise(0.12, 0.45, 'lowpass', 1200, 200, 1); this.tone('square', 220, 160, 0.1, 0.08); } break;
      case 'impact': { const k = clamp(e.param / 15, 0.2, 1); this.noise(0.25 + k * 0.3, 0.5 * vol * (0.4 + k), 'lowpass', 600 + k * 800, 80, 1, pan); this.tone('sine', 60, 30, 0.2, 0.2 * k * vol, pan); break; }
      case 'land': this.noise(0.15, 0.25, 'lowpass', 500, 120, 1); this.tone('sine', 520, 390, 0.25, 0.08, 0, 0.1); this.tone('sine', 390, 390, 0.3, 0.08, 0, 0.3); break;
      case 'launch': this.tone('sawtooth', 120, 420, 0.5, 0.06); this.noise(0.5, 0.2, 'bandpass', 200, 900, 0.8); break;
      case 'dock': this.tone('sine', 523, 523, 0.18, 0.1); this.tone('sine', 659, 659, 0.18, 0.1, 0, 0.18); this.tone('sine', 784, 784, 0.36, 0.1, 0, 0.36); break;
      case 'success': this.tone('square', 523, 523, 0.1, 0.06); this.tone('square', 659, 659, 0.1, 0.06, 0, 0.11); this.tone('square', 784, 784, 0.1, 0.06, 0, 0.22); this.tone('square', 1047, 1047, 0.25, 0.06, 0, 0.33); break;
      case 'comm': if (now - this.lastCommAt > 0.3) { this.lastCommAt = now; this.tone('square', 1300, 1300, 0.04, 0.04); this.tone('square', 1700, 1700, 0.04, 0.04, 0, 0.07); } break;
      case 'alert': this.tone('square', 880, 880, 0.12, 0.07); this.tone('square', 660, 660, 0.12, 0.07, 0, 0.15); this.tone('square', 880, 880, 0.12, 0.07, 0, 0.3); break;
      case 'alarm': for (let i = 0; i < 3; i++) this.tone('sawtooth', 500, 900, 0.25, 0.06, 0, i * 0.3); break;
      case 'pickup': this.tone('sine', 700, 1400, 0.12, 0.08, pan); if (e.param === 1) this.tone('sine', 1000, 1600, 0.15, 0.06, pan, 0.12); break;
      case 'module': for (let i = 0; i < 5; i++) this.tone('triangle', 440 * Math.pow(1.26, i), 440 * Math.pow(1.26, i), 0.2, 0.07, 0, i * 0.09); break;
      case 'overheat': this.tone('square', 200, 120, 0.4, 0.1); break;
      case 'scoop': if (now - this.lastScoopAt > 0.25) { this.lastScoopAt = now; this.noise(0.3, 0.12, 'bandpass', 500, 1200, 1); } break;
      case 'flare': this.noise(2.5, 0.35, 'lowpass', 200, 1800, 0.5); this.tone('sawtooth', 40, 90, 2.5, 0.1); break;
      case 'ui': this.tone('square', 1200, 1200, 0.03, 0.05); break;
      case 'uimove': this.tone('square', 800, 800, 0.025, 0.04); break;
      case 'buy': this.tone('sine', 600, 900, 0.1, 0.08); this.tone('sine', 900, 1200, 0.12, 0.08, 0, 0.1); break;
      case 'deny': this.tone('square', 220, 180, 0.15, 0.07); break;
      case 'death': this.noise(1.8, 0.7, 'lowpass', 2000, 50, 0.7); this.tone('sawtooth', 200, 25, 1.6, 0.2); break;
      case 'warp': this.tone('sine', 200, 1600, 0.6, 0.1); break;
      case 'ping': this.tone('sine', 1400, 700, 0.35, 0.09); this.tone('sine', 2100, 1050, 0.25, 0.04, 0, 0.02); break;
      case 'echo': this.tone('sine', 500, 380, 0.5, 0.07 * vol, pan, 0.05); this.tone('triangle', 250, 190, 0.6, 0.05 * vol, pan, 0.1); break;
      case 'return': this.tone('square', e.param === 2 ? 1900 : 1500, e.param === 2 ? 1900 : 1500, 0.03, 0.035 * vol, pan); break;
      case 'blip': this.tone('sine', 900 + e.param * 500, 900 + e.param * 500, 0.06, 0.06 * (0.3 + e.param), 0); break;
      case 'tether': if (e.param === 0) { this.noise(0.08, 0.3, 'lowpass', 1400, 300, 1, pan); this.tone('square', 240, 180, 0.07, 0.07, pan); } else { this.tone('square', 180, 240, 0.06, 0.05, pan); } break;
      case 'snap': this.tone('sawtooth', 1200, 80, 0.25, 0.14, pan); this.noise(0.15, 0.3, 'highpass', 2000, 4000, 1, pan); break;
      case 'note': this.tone('sine', 1560, 1560, 0.05, 0.035); this.tone('sine', 2080, 2080, 0.08, 0.03, 0, 0.06); break;
      case 'powerdown': this.tone('sawtooth', 220, 30, 1.6, 0.12, pan); this.tone('sine', 110, 20, 1.8, 0.1, pan); break;
      case 'transfer': this.noise(0.25, 0.08, 'bandpass', 900, 1400, 2, pan); break;
      case 'faultanswer': for (let i = 0; i < 4; i++) this.tone('triangle', 55 * Math.pow(1.5, i), 55 * Math.pow(1.5, i), 2.2, 0.08, 0, i * 0.12, 0.3); this.noise(2.0, 0.2, 'lowpass', 300, 1200, 0.7); break;
      default: break;
    }
  }
}
