// Pixelpuffer und Rasterisierung ohne Kantenglättung.

export type Color = number; // 0xAABBGGRR (Little Endian ImageData)

export function rgb(r: number, g: number, b: number, a = 255): Color {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function hex(h: string): Color {
  const v = parseInt(h.slice(1), 16);
  return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255);
}

export function mul(c: Color, f: number): Color {
  const r = Math.min(255, Math.round((c & 255) * f));
  const g = Math.min(255, Math.round(((c >>> 8) & 255) * f));
  const b = Math.min(255, Math.round(((c >>> 16) & 255) * f));
  return rgb(r, g, b, c >>> 24);
}

export function mix(a: Color, b: Color, t: number): Color {
  const f = (s: number) => Math.round(((a >>> s) & 255) * (1 - t) + ((b >>> s) & 255) * t);
  return rgb(f(0), f(8), f(16), f(24));
}

export function alpha(c: Color, a: number): Color {
  return ((c & 0xffffff) | (a << 24)) >>> 0;
}

export function ramp(...hexes: string[]): Color[] {
  return hexes.map(hex);
}

export class PixBuf {
  readonly data: Uint32Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint32Array(w * h);
  }
  set(x: number, y: number, c: Color): void {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (c >>> 24 === 255) this.data[y * this.w + x] = c;
    else if (c >>> 24) {
      const d = this.data[y * this.w + x];
      if (!(d >>> 24)) this.data[y * this.w + x] = c;
      else this.data[y * this.w + x] = mix(d, c | 0xff000000, (c >>> 24) / 255) | 0xff000000;
    }
  }
  get(x: number, y: number): Color {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[y * this.w + x];
  }
  rect(x: number, y: number, w: number, h: number, c: Color): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: Color): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  toCanvas(): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(this.w, this.h);
    new Uint32Array(img.data.buffer).set(this.data);
    ctx.putImageData(img, 0, 0);
    return cv;
  }
}

export type Pt = [number, number];
export type Shader = (u: number, v: number, px: number, py: number) => Color;

/**
 * Füllt ein Dreieck. uv-Koordinaten werden linear interpoliert.
 * Pixelmittelpunkte innerhalb (inkl. Kante) werden gezeichnet, damit keine Lücken entstehen.
 */
export function triangle(buf: PixBuf, p0: Pt, p1: Pt, p2: Pt, t0: Pt, t1: Pt, t2: Pt, shader: Shader): void {
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(buf.w - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(buf.h - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  if (Math.abs(area) < 1e-6) return;
  const eps = -1e-4;
  for (let y = minY; y <= maxY; y++) {
    const cy = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      let w0 = ((p1[0] - cx) * (p2[1] - cy) - (p1[1] - cy) * (p2[0] - cx)) / area;
      let w1 = ((p2[0] - cx) * (p0[1] - cy) - (p2[1] - cy) * (p0[0] - cx)) / area;
      let w2 = 1 - w0 - w1;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      w0 = Math.max(0, w0);
      w1 = Math.max(0, w1);
      w2 = Math.max(0, w2);
      const u = w0 * t0[0] + w1 * t1[0] + w2 * t2[0];
      const v = w0 * t0[1] + w1 * t1[1] + w2 * t2[1];
      const c = shader(u, v, x, y);
      if (c >>> 24) buf.set(x, y, c);
    }
  }
}

/** Viereck p0..p3 mit uv (0,0),(1,0),(1,1),(0,1). */
export function quad(buf: PixBuf, p0: Pt, p1: Pt, p2: Pt, p3: Pt, shader: Shader): void {
  triangle(buf, p0, p1, p2, [0, 0], [1, 0], [1, 1], shader);
  triangle(buf, p0, p2, p3, [0, 0], [1, 1], [0, 1], shader);
}
