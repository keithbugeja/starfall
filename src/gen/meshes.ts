// Procedural low-poly meshes: planets from terrain profiles, star, asteroids, ships, stations.
// Ship local frame: +x forward, +y up, +z starboard. Sim heading -> world yaw.
import { MeshBuilder, type MeshData } from '../engine/mesh';
import { fbm3, lerp, Rng, TAU, valueNoise3 } from '../engine/math';
import { surfaceRadius, type Body } from '../sim/bodies';
import type { ShipKind, Station } from '../sim/world';

type V3 = number[];

/** Triangle oriented outward relative to a reference point (centroid of the part). */
function triOut(mb: MeshBuilder, a: V3, b: V3, c: V3, col: number[], ref: V3 = [0, 0, 0]): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const cx = (a[0] + b[0] + c[0]) / 3 - ref[0], cy = (a[1] + b[1] + c[1]) / 3 - ref[1], cz = (a[2] + b[2] + c[2]) / 3 - ref[2];
  if (nx * cx + ny * cy + nz * cz >= 0) mb.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col[0], col[1], col[2]);
  else mb.tri(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], col[0], col[1], col[2]);
}

function hull(mb: MeshBuilder, verts: V3[], faces: number[][], col: number[], ref?: V3): void {
  let r = ref;
  if (!r) {
    r = [0, 0, 0];
    for (const v of verts) { r[0] += v[0]; r[1] += v[1]; r[2] += v[2]; }
    r = [r[0] / verts.length, r[1] / verts.length, r[2] / verts.length];
  }
  for (const f of faces) {
    for (let i = 1; i + 1 < f.length; i++) triOut(mb, verts[f[0]], verts[f[i]], verts[f[i + 1]], col, r);
  }
}

/** Axis-aligned box centred at c with full size s. */
function box(mb: MeshBuilder, c: V3, s: V3, col: number[], colTop?: number[]): void {
  const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
  const v: V3[] = [];
  for (let i = 0; i < 8; i++) v.push([c[0] + ((i & 1) ? hx : -hx), c[1] + ((i & 2) ? hy : -hy), c[2] + ((i & 4) ? hz : -hz)]);
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  faces.forEach((f, idx) => {
    const cc = idx === 3 && colTop ? colTop : col;
    for (let i = 1; i + 1 < f.length; i++) triOut(mb, v[f[0]], v[f[i]], v[f[i + 1]], cc, c);
  });
}

/** Regular prism (n sides) around local y axis, centred at c, radius r, height h, rotated by rot. */
function prism(mb: MeshBuilder, c: V3, n: number, r: number, h: number, col: number[], colCap?: number[], rot = 0, rTop = r): void {
  const bot: V3[] = [], top: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    bot.push([c[0] + Math.cos(a) * r, c[1] - h / 2, c[2] + Math.sin(a) * r]);
    top.push([c[0] + Math.cos(a) * rTop, c[1] + h / 2, c[2] + Math.sin(a) * rTop]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    triOut(mb, bot[i], bot[j], top[j], col, c);
    triOut(mb, bot[i], top[j], top[i], col, c);
  }
  const cap = colCap ?? col;
  for (let i = 1; i + 1 < n; i++) { triOut(mb, top[0], top[i], top[i + 1], cap, c); triOut(mb, bot[0], bot[i], bot[i + 1], cap, c); }
}

