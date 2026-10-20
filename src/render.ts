// Isometrische Darstellung mit Chunk-Zwischenspeicher.

import { BLD_MAX_H, BUILDINGS, CHUNK, HH, HS, HW, MAXH, NET_POWER, NET_ROAD, Zone } from './config';
import { Animator } from './anim';
import { alpha, Color, hex, rgb } from './pix';
import { hash2 } from './rng';
import type { Simulation } from './sim';
import { Sprite, SpriteCache, spritePixels } from './sprites';
import { World } from './world';

export type Overlay = 'power' | 'water' | 'landValue' | 'pollution' | 'crime' | 'traffic' | 'police' | 'fire' | 'edu' | 'health';

export const OVERLAYS: { key: Overlay; label: string }[] = [
  { key: 'power', label: 'Strom' },
  { key: 'water', label: 'Wasser' },
  { key: 'landValue', label: 'Bodenwert' },
  { key: 'pollution', label: 'Verschmutzung' },
  { key: 'crime', label: 'Kriminalität' },
  { key: 'traffic', label: 'Verkehr' },
  { key: 'police', label: 'Polizei' },
  { key: 'fire', label: 'Feuerschutz' },
  { key: 'edu', label: 'Bildung' },
  { key: 'health', label: 'Gesundheit' },
];

export interface Preview {
  tiles: number[];
  ok: boolean;
  building?: { key: string; x: number; y: number };
}

const TOP_MARGIN = MAXH * HS + BLD_MAX_H + 72;

// Streifenzuordnung für mehrfeldrige Gebäude: für jede Größe und Kachel (dx,dy) die Spaltenindizes c (-S..S-1)
const STRIPS: Map<number, number[][][]> = new Map();
function stripsFor(S: number): number[][][] {
  let res = STRIPS.get(S);
  if (res) return res;
  const owner: Record<number, [number, number]> = {};
  for (let c = -S; c < S; c++) {
    let best: [number, number] | null = null;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const covers = dx - dy - 1 === c || dx - dy === c;
        if (!covers) continue;
        if (!best || dx + dy > best[0] + best[1]) best = [dx, dy];
      }
    owner[c] = best!;
  }
  res = [];
  for (let dy = 0; dy < S; dy++) {
    res.push([]);
    for (let dx = 0; dx < S; dx++) {
      res[dy].push([]);
      for (let c = -S; c < S; c++) if (owner[c][0] === dx && owner[c][1] === dy) res[dy][dx].push(c);
    }
  }
  STRIPS.set(S, res);
  return res;
}

export class Renderer {
  readonly sprites = new SpriteCache();
  readonly OX: number;
  readonly OY: number;
  readonly worldW: number;
  readonly worldH: number;
  private cols: number;
  private rows: number;
  private chunks: (HTMLCanvasElement | null)[];
  /** Tiefenpuffer je Chunk: 2·(x+y)+1 für Gelände, +2 für Objekte, 0 = leer. */
  private depth: (Uint16Array | null)[];
  private curDepth: Uint16Array | null = null;
  private curCx = 0;
  private curCy = 0;
  private dirty: Uint8Array;
  private chunkTiles: Int32Array[];
  private tileChunks: Int32Array[];
  overlay: Overlay | null = null;
  cam = { x: 0, y: 0, z: 2 };
  shake = 0;
  preview: Preview | null = null;
  hover = -1;
  private ctx: CanvasRenderingContext2D;
  private unpowered: number[] = [];
  private dry: number[] = [];
  private unpoweredAt = 0;
  sim: Simulation | null = null;
  private fx: Animator;
  private layer = new PixLayer();

