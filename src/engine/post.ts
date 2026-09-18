// Post-processing: world layer + vector layer, phosphor persistence, bloom, composite with vignette.
import { createFBO, createFullscreenVAO, createProgram, deleteFBO, FULLSCREEN_VS, type FBO, type Program } from './gl';

const PERSIST_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_prev;
uniform sampler2D u_cur;
uniform float u_decay;
out vec4 o;
void main() {
  vec3 p = texture(u_prev, v_uv).rgb * u_decay;
  vec3 c = texture(u_cur, v_uv).rgb;
  o = vec4(max(p, c), 1.0);
}`;

const BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_world;
uniform sampler2D u_vec;
uniform float u_threshold;
out vec4 o;
void main() {
  vec3 w = texture(u_world, v_uv).rgb;
  vec3 v = texture(u_vec, v_uv).rgb;
  vec3 b = max(w - u_threshold, 0.0) * 1.5 + v;
  o = vec4(b, 1.0);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir; // (1/w, 0) or (0, 1/h)
out vec4 o;
void main() {
  float w[5];
  w[0] = 0.227027; w[1] = 0.1945946; w[2] = 0.1216216; w[3] = 0.054054; w[4] = 0.016216;
  vec3 c = texture(u_tex, v_uv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = u_dir * float(i) * 1.5;
    c += texture(u_tex, v_uv + off).rgb * w[i];
    c += texture(u_tex, v_uv - off).rgb * w[i];
  }
  o = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_world;
uniform sampler2D u_vec;
uniform sampler2D u_bloom;
uniform sampler2D u_bloom2;
uniform float u_bloomStrength;
uniform float u_flicker;
uniform float u_time;
uniform float u_fade; // world layer brightness: 0 = black, 1 = normal
uniform float u_vecFade; // vector layer brightness
out vec4 o;
void main() {
  vec3 w = texture(u_world, v_uv).rgb;
  vec3 v = texture(u_vec, v_uv).rgb;
  vec3 b = texture(u_bloom, v_uv).rgb;
  vec3 b2 = texture(u_bloom2, v_uv).rgb;
  vec3 c = w * u_fade + v * u_flicker * u_vecFade + (b * 0.7 + b2 * 0.5) * u_bloomStrength * mix(u_fade, 1.0, 0.6);
  // gentle tone: keep saturated highlights from clipping to white too fast
  c = c / (1.0 + c * 0.12);
  // vignette
  vec2 q = v_uv * 2.0 - 1.0;
  float vig = 1.0 - dot(q, q) * 0.22;
  c *= vig;
  // very faint scan modulation (kept subtle for readability)
  c *= 0.97 + 0.03 * sin(v_uv.y * 1200.0 + u_time * 0.3);
  c = pow(max(c, 0.0), vec3(1.0 / 1.15));
  o = vec4(c, 1.0);
}`;

export class PostPipeline {
  world!: FBO;
  vector!: FBO;
  persistA!: FBO;
  persistB!: FBO;
  bright!: FBO;
  blurA!: FBO;
  blurB!: FBO;
  blurC!: FBO;
  blurD!: FBO;
  width = 0;
  height = 0;
  private fsVao: WebGLVertexArrayObject;
  private pPersist: Program;
  private pBright: Program;
  private pBlur: Program;
  private pComposite: Program;
  persistDecay = 0.42;
  bloomStrength = 1.0;
  bloomThreshold = 0.85;
  flicker = 1.0;
  fade = 1.0;
  vecFade = 1.0;
  private persistFlip = false;

