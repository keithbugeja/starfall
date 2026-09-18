// Flat-shaded instanced mesh rendering with quantised star lighting.
import { createProgram, type Program } from './gl';

/** CPU mesh: non-indexed triangle list with per-vertex normal and colour (already duplicated per face). */
export interface MeshData {
  positions: Float32Array; // 3 per vertex
  normals: Float32Array;   // 3 per vertex
  colors: Float32Array;    // 3 per vertex
  vertexCount: number;
  radius: number;          // bounding radius
}

/** Builder that accumulates triangles and computes flat normals. */
export class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private nrm: number[] = [];
  /** Add a triangle (a, b, c) counter-clockwise when viewed from outside. */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number, g: number, b: number): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b); }
  }
  /** Add a convex polygon (fan) given flat vertex array [x,y,z, x,y,z, ...]. */
  poly(verts: number[], r: number, g: number, b: number): void {
    for (let i = 1; i + 1 < verts.length / 3; i++) {
      this.tri(verts[0], verts[1], verts[2], verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2], verts[i * 3 + 3], verts[i * 3 + 4], verts[i * 3 + 5], r, g, b);
    }
  }
  quad(a: number[], b: number[], c: number[], d: number[], r: number, g: number, bl: number): void {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], r, g, bl);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], r, g, bl);
  }
  /** Add a triangle with an explicit (shared) normal, for smooth-ish faceting tricks. */
  triN(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number, r: number, g: number, b: number): void {
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) { this.nrm.push(nx, ny, nz); this.col.push(r, g, b); }
  }
  append(other: MeshData, tx = 0, ty = 0, tz = 0, s = 1): void {
    for (let i = 0; i < other.vertexCount; i++) {
      this.pos.push(other.positions[i * 3] * s + tx, other.positions[i * 3 + 1] * s + ty, other.positions[i * 3 + 2] * s + tz);
      this.nrm.push(other.normals[i * 3], other.normals[i * 3 + 1], other.normals[i * 3 + 2]);
      this.col.push(other.colors[i * 3], other.colors[i * 3 + 1], other.colors[i * 3 + 2]);
    }
  }
  build(): MeshData {
    let radius = 0;
    for (let i = 0; i < this.pos.length; i += 3) {
      const d = Math.hypot(this.pos[i], this.pos[i + 1], this.pos[i + 2]);
      if (d > radius) radius = d;
    }
    return {
      positions: new Float32Array(this.pos),
      normals: new Float32Array(this.nrm),
      colors: new Float32Array(this.col),
      vertexCount: this.pos.length / 3,
      radius,
    };
  }
}

const MESH_VS = `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec3 a_col;
layout(location=3) in vec4 i_m0;
layout(location=4) in vec4 i_m1;
layout(location=5) in vec4 i_m2;
layout(location=6) in vec4 i_m3;
layout(location=7) in vec4 i_tint;
uniform mat4 u_viewProj;
out vec3 v_wpos;
flat out vec3 v_nrm;
flat out vec3 v_col;
flat out float v_emis;
void main() {
  mat4 M = mat4(i_m0, i_m1, i_m2, i_m3);
  vec4 wp = M * vec4(a_pos, 1.0);
  v_wpos = wp.xyz;
  v_nrm = normalize(mat3(M) * a_nrm);
  v_col = a_col * i_tint.rgb;
  v_emis = i_tint.a;
  gl_Position = u_viewProj * wp;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 v_wpos;
flat in vec3 v_nrm;
flat in vec3 v_col;
flat in float v_emis;
uniform vec3 u_lightPos;
uniform vec3 u_camPos;
uniform float u_ambient;
out vec4 o_col;
void main() {
  vec3 L = normalize(u_lightPos - v_wpos);
  float ndl = dot(v_nrm, L);
  // four illumination bands: lit, half, shadow-edge, dark
  float lit = ndl > 0.55 ? 1.0 : (ndl > 0.18 ? 0.70 : (ndl > -0.08 ? 0.42 : 0.20));
  // a faint camera-side fill so the night side is not invisible
  vec3 V = normalize(u_camPos - v_wpos);
  float fill = max(dot(v_nrm, V), 0.0) * 0.08;
  vec3 c = v_col * (lit * (1.0 - u_ambient) + u_ambient + fill);
  c = mix(c, v_col, v_emis);
  o_col = vec4(c, 1.0);
}`;