  constructor(
    public wd: World,
    public canvas: HTMLCanvasElement,
  ) {
    this.OX = wd.h * HW + 16;
    this.OY = TOP_MARGIN;
    this.worldW = (wd.w + wd.h) * HW + 32;
    this.worldH = (wd.w + wd.h) * HH + TOP_MARGIN + HS * 2 + 32;
    this.cols = Math.ceil(this.worldW / CHUNK);
    this.rows = Math.ceil(this.worldH / CHUNK);
    const nc = this.cols * this.rows;
    this.chunks = new Array(nc).fill(null);
    this.depth = new Array(nc).fill(null);
    this.dirty = new Uint8Array(nc).fill(1);
    this.ctx = canvas.getContext('2d')!;
    this.sprites.grid = wd.settings.grid;

    // Kachel-Chunk-Zuordnung in Zeichenreihenfolge
    const lists: number[][] = Array.from({ length: nc }, () => []);
    const tc: number[][] = Array.from({ length: wd.w * wd.h }, () => []);
    for (let d = 0; d <= wd.w + wd.h - 2; d++) {
      for (let x = Math.max(0, d - wd.h + 1); x <= Math.min(wd.w - 1, d); x++) {
        const y = d - x;
        const i = wd.idx(x, y);
        const cx = (x - y) * HW + this.OX;
        const cy = (x + y) * HH + this.OY;
        const x0 = cx - HW - 4;
        const x1 = cx + HW + 4;
        const y0 = cy - TOP_MARGIN;
        const y1 = cy + 2 * HH + HS + 24;
        const c0 = Math.max(0, Math.floor(x0 / CHUNK));
        const c1 = Math.min(this.cols - 1, Math.floor(x1 / CHUNK));
        const r0 = Math.max(0, Math.floor(y0 / CHUNK));
        const r1 = Math.min(this.rows - 1, Math.floor(y1 / CHUNK));
        for (let r = r0; r <= r1; r++)
          for (let c = c0; c <= c1; c++) {
            const ci = r * this.cols + c;
            lists[ci].push(i);
            tc[i].push(ci);
          }
      }
    }
    this.chunkTiles = lists.map((l) => Int32Array.from(l));
    this.tileChunks = tc.map((l) => Int32Array.from(l));
    wd.onTileChanged = (i) => this.invalidateTile(i);
    this.centerOn(wd.w / 2, wd.h / 2);
    this.fx = new Animator(this);
  }

  // ---------------- Pixelebene für bewegte Objekte ----------------

  dot(wx: number, wy: number, dmax: number, c: Color): void {
    const L = this.layer;
    wx = Math.round(wx);
    wy = Math.round(wy);
    const lx = wx - L.x0;
    const ly = wy - L.y0;
    if (lx < 0 || ly < 0 || lx >= L.w || ly >= L.h) return;
    if (wx >= 0 && wy >= 0) {
      const cc = wx >> 8;
      if (cc < this.cols) {
        const db = this.depth[(wy >> 8) * this.cols + cc];
        if (db && db[((wy & 255) << 8) | (wx & 255)] > dmax) return;
      }
    }
    L.plot(lx, ly, c);
  }

  blit(s: Sprite, x: number, y: number, dmax: number): void {
    const px = spritePixels(s);
    const W = s.cv.width;
    const left = Math.round(x - s.ax);
    const top = Math.round(y - s.ay);
    for (let j = 0; j < s.cv.height; j++)
      for (let k = 0; k < W; k++) {
        const c = px[j * W + k];
        if (c >>> 24) this.dot(left + k, top + j, dmax, c);
      }
  }

  fireSprite(frame: number): Sprite {
    return this.sprites.fire(frame);
  }

  invalidateTile(i: number): void {
    for (const c of this.tileChunks[i]) this.dirty[c] = 1;
  }

  invalidateAll(): void {
    this.dirty.fill(1);
  }

  setOverlay(o: Overlay | null): void {
    this.overlay = o;
    this.invalidateAll();
  }

  setGrid(g: boolean): void {
    this.sprites.grid = g;
    this.invalidateAll();
  }

  /** Bildschirmposition der Nordecke einer Kachel auf Höhe h in Weltpixeln. */
  tileN(x: number, y: number, h: number): [number, number] {
    return [(x - y) * HW + this.OX, (x + y) * HH + this.OY - h * HS];
  }

