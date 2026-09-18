// CPU particle pool rendered as additive points.
import { createProgram, type Program } from './gl';

const PVS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec4 a_col;
layout(location=2) in float a_size;
uniform mat4 u_vp;
uniform float u_projScale; // viewportH * 0.5 * proj[5]
out vec4 v_col;
void main() {
  vec4 c = u_vp * vec4(a_pos, 1.0);
  gl_Position = c;
  float px = a_size * u_projScale / max(c.w, 0.001);
  gl_PointSize = clamp(px, 1.5, 64.0);
  v_col = a_col;
}`;
const PFS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 o_col;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = 1.0 - smoothstep(0.5, 1.0, r);
  o_col = vec4(v_col.rgb * a * v_col.a, a * v_col.a);
}`;

/** Static point cloud (background starfield) sharing the particle shader. */
export class StaticPoints {
  private vao: WebGLVertexArrayObject;
  private count: number;
  private prog: Program;
  constructor(private gl: WebGL2RenderingContext, data: Float32Array /* x,y,z,r,g,b,a,size per point */) {
    this.count = data.length / 8;
    this.prog = createProgram(gl, PVS, PFS, 'staticpoints');
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('static point buffers');
    this.vao = vao;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);
  }
  draw(vp: Float32Array, projScale: number): void {
    const gl = this.gl;
    this.prog.use();
    gl.uniformMatrix4fv(this.prog.u('u_vp'), false, vp);
    gl.uniform1f(this.prog.u('u_projScale'), projScale);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }
}

export class ParticleSystem {
  readonly max: number;
  count = 0;
  // SoA
  px: Float32Array; py: Float32Array; pz: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  life: Float32Array; maxLife: Float32Array;
  cr: Float32Array; cg: Float32Array; cb: Float32Array;
  size: Float32Array; drag: Float32Array; grav: Float32Array;
  private prog: Program;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private gpu: Float32Array;

  constructor(private gl: WebGL2RenderingContext, max = 6000) {
    this.max = max;
    const f = () => new Float32Array(max);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.maxLife = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.size = f(); this.drag = f(); this.grav = f();
    this.gpu = new Float32Array(max * 8);
    this.prog = createProgram(gl, PVS, PFS, 'particles');
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error('particle buffers');
    this.vao = vao; this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.gpu.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
    gl.bindVertexArray(null);
  }

  /** Spawn one particle. Position/velocity in world space. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number, size: number, drag = 0, grav = 0): void {
    let i: number;
    if (this.count < this.max) {
      i = this.count++;
    } else {
      // replace the oldest-ish: pick a pseudo-random slot
      i = (Math.random() * this.max) | 0;
    }
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    this.size[i] = size; this.drag[i] = drag; this.grav[i] = grav;
  }

  clear(): void { this.count = 0; }

  update(dt: number): void {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // swap-remove
        n--;
        if (i !== n) {
          this.px[i] = this.px[n]; this.py[i] = this.py[n]; this.pz[i] = this.pz[n];
          this.vx[i] = this.vx[n]; this.vy[i] = this.vy[n]; this.vz[i] = this.vz[n];
          this.life[i] = this.life[n]; this.maxLife[i] = this.maxLife[n];
          this.cr[i] = this.cr[n]; this.cg[i] = this.cg[n]; this.cb[i] = this.cb[n];
          this.size[i] = this.size[n]; this.drag[i] = this.drag[n]; this.grav[i] = this.grav[n];
        }
        i--;
        continue;
      }
      const d = this.drag[i];
      if (d > 0) {
        const k = Math.exp(-d * dt);
        this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
    }
    this.count = n;
  }

  draw(vp: Float32Array, projScale: number): void {
    if (this.count === 0) return;
    const gl = this.gl;
    const g = this.gpu;
    for (let i = 0; i < this.count; i++) {
      const t = this.life[i] / this.maxLife[i];
      const fade = t < 0.5 ? t * 2 : 1;
      const o = i * 8;
      g[o] = this.px[i]; g[o + 1] = this.py[i]; g[o + 2] = this.pz[i];
      g[o + 3] = this.cr[i]; g[o + 4] = this.cg[i]; g[o + 5] = this.cb[i]; g[o + 6] = fade;
      g[o + 7] = this.size[i] * (0.6 + 0.4 * t);
    }
    this.prog.use();
    gl.uniformMatrix4fv(this.prog.u('u_vp'), false, vp);
    gl.uniform1f(this.prog.u('u_projScale'), projScale);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, g, 0, this.count * 8);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
  }
}
