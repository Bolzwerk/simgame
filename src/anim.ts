// Belebte Welt: Autos, Fußgänger, Wasser, Boote, Rauch, Windräder, Brunnen, Baustaub, Flugzeuge und Vögel.
// Alles wird pro Bild in eine Pixelebene gezeichnet; der Tiefenpuffer der Chunks sorgt dafür,
// dass Häuser, Bäume und Hügel im Vordergrund die bewegten Objekte verdecken.

import { HS, NET_ROAD, Zone } from './config';
import { alpha, Color, hex, rgb } from './pix';
import { hash2, Rng } from './rng';
import type { Simulation } from './sim';
import type { Sprite } from './sprites';
import { World } from './world';

/** Was die Animationen vom Renderer brauchen. */
export interface FxHost {
  wd: World;
  sim: Simulation | null;
  cam: { x: number; y: number; z: number };
  groundPt(x: number, y: number, u: number, v: number): [number, number];
  tileN(x: number, y: number, h: number): [number, number];
  /** Setzt einen Pixel, falls an dieser Stelle nichts mit größerer Tiefe als dmax liegt. */
  dot(wx: number, wy: number, dmax: number, c: Color): void;
  blit(s: Sprite, x: number, y: number, dmax: number): void;
  fireSprite(frame: number): Sprite;
}

const SKY = 1 << 15; // über allem

const CAR_COLORS = ['#d83a2a', '#f0f0f0', '#2a5ad8', '#e8c020', '#303030', '#3a9a4a', '#a0a0a8', '#e07020'].map(hex);
const SHIRTS = ['#d83a2a', '#2a5ad8', '#e8c020', '#f0f0f0', '#3a9a4a', '#a040b0'].map(hex);
const SKIN = hex('#e8b890');
const SHADOW = alpha(rgb(0, 0, 0), 80);

/** Rauch-, Dampf- und Brunnenquellen relativ zur Nordecke der Ursprungskachel (Iso-Einheiten, Höhe in px). */
type Emitter = [number, number, number, 'smoke' | 'steam' | 'fountain'];
const BUILDING_FX: Record<string, Emitter[]> = {
  gas: [
    [0.55, 0.4, 35, 'smoke'],
    [0.85, 0.4, 31, 'smoke'],
  ],
  coal: [
    [0.6, 0.6, 71, 'smoke'],
    [1.3, 0.6, 71, 'smoke'],
  ],
  nuclear: [
    [0.7, 0.7, 50, 'steam'],
    [0.75, 2.0, 50, 'steam'],
  ],
  park: [[0.5, 0.5, 1, 'fountain']],
  bigpark: [[0.7, 0.65, 1, 'fountain']],
};
const INDUSTRY_FX: Record<number, Emitter[]> = {
  3: [[0.25, 0.15, 45, 'smoke']],
  4: [[0.6, 0.65, 57, 'smoke']],
};

interface Boat {
  x: number;
  y: number;
  dx: number;
  dy: number;
  kind: number; // 0 Segelboot, 1 Motorboot, 2 Frachter
  turn: number;
}

interface Flyer {
  x: number; // Weltpixel
  y: number;
  vx: number;
  vy: number;
  alt: number;
  life: number;
  kind: 'plane' | 'birds';
}

export class Animator {
  private boats: Boat[] = [];
  private boatsFor = -1;
  private flyers: Flyer[] = [];
  private nextFlyer = 6;
  private dust: { i: number; t0: number }[] = [];
  private rng = new Rng(12345);
  private last = -1;

  constructor(private h: FxHost) {}

  draw(time: number, x0: number, y0: number, x1: number, y1: number): void {
    const t = time / 1000;
    const dt = this.last < 0 ? 0 : Math.min(0.1, t - this.last);
    this.last = t;
    const h = this.h;
    const wd = h.wd;
    const z = h.cam.z;

    if (h.sim) {
      for (const i of h.sim.built.splice(0)) this.dust.push({ i, t0: t });
      if (this.dust.length > 200) this.dust.splice(0, this.dust.length - 200);
    }

    const detail = z >= 1.5;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * wd.w + x;
        if (wd.isWater(i)) this.water(x, y, t, detail);
        if (wd.net[i] & NET_ROAD) {
          this.cars(x, y, i, t);
          if (z >= 2) this.pedestrians(x, y, i, t);
        }
        if (wd.zone[i] === Zone.I && wd.level[i] >= 3 && wd.powered[i] && !wd.fire[i]) {
          const em = INDUSTRY_FX[wd.level[i]];
          const [Nx, Ny] = h.tileN(x, y, wd.minH(i));
          for (const e of em) this.emit(Nx, Ny, e, (x + y) * 2 + 3, t, hash2(x, y, 3));
        }
      }