  /** Weltpixel eines Punktes innerhalb der Kachel (u,v in 0..1) auf Geländehöhe. */
  groundPt(x: number, y: number, u: number, v: number): [number, number] {
    const wd = this.wd;
    const [n, e, s, w] = wd.tileCorners(x, y);
    const h = n * (1 - u) * (1 - v) + e * u * (1 - v) + s * u * v + w * (1 - u) * v;
    return [(x + u - (y + v)) * HW + this.OX, (x + u + y + v) * HH + this.OY - h * HS];
  }

  centerOn(tx: number, ty: number): void {
    const wd = this.wd;
    const x = Math.max(0, Math.min(wd.w - 1, Math.floor(tx)));
    const y = Math.max(0, Math.min(wd.h - 1, Math.floor(ty)));
    const p = this.groundPt(x, y, tx - x, ty - y);
    this.cam.x = p[0];
    this.cam.y = p[1];
  }

  /** Mittelpunkt der Ansicht als Kachelkoordinate (ungefähr). */
  centerTile(): [number, number] {
    const i = this.pickWorld(this.cam.x, this.cam.y);
    if (i >= 0) return [i % this.wd.w, (i / this.wd.w) | 0];
    return [this.wd.w / 2, this.wd.h / 2];
  }

  clampCam(): void {
    this.cam.x = Math.max(0, Math.min(this.worldW, this.cam.x));
    this.cam.y = Math.max(this.OY - 40, Math.min(this.worldH, this.cam.y));
  }

  // ---------------- Zeichnen einzelner Kacheln ----------------

  surfaceKey(i: number): string {
    const wd = this.wd;
    if (wd.isWater(i)) return 'water';
    if (wd.net[i] & NET_ROAD) return `road:${wd.netMask(i, NET_ROAD)}`;
    if (wd.rubble[i]) return 'rubble';
    if (wd.zone[i]) return wd.level[i] ? `lot:${wd.zone[i]}` : `zone:${wd.zone[i]}:${wd.dense[i]}`;
    if (wd.bld[i]) {
      const k = wd.bldDef(i)!.key;
      if (k === 'park' || k === 'bigpark') return 'lawn';
      if (k === 'airport') return 'tarmac';
      if (k === 'coal' || k === 'solar') return 'dirt';
      return 'pave';
    }
    if (wd.maxH(i) >= MAXH - 1) return 'rock';
    return 'grass';
  }

  private overlayValue(i: number): number {
    const wd = this.wd;
    switch (this.overlay) {
      case 'power':
        if (!wd.isConductor(i)) return -1;
        return wd.powered[i] ? 200 : 0;
      case 'water':
        if (!wd.isWaterConductor(i)) return -1;
        return wd.watered[i] ? 200 : 0;
      case 'landValue':
        return wd.isWater(i) ? -1 : wd.landValue[i];
      case 'pollution':
        return wd.pollution[i];
      case 'crime':
        return wd.crime[i];
      case 'traffic':
        return wd.isRoad(i) ? wd.traffic[i] : -1;
      case 'police':
        return wd.covPolice[i];
      case 'fire':
        return wd.covFire[i];
      case 'edu':
        return wd.covEdu[i];
      case 'health':
        return wd.covHealth[i];
      default:
        return -1;
    }
  }

  private overlayColor(v: number): Color {
    const q = Math.min(7, Math.floor(v / 32));
    const good = this.overlay === 'landValue' || this.overlay === 'police' || this.overlay === 'fire' || this.overlay === 'edu' || this.overlay === 'health' || this.overlay === 'power' || this.overlay === 'water';
    const t = good ? q / 7 : 1 - q / 7;
    // rot -> gelb -> grün
    const r = t < 0.5 ? 230 : Math.round(230 - (t - 0.5) * 2 * 170);
    const g = t < 0.5 ? Math.round(60 + t * 2 * 170) : 220;
    return alpha(rgb(r, g, 50), 150);
  }

