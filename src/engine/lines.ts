// Line rendering as screen-space expanded quads (WebGL line width is 1px only).
// Used for HUD, text, trajectories, weapons, map. Additive blending gives the phosphor look.
import { createProgram, type Program } from './gl';

const LINE_VS = `#version 300 es
layout(location=0) in vec3 a_a;
layout(location=1) in vec3 a_b;
layout(location=2) in vec4 a_col;
layout(location=3) in vec2 a_prm; // x: side (-1/1), y: end (0/1)
layout(location=4) in float a_w;  // width in pixels
uniform mat4 u_vp;
uniform vec2 u_viewport;
out vec4 v_col;
out float v_across;
out float v_hw;
void main() {
  vec4 ca = u_vp * vec4(a_a, 1.0);
  vec4 cb = u_vp * vec4(a_b, 1.0);
  // Avoid projection flips for points behind the camera (never happens for the top-down view, but be safe).
  ca.w = max(ca.w, 1e-3);
  cb.w = max(cb.w, 1e-3);
  vec2 hv = u_viewport * 0.5;
  vec2 sa = ca.xy / ca.w * hv;
  vec2 sb = cb.xy / cb.w * hv;
  vec2 d = sb - sa;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = a_w * 0.5 + 1.0; // +1px feather margin
  bool isB = a_prm.y > 0.5;
  vec4 c = isB ? cb : ca;
  vec2 s = isB ? sb : sa;
  // extend ends by hw for round-ish caps so polylines join without gaps
  s += dir * (isB ? hw : -hw) + nrm * hw * a_prm.x;
  gl_Position = vec4(s / hv * c.w, c.z, c.w);
  v_col = a_col;
  v_across = a_prm.x * hw;
  v_hw = a_w * 0.5;
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
in float v_across;
in float v_hw;
out vec4 o_col;
void main() {
  float d = abs(v_across);
  float a = 1.0 - smoothstep(v_hw - 0.5, v_hw + 0.9, d);
  // bright core for thin lines so they read as glowing phosphor
  float core = 1.0 - smoothstep(0.0, max(v_hw * 0.6, 0.5), d);
  vec3 c = v_col.rgb * (a + core * 0.35);
  o_col = vec4(c * v_col.a, v_col.a * a);
}`;

const FLOATS_PER_VERT = 13;

/** A batch of line segments; fill it each frame then draw with a matrix. */
export class LineBatch {
  data: Float32Array;
  count = 0; // segments
  capacity: number;
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * 4 * FLOATS_PER_VERT);
  }
  clear(): void { this.count = 0; }
  private grow(): void {
    this.capacity *= 2;
    const nd = new Float32Array(this.capacity * 4 * FLOATS_PER_VERT);
    nd.set(this.data);
    this.data = nd;
  }
  /** Add one segment from (ax,ay,az) to (bx,by,bz). */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, g: number, b: number, a: number, w: number): void {
    if (this.count >= this.capacity) this.grow();
    let o = this.count * 4 * FLOATS_PER_VERT;
    const d = this.data;
    for (let i = 0; i < 4; i++) {
      d[o] = ax; d[o + 1] = ay; d[o + 2] = az;
      d[o + 3] = bx; d[o + 4] = by; d[o + 5] = bz;
      d[o + 6] = r; d[o + 7] = g; d[o + 8] = b; d[o + 9] = a;
      d[o + 10] = (i & 1) ? 1 : -1;
      d[o + 11] = (i >> 1) ? 1 : 0;
      d[o + 12] = w;
      o += FLOATS_PER_VERT;
    }
    this.count++;
  }
  /** 2D convenience (z = 0). */
  line2(ax: number, ay: number, bx: number, by: number, r: number, g: number, b: number, a: number, w: number): void {
    this.seg(ax, ay, 0, bx, by, 0, r, g, b, a, w);
  }
  polyline2(pts: ArrayLike<number>, r: number, g: number, b: number, a: number, w: number, closed = false): void {
    const n = pts.length / 2;
    for (let i = 0; i + 1 < n; i++) this.line2(pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], r, g, b, a, w);
    if (closed && n > 2) this.line2(pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], pts[0], pts[1], r, g, b, a, w);
  }
  circle2(cx: number, cy: number, rad: number, segs: number, r: number, g: number, b: number, a: number, w: number, start = 0, end = Math.PI * 2): void {
    let px = cx + Math.cos(start) * rad, py = cy + Math.sin(start) * rad;
    for (let i = 1; i <= segs; i++) {
      const t = start + (end - start) * i / segs;
      const x = cx + Math.cos(t) * rad, y = cy + Math.sin(t) * rad;
      this.line2(px, py, x, y, r, g, b, a, w);
      px = x; py = y;
    }
  }
  /** Circle in the sim plane at world height y. */
  circleWorld(cx: number, cy: number, cz: number, rad: number, segs: number, r: number, g: number, b: number, a: number, w: number): void {
    let px = cx + rad, pz = cz;
    for (let i = 1; i <= segs; i++) {
      const t = Math.PI * 2 * i / segs;
      const x = cx + Math.cos(t) * rad, z = cz + Math.sin(t) * rad;
      this.seg(px, cy, pz, x, cy, z, r, g, b, a, w);
      px = x; pz = z;
    }
  }
  rect2(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number, lw: number): void {
    this.line2(x, y, x + w, y, r, g, b, a, lw);
    this.line2(x + w, y, x + w, y + h, r, g, b, a, lw);
    this.line2(x + w, y + h, x, y + h, r, g, b, a, lw);
    this.line2(x, y + h, x, y, r, g, b, a, lw);
  }
}

export class LineRenderer {
  private prog: Program;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private vboCapacity = 0; // in segments
  private iboCapacity = 0;
  constructor(private gl: WebGL2RenderingContext) {
    this.prog = createProgram(gl, LINE_VS, LINE_FS, 'lines');
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('line buffers');
    this.vao = vao; this.vbo = vbo; this.ibo = ibo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 40);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 48);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    this.ensure(4096);
  }
  private ensure(segments: number): void {
    const gl = this.gl;
    if (segments <= this.vboCapacity) return;
    let cap = Math.max(4096, this.vboCapacity);
    while (cap < segments) cap *= 2;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, cap * 4 * FLOATS_PER_VERT * 4, gl.DYNAMIC_DRAW);
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4, o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v + 2;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.vboCapacity = cap;
    this.iboCapacity = cap;
  }
  /** Draw a batch with the given view-projection matrix. Additive blending, no depth. */
  draw(batch: LineBatch, vp: Float32Array, viewportW: number, viewportH: number): void {
    if (batch.count === 0) return;
    const gl = this.gl;
    this.ensure(batch.count);
    this.prog.use();
    gl.uniformMatrix4fv(this.prog.u('u_vp'), false, vp);
    gl.uniform2f(this.prog.u('u_viewport'), viewportW, viewportH);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data, 0, batch.count * 4 * FLOATS_PER_VERT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawElements(gl.TRIANGLES, batch.count * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}