  constructor(private gl: WebGL2RenderingContext, w: number, h: number) {
    this.fsVao = createFullscreenVAO(gl);
    this.pPersist = createProgram(gl, FULLSCREEN_VS, PERSIST_FS, 'persist');
    this.pBright = createProgram(gl, FULLSCREEN_VS, BRIGHT_FS, 'bright');
    this.pBlur = createProgram(gl, FULLSCREEN_VS, BLUR_FS, 'blur');
    this.pComposite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FS, 'composite');
    this.resize(w, h);
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    if (this.world) {
      for (const f of [this.world, this.vector, this.persistA, this.persistB, this.bright, this.blurA, this.blurB, this.blurC, this.blurD]) deleteFBO(gl, f);
    }
    this.width = w; this.height = h;
    this.world = createFBO(gl, w, h, { float: true, depth: true });
    this.vector = createFBO(gl, w, h, { float: true });
    this.persistA = createFBO(gl, w, h, { float: true });
    this.persistB = createFBO(gl, w, h, { float: true });
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.bright = createFBO(gl, qw, qh, { float: true });
    this.blurA = createFBO(gl, qw, qh, { float: true });
    this.blurB = createFBO(gl, qw, qh, { float: true });
    const ew = Math.max(1, w >> 3), eh = Math.max(1, h >> 3);
    this.blurC = createFBO(gl, ew, eh, { float: true });
    this.blurD = createFBO(gl, ew, eh, { float: true });
    // clear persistence buffers
    for (const f of [this.persistA, this.persistB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  beginWorld(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.world.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.0, 0.0, 0.0, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  beginVector(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vector.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private bindTex(unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private fs(target: FBO | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Run persistence, bloom and composite to the default framebuffer. */
  finish(time: number): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    // persistence
    const prev = this.persistFlip ? this.persistB : this.persistA;
    const cur = this.persistFlip ? this.persistA : this.persistB;
    this.persistFlip = !this.persistFlip;
    this.pPersist.use();
    this.bindTex(0, prev.tex); this.bindTex(1, this.vector.tex);
    gl.uniform1i(this.pPersist.u('u_prev'), 0);
    gl.uniform1i(this.pPersist.u('u_cur'), 1);
    gl.uniform1f(this.pPersist.u('u_decay'), this.persistDecay);
    this.fs(cur, this.width, this.height);
    // bright pass at quarter res
    this.pBright.use();
    this.bindTex(0, this.world.tex); this.bindTex(1, cur.tex);
    gl.uniform1i(this.pBright.u('u_world'), 0);
    gl.uniform1i(this.pBright.u('u_vec'), 1);
    gl.uniform1f(this.pBright.u('u_threshold'), this.bloomThreshold);
    this.fs(this.bright, this.bright.width, this.bright.height);
    // blur quarter
    this.pBlur.use();
    gl.uniform1i(this.pBlur.u('u_tex'), 0);
    this.bindTex(0, this.bright.tex);
    gl.uniform2f(this.pBlur.u('u_dir'), 1 / this.bright.width, 0);
    this.fs(this.blurA, this.blurA.width, this.blurA.height);
    this.bindTex(0, this.blurA.tex);
    gl.uniform2f(this.pBlur.u('u_dir'), 0, 1 / this.bright.height);
    this.fs(this.blurB, this.blurB.width, this.blurB.height);
    // wider blur at eighth res
    this.bindTex(0, this.blurB.tex);
    gl.uniform2f(this.pBlur.u('u_dir'), 1 / this.blurC.width, 0);
    this.fs(this.blurC, this.blurC.width, this.blurC.height);
    this.bindTex(0, this.blurC.tex);
    gl.uniform2f(this.pBlur.u('u_dir'), 0, 1 / this.blurC.height);
    this.fs(this.blurD, this.blurD.width, this.blurD.height);
    // composite
    this.pComposite.use();
    this.bindTex(0, this.world.tex); this.bindTex(1, cur.tex); this.bindTex(2, this.blurB.tex); this.bindTex(3, this.blurD.tex);
    gl.uniform1i(this.pComposite.u('u_world'), 0);
    gl.uniform1i(this.pComposite.u('u_vec'), 1);
    gl.uniform1i(this.pComposite.u('u_bloom'), 2);
    gl.uniform1i(this.pComposite.u('u_bloom2'), 3);
    gl.uniform1f(this.pComposite.u('u_bloomStrength'), this.bloomStrength);
    gl.uniform1f(this.pComposite.u('u_flicker'), this.flicker);
    gl.uniform1f(this.pComposite.u('u_time'), time);
    gl.uniform1f(this.pComposite.u('u_fade'), this.fade);
    gl.uniform1f(this.pComposite.u('u_vecFade'), this.vecFade);
    this.fs(null, this.width, this.height);
    gl.bindVertexArray(null);
  }
}