export class GpuMesh {
  vao: WebGLVertexArrayObject;
  instBuf: WebGLBuffer;
  instData: Float32Array;
  instCount = 0;
  instCapacity: number;
  vertexCount: number;
  radius: number;
  constructor(private gl: WebGL2RenderingContext, data: MeshData, initialCapacity = 4) {
    this.vertexCount = data.vertexCount;
    this.radius = data.radius;
    this.instCapacity = initialCapacity;
    this.instData = new Float32Array(initialCapacity * 20);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('vao');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const mk = (loc: number, arr: Float32Array) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    mk(0, data.positions);
    mk(1, data.normals);
    mk(2, data.colors);
    const ib = gl.createBuffer();
    if (!ib) throw new Error('buffer');
    this.instBuf = ib;
    gl.bindBuffer(gl.ARRAY_BUFFER, ib);
    gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 5; i++) {
      gl.enableVertexAttribArray(3 + i);
      gl.vertexAttribPointer(3 + i, 4, gl.FLOAT, false, 80, i * 16);
      gl.vertexAttribDivisor(3 + i, 1);
    }
    gl.bindVertexArray(null);
  }
  /** Queue an instance: model matrix (16 floats) and tint rgb + emissive. */
  add(m: Float32Array, r: number, g: number, b: number, emissive: number): void {
    if (this.instCount >= this.instCapacity) {
      this.instCapacity *= 2;
      const nd = new Float32Array(this.instCapacity * 20);
      nd.set(this.instData);
      this.instData = nd;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, nd.byteLength, gl.DYNAMIC_DRAW);
    }
    const o = this.instCount * 20;
    this.instData.set(m, o);
    this.instData[o + 16] = r;
    this.instData[o + 17] = g;
    this.instData[o + 18] = b;
    this.instData[o + 19] = emissive;
    this.instCount++;
  }
  flush(): void {
    if (this.instCount === 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instData, 0, this.instCount * 20);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, this.vertexCount, this.instCount);
    gl.bindVertexArray(null);
    this.instCount = 0;
  }
}

export class MeshRenderer {
  private prog: Program;
  meshes: Set<GpuMesh> = new Set();
  drawCalls = 0;
  constructor(private gl: WebGL2RenderingContext) {
    this.prog = createProgram(gl, MESH_VS, MESH_FS, 'mesh');
  }
  create(data: MeshData, capacity = 4): GpuMesh {
    const m = new GpuMesh(this.gl, data, capacity);
    this.meshes.add(m);
    return m;
  }
  /** Draw all queued instances of all meshes. */
  flush(viewProj: Float32Array, lightPos: [number, number, number], camPos: [number, number, number], ambient: number): void {
    const gl = this.gl;
    this.prog.use();
    gl.uniformMatrix4fv(this.prog.u('u_viewProj'), false, viewProj);
    gl.uniform3f(this.prog.u('u_lightPos'), lightPos[0], lightPos[1], lightPos[2]);
    gl.uniform3f(this.prog.u('u_camPos'), camPos[0], camPos[1], camPos[2]);
    gl.uniform1f(this.prog.u('u_ambient'), ambient);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.disable(gl.BLEND);
    this.drawCalls = 0;
    for (const m of this.meshes) {
      if (m.instCount > 0) { this.drawCalls++; m.flush(); }
    }
    gl.disable(gl.CULL_FACE);
  }
}