  private drawSprite(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number): void {
    ctx.drawImage(s.cv, Math.round(x - s.ax), Math.round(y - s.ay));
  }

  /** Zeichnet ein Sprite in den Chunk und trägt seine deckenden Pixel mit Tiefe d in den Tiefenpuffer ein. */
  private put(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, d: number): void {
    const left = Math.round(x - s.ax);
    const top = Math.round(y - s.ay);
    ctx.drawImage(s.cv, left, top);
    this.stamp(s, left, top, d, 0, s.cv.width);
  }

  private stamp(s: Sprite, left: number, top: number, d: number, sx0: number, sw: number): void {
    const db = this.curDepth;
    if (!db) return;
    const px = spritePixels(s);
    const W = s.cv.width;
    const H = s.cv.height;
    const ox = left - this.curCx;
    const oy = top - this.curCy;
    const xa = Math.max(sx0, -ox);
    const xb = Math.min(sx0 + sw, CHUNK - ox, W);
    const ya = Math.max(0, -oy);
    const yb = Math.min(H, CHUNK - oy);
    for (let y = ya; y < yb; y++) {
      const row = y * W;
      const drow = (y + oy) * CHUNK + ox;
      for (let x = xa; x < xb; x++) if (px[row + x] >>> 24 > 128) db[drow + x] = d;
    }
  }

  private drawTile(ctx: CanvasRenderingContext2D, i: number): void {
    const wd = this.wd;
    const x = i % wd.w;
    const y = (i / wd.w) | 0;
    const [n, e, s, w] = wd.tileCorners(x, y);
    const b = Math.min(n, e, s, w);
    const [Nx, Ny] = this.tileN(x, y, b);
    const variant = (hash2(x, y, 5) * 4) | 0;
    const surf = this.surfaceKey(i);
    const sp = this.sprites;
    const dg = (x + y) * 2 + 1; // Tiefe Gelände
    const dobj = dg + 1; // Tiefe Objekte
    this.put(ctx, sp.terrain(n - b, e - b, s - b, w - b, surf, variant), Nx, Ny, dg);

    // Kartenrand
    const midY = (x + y) * HH + this.OY + HH;
    if (x === wd.w - 1) {
      this.put(ctx, sp.skirt(0, s, e, wd.isWater(i)), Nx, midY, dg);
    }
    if (y === wd.h - 1) {
      this.put(ctx, sp.skirt(1, w, s, wd.isWater(i)), Nx - HW, midY, dg);
    }

    if (this.overlay) {
      const v = this.overlayValue(i);
      if (v >= 0) this.drawSprite(ctx, sp.tint(n - b, e - b, s - b, w - b, this.overlayColor(v)), Nx, Ny);
      if (this.overlay === 'water' && wd.pipe[i]) this.drawSprite(ctx, sp.terrain(n - b, e - b, s - b, w - b, `pipe:${this.pipeMask(i)}`, 0), Nx, Ny);
    }

    // Objekte
    const net = wd.net[i];
    if (net & NET_ROAD && wd.isWater(i)) this.put(ctx, sp.bridge(wd.netMask(i, NET_ROAD)), Nx, Ny, dobj);
    if (wd.bld[i]) {
      const def = wd.bldDef(i)!;
      const o = wd.origin[i];
      const ox = o % wd.w;
      const oy = (o / wd.w) | 0;
      const spr = sp.building(def);
      const oh = wd.minH(o);
      const [ONx, ONy] = this.tileN(ox, oy, oh);
      if (def.size === 1) this.put(ctx, spr, ONx, ONy, dobj);
      else {
        const strips = stripsFor(def.size)[y - oy][x - ox];
        const left = Math.round(ONx - spr.ax);
        const top = Math.round(ONy - spr.ay);
        for (const c of strips) {
          const sx = (def.size + c) * HW;
          ctx.drawImage(spr.cv, sx, 0, HW, spr.cv.height, left + sx, top, HW, spr.cv.height);
          this.stamp(spr, left, top, dobj, sx, HW);
        }
      }
      return;
    }
    if (this.overlay) {
      if (net & NET_POWER) this.drawPower(ctx, i, n, e, s, w, b, Nx, Ny, dobj);
      return;
    }
    if (wd.zone[i] && wd.level[i] && !wd.rubble[i]) {
      this.put(ctx, sp.zone(wd.zone[i] as Zone, wd.level[i], wd.variant[i]), Nx, Ny, dobj);
    } else if (wd.tree[i] && !net) {
      const pts = TREE_PTS[Math.min(3, wd.tree[i]) - 1];
      for (let k = 0; k < pts.length; k++) {
        const p = this.groundPt(x, y, pts[k][0], pts[k][1]);
        this.put(ctx, sp.tree(((hash2(x, y, k) * 40) | 0) + k), p[0], p[1], dobj);
      }
    }
    if (net & NET_POWER) this.drawPower(ctx, i, n, e, s, w, b, Nx, Ny, dobj);
  }