export function icosphere(level: number): { verts: V3[]; faces: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map(v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let l = 0; l < level; l++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const c = cache.get(key);
      if (c !== undefined) return c;
      const va = verts[a], vb = verts[b];
      const m = [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
      const ln = Math.hypot(m[0], m[1], m[2]);
      verts.push([m[0] / ln, m[1] / ln, m[2] / ln]);
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const nf: number[][] = [];
    for (const f of faces) {
      const a = mid(f[0], f[1]), b = mid(f[1], f[2]), c = mid(f[2], f[0]);
      nf.push([f[0], a, c], [f[1], b, a], [f[2], c, b], [a, b, c]);
    }
    faces = nf;
  }
  return { verts, faces };
}

export function buildStarMesh(radius: number, seed: number): MeshData {
  const mb = new MeshBuilder();
  const { verts, faces } = icosphere(2);
  const rng = new Rng(seed);
  for (const f of faces) {
    const v = f.map(i => verts[i].map(x => x * radius));
    const k = 0.85 + rng.next() * 0.35;
    // HDR-ish emissive: bright core colour
    triOut(mb, v[0], v[1], v[2], [1.9 * k, 1.35 * k, 0.55 * k]);
  }
  return mb.build();
}

export function buildPlanetMesh(b: Body): MeshData {
  const mb = new MeshBuilder();
  const N = b.segments;
  const M = Math.max(12, Math.round(N / 2) & ~1); // even, so ring M/2 is the equator
  const R = b.radius;
  const pos: V3[][] = [];
  const rad: number[][] = [];
  for (let j = 0; j <= M; j++) {
    const lat = -Math.PI / 2 + Math.PI * j / M;
    const row: V3[] = [], rrow: number[] = [];
    for (let i = 0; i < N; i++) {
      const lon = (i / N) * TAU;
      let r: number;
      if (b.kind === 'gas' || b.roughness <= 0) r = R;
      else if (j === M / 2) r = b.terrain[i];
      else {
        const s = surfaceRadius(b, lon, lat);
        const blend = Math.max(0, 1 - Math.abs(lat) / 0.28);
        r = lerp(s, b.terrain[i], blend * blend);
      }
      const cl = Math.cos(lat);
      row.push([r * cl * Math.cos(lon), r * Math.sin(lat) * b.oblate, -r * cl * Math.sin(lon)]);
      rrow.push(r);
    }
    pos.push(row); rad.push(rrow);
  }
  const pal = b.palette;
  const colorFor = (hRel: number, lat: number, lon: number, i: number, j: number): number[] => {
    if (b.kind === 'gas') {
      const warp = fbm3(Math.cos(lon) * 1.5, lat * 4.0, Math.sin(lon) * 1.5, 2, b.seed) * 0.35;
      const band = Math.sin(lat * 9 + warp * 6 + b.seed % 7) * 0.5 + 0.5;
      // storms: large blotches that break the bands so the sphere reads from any angle
      const storm = fbm3(Math.cos(lon) * 2.2 + 5, lat * 3.0, Math.sin(lon) * 2.2 + 9, 3, b.seed + 13);
      const v = band + storm * 0.55;
      const q = v < 0.3 ? pal.low : v < 0.66 ? pal.mid : pal.high;
      return q;
    }
    // ice caps for icy/rocky worlds at high latitude
    if ((b.type === 'ice') && Math.abs(lat) > 1.15) return pal.high;
    const n = valueNoise3(i * 0.9, j * 0.9, b.seed * 0.01, b.seed) * 0.02;
    const h = hRel + n;
    if (h < -0.03) return pal.low;
    if (h < 0.035) return pal.mid;
    return pal.high;
  };
  const padSeg = new Set<number>();
  for (const p of b.pads) padSeg.add(p.segIndex);
  const padCol = [0.32, 0.34, 0.38];
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < N; i++) {
      const i1 = (i + 1) % N;
      const p00 = pos[j][i], p10 = pos[j][i1], p11 = pos[j + 1][i1], p01 = pos[j + 1][i];
      const hRel = ((rad[j][i] + rad[j][i1] + rad[j + 1][i1] + rad[j + 1][i]) / 4 - R) / R;
      const lat = -Math.PI / 2 + Math.PI * (j + 0.5) / M;
      const lon = ((i + 0.5) / N) * TAU;
      let col = colorFor(hRel, lat, lon, i, j);
      const nearEq = j === M / 2 - 1 || j === M / 2;
      if (nearEq && padSeg.has(i)) col = padCol;
      if (j === 0) triOut(mb, p00, p10, p11, col);
      else if (j === M - 1) triOut(mb, p00, p10, p01, col);
      else {
        // split the quad along the diagonal that makes the facets visibly irregular
        if ((i + j) & 1) { triOut(mb, p00, p10, p11, col); triOut(mb, p00, p11, p01, col); }
        else { triOut(mb, p00, p10, p01, col); triOut(mb, p10, p11, p01, col); }
      }
    }
  }
  // ring system for gas giants: a flat faceted annulus in the ecliptic
  if (b.kind === 'gas') {
    const rng = new Rng(b.seed + 99);
    const r0 = R * 1.35, r1 = R * (1.9 + rng.next() * 0.3);
    const n = 48;
    const gap = 0.5 + rng.next() * 0.3; // a Cassini-like division
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU;
      const shade = 0.75 + (i % 2) * 0.12;
      const col = [pal.mid[0] * 0.55 * shade, pal.mid[1] * 0.55 * shade, pal.mid[2] * 0.55 * shade];
      const bands: [number, number][] = [[r0, r0 + (r1 - r0) * gap * 0.93], [r0 + (r1 - r0) * gap * 1.05, r1]];
      for (const [ra, rb] of bands) {
        const p0: V3 = [Math.cos(a0) * ra, 0, -Math.sin(a0) * ra], p1: V3 = [Math.cos(a1) * ra, 0, -Math.sin(a1) * ra];
        const p2: V3 = [Math.cos(a1) * rb, 0, -Math.sin(a1) * rb], p3: V3 = [Math.cos(a0) * rb, 0, -Math.sin(a0) * rb];
        // both windings so the ring is visible from above and below; normal up for the lit face
        mb.triN(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2], 0, 1, 0, col[0], col[1], col[2]);
        mb.triN(p0[0], p0[1], p0[2], p3[0], p3[1], p3[2], p2[0], p2[1], p2[2], 0, 1, 0, col[0], col[1], col[2]);
      }
    }
  }
  return mb.build();
}

