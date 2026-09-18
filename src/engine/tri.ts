// Polygon triangulation by ear clipping, for simple (non-self-crossing) outlines that may carry
// collinear or duplicated vertices from splitting. Returns triangle vertex indices into the input.
import type { V2 } from './math';

function area2(a: V2, b: V2, c: V2): number { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }

function inTri(p: V2, a: V2, b: V2, c: V2): boolean {
  const s1 = area2(a, b, p), s2 = area2(b, c, p), s3 = area2(c, a, p);
  return (s1 >= -1e-9 && s2 >= -1e-9 && s3 >= -1e-9) || (s1 <= 1e-9 && s2 <= 1e-9 && s3 <= 1e-9);
}

export function triangulate(poly: V2[]): number[] {
  const n = poly.length;
  const out: number[] = [];
  if (n < 3) return out;
  // orientation: make the working list counter-clockwise
  let signed = 0;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; signed += a.x * b.y - b.x * a.y; }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(signed >= 0 ? i : n - 1 - i);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    let flattest = -1, flatArea = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      const ar = area2(a, b, c);
      if (Math.abs(ar) < flatArea) { flatArea = Math.abs(ar); flattest = k; }
      if (ar <= 1e-9) continue; // reflex or flat: not an ear
      let empty = true;
      for (let j = 0; j < idx.length && empty; j++) {
        const q = idx[j];
        if (q === i0 || q === i1 || q === i2) continue;
        const p = poly[q];
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y)) continue;
        if (inTri(p, a, b, c)) empty = false;
      }
      if (!empty) continue;
      out.push(i0, i1, i2);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // no clean ear (collinear runs, tiny slivers): drop the flattest corner, which loses no area worth drawing
      if (flattest < 0) break;
      const i0 = idx[(flattest - 1 + idx.length) % idx.length], i1 = idx[flattest], i2 = idx[(flattest + 1) % idx.length];
      if (flatArea > 1e-6) out.push(i0, i1, i2);
      idx.splice(flattest, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