  /** Rohrverbindungen zu Nachbarn mit Rohr, Zone oder Gebäude. */
  private pipeMask(i: number): number {
    const wd = this.wd;
    const x = i % wd.w;
    const y = (i / wd.w) | 0;
    let m = 0;
    if (y > 0 && wd.isWaterConductor(i - wd.w)) m |= 1;
    if (x < wd.w - 1 && wd.isWaterConductor(i + 1)) m |= 2;
    if (y < wd.h - 1 && wd.isWaterConductor(i + wd.w)) m |= 4;
    if (x > 0 && wd.isWaterConductor(i - 1)) m |= 8;
    return m;
  }

  private drawPower(ctx: CanvasRenderingContext2D, i: number, n: number, e: number, s: number, w: number, b: number, Nx: number, Ny: number, d: number): void {
    const wd = this.wd;
    const water = wd.isWater(i);
    const lift = water ? HS : 0;
    const rel = (h: number) => (h - b) * HS + lift;
    const hc = rel((n + e + s + w) / 4);
    const he = [rel((n + e) / 2), rel((e + s) / 2), rel((s + w) / 2), rel((w + n) / 2)];
    const mask = wd.netMask(i, NET_POWER);
    this.put(ctx, this.sprites.power(mask, Math.round(hc), he.map(Math.round), (wd.net[i] & NET_ROAD) !== 0), Nx, Ny, d);
  }