    // Gebäude (Ursprung kann außerhalb des sichtbaren Bereichs liegen)
    const pad = 3;
    for (let y = Math.max(0, y0 - pad); y <= y1; y++)
      for (let x = Math.max(0, x0 - pad); x <= x1; x++) {
        const i = y * wd.w + x;
        if (!wd.bld[i] || wd.origin[i] !== i || wd.fire[i]) continue;
        const def = wd.bldDef(i)!;
        const [Nx, Ny] = h.tileN(x, y, wd.minH(i));
        const front = (x + y + 2 * (def.size - 1)) * 2 + 3;
        if (def.key === 'wind') this.rotor(Nx, Ny, front, t, hash2(x, y, 9));
        else if (def.key === 'airport') this.beacon(Nx, Ny, t);
        const em = BUILDING_FX[def.key];
        if (em && (def.cat === 'power' || def.cat === 'park' || wd.powered[i])) for (const e of em) this.emit(Nx, Ny, e, front, t, hash2(x, y, 3));
      }

    // Feuer
    if (h.sim && h.sim.burning.size) {
      const frame = Math.floor(t * 8) % 4;
      for (const i of h.sim.burning) {
        const x = i % wd.w;
        const y = (i / wd.w) | 0;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const g = h.groundPt(x, y, 0.5, 0.5);
        h.blit(h.fireSprite((frame + i) % 4), g[0], g[1] + 4, (x + y) * 2 + 3);
      }
    }