/** Unit-ish asteroid: radius ~1 with jitter. Two detail levels. */
export function buildAsteroidMesh(seed: number, chunky: boolean): MeshData {
  const rng = new Rng(seed);
  const mb = new MeshBuilder();
  const { verts, faces } = icosphere(chunky ? 0 : 1);
  const sx = 0.7 + rng.next() * 0.6, sy = 0.7 + rng.next() * 0.6, sz = 0.7 + rng.next() * 0.6;
  const jit = verts.map(v => {
    const k = 0.72 + rng.next() * 0.5;
    return [v[0] * k * sx, v[1] * k * sy, v[2] * k * sz];
  });
  const base = [0.55 + rng.next() * 0.1, 0.5 + rng.next() * 0.08, 0.45 + rng.next() * 0.08];
  for (const f of faces) {
    const k = 0.85 + rng.next() * 0.3;
    triOut(mb, jit[f[0]], jit[f[1]], jit[f[2]], [base[0] * k, base[1] * k, base[2] * k]);
  }
  return mb.build();
}

export function buildShipMesh(kind: ShipKind): MeshData {
  const mb = new MeshBuilder();
  switch (kind) {
    case 'kestrel': {
      const light = [0.78, 0.84, 0.95], mid = [0.52, 0.6, 0.75], dark = [0.3, 0.34, 0.45], accent = [1.0, 0.62, 0.2];
      const v: V3[] = [
        [1.35, 0.04, 0],      // 0 nose
        [-0.95, 0, -1.05],    // 1 wing L
        [-0.95, 0, 1.05],     // 2 wing R
        [-0.85, 0.05, 0],     // 3 tail
        [-0.05, 0.38, 0],     // 4 spine top
        [-0.8, 0.22, 0],      // 5 spine back
        [0.05, -0.2, 0],      // 6 keel
      ];
      const upper = [[0, 4, 1], [0, 2, 4], [4, 5, 1], [4, 2, 5], [5, 3, 1], [5, 2, 3]];
      const lower = [[0, 1, 6], [0, 6, 2], [6, 1, 3], [6, 3, 2]];
      hull(mb, v, upper.slice(0, 2), light, [0, 0, 0]);
      hull(mb, v, upper.slice(2), mid, [0, 0, 0]);
      hull(mb, v, lower, dark, [0, 0, 0]);
      // cockpit
      const ck: V3[] = [[0.55, 0.12, -0.16], [0.55, 0.12, 0.16], [-0.05, 0.4, 0.16], [-0.05, 0.4, -0.16], [0.75, 0.16, 0]];
      hull(mb, ck, [[4, 0, 1], [0, 3, 2, 1], [4, 1, 2], [4, 2, 3], [4, 3, 0]], accent, [0.3, 0.15, 0]);
      // engines
      box(mb, [-0.95, 0.02, -0.45], [0.5, 0.26, 0.3], dark);
      box(mb, [-0.95, 0.02, 0.45], [0.5, 0.26, 0.3], dark);
      break;
    }
    case 'wasp': {
      const a = [0.95, 0.35, 0.2], b = [0.55, 0.15, 0.12];
      const v: V3[] = [[1.0, 0, 0], [-0.6, 0.42, 0], [-0.6, -0.22, -0.65], [-0.6, -0.22, 0.65]];
      hull(mb, v, [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]], a);
      // fins
      hull(mb, [[-0.3, 0.1, -0.4], [-1.1, 0.1, -1.0], [-0.9, 0.1, -0.35], [-0.6, 0.0, -0.5]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      hull(mb, [[-0.3, 0.1, 0.4], [-1.1, 0.1, 1.0], [-0.9, 0.1, 0.35], [-0.6, 0.0, 0.5]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      break;
    }
    case 'lancer': {
      const a = [0.62, 0.12, 0.2], b = [0.4, 0.4, 0.46], c = [0.9, 0.3, 0.3];
      const v: V3[] = [[1.7, 0, 0], [0, 0.4, 0], [0, 0, 0.55], [0, -0.35, 0], [0, 0, -0.55], [-1.3, 0, 0]];
      hull(mb, v, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]], a);
      hull(mb, [[-0.4, 0, -0.5], [-1.0, 0.1, -1.3], [-1.2, 0, -0.5], [-0.7, -0.1, -0.6]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      hull(mb, [[-0.4, 0, 0.5], [-1.0, 0.1, 1.3], [-1.2, 0, 0.5], [-0.7, -0.1, 0.6]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      box(mb, [-1.3, 0, 0], [0.4, 0.3, 0.3], c);
      break;
    }
    case 'reaver': {
      const a = [0.5, 0.25, 0.65], b = [0.3, 0.12, 0.4], c = [0.9, 0.5, 0.2];
      const v: V3[] = [[1.1, 0, 0], [0, 0.6, 0], [0, 0, 1.3], [0, -0.55, 0], [0, 0, -1.3], [-1.3, 0, 0]];
      hull(mb, v, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]], a);
      // claws
      hull(mb, [[0.3, 0, 0.9], [1.6, -0.1, 1.1], [0.6, 0.2, 1.3], [0.4, -0.2, 1.3]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      hull(mb, [[0.3, 0, -0.9], [1.6, -0.1, -1.1], [0.6, 0.2, -1.3], [0.4, -0.2, -1.3]], [[0, 1, 2], [0, 2, 3], [0, 3, 1], [1, 3, 2]], b);
      prism(mb, [-0.5, 0.45, 0], 6, 0.35, 0.3, c);
      break;
    }
    case 'freighter': {
      const a = [0.85, 0.6, 0.3], b = [0.5, 0.5, 0.55], c = [0.35, 0.35, 0.4];
      box(mb, [0, 0, 0], [3.8, 0.8, 1.0], b);
      box(mb, [2.2, 0.1, 0], [0.9, 1.0, 1.2], a);
      box(mb, [-0.6, 0.15, 1.1], [1.6, 1.0, 1.0], a);
      box(mb, [-0.6, 0.15, -1.1], [1.6, 1.0, 1.0], a);
      box(mb, [1.0, 0.15, 1.1], [1.2, 1.0, 1.0], c);
      box(mb, [1.0, 0.15, -1.1], [1.2, 1.0, 1.0], c);
      box(mb, [-2.2, 0, 0.5], [0.6, 0.5, 0.5], c);
      box(mb, [-2.2, 0, -0.5], [0.6, 0.5, 0.5], c);
      break;
    }
    case 'dreadnought': {
      const a = [0.3, 0.36, 0.34], b = [0.2, 0.24, 0.26], c = [0.85, 0.2, 0.15];
      const v: V3[] = [[5.5, 0, 0], [-4.5, 0, -3.8], [-4.5, 0, 3.8], [-1.0, 1.3, 0], [-1.0, -0.9, 0], [-4.8, 0.3, 0]];
      hull(mb, v, [[0, 3, 1], [0, 2, 3], [3, 5, 1], [3, 2, 5], [0, 1, 4], [0, 4, 2], [4, 1, 5], [4, 5, 2]], a);
      prism(mb, [1.0, 1.0, 0], 8, 0.9, 0.5, b, c);
      prism(mb, [-2.5, 1.1, -1.8], 6, 0.7, 0.5, b, c);
      prism(mb, [-2.5, 1.1, 1.8], 6, 0.7, 0.5, b, c);
      box(mb, [-4.6, 0.2, -1.6], [1.2, 0.9, 0.9], b);
      box(mb, [-4.6, 0.2, 1.6], [1.2, 0.9, 0.9], b);
      break;
    }
    case 'shuttle': {
      const a = [0.7, 0.75, 0.6], b = [0.4, 0.42, 0.38];
      const v: V3[] = [[1.0, 0, 0], [-0.7, 0.3, -0.5], [-0.7, 0.3, 0.5], [-0.7, -0.3, 0.5], [-0.7, -0.3, -0.5]];
      hull(mb, v, [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [1, 4, 3, 2]], a);
      box(mb, [-0.8, 0, 0], [0.4, 0.4, 0.8], b);
      break;
    }
    case 'sentinel': {
      const a = [0.4, 0.2, 0.25], b = [0.9, 0.3, 0.2];
      prism(mb, [0, 0, 0], 6, 1.5, 0.5, a, b);
      box(mb, [0.9, 0.3, 0], [1.6, 0.25, 0.25], b);
      prism(mb, [0, 0.45, 0], 6, 0.5, 0.4, b);
      break;
    }
  }
  return mb.build();
}

/** Station mesh. The docking gap in the ring is centred on local +x. */
export function buildStationMesh(st: Station, seed: number): MeshData {
  const mb = new MeshBuilder();
  const rng = new Rng(seed);
  const R = st.radius;
  const kind = st.kind;
  const ringCol = kind === 'harbour' ? [0.6, 0.66, 0.78] : kind === 'refinery' ? [0.75, 0.55, 0.3] : kind === 'research' ? [0.55, 0.75, 0.7] : [0.6, 0.6, 0.55];
  const hubCol = [0.35, 0.38, 0.45];
  const accent = kind === 'harbour' ? [0.9, 0.7, 0.25] : kind === 'refinery' ? [0.9, 0.35, 0.2] : [0.3, 0.9, 0.8];
  const segs = 24;
  const gapHalf = st.bayHalfWidth; // radians; gap centred on local +x
  const thick = R * 0.16, height = R * 0.12;
  // ring segments (skip those inside the gap)
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * TAU + TAU / segs / 2 - 0.015, a1 = ((i + 1) / segs) * TAU + TAU / segs / 2 + 0.015;
    const mid = (a0 + a1) / 2;
    const dm = Math.atan2(Math.sin(mid), Math.cos(mid));
    if (Math.abs(dm) < gapHalf) continue;
    const ri = R - thick / 2, ro = R + thick / 2;
    const pts = (a: number, r: number, y: number): V3 => [Math.cos(a) * r, y, -Math.sin(a) * r];
    const v: V3[] = [pts(a0, ri, -height / 2), pts(a0, ro, -height / 2), pts(a1, ro, -height / 2), pts(a1, ri, -height / 2), pts(a0, ri, height / 2), pts(a0, ro, height / 2), pts(a1, ro, height / 2), pts(a1, ri, height / 2)];
    const c: V3 = [Math.cos(mid) * R, 0, -Math.sin(mid) * R];
    hull(mb, v, [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]], ringCol, c);
  }
  // gap markers: two small pylons
  for (const s of [-1, 1]) {
    const a = s * gapHalf;
    box(mb, [Math.cos(a) * R, 0, -Math.sin(a) * R], [thick * 0.7, height * 2.4, thick * 0.7], accent);
  }
  // hub
  const hubR = R * 0.32;
  prism(mb, [0, 0, 0], kind === 'research' ? 5 : 6, hubR, R * 0.2, hubCol, accent, rng.next() * TAU);
  prism(mb, [0, R * 0.16, 0], 4, hubR * 0.5, R * 0.12, accent, undefined, rng.next() * TAU);
  // spokes to the ring (avoiding the gap direction)
  const spokes = kind === 'refinery' ? 3 : 4;
  for (let i = 0; i < spokes; i++) {
    const a = Math.PI + (i - (spokes - 1) / 2) * (TAU / (spokes + 1)) * 0.9;
    const len = R - hubR - thick / 2;
    const cx = Math.cos(a) * (hubR + len / 2), cz = -Math.sin(a) * (hubR + len / 2);
    // spokes as thin boxes rotated by hand: approximate with segmented boxes
    const n = 4;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const px = Math.cos(a) * (hubR + len * t), pz = -Math.sin(a) * (hubR + len * t);
      box(mb, [px, 0, pz], [len / n * 1.05, R * 0.05, R * 0.05], hubCol);
    }
    void cx; void cz;
  }
  // kind-specific decoration
  if (kind === 'refinery') {
    for (let i = 0; i < 3; i++) {
      const a = Math.PI + (i - 1) * 0.9;
      prism(mb, [Math.cos(a) * R * 0.62, R * 0.05, -Math.sin(a) * R * 0.62], 8, R * 0.09, R * 0.3, accent);
    }
  } else if (kind === 'research') {
    prism(mb, [0, R * 0.3, 0], 3, hubR * 0.8, R * 0.05, accent);
    box(mb, [-R * 0.7, 0, 0], [R * 0.06, R * 0.5, R * 0.06], accent);
  } else if (kind === 'harbour') {
    for (const s of [-1, 1]) box(mb, [-R * 0.55, R * 0.12, s * R * 0.45], [R * 0.25, R * 0.06, R * 0.06], accent);
  }
  return mb.build();
}

/** Small pad beacon marker geometry (a low box), placed on the terrain by the renderer. */
export function buildPadMesh(): MeshData {
  const mb = new MeshBuilder();
  box(mb, [0, 0, 0], [1, 0.3, 1], [0.3, 0.32, 0.36]);
  return mb.build();
}

/** Escape pod / cargo / module pickups. */
export function buildPickupMesh(kind: string): MeshData {
  const mb = new MeshBuilder();
  switch (kind) {
    case 'pod': prism(mb, [0, 0, 0], 6, 0.7, 1.0, [0.85, 0.85, 0.9], [0.9, 0.6, 0.2]); break;
    case 'ore': { const { verts, faces } = icosphere(0); hull(mb, verts.map(v => v.map(x => x * 0.55)), faces, [0.8, 0.65, 0.3]); break; }
    case 'salvage': box(mb, [0, 0, 0], [0.9, 0.5, 0.6], [0.6, 0.65, 0.7]); break;
    case 'fuel': prism(mb, [0, 0, 0], 8, 0.5, 0.9, [0.3, 0.8, 0.9]); break;
    case 'module': { const { verts, faces } = icosphere(1); hull(mb, verts.map(v => v.map(x => x * 0.7)), faces, [1.0, 0.85, 0.4]); break; }
    case 'wreck': box(mb, [0, 0, 0], [3.5, 0.7, 1.2], [0.35, 0.36, 0.4]); box(mb, [1.2, 0.3, 0.8], [1.0, 0.8, 0.8], [0.3, 0.3, 0.32]); break;
  }
  return mb.build();
}