  private renderChunk(ci: number): HTMLCanvasElement {
    let cv = this.chunks[ci];
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = CHUNK;
      cv.height = CHUNK;
      this.chunks[ci] = cv;
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, CHUNK, CHUNK);
    const cx = (ci % this.cols) * CHUNK;
    const cy = Math.floor(ci / this.cols) * CHUNK;
    ctx.setTransform(1, 0, 0, 1, -cx, -cy);
    ctx.imageSmoothingEnabled = false;
    let db = this.depth[ci];
    if (!db) db = this.depth[ci] = new Uint16Array(CHUNK * CHUNK);
    else db.fill(0);
    this.curDepth = db;
    this.curCx = cx;
    this.curCy = cy;
    for (const i of this.chunkTiles[ci]) this.drawTile(ctx, i);
    this.curDepth = null;
    this.dirty[ci] = 0;
    return cv;
  }

  // ---------------- Bild ----------------

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  frame(time: number): void {
    const ctx = this.ctx;
    const cv = this.canvas;
    const z = this.cam.z;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1a2b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    let sx = 0;
    let sy = 0;
    if (this.shake > 0) {
      sx = (Math.random() - 0.5) * 12 * this.shake;
      sy = (Math.random() - 0.5) * 8 * this.shake;
      this.shake = Math.max(0, this.shake - 0.02);
    }
    const tx = Math.round(cv.width / 2 - this.cam.x * z + sx);
    const ty = Math.round(cv.height / 2 - this.cam.y * z + sy);
    ctx.imageSmoothingEnabled = false;

    const vx0 = -tx / z;
    const vy0 = -ty / z;
    const vx1 = vx0 + cv.width / z;
    const vy1 = vy0 + cv.height / z;
    const c0 = Math.max(0, Math.floor(vx0 / CHUNK));
    const c1 = Math.min(this.cols - 1, Math.floor(vx1 / CHUNK));
    const r0 = Math.max(0, Math.floor(vy0 / CHUNK));
    const r1 = Math.min(this.rows - 1, Math.floor(vy1 / CHUNK));
    let budget = 24; // max. neu gezeichnete Chunks pro Bild
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const ci = r * this.cols + c;
        let ch = this.chunks[ci];
        if (!ch || (this.dirty[ci] && budget > 0)) {
          ch = this.renderChunk(ci);
          budget--;
        }
        const dx = tx + c * CHUNK * z;
        const dy = ty + r * CHUNK * z;
        // Ganzzahlige Kanten vermeiden Lücken zwischen Chunks
        const nx = Math.round(tx + (c + 1) * CHUNK * z);
        const ny = Math.round(ty + (r + 1) * CHUNK * z);
        ctx.drawImage(ch, Math.round(dx), Math.round(dy), nx - Math.round(dx), ny - Math.round(dy));
      }

    ctx.setTransform(z, 0, 0, z, tx, ty);
    ctx.imageSmoothingEnabled = false;
    this.drawDynamic(ctx, time, vx0, vy0, vx1, vy1);
  }

  private visibleTiles(vx0: number, vy0: number, vx1: number, vy1: number): [number, number, number, number] {
    // grobe Kachelgrenzen des sichtbaren Bereichs
    const toTile = (px: number, py: number): [number, number] => {
      const rx = (px - this.OX) / HW;
      const ry = (py - this.OY) / HH;
      return [(ry + rx) / 2, (ry - rx) / 2];
    };
    const pts = [toTile(vx0, vy0 - 20), toTile(vx1, vy0 - 20), toTile(vx0, vy1 + MAXH * HS + 20), toTile(vx1, vy1 + MAXH * HS + 20)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [
      Math.max(0, Math.floor(Math.min(...xs)) - 1),
      Math.max(0, Math.floor(Math.min(...ys)) - 1),
      Math.min(this.wd.w - 1, Math.ceil(Math.max(...xs)) + 1),
      Math.min(this.wd.h - 1, Math.ceil(Math.max(...ys)) + 1),
    ];
  }

  private drawDynamic(ctx: CanvasRenderingContext2D, time: number, vx0: number, vy0: number, vx1: number, vy1: number): void {
    const wd = this.wd;
    const [x0, y0, x1, y1] = this.visibleTiles(vx0, vy0, vx1, vy1);
    const sp = this.sprites;
    const t = time / 1000;

    // Bewegte Objekte mit Verdeckung durch den Tiefenpuffer
    const lw = Math.ceil(vx1) - Math.floor(vx0);
    const lh = Math.ceil(vy1) - Math.floor(vy0);
    if (!this.overlay && lw * lh <= 4_500_000) {
      this.layer.begin(Math.floor(vx0), Math.floor(vy0), lw, lh);
      this.fx.draw(time, x0, y0, x1, y1);
      this.layer.flush(ctx);
    } else if (this.sim && this.sim.burning.size) {
      const frame = Math.floor(t * 8) % 4;
      for (const i of this.sim.burning) {
        const x = i % wd.w;
        const y = (i / wd.w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const g = this.groundPt(x, y, 0.5, 0.5);
        this.drawSprite(ctx, sp.fire((frame + i) % 4), g[0], g[1] + 4);
      }
    }

    // Stromsymbol
    if (time - this.unpoweredAt > 1000) {
      this.unpoweredAt = time;
      this.unpowered = [];
      this.dry = [];
      for (let i = 0; i < wd.w * wd.h; i++) {
        if (!wd.powered[i]) {
          if ((wd.zone[i] && wd.level[i]) || (wd.bld[i] && wd.origin[i] === i && wd.bldDef(i)!.cat !== 'park')) this.unpowered.push(i);
        } else if (!wd.watered[i] && wd.zone[i] && wd.level[i] >= 3) this.dry.push(i);
      }
    }
    if (Math.floor(t * 1.5) % 2 === 1) {
      const drop = sp.drop();
      for (const i of this.dry) {
        const x = i % wd.w;
        const y = (i / wd.w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const g = this.groundPt(x, y, 0.5, 0.5);
        this.drawSprite(ctx, drop, g[0], g[1] - 14);
      }
    }
    if (Math.floor(t * 1.5) % 2 === 0) {
      const bolt = sp.bolt();
      for (const i of this.unpowered) {
        const x = i % wd.w;
        const y = (i / wd.w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const g = this.groundPt(x, y, 0.5, 0.5);
        this.drawSprite(ctx, bolt, g[0], g[1] - 14);
      }
    }

    // Tornado
    if (this.sim && this.sim.tornado) {
      const tor = this.sim.tornado;
      const x = Math.max(0, Math.min(wd.w - 1, Math.floor(tor.x)));
      const y = Math.max(0, Math.min(wd.h - 1, Math.floor(tor.y)));
      const g = this.groundPt(x, y, tor.x - x, tor.y - y);
      this.drawSprite(ctx, sp.tornado(Math.floor(t * 10) % 6), g[0], g[1]);
    }

    // Vorschau
    const pv = this.preview;
    if (pv) {
      const col = pv.ok ? hex('#ffffff') : hex('#ff3030');
      const fill = pv.ok ? alpha(hex('#ffffff'), 70) : alpha(hex('#ff3030'), 90);
      for (const i of pv.tiles) {
        const x = i % wd.w;
        const y = (i / wd.w) | 0;
        const [n, e, s, w] = wd.tileCorners(x, y);
        const b = Math.min(n, e, s, w);
        const [Nx, Ny] = this.tileN(x, y, b);
        this.drawSprite(ctx, sp.tint(n - b, e - b, s - b, w - b, fill), Nx, Ny);
        this.drawSprite(ctx, sp.outline(n - b, e - b, s - b, w - b, col), Nx, Ny);
      }
      if (pv.building && pv.ok) {
        const def = BUILDINGS.find((d) => d.key === pv.building!.key)!;
        const o = wd.idx(pv.building.x, pv.building.y);
        const [ONx, ONy] = this.tileN(pv.building.x, pv.building.y, wd.minH(o));
        ctx.globalAlpha = 0.75;
        this.drawSprite(ctx, sp.building(def), ONx, ONy);
        ctx.globalAlpha = 1;
      }
    } else if (this.hover >= 0) {
      const x = this.hover % wd.w;
      const y = (this.hover / wd.w) | 0;
      const [n, e, s, w] = wd.tileCorners(x, y);
      const b = Math.min(n, e, s, w);
      const [Nx, Ny] = this.tileN(x, y, b);
      this.drawSprite(ctx, sp.outline(n - b, e - b, s - b, w - b, hex('#ffffff')), Nx, Ny);
    }
  }

  // ---------------- Auswahl ----------------

  screenToWorld(px: number, py: number): [number, number] {
    const z = this.cam.z;
    return [(px - this.canvas.width / 2) / z + this.cam.x, (py - this.canvas.height / 2) / z + this.cam.y];
  }

  pick(px: number, py: number): number {
    const [wx, wy] = this.screenToWorld(px, py);
    return this.pickWorld(wx, wy);
  }

  pickWorld(wx: number, wy: number): number {
    const wd = this.wd;
    let best = -1;
    let bestD = -1;
    for (let h = MAXH; h >= 0; h--) {
      const rx = (wx - this.OX) / HW;
      const ry = (wy - this.OY + h * HS) / HH;
      const X = (ry + rx) / 2;
      const Y = (ry - rx) / 2;
      const tx = Math.floor(X);
      const ty = Math.floor(Y);
      if (!wd.inb(tx, ty)) continue;
      const i = wd.idx(tx, ty);
      // Höhe an genau dieser Stelle
      const [n, e, s, w] = wd.tileCorners(tx, ty);
      const u = X - tx;
      const v = Y - ty;
      const gh = n * (1 - u) * (1 - v) + e * u * (1 - v) + s * u * v + w * (1 - u) * v;
      if (Math.abs(gh - h) > 0.75) continue;
      if (tx + ty > bestD) {
        bestD = tx + ty;
        best = i;
      }
    }
    return best;
  }
}

const TREE_PTS: [number, number][][] = [
  [[0.5, 0.55]],
  [
    [0.3, 0.4],
    [0.68, 0.7],
  ],
  [
    [0.28, 0.3],
    [0.72, 0.42],
    [0.45, 0.78],
  ],
];

const BLOCK = 128;

/** Pixelpuffer in Weltauflösung für den sichtbaren Ausschnitt; nur berührte Blöcke werden übertragen. */
class PixLayer {
  x0 = 0;
  y0 = 0;
  w = 0;
  h = 0;
  private aw = 0;
  private ah = 0;
  private bw = 0;
  private cv = document.createElement('canvas');
  private ctx = this.cv.getContext('2d')!;
  private img: ImageData | null = null;
  private data = new Uint32Array(0);
  private touched = new Uint8Array(0);

  begin(x0: number, y0: number, w: number, h: number): void {
    if (w > this.aw || h > this.ah) {
      this.aw = Math.ceil(w / BLOCK) * BLOCK;
      this.ah = Math.ceil(h / BLOCK) * BLOCK;
      this.cv.width = this.aw;
      this.cv.height = this.ah;
      this.img = this.ctx.createImageData(this.aw, this.ah);
      this.data = new Uint32Array(this.img.data.buffer);
      this.bw = this.aw / BLOCK;
      this.touched = new Uint8Array(this.bw * (this.ah / BLOCK));
    }
    this.x0 = x0;
    this.y0 = y0;
    this.w = w;
    this.h = h;
  }

  plot(x: number, y: number, c: Color): void {
    const k = y * this.aw + x;
    const a = c >>> 24;
    if (a === 255) this.data[k] = c;
    else {
      const d = this.data[k];
      const da = d >>> 24;
      if (!da) this.data[k] = c;
      else {
        const t = a / 255;
        const f = (s: number) => Math.round(((d >>> s) & 255) * (1 - t) + ((c >>> s) & 255) * t);
        this.data[k] = (((Math.max(a, da) << 24) | (f(16) << 16) | (f(8) << 8) | f(0)) >>> 0);
      }
    }
    this.touched[(y >> 7) * this.bw + (x >> 7)] = 1;
  }

  flush(target: CanvasRenderingContext2D): void {
    let bx0 = 1e9;
    let by0 = 1e9;
    let bx1 = -1;
    let by1 = -1;
    for (let b = 0; b < this.touched.length; b++) {
      if (!this.touched[b]) continue;
      this.touched[b] = 0;
      const bx = b % this.bw;
      const by = Math.floor(b / this.bw);
      bx0 = Math.min(bx0, bx);
      by0 = Math.min(by0, by);
      bx1 = Math.max(bx1, bx);
      by1 = Math.max(by1, by);
    }
    if (bx1 < 0) return;
    const x = bx0 * BLOCK;
    const y = by0 * BLOCK;
    const w = (bx1 - bx0 + 1) * BLOCK;
    const h = (by1 - by0 + 1) * BLOCK;
    this.ctx.putImageData(this.img!, 0, 0, x, y, w, h);
    target.drawImage(this.cv, x, y, w, h, this.x0 + x, this.y0 + y, w, h);
    for (let r = y; r < y + h; r++) this.data.fill(0, r * this.aw + x, r * this.aw + x + w);
  }
}
