// Vector stroke font. Every glyph is a set of polylines on a 5x7 grid (x 0..4, y 0..6, y down).
// Encoded as points "xy" separated by spaces; strokes separated by "/".
import type { LineBatch } from './lines';

const GLYPHS: Record<string, string> = {
  'A': '06 02 20 42 46/03 43',
  'B': '06 00 30 41 42 33 03/33 44 45 36 06',
  'C': '41 30 10 01 05 16 36 45',
  'D': '06 00 30 41 45 36 06',
  'E': '40 00 06 46/03 23',
  'F': '40 00 06/03 23',
  'G': '41 30 10 01 05 16 36 45 43 23',
  'H': '00 06/40 46/03 43',
  'I': '10 30/20 26/16 36',
  'J': '40 45 36 16 05',
  'K': '00 06/40 03 46',
  'L': '00 06 46',
  'M': '06 00 23 40 46',
  'N': '06 00 46 40',
  'O': '10 30 41 45 36 16 05 01 10',
  'P': '06 00 30 41 42 33 03',
  'Q': '10 30 41 45 36 16 05 01 10/24 46',
  'R': '06 00 30 41 42 33 03/23 46',
  'S': '41 30 10 01 02 13 33 44 45 36 16 05',
  'T': '00 40/20 26',
  'U': '00 05 16 36 45 40',
  'V': '00 26 40',
  'W': '00 06 23 46 40',
  'X': '00 46/40 06',
  'Y': '00 23 40/23 26',
  'Z': '00 40 06 46',
  '0': '10 30 41 45 36 16 05 01 10/15 31',
  '1': '11 20 26/16 36',
  '2': '01 10 30 41 42 06 46',
  '3': '01 10 30 41 42 33 23/33 44 45 36 16 05',
  '4': '30 04 44/30 36',
  '5': '40 00 02 32 43 45 36 16 05',
  '6': '41 30 10 01 05 16 36 45 44 33 13 04',
  '7': '00 40 16',
  '8': '10 30 41 42 33 13 02 01 10/13 04 05 16 36 45 44 33',
  '9': '05 16 36 45 41 30 10 01 02 13 33 42',
  '.': '25 26',
  ',': '26 17',
  ':': '22 23/25 26',
  ';': '22 23/25 26 17',
  '!': '20 24/25 26',
  '?': '01 10 30 41 42 23 24/25 26',
  '-': '03 43',
  '+': '13 33/21 25',
  '/': '06 40',
  '\\': '00 46',
  '(': '30 11 15 36',
  ')': '10 31 35 16',
  '[': '30 10 16 36',
  ']': '10 30 36 16',
  "'": '20 22',
  '"': '10 12/30 32',
  '%': '06 40/00 10 11 01 00/35 45 46 36 35',
  '<': '40 03 46',
  '>': '00 43 06',
  '=': '02 42/04 44',
  '*': '20 26/03 43/01 45/41 05',
  '#': '10 16/30 36/02 42/04 44',
  '&': '46 01 10 21 12 05 16 36 44',
  '_': '06 46',
  '^': '02 20 42',
  '|': '20 26',
  '~': '03 12 32 43',
  '$': '20 26/41 30 10 01 02 13 33 44 45 36 16 05',
  '@': '43 32 22 13 14 25 35 44/44 45 36 16 05 01 10 30 41 44',
  '°': '10 20 21 11 10',
  '·': '23 24',
  '{': '30 20 12 03 14 25 26 36',
  '}': '10 20 22 33 24 25 26 16',
};

interface Glyph { strokes: number[][]; }
const cache = new Map<string, Glyph>();
function glyph(ch: string): Glyph | null {
  const c = ch.toUpperCase();
  let g = cache.get(c);
  if (g) return g;
  const def = GLYPHS[c];
  if (!def) return null;
  const strokes = def.split('/').map(s => {
    const pts: number[] = [];
    for (const p of s.trim().split(/\s+/)) {
      pts.push(parseInt(p[0], 10), parseInt(p[1], 10));
    }
    return pts;
  });
  g = { strokes };
  cache.set(c, g);
  return g;
}

export const GLYPH_W = 5;
export const GLYPH_H = 7;
export const GLYPH_ADV = 6.5;

/** Width in pixels of a string at the given pixel height. */
export function textWidth(text: string, size: number): number {
  const s = size / GLYPH_H;
  return Math.max(0, text.length * GLYPH_ADV * s - (GLYPH_ADV - GLYPH_W) * s);
}

export type Align = 'left' | 'center' | 'right';

/**
 * Emit a string as 2D line segments into a batch. (x, y) is the top-left of the text box
 * (y down, screen pixels). size is the cap height in pixels.
 */
export function drawText(batch: LineBatch, text: string, x: number, y: number, size: number, r: number, g: number, b: number, a = 1, align: Align = 'left', width = 1.5): number {
  const s = size / GLYPH_H;
  const w = textWidth(text, size);
  let cx = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== ' ') {
      const gl = glyph(ch);
      if (gl) {
        for (const st of gl.strokes) {
          if (st.length === 2) {
            // dot: tiny segment
            batch.line2(cx + st[0] * s, y + st[1] * s, cx + st[0] * s + 0.01, y + st[1] * s + s * 0.5, r, g, b, a, width);
            continue;
          }
          for (let k = 0; k + 3 < st.length; k += 2) {
            batch.line2(cx + st[k] * s, y + st[k + 1] * s, cx + st[k + 2] * s, y + st[k + 3] * s, r, g, b, a, width);
          }
        }
      }
    }
    cx += GLYPH_ADV * s;
  }
  return w;
}

/** Draw text in the world plane (sim coordinates, y up) — useful for labels attached to objects. */
export function drawTextWorld(batch: LineBatch, text: string, wx: number, wy: number, wz: number, size: number, r: number, g: number, b: number, a = 1, align: Align = 'center', width = 1.5): void {
  const s = size / GLYPH_H;
  const w = textWidth(text, size);
  let cx = align === 'left' ? wx : align === 'center' ? wx - w / 2 : wx - w;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== ' ') {
      const gl = glyph(ch);
      if (gl) {
        for (const st of gl.strokes) {
          if (st.length === 2) {
            batch.seg(cx + st[0] * s, wy, wz + st[1] * s, cx + st[0] * s + 0.01, wy, wz + st[1] * s + s * 0.5, r, g, b, a, width);
            continue;
          }
          for (let k = 0; k + 3 < st.length; k += 2) {
            batch.seg(cx + st[k] * s, wy, wz + st[k + 1] * s, cx + st[k + 2] * s, wy, wz + st[k + 3] * s, r, g, b, a, width);
          }
        }
      }
    }
    cx += GLYPH_ADV * s;
  }
}
