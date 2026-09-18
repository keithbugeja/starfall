// Perspective camera looking down at the sim plane (world y = 0). Sim (x, y) -> world (x, 0, -y).
import { mat4Invert, mat4LookAt, mat4Multiply, mat4Perspective, mat4TransformPoint, type Mat4 } from './math';

export class Camera {
  eye = [0, 100, 0];
  target = [0, 0, 0];
  fov = 0.9;
  aspect = 16 / 9;
  near = 1;
  far = 20000;
  view: Mat4 = new Float32Array(16);
  proj: Mat4 = new Float32Array(16);
  viewProj: Mat4 = new Float32Array(16);
  invViewProj: Mat4 = new Float32Array(16);
  viewportW = 1280;
  viewportH = 720;
  private tmp = [0, 0, 0, 0];

  update(): void {
    mat4Perspective(this.proj, this.fov, this.aspect, this.near, this.far);
    // "up" on screen is world -z (sim +y): look down the -y axis with up = -z.
    mat4LookAt(this.view, this.eye[0], this.eye[1], this.eye[2], this.target[0], this.target[1], this.target[2], 0, 0, -1);
    mat4Multiply(this.viewProj, this.proj, this.view);
    mat4Invert(this.invViewProj, this.viewProj);
  }

  /** Projection scale used for point sprite sizing. */
  get projScale(): number { return this.viewportH * 0.5 * this.proj[5]; }

  /** World point -> screen pixels (y down). Returns null if behind camera. */
  worldToScreen(x: number, y: number, z: number, out: number[] = [0, 0]): number[] | null {
    const c = mat4TransformPoint(this.viewProj, x, y, z, this.tmp);
    if (c[3] <= 1e-6) return null;
    out[0] = (c[0] / c[3] * 0.5 + 0.5) * this.viewportW;
    out[1] = (1 - (c[1] / c[3] * 0.5 + 0.5)) * this.viewportH;
    return out;
  }
  /** Sim position (x, y) -> screen pixels. */
  simToScreen(sx: number, sy: number, out: number[] = [0, 0]): number[] | null {
    return this.worldToScreen(sx, 0, -sy, out);
  }
  /** Screen pixels -> sim plane position (intersection with world y = 0). */
  screenToSim(px: number, py: number): { x: number; y: number } {
    const nx = (px / this.viewportW) * 2 - 1;
    const ny = 1 - (py / this.viewportH) * 2;
    const a = mat4TransformPoint(this.invViewProj, nx, ny, -1, [0, 0, 0, 0]);
    const b = mat4TransformPoint(this.invViewProj, nx, ny, 1, [0, 0, 0, 0]);
    const ax = a[0] / a[3], ay = a[1] / a[3], az = a[2] / a[3];
    const bx = b[0] / b[3], by = b[1] / b[3], bz = b[2] / b[3];
    const t = ay / (ay - by || 1e-9);
    const wx = ax + (bx - ax) * t, wz = az + (bz - az) * t;
    return { x: wx, y: -wz };
  }
  /** Approximate world units per pixel at the plane under the camera target. */
  unitsPerPixel(): number {
    const h = Math.hypot(this.eye[0] - this.target[0], this.eye[1] - this.target[1], this.eye[2] - this.target[2]);
    return (2 * h * Math.tan(this.fov / 2)) / this.viewportH;
  }
}