    this.drawDust(t);
    this.updateBoats(dt);
    this.drawBoats(t);
    this.updateFlyers(dt);
    this.drawFlyers(t);
  }

  // ---------------- Wasser ----------------

  private water(x: number, y: number, t: number, detail: boolean): void {
    const h = this.h;
    const d = (x + y) * 2 + 1;
    // langsam wandernde Wellenkämme
    const hw = hash2(x, y, 41);
    const u = (t * 0.06 + hw) % 1;
    const v = 0.2 + hash2(x, y, 42) * 0.6;
    const g = h.groundPt(x, y, u, v);
    const wave = alpha(hex('#9cc0f0'), 150);
    for (let k = -3; k <= 2; k++) h.dot(g[0] + k, g[1] + (k > 0 ? 1 : 0), d, wave);
    if (!detail) return;
    // Glitzern
    for (let k = 0; k < 2; k++) {
      const ph = hash2(x, y, 43 + k);
      const s = Math.sin(t * (1.3 + ph) + ph * 40);
      if (s < 0.75) continue;
      const p = h.groundPt(x, y, hash2(x, y, 45 + k) * 0.8 + 0.1, hash2(x, y, 47 + k) * 0.8 + 0.1);
      const c = s > 0.93 ? hex('#ffffff') : alpha(hex('#cfe2ff'), 220);
      h.dot(p[0], p[1], d, c);
      h.dot(p[0] + 1, p[1], d, c);
      if (s > 0.9) h.dot(p[0] - 1, p[1], d, alpha(hex('#cfe2ff'), 160));
    }
  }

  // ---------------- Verkehr ----------------

  private cars(x: number, y: number, i: number, t: number): void {
    const h = this.h;
    const wd = h.wd;
    if (h.cam.z < 1) return;
    const tr = wd.traffic[i];
    if (tr < 6) return;
    const mask = wd.netMask(i, NET_ROAD);
    const cars = Math.min(4, 1 + Math.floor(tr / 55));
    const lift = wd.isWater(i) ? HS + 2 : 0;
    const d = (x + y) * 2 + 3;
    for (let k = 0; k < cars; k++) {
      const hh = hash2(x, y, k + 17);
      const alongU = mask & 10 ? (mask & 5 ? k % 2 === 0 : true) : false;
      const dir = (k >> 1) % 2 === 0 ? 1 : -1;
      let p = (t * (0.3 + hh * 0.25) + hh) % 1;
      if (dir < 0) p = 1 - p;
      let u: number;
      let v: number;
      if (alongU) {
        u = p;
        v = dir > 0 ? 0.4 : 0.6;
        if ((u < 0.5 && !(mask & 8)) || (u > 0.5 && !(mask & 2))) continue;
      } else {
        v = p;
        u = dir > 0 ? 0.6 : 0.4;
        if ((v < 0.5 && !(mask & 1)) || (v > 0.5 && !(mask & 4))) continue;
      }
      const g = h.groundPt(x, y, u, v);
      const gx = Math.round(g[0]);
      const gy = Math.round(g[1] - lift);
      const col = CAR_COLORS[(hh * CAR_COLORS.length) | 0];
      // Fahrzeug: 4×2 Pixel schräg entlang der Fahrtrichtung, darunter Schatten
      const sx = alongU ? 1 : -1;
      for (let a = -1; a <= 2; a++) {
        const px = gx + a * sx;
        const py = gy - 2 + (a >= 1 ? 1 : 0);
        h.dot(px, py, d, a === (dir > 0 ? 1 : 0) ? hex('#a8c8e8') : col);
        h.dot(px, py + 1, d, col);
        h.dot(px, py + 2, d, SHADOW);
      }
    }
  }

  private pedestrians(x: number, y: number, i: number, t: number): void {
    const h = this.h;
    const wd = h.wd;
    if (wd.isWater(i)) return;
    // nur in belebten Vierteln
    let busy = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!wd.inb(nx, ny)) continue;
      const j = wd.idx(nx, ny);
      if ((wd.zone[j] === Zone.C || wd.zone[j] === Zone.R) && wd.level[j] > 0) busy += wd.zone[j] === Zone.C ? 2 : 1;
    }
    if (!busy) return;
    const mask = wd.netMask(i, NET_ROAD);
    const n = Math.min(3, busy);
    const d = (x + y) * 2 + 3;
    for (let k = 0; k < n; k++) {
      const hh = hash2(x, y, 60 + k);
      if (hh < 0.3) continue;
      const alongU = mask & 10 ? !(mask & 5) || k % 2 === 0 : false;
      let p = (t * (0.04 + hh * 0.03) + hh * 7) % 1;
      if (k % 2) p = 1 - p;
      const side = hash2(x, y, 70 + k) < 0.5 ? 0.17 : 0.83;
      const [u, v] = alongU ? [p, side] : [side, p];
      const g = h.groundPt(x, y, u, v);
      const gx = Math.round(g[0]);
      const gy = Math.round(g[1]);
      const step = Math.floor(t * 4 + hh * 10) % 2;
      h.dot(gx, gy - 3, d, SKIN);
      h.dot(gx, gy - 2, d, SHIRTS[(hh * 97) % SHIRTS.length | 0]);
      h.dot(gx + (step ? 0 : 1) - 0, gy - 1, d, hex('#303848'));
      h.dot(gx, gy, d, SHADOW);
    }
  }

  // ---------------- Rauch, Rotoren, Lichter ----------------

  private emit(Nx: number, Ny: number, e: Emitter, d: number, t: number, seed: number): void {
    const h = this.h;
    const [X, Y, Z, kind] = e;
    const bx = Nx + (X - Y) * 16;
    const by = Ny + (X + Y) * 8 - Z;
    if (kind === 'fountain') {
      const col = alpha(hex('#d8ecff'), 230);
      for (let k = 0; k < 10; k++) {
        const ph = (t * 0.9 + k / 10 + seed) % 1;
        const ang = (k * 2.4 + seed * 6) % (Math.PI * 2);
        const px = bx + Math.cos(ang) * ph * 4;
        const py = by + Math.sin(ang) * ph * 2 - ph * (1 - ph) * 4 * 9;
        h.dot(Math.round(px), Math.round(py), d, col);
      }
      h.dot(bx, by - 9, d, hex('#ffffff'));
      return;
    }
    const steam = kind === 'steam';
    const N = steam ? 7 : 6;
    const period = steam ? 4.5 : 3.2;
    for (let k = 0; k < N; k++) {
      const ph = (t / period + k / N + seed) % 1;
      const rise = ph * (steam ? 34 : 30);
      const drift = ph * ph * 16 + Math.sin(ph * 7 + k) * 1.5;
      const r = (steam ? 2.5 : 1.2) + ph * (steam ? 4 : 2.8);
      const a = Math.round((1 - ph) * (steam ? 170 : 190));
      const base = steam ? 235 - Math.round(ph * 20) : 120 + Math.round(ph * 70);
      const col = rgb(base, base, base + (steam ? 5 : 0), a);
      const cx = bx + drift;
      const cy = by - rise;
      const rr = r * r;
      for (let yy = -Math.ceil(r); yy <= Math.ceil(r); yy++)
        for (let xx = -Math.ceil(r); xx <= Math.ceil(r); xx++) {
          if (xx * xx + yy * yy * 1.4 > rr) continue;
          h.dot(Math.round(cx + xx), Math.round(cy + yy), d, col);
        }
    }
  }

  private rotor(Nx: number, Ny: number, d: number, t: number, seed: number): void {
    const h = this.h;
    const hx = Nx;
    const hy = Ny + 8 - 32;
    const a0 = t * 2.6 + seed * 6;
    const col = hex('#f4f4f4');
    const dark = hex('#c8c8c8');
    for (let b = 0; b < 3; b++) {
      const a = a0 + (b * Math.PI * 2) / 3;
      const cx = Math.cos(a);
      const sy = Math.sin(a);
      for (let s = 1; s <= 12; s++) h.dot(Math.round(hx + cx * s * 0.75), Math.round(hy + sy * s), d, s > 9 ? dark : col);
    }
    h.dot(hx, hy, d, hex('#909090'));
  }

  private beacon(Nx: number, Ny: number, t: number): void {
    const on = Math.floor(t * 1.5) % 2 === 0;
    if (!on) return;
    const px = Nx + (3.2 - 0.6) * 16;
    const py = Ny + (3.2 + 0.6) * 8 - 41;
    this.h.dot(Math.round(px), Math.round(py), SKY, hex('#ff3030'));
    this.h.dot(Math.round(px), Math.round(py) - 1, SKY, alpha(hex('#ff8080'), 140));
  }

  // ---------------- Baustaub ----------------

  private drawDust(t: number): void {
    const h = this.h;
    const wd = h.wd;
    this.dust = this.dust.filter((e) => t - e.t0 < 1.8);
    for (const e of this.dust) {
      const x = e.i % wd.w;
      const y = (e.i / wd.w) | 0;
      const ph = (t - e.t0) / 1.8;
      const d = (x + y) * 2 + 3;
      for (let k = 0; k < 7; k++) {
        const ang = k * 0.9 + e.i;
        const g = h.groundPt(x, y, 0.5 + Math.cos(ang) * 0.35 * (0.4 + ph), 0.5 + Math.sin(ang) * 0.35 * (0.4 + ph));
        const r = 1.5 + ph * 3;
        const a = Math.round((1 - ph) * 200);
        const col = rgb(196, 176, 140, a);
        const cy = g[1] - ph * 8 - 2;
        for (let yy = -Math.ceil(r); yy <= Math.ceil(r); yy++)
          for (let xx = -Math.ceil(r); xx <= Math.ceil(r); xx++) if (xx * xx + yy * yy * 1.5 <= r * r) h.dot(Math.round(g[0] + xx), Math.round(cy + yy), d, col);
      }
    }
  }

  // ---------------- Boote ----------------

  private seaport(): boolean {
    const wd = this.h.wd;
    for (let i = 0; i < wd.bld.length; i++) if (wd.bld[i] && wd.bldDef(i)!.key === 'seaport') return true;
    return false;
  }

  private openWater(x: number, y: number): boolean {
    const wd = this.h.wd;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!wd.inb(tx, ty)) return false;
    const i = wd.idx(tx, ty);
    return wd.isWater(i) && !(wd.net[i] & NET_ROAD);
  }

  private updateBoats(dt: number): void {
    const wd = this.h.wd;
    const stamp = wd.year * 12 + wd.month;
    if (this.boatsFor < 0 || (stamp !== this.boatsFor && stamp % 6 === 0)) {
      this.boatsFor = stamp;
      let water = 0;
      for (let i = 0; i < wd.w * wd.h; i++) if (wd.isWater(i)) water++;
      const port = this.seaport();
      const want = Math.min(14, Math.floor(water / 70)) + (port ? 3 : 0);
      this.boats = this.boats.filter((b) => this.openWater(b.x, b.y));
      let tries = 0;
      while (this.boats.length < want && tries++ < 400) {
        const x = this.rng.int(wd.w);
        const y = this.rng.int(wd.h);
        if (!this.openWater(x + 0.5, y + 0.5) || !this.openWater(x + 1.5, y + 0.5) || !this.openWater(x + 0.5, y + 1.5)) continue;
        const dirs = this.dirsFrom(x + 0.5, y + 0.5);
        if (!dirs.length) continue;
        const [dx, dy] = this.rng.pick(dirs);
        const kind = port && this.boats.length < 3 ? 2 : this.rng.chance(0.6) ? 0 : 1;
        this.boats.push({ x: x + 0.5, y: y + 0.5, dx, dy, kind, turn: this.rng.range(3, 10) });
      }
    }
    for (const b of this.boats) {
      const sp = (b.kind === 1 ? 0.55 : b.kind === 2 ? 0.25 : 0.32) * dt;
      b.turn -= dt;
      const nx = b.x + b.dx * sp;
      const ny = b.y + b.dy * sp;
      const ahead = this.openWater(nx + b.dx * 0.6, ny + b.dy * 0.6);
      if (!ahead || b.turn <= 0) {
        const dirs = this.dirsFrom(b.x, b.y);
        if (dirs.length) {
          const fwd = dirs.filter(([dx, dy]) => dx * b.dx + dy * b.dy >= 0);
          const [dx, dy] = this.rng.pick(ahead && fwd.length ? fwd : dirs);
          b.dx = dx;
          b.dy = dy;
        }
        b.turn = this.rng.range(3, 10);
        if (!ahead) continue;
      }
      b.x = nx;
      b.y = ny;
    }
  }

  private dirsFrom(x: number, y: number): [number, number][] {
    const out: [number, number][] = [];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [0.7, 0.7],
      [-0.7, -0.7],
      [0.7, -0.7],
      [-0.7, 0.7],
    ] as [number, number][])
      if (this.openWater(x + dx * 0.9, y + dy * 0.9) && this.openWater(x + dx * 1.6, y + dy * 1.6)) out.push([dx, dy]);
    return out;
  }

  private drawBoats(t: number): void {
    const h = this.h;
    for (const b of this.boats) {
      const tx = Math.floor(b.x);
      const ty = Math.floor(b.y);
      const d = (tx + ty) * 2 + 3;
      const g = h.groundPt(tx, ty, b.x - tx, b.y - ty);
      const gx = Math.round(g[0]);
      const gy = Math.round(g[1]);
      // Bildschirmrichtung
      const sx = (b.dx - b.dy) * 16;
      const sy = (b.dx + b.dy) * 8;
      const len = Math.hypot(sx, sy) || 1;
      const ux = sx / len;
      const uy = sy / len;
      // Kielwasser
      const wake = alpha(hex('#e8f2ff'), 150);
      for (let k = 2; k < (b.kind === 1 ? 12 : 8); k++) {
        const spread = Math.floor(k / 3);
        const wx = gx - ux * k;
        const wy = gy - uy * k;
        if ((k + Math.floor(t * 6)) % 3 === 0) continue;
        h.dot(Math.round(wx - uy * spread), Math.round(wy + ux * spread * 0.5), d, wake);
        h.dot(Math.round(wx + uy * spread), Math.round(wy - ux * spread * 0.5), d, wake);
      }
      const L = b.kind === 2 ? 6 : b.kind === 1 ? 4 : 3;
      const hull = b.kind === 2 ? hex('#a03028') : b.kind === 1 ? hex('#f0f0f0') : hex('#e8e0d0');
      for (let k = -L; k <= L; k++) {
        const px = Math.round(gx + ux * k);
        const py = Math.round(gy + uy * k * 0.5);
        h.dot(px, py, d, hull);
        h.dot(px, py - 1, d, hull);
        h.dot(px, py + 1, d, alpha(hex('#0a1a40'), 90));
        if (b.kind === 2 && k > -L && k < L - 1) {
          const cc = [hex('#3070c0'), hex('#d08020'), hex('#30a050'), hex('#c03030')][(k + L) % 4];
          h.dot(px, py - 2, d, cc);
          h.dot(px, py - 3, d, cc);
        }
      }
      if (b.kind === 0) {
        // Segel
        for (let s = 0; s < 6; s++) for (let w = 0; w <= (5 - s) >> 1; w++) h.dot(gx + w, gy - 2 - s, d, hex('#ffffff'));
        for (let s = 0; s < 7; s++) h.dot(gx - 1, gy - 2 - s, d, hex('#806040'));
      } else if (b.kind === 1) {
        for (let k = -1; k <= 1; k++) {
          h.dot(gx + k, gy - 2, d, k === 1 ? hex('#a8c8e8') : hex('#3060c0'));
          h.dot(gx + k, gy - 3, d, hex('#f8f8f8'));
        }
      } else {
        const bx = Math.round(gx - ux * (L - 1));
        const by = Math.round(gy - uy * (L - 1) * 0.5);
        for (let s = 2; s < 6; s++) {
          h.dot(bx, by - s, d, hex('#f0f0f0'));
          h.dot(bx + 1, by - s, d, hex('#d0d0d0'));
        }
      }
    }
  }

  // ---------------- Flugzeuge und Vögel ----------------

  private updateFlyers(dt: number): void {
    const h = this.h;
    this.nextFlyer -= dt;
    if (this.nextFlyer <= 0) {
      const birds = this.rng.chance(0.55);
      this.nextFlyer = this.rng.range(10, 25);
      const ang = this.rng.range(0, Math.PI * 2);
      const speed = birds ? 22 : 55;
      const dist = 520 / Math.max(0.6, h.cam.z) + 200;
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed * 0.6;
      // startet außerhalb der Ansicht und überquert sie
      const off = this.rng.range(-0.3, 0.3) * dist;
      this.flyers.push({
        x: h.cam.x - Math.cos(ang) * dist - Math.sin(ang) * off,
        y: h.cam.y - Math.sin(ang) * dist * 0.6 + Math.cos(ang) * off * 0.6,
        vx,
        vy,
        alt: birds ? this.rng.range(30, 60) : this.rng.range(70, 110),
        life: (dist * 2) / speed,
        kind: birds ? 'birds' : 'plane',
      });
    }
    for (const f of this.flyers) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.life -= dt;
    }
    this.flyers = this.flyers.filter((f) => f.life > 0);
  }

  private drawFlyers(t: number): void {
    const h = this.h;
    for (const f of this.flyers) {
      const x = Math.round(f.x);
      const y = Math.round(f.y - f.alt);
      if (f.kind === 'birds') {
        for (let k = 0; k < 5; k++) {
          const bx = x - Math.sign(f.vx || 1) * (k >> 1) * 5 + (k % 2 ? 0 : 0);
          const by = y + (k % 2 ? 1 : -1) * (k >> 1) * 3 + Math.round(Math.sin(t * 3 + k) * 1);
          const up = Math.floor(t * 6 + k) % 2 === 0;
          const c = hex('#202020');
          h.dot(bx, by, SKY, c);
          h.dot(bx - 1, by + (up ? -1 : 0), SKY, c);
          h.dot(bx + 1, by + (up ? -1 : 0), SKY, c);
        }
        continue;
      }
      // Flugzeug mit Schatten am Boden
      const ux = Math.sign(f.vx || 1);
      const shadow = alpha(rgb(0, 0, 0), 60);
      for (let k = -4; k <= 4; k++) h.dot(Math.round(f.x) + k, Math.round(f.y) + Math.round((k * f.vy) / (Math.abs(f.vx) + 1)), SKY - 1, shadow);
      for (let k = -4; k <= 4; k++) {
        const px = x + k;
        const py = y + Math.round((k * f.vy) / (Math.abs(f.vx) + 1));
        h.dot(px, py, SKY, hex('#f4f4f4'));
        h.dot(px, py + 1, SKY, hex('#c8c8d0'));
      }
      for (let k = -3; k <= 3; k++) h.dot(x - ux, y + k, SKY, hex('#e0e0e8'));
      h.dot(x - ux * 4, y - 1, SKY, hex('#3060c0'));
      h.dot(x - ux * 4, y - 2, SKY, hex('#3060c0'));
      if (Math.floor(t * 2) % 2 === 0) h.dot(x - ux, y - 3, SKY, hex('#ff3030'));
    }
  }
}
