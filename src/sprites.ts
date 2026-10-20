// Prozedural erzeugte Pixelgrafik im isometrischen Stil.

import { BLD_MAX_H, BuildingDef, HS, Zone } from './config';
import { alpha, CANVAS_PIXELS, Color, hex, mix, mul, PixBuf, Pt, quad, ramp, rgb, Shader, triangle } from './pix';
import { hash2, Rng } from './rng';

export interface Sprite {
  cv: HTMLCanvasElement;
  ax: number; // Ankerpunkt (Nordecke der Kachel bzw. Stammfuß)
  ay: number;
}

/** Pixeldaten eines Sprites (einmalig gelesen und zwischengespeichert). */
export function spritePixels(s: Sprite): Uint32Array {
  let d = CANVAS_PIXELS.get(s.cv);
  if (!d) {
    const c = s.cv.getContext('2d')!;
    d = new Uint32Array(c.getImageData(0, 0, s.cv.width, s.cv.height).data.buffer.slice(0));
    CANVAS_PIXELS.set(s.cv, d);
  }
  return d;
}

// ---------------- Palette ----------------

const GRASS = ramp('#2c5219', '#3a6621', '#477a28', '#558c30', '#649f39', '#77b246', '#8cc256');
const DIRT = ramp('#4a3019', '#5d3e21', '#714d2b', '#875f37', '#9c7244', '#b08653', '#c49b66');
const WATER = ramp('#16316b', '#1d3f84', '#244d9b', '#2c5cb0', '#3a6fc4', '#5288d6', '#7aa6e4');
const ROCK = ramp('#4b4740', '#5c574e', '#6d675d', '#7f786c', '#918a7c', '#a59e8f', '#b8b1a2');
const ASPHALT = ramp('#2e2f33', '#38393e', '#424349', '#4c4d53', '#57585e');
const PAVE = ramp('#6f6e69', '#7f7e78', '#8f8e88', '#9f9e98', '#afaea8', '#bfbeb8', '#cfcec8');
const LAWN = ramp('#356b22', '#41802a', '#4d9332', '#5aa53b', '#68b545', '#79c552', '#8bd360');

const ZONE_COL: Record<number, Color> = {
  [Zone.R]: hex('#58c050'),
  [Zone.C]: hex('#4f86d8'),
  [Zone.I]: hex('#e0c040'),
};

const BLACK = rgb(0, 0, 0);
const WHITE = rgb(255, 255, 255);

function rampAt(r: Color[], i: number): Color {
  return r[Math.max(0, Math.min(r.length - 1, Math.round(i)))];
}

// ---------------- Gelände ----------------

interface TriDef {
  p: [Pt, Pt, Pt];
  t: [Pt, Pt, Pt];
  shade: number;
}

const K = 0.55; // Höhe einer Stufe relativ zur Kachelkante für die Beleuchtung
const LIGHT = normalize([-0.35, 0.75, 1]);

function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function triShade(a: number[], b: number[], c: number[]): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  n = normalize(n);
  const d = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
  return d / LIGHT[2] - 1; // 0 = flach, >0 heller, <0 dunkler
}

/** Zerlegt eine Kachel mit relativen Eckhöhen in zwei Dreiecke (Bildschirmkoordinaten im Sprite). */
function tileTris(n: number, e: number, s: number, w: number, top: number): TriDef[] {
  const P = {
    N: [16, top - n * HS] as Pt,
    E: [32, top + 8 - e * HS] as Pt,
    S: [16, top + 16 - s * HS] as Pt,
    W: [0, top + 8 - w * HS] as Pt,
  };
  const T = { N: [0, 0] as Pt, E: [1, 0] as Pt, S: [1, 1] as Pt, W: [0, 1] as Pt };
  const Q = { N: [0, 0, n * K], E: [1, 0, e * K], S: [1, 1, s * K], W: [0, 1, w * K] };
  const splitNS = n === s || (e !== w && Math.abs(n - s) < Math.abs(e - w));
  if (splitNS) {
    return [
      { p: [P.N, P.E, P.S], t: [T.N, T.E, T.S], shade: triShade(Q.N, Q.E, Q.S) },
      { p: [P.N, P.S, P.W], t: [T.N, T.S, T.W], shade: triShade(Q.N, Q.S, Q.W) },
    ];
  }
  return [
    { p: [P.W, P.N, P.E], t: [T.W, T.N, T.E], shade: triShade(Q.W, Q.N, Q.E) },
    { p: [P.W, P.E, P.S], t: [T.W, T.E, T.S], shade: triShade(Q.W, Q.E, Q.S) },
  ];
}

export type SurfaceShader = (u: number, v: number, px: number, py: number, shade: number) => Color;

function edgeDark(u: number, v: number): boolean {
  return u < 0.045 || v < 0.045;
}

function noisy(r: Color[], base: number, px: number, py: number, seed: number, shade: number, grid: boolean, u: number, v: number): Color {
  const h = hash2(px, py, seed);
  let i = base + shade * 4.5;
  if (h < 0.18) i -= 1;
  else if (h > 0.9) i += 1;
  if (grid && edgeDark(u, v)) i -= 0.8;
  return rampAt(r, i);
}

export function surfaceShader(key: string, variant: number, grid: boolean): SurfaceShader {
  const parts = key.split(':');
  const kind = parts[0];
  switch (kind) {
    case 'grass':
      return (u, v, px, py, s) => noisy(GRASS, 3, px, py, 11 + variant, s, grid, u, v);
    case 'dirt':
      return (u, v, px, py, s) => noisy(DIRT, 3, px, py, 21 + variant, s, grid, u, v);
    case 'rock':
      return (u, v, px, py, s) => noisy(ROCK, 3, px, py, 31 + variant, s, grid, u, v);
    case 'lawn':
      return (u, v, px, py, s) => noisy(LAWN, 3, px, py, 41 + variant, s, false, u, v);
    case 'pave':
      return (u, v, px, py, s) => {
        let i = 3 + s * 3;
        if (u < 0.04 || v < 0.04) i -= 1;
        if (hash2(px, py, 51) < 0.08) i -= 1;
        return rampAt(PAVE, i);
      };
    case 'tarmac':
      return (u, v, px, py, s) => {
        let i = 2 + s * 3;
        if (hash2(px, py, 52) < 0.1) i += 1;
        return rampAt(ASPHALT, i);
      };
    case 'water':
      return (u, v, px, py) => {
        const h = hash2(px >> 2, py, 61 + variant);
        let i = 2;
        if (h > 0.86) i = 4;
        else if (h > 0.72) i = 3;
        if ((py + (px >> 3)) % 7 === 0 && hash2(px >> 1, py, 62 + variant) > 0.6) i = 5;
        return rampAt(WATER, i);
      };
    case 'rubble':
      return (u, v, px, py, s) => {
        const h = hash2(px, py, 71);
        if (h < 0.3) return rampAt(PAVE, 1 + s * 3 + (h < 0.1 ? 2 : 0));
        if (h < 0.42) return rampAt(DIRT, 1 + s * 3);
        return noisy(DIRT, 3, px, py, 72, s, grid, u, v);
      };
    case 'road':
      return roadShader(parseInt(parts[1], 10), grid, variant);
    case 'pipe':
      return pipeShader(parseInt(parts[1], 10));
    case 'zone':
      return zoneShader(parseInt(parts[1], 10), parts[2] === '1', grid, variant);
    case 'lot':
      return lotShader(parseInt(parts[1], 10), variant);
    default:
      return (u, v, px, py, s) => noisy(GRASS, 3, px, py, 11, s, grid, u, v);
  }
}

const RW0 = 0.24;
const RW1 = 0.76;

export function onRoad(mask: number, u: number, v: number): boolean {
  const inU = u >= RW0 && u <= RW1;
  const inV = v >= RW0 && v <= RW1;
  if (inU && inV) return true;
  if (inU && v < 0.5 && mask & 1) return true;
  if (inU && v > 0.5 && mask & 4) return true;
  if (inV && u > 0.5 && mask & 2) return true;
  if (inV && u < 0.5 && mask & 8) return true;
  return false;
}

function roadShader(mask: number, grid: boolean, variant: number): SurfaceShader {
  const arms = ((mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1)) | 0;
  const straightU = (mask & 10) !== 0 && (mask & 5) === 0; // Verlauf in x-Richtung
  const straightV = (mask & 5) !== 0 && (mask & 10) === 0;
  return (u, v, px, py, s) => {
    if (!onRoad(mask, u, v)) return noisy(GRASS, 3, px, py, 11 + variant, s, grid, u, v);
    const inU = u >= RW0 && u <= RW1;
    const inV = v >= RW0 && v <= RW1;
    // Bordstein
    const edge = 0.055;
    const nearEdgeU = Math.abs(u - RW0) < edge || Math.abs(u - RW1) < edge;
    const nearEdgeV = Math.abs(v - RW0) < edge || Math.abs(v - RW1) < edge;
    let curb = false;
    if (inU && !inV) curb = nearEdgeU;
    else if (inV && !inU) curb = nearEdgeV;
    else {
      // Kreuzungsfeld: Bordstein nur an Seiten ohne Anschluss
      if (Math.abs(v - RW0) < edge && !(mask & 1)) curb = true;
      if (Math.abs(v - RW1) < edge && !(mask & 4)) curb = true;
      if (Math.abs(u - RW1) < edge && !(mask & 2)) curb = true;
      if (Math.abs(u - RW0) < edge && !(mask & 8)) curb = true;
    }
    if (curb) return rampAt(PAVE, 4 + s * 3);
    let c = rampAt(ASPHALT, 2 + s * 3 + (hash2(px, py, 81) < 0.12 ? -1 : 0));
    // Mittellinie
    if (arms <= 2) {
      const dashU = Math.floor(u * 8) % 2 === 0;
      const dashV = Math.floor(v * 8) % 2 === 0;
      if ((straightU || (!straightV && inV && !inU)) && Math.abs(v - 0.5) < 0.035 && dashU) c = hex('#d8c860');
      if ((straightV || (!straightU && inU && !inV)) && Math.abs(u - 0.5) < 0.035 && dashV) c = hex('#d8c860');
    }
    return c;
  };
}

/** Wasserrohre für die Untergrundansicht (außerhalb der Rohre durchsichtig). */
function pipeShader(mask: number): SurfaceShader {
  const P0 = 0.4;
  const P1 = 0.6;
  return (u, v, px, py, s) => {
    const inU = u >= P0 && u <= P1;
    const inV = v >= P0 && v <= P1;
    let on = inU && inV;
    if (inU && v < 0.5 && mask & 1) on = true;
    if (inU && v > 0.5 && mask & 4) on = true;
    if (inV && u > 0.5 && mask & 2) on = true;
    if (inV && u < 0.5 && mask & 8) on = true;
    if (!on) return 0;
    // Rand dunkler, Mitte mit Glanzlicht
    const du = inV && !inU ? Math.abs(v - 0.5) : inU && !inV ? Math.abs(u - 0.5) : Math.min(Math.abs(u - 0.5), Math.abs(v - 0.5));
    if (du > 0.075) return mul(hex('#1c4f8a'), 1 + s);
    if (du < 0.03) return mul(hex('#7fb8f0'), 1 + s);
    return mul(hex('#3a7cc4'), 1 + s);
  };
}

function zoneShader(z: number, dense: boolean, grid: boolean, variant: number): SurfaceShader {
  const col = ZONE_COL[z];
  return (u, v, px, py, s) => {
    const g = noisy(GRASS, 3, px, py, 11 + variant, s, false, u, v);
    const b = 0.07;
    const border = u < b || v < b || u > 1 - b || v > 1 - b;
    if (border) {
      if (!dense && (px + py) % 3 === 0) return g;
      return mul(col, 0.85 + s * 0.4);
    }
    return mix(g, col, dense ? 0.42 : 0.28);
  };
}

function lotShader(z: number, variant: number): SurfaceShader {
  if (z === Zone.R)
    return (u, v, px, py, s) => {
      if (Math.abs(u - 0.5) < 0.06 && v > 0.6) return rampAt(PAVE, 4 + s * 3);
      return noisy(LAWN, 3, px, py, 41 + variant, s, false, u, v);
    };
  if (z === Zone.C)
    return (u, v, px, py, s) => {
      let i = 4 + s * 3;
      if ((Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0) i -= 0.6;
      return rampAt(PAVE, i);
    };
  return (u, v, px, py, s) => {
    const h = hash2(px, py, 91);
    if (h < 0.5) return rampAt(PAVE, 2 + s * 3);
    return rampAt(DIRT, 4 + s * 3 + (h > 0.92 ? -1 : 0));
  };
}

export const TILE_SPRITE_H = 16 + 2 * HS;

/**
 * Geländesprite für relative Eckhöhen (0..2). Anker: Nordecke bei Grundhöhe → (16, 2*HS).
 */
export function terrainSprite(n: number, e: number, s: number, w: number, shader: SurfaceShader): Sprite {
  const buf = new PixBuf(32, TILE_SPRITE_H);
  const top = 2 * HS;
  for (const tri of tileTris(n, e, s, w, top)) {
    const sh = Math.max(-0.6, Math.min(0.5, tri.shade));
    triangle(buf, tri.p[0], tri.p[1], tri.p[2], tri.t[0], tri.t[1], tri.t[2], (u, v, px, py) => shader(u, v, px, py, sh));
  }
  return { cv: buf.toCanvas(), ax: 16, ay: top };
}

/** Maske einer Kachel (für Überlagerungen und Auswahl). */
export function tintSprite(n: number, e: number, s: number, w: number, color: Color): Sprite {
  const buf = new PixBuf(32, TILE_SPRITE_H);
  const top = 2 * HS;
  for (const tri of tileTris(n, e, s, w, top)) triangle(buf, tri.p[0], tri.p[1], tri.p[2], tri.t[0], tri.t[1], tri.t[2], () => color);
  return { cv: buf.toCanvas(), ax: 16, ay: top };
}

export function outlineSprite(n: number, e: number, s: number, w: number, color: Color): Sprite {
  const buf = new PixBuf(32, TILE_SPRITE_H);
  const top = 2 * HS;
  const P: Pt[] = [
    [16, top - n * HS],
    [31, top + 8 - e * HS],
    [16, top + 15 - s * HS],
    [0, top + 8 - w * HS],
  ];
  for (let k = 0; k < 4; k++) {
    const a = P[k];
    const b = P[(k + 1) % 4];
    buf.line(a[0], a[1], b[0], b[1], color);
  }
  return { cv: buf.toCanvas(), ax: 16, ay: top };
}

/** Seitenwand am Kartenrand. side 0 = rechte Kante (Süd→Ost), 1 = linke Kante (West→Süd). h1 links, h2 rechts. */
export function skirtSprite(side: number, h1: number, h2: number, water: boolean): Sprite {
  const depth = (Math.max(h1, h2) + 1) * HS + 8;
  const buf = new PixBuf(17, depth + 9);
  // Lokale Koordinaten: x 0..16, Oberkante von (0, y1) nach (16, y2)
  const topY = Math.max(h1, h2) * HS;
  // Lokal (0, topY) entspricht der linken Ecke bei Höhe 0 auf Höhe der Kachelmitte
  const ya = topY - h1 * HS + (side === 0 ? 8 : 0);
  const yb = topY - h2 * HS + (side === 0 ? 0 : 8);
  const bottomA = topY + HS + (side === 0 ? 8 : 0);
  const bottomB = topY + HS + (side === 0 ? 0 : 8);
  const base = side === 0 ? 0.68 : 0.88;
  quad(buf, [0, ya], [16, yb], [16, bottomB], [0, bottomA], (u, v, px, py) => {
    const zFromTop = py - (ya + (yb - ya) * u);
    let c: Color;
    if (water) c = mul(WATER[1], base);
    else {
      const band = Math.floor((zFromTop + (h1 > h2 ? 0 : 0)) / 4) % 3;
      c = mul([DIRT[2], DIRT[3], DIRT[1]][band], base);
      if (zFromTop < 2) c = mul(GRASS[2], base);
      if (hash2(px, py, 99) < 0.12) c = mul(c, 0.85);
    }
    return c;
  });
  return { cv: buf.toCanvas(), ax: 0, ay: topY };
}

// ---------------- Objekte: Bäume, Leitungen ----------------

export function treeSprite(variant: number): Sprite {
  const r = new Rng(variant * 7919 + 3);
  const buf = new PixBuf(14, 22);
  const ax = 7;
  const ay = 20;
  const conifer = r.chance(0.45);
  const dark = GRASS[0];
  const mid = GRASS[2];
  const light = GRASS[4];
  const trunk = DIRT[1];
  if (conifer) {
    const hgt = 12 + r.int(5);
    buf.rect(ax - 1, ay - 3, 2, 3, trunk);
    for (let y = 0; y < hgt; y++) {
      const ww = Math.max(1, Math.round(((y % 4) + y * 0.9) * 0.45 + 1));
      for (let x = -ww; x <= ww; x++) {
        const c = x < -ww / 3 ? light : x > ww / 3 ? dark : mid;
        buf.set(ax + x, ay - 3 - hgt + y, c);
      }
    }
  } else {
    const rad = 3.5 + r.next() * 1.5;
    const cy = ay - 5 - rad;
    buf.rect(ax - 1, ay - 5, 2, 5, trunk);
    for (let y = -6; y <= 6; y++)
      for (let x = -6; x <= 6; x++) {
        const d = Math.hypot(x, y * 1.1);
        if (d > rad + (hash2(x, y, variant) - 0.5) * 1.2) continue;
        const l = -x * 0.5 - y * 0.7;
        const c = l > 1.5 ? light : l < -1.5 ? dark : mid;
        buf.set(ax + x, Math.round(cy + y), hash2(x, y, variant + 5) < 0.12 ? dark : c);
      }
  }
  // Schatten
  for (let x = -3; x <= 4; x++) buf.set(ax + x, ay, alpha(BLACK, 60));
  return { cv: buf.toCanvas(), ax, ay };
}

/** Strommast mit Leitungen. hs: Bodenhöhen [Mitte, Kante -y, Kante +x, Kante +y, Kante -x] in Pixeln über Grund. */
export function powerSprite(mask: number, hc: number, he: number[], onRoad: boolean): Sprite {
  const buf = new PixBuf(32, 64);
  const base = 40; // y der Nordecke bei Höhe 0
  const P = (u: number, v: number, z: number): Pt => [16 + (u - v) * 16, base + (u + v) * 8 - z];
  const POLE = hex('#6b4a2b');
  const WIRE = hex('#26221e');
  const ph = 15;
  const cu = onRoad ? 0.12 : 0.5;
  const cv = onRoad ? 0.12 : 0.5;
  const c = P(cu, cv, hc + ph);
  const ends: [number, number, number][] = [
    [0.5, 0, he[0]],
    [1, 0.5, he[1]],
    [0.5, 1, he[2]],
    [0, 0.5, he[3]],
  ];
  for (let k = 0; k < 4; k++) {
    if (!(mask & (1 << k))) continue;
    const [u, v, z] = ends[k];
    const e = P(u, v, z + ph);
    buf.line(c[0] - 2, c[1] + 1, e[0] - 2, e[1] + 1, WIRE);
    buf.line(c[0] + 2, c[1] + 1, e[0] + 2, e[1] + 1, WIRE);
  }
  const g = P(cu, cv, hc);
  buf.rect(g[0], g[1] - ph, 1, ph, POLE);
  buf.rect(g[0] - 3, g[1] - ph + 1, 7, 1, POLE);
  buf.set(g[0] - 3, g[1] - ph, hex('#ddd'));
  buf.set(g[0] + 3, g[1] - ph, hex('#ddd'));
  buf.set(g[0] + 1, g[1] - 1, alpha(BLACK, 70));
  return { cv: buf.toCanvas(), ax: 16, ay: base };
}

export function bridgeSprite(mask: number): Sprite {
  const buf = new PixBuf(32, 40);
  const base = 16;
  const deck = HS + 2;
  const P = (u: number, v: number, z: number): Pt => [16 + (u - v) * 16, base + (u + v) * 8 - z];
  const alongU = (mask & 10) !== 0 && (mask & 5) === 0 ? true : (mask & 5) !== 0 ? false : true;
  const PIL = hex('#8a857a');
  // Pfeiler
  const pc = P(0.5, 0.5, 0);
  buf.rect(pc[0] - 2, pc[1] - deck, 4, deck + 2, PIL);
  buf.rect(pc[0] + 1, pc[1] - deck, 1, deck + 2, mul(PIL, 0.7));
  // Fahrbahn als flaches Viereck
  const a0 = alongU ? [0, RW0] : [RW0, 0];
  const a1 = alongU ? [1, RW0] : [RW1, 0];
  const a2 = alongU ? [1, RW1] : [RW1, 1];
  const a3 = alongU ? [0, RW1] : [RW0, 1];
  const sh = roadShader(alongU ? 10 : 5, false, 0);
  quad(buf, P(a0[0], a0[1], deck), P(a1[0], a1[1], deck), P(a2[0], a2[1], deck), P(a3[0], a3[1], deck), (u, v, px, py) => {
    const uu = alongU ? u : RW0 + u * (RW1 - RW0);
    const vv = alongU ? RW0 + v * (RW1 - RW0) : v;
    return sh(uu, vv, px, py, 0);
  });
  // Seitenblende
  const s0 = P(a3[0], a3[1], deck);
  const s1 = P(a2[0], a2[1], deck);
  buf.line(s0[0], s0[1] + 1, s1[0], s1[1] + 1, mul(PAVE[2], 0.8));
  buf.line(s0[0], s0[1] + 2, s1[0], s1[1] + 2, mul(PAVE[1], 0.7));
  const r0 = P(a0[0], a0[1], deck + 3);
  const r1 = P(a1[0], a1[1], deck + 3);
  buf.line(r0[0], r0[1], r1[0], r1[1], hex('#c9c3b5'));
  const q0 = P(a3[0], a3[1], deck + 3);
  const q1 = P(a2[0], a2[1], deck + 3);
  buf.line(q0[0], q0[1], q1[0], q1[1], hex('#e0dacb'));
  return { cv: buf.toCanvas(), ax: 16, ay: base };
}

// ---------------- Gebäude ----------------

class Iso {
  constructor(
    public buf: PixBuf,
    public ox: number,
    public oy: number,
  ) {}
  p(X: number, Y: number, Z: number): Pt {
    return [this.ox + (X - Y) * 16, this.oy + (X + Y) * 8 - Z];
  }
  face(a: number[], b: number[], c: number[], d: number[], sh: Shader): void {
    quad(this.buf, this.p(a[0], a[1], a[2]), this.p(b[0], b[1], b[2]), this.p(c[0], c[1], c[2]), this.p(d[0], d[1], d[2]), sh);
  }
  tri(a: number[], b: number[], c: number[], col: Color): void {
    triangle(this.buf, this.p(a[0], a[1], a[2]), this.p(b[0], b[1], b[2]), this.p(c[0], c[1], c[2]), [0, 0], [1, 0], [0, 1], () => col);
  }
  /** Quader; left = Fläche y=y1 (vorne links), right = Fläche x=x1 (vorne rechts). */
  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, top: Shader | Color, left: Shader | Color, right: Shader | Color): void {
    const S = (s: Shader | Color): Shader => (typeof s === 'number' ? () => s : s);
    this.face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], S(left));
    this.face([x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], S(right));
    this.face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], S(top));
  }
  shadow(x0: number, y0: number, x1: number, y1: number, len: number): void {
    // weicher Schlagschatten nach rechts hinten
    this.face([x1, y0, 0], [x1 + len, y0 - len * 0.3, 0], [x1 + len, y1 - len * 0.3, 0], [x1, y1, 0], () => alpha(BLACK, 55));
  }
  cyl(cx: number, cy: number, r: number, z0: number, z1: number, col: Color, topCol?: Color, stripe?: Color): void {
    const c0 = this.p(cx, cy, z0);
    const c1 = this.p(cx, cy, z1);
    const rx = r * 22.6;
    const ry = r * 11.3;
    for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++) {
      if (Math.abs(x + 0.5) > rx) continue;
      const t = (x + 0.5) / rx;
      const ey = ry * Math.sqrt(Math.max(0, 1 - t * t));
      const f = 1.08 - (t + 1) * 0.22;
      const yTop = Math.round(c1[1] + ey);
      const yBot = Math.round(c0[1] + ey);
      for (let y = yTop; y <= yBot; y++) {
        let cc = mul(col, f);
        if (stripe && Math.floor((yBot - y) / 5) % 2 === 1) cc = mul(stripe, f);
        this.buf.set(c0[0] + x, y, cc);
      }
    }
    const tc = topCol ?? mul(col, 1.15);
    for (let y = Math.floor(-ry); y <= Math.ceil(ry); y++)
      for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++) {
        if ((x + 0.5) ** 2 / (rx * rx) + (y + 0.5) ** 2 / (ry * ry) > 1) continue;
        this.buf.set(c1[0] + x, Math.round(c1[1] + y), tc);
      }
  }
}

interface WallOpts {
  base: Color;
  win: Color;
  lit?: Color;
  floor: number; // Geschosshöhe in px
  period: number; // Fensterabstand horizontal in px
  winW: number;
  winH: number;
  seed: number;
  lenPx: number; // Breite der Fläche in Bildschirm-px
  hPx: number;
  doors?: boolean;
  bands?: boolean; // durchgehende Fensterbänder
}

function wallShader(o: WallOpts, f: number): Shader {
  const base = mul(o.base, f);
  const win = mul(o.win, f);
  const lit = o.lit ? mul(o.lit, f) : win;
  return (u, v) => {
    const fx = Math.floor(u * o.lenPx - 0.001);
    const fz = Math.floor(v * o.hPx - 0.001);
    const fromBottom = o.hPx - 1 - fz;
    const inFloor = fromBottom % o.floor;
    const storey = Math.floor(fromBottom / o.floor);
    if (fx <= 0 || fx >= o.lenPx - 1) return mul(base, 0.92);
    if (o.doors && storey === 0 && inFloor < 4 && Math.abs(fx - Math.floor(o.lenPx / 2)) <= 1) return mul(base, 0.4);
    if (fromBottom < 2) return mul(base, 0.85);
    const col = fx % o.period;
    if (inFloor >= 2 && inFloor < 2 + o.winH && fromBottom < o.hPx - 1) {
      if (o.bands || (col >= 1 && col < 1 + o.winW)) {
        return hash2(fx, storey, o.seed) < 0.18 ? lit : win;
      }
    }
    return base;
  };
}

function roofShader(col: Color, edge: Color, seed: number): Shader {
  return (u, v, px, py) => {
    if (u < 0.06 || v < 0.06 || u > 0.94 || v > 0.94) return edge;
    return hash2(px, py, seed) < 0.1 ? mul(col, 0.92) : col;
  };
}

const WALLS = ramp('#e8e0cc', '#d9c9a3', '#c9b48a', '#f0ece0', '#cfc3b0', '#d7d2c4');
const BRICK = ramp('#9c4a32', '#a85c3a', '#8a3f2c', '#b06a48');
const ROOFS = ramp('#a33a2a', '#8f4a2e', '#5d5a6a', '#7a3a2a', '#4f5f74', '#6a6a60');
const GLASS = ramp('#4a6f9a', '#3b5d86', '#5d84ad', '#2f4b70');
const CONC = ramp('#b9b6ac', '#a7a49a', '#c8c4b8', '#9a978d');

function buildingCanvas(size: number): { buf: PixBuf; iso: Iso; ax: number; ay: number } {
  const w = size * 32;
  const h = size * 16 + BLD_MAX_H;
  const buf = new PixBuf(w, h);
  const ax = size * 16;
  const ay = BLD_MAX_H;
  return { buf, iso: new Iso(buf, ax, ay), ax, ay };
}

function gableHouse(iso: Iso, r: Rng, x0: number, y0: number, x1: number, y1: number, wallH: number, roofH: number, wallC: Color, roofC: Color): void {
  const lenL = (x1 - x0) * 16;
  const lenR = (y1 - y0) * 16;
  const wo = { base: wallC, win: hex('#3d5878'), lit: hex('#f2e4a0'), floor: 7, period: 5, winW: 2, winH: 3, seed: r.int(999), hPx: wallH };
  iso.shadow(x0, y0, x1, y1, 0.25);
  iso.box(x0, y0, x1, y1, 0, wallH, wallC, wallShader({ ...wo, lenPx: lenL, doors: true }, 1), wallShader({ ...wo, lenPx: lenR }, 0.72));
  const alongX = r.chance(0.5);
  const zr = wallH + roofH;
  const rl = mul(roofC, 1.0);
  const rd = mul(roofC, 0.7);
  if (alongX) {
    const ym = (y0 + y1) / 2;
    iso.face([x0 - 0.04, y0 - 0.04, wallH], [x1 + 0.04, y0 - 0.04, wallH], [x1 + 0.04, ym, zr], [x0 - 0.04, ym, zr], () => mul(roofC, 1.15));
    iso.face([x0 - 0.04, ym, zr], [x1 + 0.04, ym, zr], [x1 + 0.04, y1 + 0.04, wallH], [x0 - 0.04, y1 + 0.04, wallH], (u, v, px, py) => (py % 2 === 0 ? rl : mul(rl, 0.9)));
    iso.tri([x1, y1, wallH], [x1, y0, wallH], [x1, ym, zr], mul(wallC, 0.72));
  } else {
    const xm = (x0 + x1) / 2;
    iso.face([x0 - 0.04, y0 - 0.04, wallH], [xm, y0 - 0.04, zr], [xm, y1 + 0.04, zr], [x0 - 0.04, y1 + 0.04, wallH], () => mul(roofC, 1.15));
    iso.face([xm, y0 - 0.04, zr], [x1 + 0.04, y0 - 0.04, wallH], [x1 + 0.04, y1 + 0.04, wallH], [xm, y1 + 0.04, zr], (u, v, px, py) => (py % 2 === 0 ? rd : mul(rd, 0.9)));
    iso.tri([x0, y1, wallH], [x1, y1, wallH], [xm, y1, zr], wallC);
  }
}

function tower(iso: Iso, r: Rng, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, wall: Color, win: Color, opts: Partial<WallOpts> = {}, roof?: Color): void {
  const wo: WallOpts = {
    base: wall,
    win,
    lit: hex('#f4e9a8'),
    floor: 5,
    period: 3,
    winW: 1,
    winH: 2,
    seed: r.int(9999),
    lenPx: (x1 - x0) * 16,
    hPx: z1 - z0,
    ...opts,
  };
  const roofC = roof ?? mul(wall, 0.8);
  iso.box(x0, y0, x1, y1, z0, z1, roofShader(roofC, mul(wall, 1.1), wo.seed), wallShader(wo, 1), wallShader({ ...wo, lenPx: (y1 - y0) * 16 }, 0.7));
}

function zoneBuilding(z: Zone, level: number, variant: number): Sprite {
  const { buf, iso, ax, ay } = buildingCanvas(1);
  const r = new Rng(variant * 131 + level * 17 + z * 7);
  if (z === Zone.R) {
    if (level === 1) {
      const s = r.range(0.22, 0.3);
      gableHouse(iso, r, s, s, 1 - s, 1 - s + 0.04, 7, 6, r.pick(WALLS), r.pick(ROOFS));
      if (r.chance(0.6)) {
        const t = treeSprite(r.int(50));
        drawOn(buf, t, iso.p(0.85, 0.2, 0));
      }
    } else if (level === 2) {
      const s = r.range(0.12, 0.18);
      gableHouse(iso, r, s, s, 1 - s, 1 - s, 13, 7, r.pick(WALLS), r.pick(ROOFS));
    } else if (level === 3) {
      const h = 24 + r.int(4) * 5;
      const wall = r.chance(0.5) ? r.pick(BRICK) : r.pick(WALLS);
      iso.shadow(0.1, 0.1, 0.9, 0.9, 0.4);
      tower(iso, r, 0.1, 0.1, 0.9, 0.9, 0, h, wall, hex('#34506e'), { floor: 6, period: 4, winW: 2, winH: 3, doors: true });
      if (r.chance(0.6)) iso.box(0.55, 0.2, 0.75, 0.4, h, h + 4, hex('#9a978d'), hex('#8a877d'), hex('#6f6c64'));
    } else {
      const h = 52 + r.int(6) * 6;
      const wall = r.pick([...WALLS, ...CONC]);
      iso.shadow(0.15, 0.15, 0.85, 0.85, 0.7);
      tower(iso, r, 0.15, 0.15, 0.85, 0.85, 0, h, wall, hex('#2f4866'), { floor: 5, period: 3, winW: 2, winH: 2, doors: true });
      if (r.chance(0.5)) tower(iso, r, 0.28, 0.28, 0.72, 0.72, h, h + 8, wall, hex('#2f4866'));
    }
  } else if (z === Zone.C) {
    if (level === 1) {
      const wall = r.pick(WALLS);
      iso.shadow(0.12, 0.12, 0.88, 0.88, 0.25);
      tower(iso, r, 0.12, 0.12, 0.88, 0.88, 0, 10, wall, hex('#5a7fa0'), { floor: 10, period: 4, winW: 3, winH: 4, doors: true });
      const aw = r.pick(ramp('#c03030', '#3070c0', '#30a050', '#d08020'));
      iso.face([0.12, 0.88, 7], [0.88, 0.88, 7], [0.88, 1.0, 5], [0.12, 1.0, 5], (u) => (Math.floor(u * 12) % 2 ? aw : WHITE));
      iso.box(0.3, 0.3, 0.7, 0.4, 10, 13, mul(aw, 1.1), aw, mul(aw, 0.7));
    } else if (level === 2) {
      const h = 18 + r.int(3) * 5;
      iso.shadow(0.1, 0.1, 0.9, 0.9, 0.35);
      tower(iso, r, 0.1, 0.1, 0.9, 0.9, 0, h, r.pick([...CONC, ...WALLS]), r.pick(GLASS), { floor: 6, period: 4, winW: 3, winH: 3, doors: true });
    } else if (level === 3) {
      const h = 40 + r.int(4) * 6;
      iso.shadow(0.12, 0.12, 0.88, 0.88, 0.6);
      tower(iso, r, 0.12, 0.12, 0.88, 0.88, 0, h, r.pick(CONC), r.pick(GLASS), { floor: 5, period: 3, winW: 2, winH: 3, bands: r.chance(0.4) });
      iso.box(0.4, 0.4, 0.6, 0.6, h, h + 5, hex('#8a877d'), hex('#7a776d'), hex('#5f5c55'));
    } else {
      const h = 76 + r.int(5) * 8;
      const glass = r.pick(GLASS);
      const wall = r.chance(0.5) ? mul(glass, 1.3) : r.pick(CONC);
      iso.shadow(0.12, 0.12, 0.88, 0.88, 0.9);
      tower(iso, r, 0.12, 0.12, 0.88, 0.88, 0, h - 16, wall, glass, { floor: 4, period: 3, winW: 2, winH: 2, bands: r.chance(0.5) });
      tower(iso, r, 0.22, 0.22, 0.78, 0.78, h - 16, h, wall, glass, { floor: 4, period: 3, winW: 2, winH: 2 });
      const a = iso.p(0.5, 0.5, h);
      buf.rect(a[0], a[1] - 10, 1, 10, hex('#c0c0c0'));
      buf.set(a[0], a[1] - 11, hex('#ff3030'));
    }
  } else {
    if (level === 1) {
      iso.shadow(0.15, 0.15, 0.85, 0.85, 0.25);
      gableHouse(iso, r, 0.15, 0.2, 0.85, 0.8, 9, 5, r.pick(CONC), hex('#6f6f74'));
    } else if (level === 2) {
      iso.shadow(0.08, 0.08, 0.92, 0.92, 0.3);
      const wall = r.pick(['#a7a49a', '#b8a07a', '#9a8f7c'].map(hex));
      iso.box(0.08, 0.08, 0.92, 0.92, 0, 14, (u, v, px) => (px % 3 === 0 ? hex('#7c7a74') : hex('#94928a')), wallShader({ base: wall, win: hex('#4b4b4b'), floor: 14, period: 8, winW: 4, winH: 8, seed: 1, lenPx: 13, hPx: 14 }, 1), mul(wall, 0.7));
    } else if (level === 3) {
      iso.shadow(0.1, 0.1, 0.9, 0.9, 0.4);
      const wall = r.pick(BRICK);
      tower(iso, r, 0.1, 0.25, 0.9, 0.9, 0, 18, wall, hex('#3b3b3b'), { floor: 9, period: 4, winW: 2, winH: 4 });
      iso.cyl(0.25, 0.15, 0.08, 0, 44, hex('#b8b0a0'), hex('#3a3a3a'), hex('#b03020'));
      iso.cyl(0.75, 0.6, 0.12, 18, 26, hex('#8f9aa3'));
    } else {
      iso.shadow(0.05, 0.05, 0.95, 0.95, 0.5);
      tower(iso, r, 0.05, 0.4, 0.95, 0.95, 0, 22, r.pick(CONC), hex('#3b3b3b'), { floor: 11, period: 5, winW: 3, winH: 4 });
      iso.cyl(0.3, 0.2, 0.17, 0, 20, hex('#c8c8c0'));
      iso.cyl(0.72, 0.2, 0.13, 0, 16, hex('#b0b8c0'));
      iso.cyl(0.6, 0.65, 0.07, 22, 56, hex('#b8b0a0'), hex('#3a3a3a'), hex('#b03020'));
    }
  }
  return { cv: buf.toCanvas(), ax, ay };
}

function drawOn(buf: PixBuf, s: Sprite, at: Pt): void {
  const ctx = s.cv.getContext('2d')!;
  const d = new Uint32Array(ctx.getImageData(0, 0, s.cv.width, s.cv.height).data.buffer);
  for (let y = 0; y < s.cv.height; y++)
    for (let x = 0; x < s.cv.width; x++) {
      const c = d[y * s.cv.width + x];
      if (c >>> 24) buf.set(Math.round(at[0] - s.ax + x), Math.round(at[1] - s.ay + y), c);
    }
}

function serviceBuilding(def: BuildingDef): Sprite {
  const S = def.size;
  const { buf, iso, ax, ay } = buildingCanvas(S);
  const r = new Rng(def.id * 977);
  const trees = (pts: number[][]) => {
    for (const [u, v] of pts) drawOn(buf, treeSprite(r.int(60)), iso.p(u, v, 0));
  };
  switch (def.key) {
    case 'wind': {
      const b = iso.p(0.5, 0.5, 0);
      buf.rect(b[0] - 1, b[1] - 30, 2, 30, hex('#e8e8e8'));
      buf.rect(b[0], b[1] - 30, 1, 30, hex('#b8b8b8'));
      buf.rect(b[0] - 2, b[1] - 33, 5, 3, hex('#d0d0d0'));
      // Rotorblätter werden animiert in render.ts gezeichnet
      buf.set(b[0] + 1, b[1], alpha(BLACK, 80));
      break;
    }
    case 'gas': {
      iso.shadow(0.2, 0.3, 1.5, 1.8, 0.4);
      tower(iso, r, 0.2, 0.8, 1.5, 1.8, 0, 16, hex('#c8c4b8'), hex('#3b4b5b'), { floor: 8, period: 5, winW: 3, winH: 3 });
      iso.cyl(1.4, 0.45, 0.32, 0, 18, hex('#d0d4d8'));
      iso.cyl(0.55, 0.4, 0.07, 0, 34, hex('#b0b0b0'), hex('#333'));
      iso.cyl(0.85, 0.4, 0.07, 0, 30, hex('#b0b0b0'), hex('#333'));
      break;
    }
    case 'coal': {
      iso.box(1.9, 0.2, 2.8, 1.0, 0, 3, hex('#2a2a2a'), hex('#222'), hex('#1a1a1a'));
      iso.shadow(0.2, 1.1, 2.6, 2.8, 0.6);
      tower(iso, r, 0.2, 1.1, 2.6, 2.8, 0, 26, hex('#8f6a52'), hex('#3a3a3a'), { floor: 13, period: 6, winW: 3, winH: 8 }, hex('#5a5a5a'));
      iso.cyl(0.6, 0.6, 0.18, 0, 70, hex('#c0b8a8'), hex('#2a2a2a'), hex('#b03020'));
      iso.cyl(1.3, 0.6, 0.18, 0, 70, hex('#c0b8a8'), hex('#2a2a2a'), hex('#b03020'));
      break;
    }
    case 'nuclear': {
      const tower2 = (cx: number, cy: number) => {
        const c0 = iso.p(cx, cy, 0);
        const H = 50;
        for (let y = 0; y < H; y++) {
          const t = y / H;
          const rr = 0.42 - 0.18 * Math.sin(t * Math.PI * 0.85);
          const rx = rr * 22.6;
          for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++) {
            if (Math.abs(x + 0.5) > rx) continue;
            const f = 1.1 - ((x + 0.5) / rx + 1) * 0.25;
            buf.set(c0[0] + x, Math.round(c0[1] + rr * 11 - y), mul(hex('#d8d6d0'), f));
          }
        }
        const ctop = iso.p(cx, cy, H);
        const rt = (0.42 - 0.18 * Math.sin(Math.PI * 0.85)) * 22.6;
        for (let y = -6; y <= 6; y++)
          for (let x = -16; x <= 16; x++)
            if ((x * x) / (rt * rt) + (y * y) / ((rt / 2) * (rt / 2)) <= 1) buf.set(ctop[0] + x, ctop[1] + y, hex('#555'));
      };
      tower2(0.7, 0.7);
      tower2(0.75, 2.0);
      iso.box(1.6, 1.0, 2.8, 2.6, 0, 14, hex('#bdbab0'), hex('#d8d4c8'), hex('#a09d94'));
      const d = iso.p(2.2, 1.8, 14);
      for (let y = -12; y <= 0; y++)
        for (let x = -12; x <= 12; x++) {
          if (x * x + (y * 2) * (y * 2) * 0.25 > 144 * 0.9 || x * x + y * y * 1.0 > 144) continue;
          buf.set(d[0] + x, d[1] + y, mul(hex('#e4e2da'), 1.1 - (x + 12) / 40));
        }
      break;
    }
    case 'solar': {
      for (let k = 0; k < 4; k++) {
        const y0 = 0.15 + k * 0.45;
        iso.face([0.15, y0, 5], [1.85, y0, 5], [1.85, y0 + 0.3, 1], [0.15, y0 + 0.3, 1], (u, v, px) => (px % 4 === 0 ? hex('#5c78a8') : hex('#22345e')));
      }
      break;
    }
    case 'pump': {
      iso.shadow(0.15, 0.25, 0.75, 0.8, 0.3);
      tower(iso, r, 0.15, 0.25, 0.75, 0.8, 0, 11, hex('#d8d2c0'), hex('#34506e'), { floor: 11, period: 5, winW: 2, winH: 4, doors: true }, hex('#2f5f9a'));
      // Rohrleitung und Ventilrad
      iso.box(0.75, 0.45, 0.95, 0.6, 0, 4, hex('#4a8ad0'), hex('#3a7ac0'), hex('#2a5a90'));
      iso.box(0.3, 0.05, 0.45, 0.25, 0, 6, hex('#4a8ad0'), hex('#3a7ac0'), hex('#2a5a90'));
      const v = iso.p(0.85, 0.52, 7);
      for (let k = -2; k <= 2; k++) {
        buf.set(v[0] + k, v[1], hex('#c03020'));
        buf.set(v[0], v[1] + k, hex('#c03020'));
      }
      break;
    }
    case 'watertower': {
      iso.shadow(0.45, 0.45, 1.55, 1.55, 0.9);
      const legs = [
        [0.6, 0.6],
        [1.4, 0.6],
        [0.6, 1.4],
        [1.4, 1.4],
      ];
      const legTop = 34;
      for (const [lx, ly] of legs) iso.box(lx - 0.05, ly - 0.05, lx + 0.05, ly + 0.05, 0, legTop, hex('#8a8f96'), hex('#9aa0a8'), hex('#6a7078'));
      for (const z of [10, 22]) {
        const a = iso.p(0.6, 1.4, z);
        const b = iso.p(1.4, 1.4, z + 8);
        buf.line(a[0], a[1], b[0], b[1], hex('#70757c'));
        const c = iso.p(1.4, 1.4, z);
        const d = iso.p(1.4, 0.6, z + 8);
        buf.line(c[0], c[1], d[0], d[1], hex('#5a6068'));
      }
      iso.cyl(1, 1, 0.62, legTop, legTop + 20, hex('#cfd8e2'), hex('#9fb0c2'));
      const top = iso.p(1, 1, legTop + 20);
      const rx = 0.62 * 22.6;
      for (let y = 0; y < 9; y++) {
        const half = Math.round((y / 9) * rx);
        for (let x = -half; x <= half; x++) buf.set(top[0] + x, top[1] - 9 + y, mul(hex('#4a7ab8'), 1.15 - ((x / (rx + 1)) + 1) * 0.2));
      }
      // Schriftband
      const band = iso.p(1, 1, legTop + 10);
      for (let x = -9; x <= 9; x += 3) buf.set(band[0] + x, band[1] + 4, hex('#2a5a9a'));
      break;
    }
    case 'police': {
      iso.shadow(0.2, 0.2, 1.8, 1.6, 0.4);
      tower(iso, r, 0.2, 0.2, 1.8, 1.6, 0, 16, hex('#cfd6dc'), hex('#2f4866'), { floor: 8, period: 4, winW: 2, winH: 3, doors: true }, hex('#5a6e8a'));
      iso.face([0.2, 1.6, 15], [1.8, 1.6, 15], [1.8, 1.6, 12], [0.2, 1.6, 12], () => hex('#2050b0'));
      iso.box(0.5, 1.75, 0.8, 1.9, 0, 3, hex('#2a50a8'), hex('#eee'), hex('#1a3a80'));
      iso.box(1.1, 1.75, 1.4, 1.9, 0, 3, hex('#2a50a8'), hex('#eee'), hex('#1a3a80'));
      break;
    }
    case 'fire': {
      iso.shadow(0.2, 0.2, 1.6, 1.8, 0.4);
      tower(iso, r, 0.2, 0.2, 1.6, 1.8, 0, 14, hex('#a8402c'), hex('#3a2a2a'), { floor: 14, period: 7, winW: 5, winH: 9 }, hex('#5a5a5a'));
      tower(iso, r, 1.6, 0.2, 1.9, 0.5, 0, 30, hex('#a8402c'), hex('#3a2a2a'), { floor: 6, period: 3, winW: 1, winH: 2 });
      iso.box(0.4, 1.85, 0.9, 2.0, 0, 4, hex('#d02020'), hex('#c01818'), hex('#901010'));
      break;
    }
    case 'hospital': {
      iso.shadow(0.15, 0.15, 1.85, 1.85, 0.5);
      tower(iso, r, 0.15, 0.15, 1.85, 1.85, 0, 22, hex('#f0f0ec'), hex('#4a6f9a'), { floor: 6, period: 4, winW: 2, winH: 3, doors: true }, hex('#d8d8d4'));
      iso.face([0.6, 0.6, 22.5], [1.4, 0.6, 22.5], [1.4, 1.4, 22.5], [0.6, 1.4, 22.5], (u, v) =>
        (Math.abs(u - 0.5) < 0.12 && v > 0.15 && v < 0.85) || (Math.abs(v - 0.5) < 0.12 && u > 0.15 && u < 0.85) ? hex('#d02020') : hex('#e8e8e4'),
      );
      break;
    }
    case 'school': {
      iso.shadow(0.15, 0.15, 1.85, 1.0, 0.3);
      tower(iso, r, 0.15, 0.15, 1.85, 1.0, 0, 13, hex('#c8724a'), hex('#34506e'), { floor: 6, period: 4, winW: 2, winH: 3, doors: true }, hex('#7a5040'));
      iso.face([0.3, 1.2, 0.5], [1.7, 1.2, 0.5], [1.7, 1.85, 0.5], [0.3, 1.85, 0.5], (u, v) => (Math.abs(u - 0.5) < 0.02 || Math.abs(v - 0.5) < 0.03 ? WHITE : hex('#a0522d')));
      const f = iso.p(1.8, 1.8, 0);
      buf.rect(f[0], f[1] - 22, 1, 22, hex('#ddd'));
      buf.rect(f[0] + 1, f[1] - 22, 6, 2, hex('#202020'));
      buf.rect(f[0] + 1, f[1] - 20, 6, 2, hex('#d02020'));
      buf.rect(f[0] + 1, f[1] - 18, 6, 2, hex('#f0c020'));
      break;
    }
    case 'college': {
      iso.shadow(0.2, 0.2, 2.8, 1.4, 0.4);
      tower(iso, r, 0.2, 0.2, 2.8, 1.3, 0, 20, hex('#d8cfb8'), hex('#34506e'), { floor: 7, period: 4, winW: 2, winH: 4, doors: true }, hex('#6a7a6a'));
      tower(iso, r, 0.2, 1.5, 1.2, 2.8, 0, 16, hex('#d8cfb8'), hex('#34506e'), { floor: 8, period: 4, winW: 2, winH: 4 });
      tower(iso, r, 1.2, 0.5, 1.8, 1.1, 20, 44, hex('#d8cfb8'), hex('#34506e'), { floor: 8, period: 3, winW: 1, winH: 3 });
      const c = iso.p(1.5, 0.8, 44);
      for (let y = 0; y < 8; y++) for (let x = -y; x <= y; x++) buf.set(c[0] + x, c[1] - 8 + y, x < 0 ? hex('#4a8a6a') : hex('#3a6a52'));
      trees([
        [1.8, 2.0],
        [2.4, 1.9],
        [2.2, 2.5],
      ]);
      break;
    }
    case 'park': {
      iso.face([0.2, 0.2, 0.3], [0.8, 0.2, 0.3], [0.8, 0.8, 0.3], [0.2, 0.8, 0.3], (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.22 ? hex('#4a86d8') : Math.hypot(u - 0.5, v - 0.5) < 0.3 ? hex('#cfc8b0') : 0));
      trees([
        [0.15, 0.2],
        [0.85, 0.3],
        [0.3, 0.85],
      ]);
      break;
    }
    case 'bigpark': {
      iso.face([0.2, 0.3, 0.3], [1.2, 0.3, 0.3], [1.2, 1.0, 0.3], [0.2, 1.0, 0.3], (u, v) => (Math.hypot((u - 0.5) * 1.4, v - 0.5) < 0.42 ? (Math.hypot((u - 0.5) * 1.4, v - 0.5) < 0.36 ? hex('#3f7fd0') : hex('#c8c0a0')) : 0));
      iso.face([0.95, 0.0, 0.2], [1.05, 0.0, 0.2], [1.05, 2.0, 0.2], [0.95, 2.0, 0.2], () => hex('#cfc8b0'));
      trees([
        [0.2, 1.3],
        [0.5, 1.7],
        [1.4, 0.3],
        [1.7, 0.7],
        [1.5, 1.4],
        [1.8, 1.8],
        [0.8, 1.5],
      ]);
      break;
    }
    case 'stadium': {
      const cxy = 1.5;
      const c = iso.p(cxy, cxy, 0);
      const rx = 2.4 * 16;
      const ry = 2.4 * 8;
      for (let y = -Math.ceil(ry) - 14; y <= Math.ceil(ry); y++)
        for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
          // Ring mit Höhe: Tribünen
          for (let z = 12; z >= 0; z -= 1) {
            const yy = y + z;
            const d = (x * x) / (rx * rx) + (yy * yy) / (ry * ry);
            if (d <= 1 && d >= 0.42) {
              const shade = yy < 0 ? 0.85 : 1;
              buf.set(c[0] + x, c[1] + y, mul(z === 12 ? hex('#c8c8c0') : (y + x) % 3 === 0 ? hex('#b03030') : hex('#909090'), shade));
              break;
            }
          }
        }
      for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++)
        for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++) {
          const yy = y + 12;
          const d = (x * x) / (rx * rx) + (yy * yy) / (ry * ry);
          if (d < 0.42) buf.set(c[0] + x, c[1] + y, Math.abs(x) < 1 || Math.abs(d - 0.2) < 0.015 ? WHITE : (Math.floor(x / 4) % 2 ? hex('#3f9a3a') : hex('#4aa844')));
        }
      break;
    }
    case 'seaport': {
      iso.box(0.2, 0.2, 1.4, 1.2, 0, 14, hex('#9a978d'), hex('#b8b4a8'), hex('#86837a'));
      const cols = ramp('#c03030', '#3070c0', '#30a050', '#d08020', '#808080');
      for (let k = 0; k < 6; k++) {
        const x = 1.6 + (k % 3) * 0.4;
        const y = 1.5 + Math.floor(k / 3) * 0.6;
        const c = r.pick(cols);
        iso.box(x, y, x + 0.32, y + 0.5, 0, 5 + (k % 2) * 5, mul(c, 1.1), c, mul(c, 0.7));
      }
      for (const [cx, cy] of [
        [2.6, 0.5],
        [2.6, 1.3],
      ]) {
        const b = iso.p(cx, cy, 0);
        buf.rect(b[0] - 1, b[1] - 34, 2, 34, hex('#e0b020'));
        buf.line(b[0], b[1] - 34, b[0] - 22, b[1] - 24, hex('#e0b020'));
        buf.line(b[0], b[1] - 33, b[0] - 22, b[1] - 23, hex('#b08010'));
      }
      break;
    }
    case 'airport': {
      iso.face([0.3, 2.6, 0.3], [3.9, 2.6, 0.3], [3.9, 3.4, 0.3], [0.3, 3.4, 0.3], (u, v) => (Math.abs(v - 0.5) < 0.06 && Math.floor(u * 20) % 2 === 0 ? WHITE : hex('#3a3b40')));
      iso.shadow(0.3, 0.3, 2.4, 1.4, 0.4);
      tower(iso, r, 0.3, 0.3, 2.4, 1.4, 0, 14, hex('#d8d8d0'), r.pick(GLASS), { floor: 14, period: 3, winW: 2, winH: 8, bands: true, doors: true }, hex('#9a9a94'));
      tower(iso, r, 3.0, 0.4, 3.4, 0.8, 0, 34, hex('#d8d8d0'), hex('#555'), { floor: 6, period: 3, winW: 1, winH: 2 });
      iso.box(2.9, 0.3, 3.5, 0.9, 34, 40, hex('#3a6a9a'), hex('#5a8aba'), hex('#2a4a6a'));
      // kleines Flugzeug
      const p = iso.p(2.6, 1.9, 1);
      buf.rect(p[0] - 8, p[1], 16, 2, hex('#f0f0f0'));
      buf.rect(p[0] - 2, p[1] - 5, 3, 12, hex('#e0e0e0'));
      buf.rect(p[0] + 6, p[1] - 3, 2, 3, hex('#3060c0'));
      break;
    }
  }
  return { cv: buf.toCanvas(), ax, ay };
}

// ---------------- Feuer, Tornado, Symbole ----------------

export function fireSprite(frame: number): Sprite {
  const buf = new PixBuf(20, 28);
  const r = new Rng(frame * 31 + 5);
  const cols = ramp('#fff3a0', '#ffd040', '#ff9020', '#e04010', '#a02008');
  for (let k = 0; k < 4; k++) {
    const bx = 4 + r.int(12);
    const hgt = 10 + r.int(14);
    for (let y = 0; y < hgt; y++) {
      const ww = Math.round((1 - y / hgt) * 3.2);
      for (let x = -ww; x <= ww; x++) {
        const t = Math.abs(x) / (ww + 1) + y / hgt;
        buf.set(bx + x + (y > hgt / 2 ? r.int(2) - 1 : 0), 26 - y, cols[Math.min(4, Math.floor(t * 3.2))]);
      }
    }
  }
  return { cv: buf.toCanvas(), ax: 10, ay: 24 };
}

export function tornadoSprite(frame: number): Sprite {
  const buf = new PixBuf(40, 80);
  for (let y = 0; y < 76; y++) {
    const t = y / 76;
    const rad = 2 + Math.pow(t, 1.6) * 16;
    const off = Math.sin(y * 0.15 + frame * 1.3) * (3 + t * 3);
    for (let x = -rad; x <= rad; x++) {
      const h = hash2(Math.round(x + frame * 3), y, 3);
      if (h < 0.35) continue;
      const shade = 0.6 + 0.3 * Math.sin((x / rad) * Math.PI + frame);
      buf.set(Math.round(20 + x + off), 78 - (76 - y), mul(hex('#8a8478'), shade));
    }
  }
  return { cv: buf.toCanvas(), ax: 20, ay: 78 };
}

export function boltSprite(): Sprite {
  const pts = ['..####', '.####.', '####..', '.####.', '..###.', '.###..', '##....'];
  const buf = new PixBuf(8, 9);
  pts.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && buf.set(x + 1, y + 1, hex('#ffe020'))));
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 8; x++) {
      if (buf.get(x, y)) continue;
      const nb = buf.get(x - 1, y) | buf.get(x + 1, y) | buf.get(x, y - 1) | buf.get(x, y + 1);
      if (nb && (buf.get(x - 1, y) === hex('#ffe020') || buf.get(x + 1, y) === hex('#ffe020') || buf.get(x, y - 1) === hex('#ffe020') || buf.get(x, y + 1) === hex('#ffe020')))
        buf.set(x, y, hex('#a01010'));
    }
  return { cv: buf.toCanvas(), ax: 4, ay: 9 };
}

/** Wassertropfen mit rotem Rand: kein Wasseranschluss. */
export function dropSprite(): Sprite {
  const rows = ['...#...', '...#...', '..###..', '.#####.', '#######', '#######', '#######', '.#####.', '..###..'];
  const buf = new PixBuf(9, 11);
  const blue = hex('#4aa0ff');
  rows.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && buf.set(x + 1, y + 1, blue)));
  buf.set(3, 5, hex('#d8ecff'));
  buf.set(3, 6, hex('#d8ecff'));
  for (let y = 0; y < 11; y++)
    for (let x = 0; x < 9; x++) {
      if (buf.get(x, y)) continue;
      const b = (xx: number, yy: number) => buf.get(xx, yy) === blue;
      if (b(x - 1, y) || b(x + 1, y) || b(x, y - 1) || b(x, y + 1)) buf.set(x, y, hex('#a01010'));
    }
  return { cv: buf.toCanvas(), ax: 4, ay: 11 };
}

// ---------------- Cache ----------------

export class SpriteCache {
  private map = new Map<string, Sprite>();
  grid = true;

  private get(key: string, make: () => Sprite): Sprite {
    let s = this.map.get(key);
    if (!s) {
      s = make();
      this.map.set(key, s);
    }
    return s;
  }

  clearTerrain(): void {
    for (const k of Array.from(this.map.keys())) if (k.startsWith('t|')) this.map.delete(k);
  }

  terrain(n: number, e: number, s: number, w: number, surface: string, variant: number): Sprite {
    const key = `t|${n}${e}${s}${w}|${surface}|${variant}|${this.grid ? 1 : 0}`;
    return this.get(key, () => terrainSprite(n, e, s, w, surfaceShader(surface, variant, this.grid)));
  }
  tint(n: number, e: number, s: number, w: number, color: Color): Sprite {
    return this.get(`tint|${n}${e}${s}${w}|${color}`, () => tintSprite(n, e, s, w, color));
  }
  outline(n: number, e: number, s: number, w: number, color: Color): Sprite {
    return this.get(`ol|${n}${e}${s}${w}|${color}`, () => outlineSprite(n, e, s, w, color));
  }
  skirt(side: number, h1: number, h2: number, water: boolean): Sprite {
    return this.get(`sk|${side}|${h1}|${h2}|${water ? 1 : 0}`, () => skirtSprite(side, h1, h2, water));
  }
  tree(v: number): Sprite {
    return this.get(`tree|${v}`, () => treeSprite(v));
  }
  power(mask: number, hc: number, he: number[], road: boolean): Sprite {
    return this.get(`pw|${mask}|${hc}|${he.join(',')}|${road ? 1 : 0}`, () => powerSprite(mask, hc, he, road));
  }
  bridge(mask: number): Sprite {
    return this.get(`br|${mask}`, () => bridgeSprite(mask));
  }
  zone(z: Zone, level: number, variant: number): Sprite {
    const v = variant % 6;
    return this.get(`zb|${z}|${level}|${v}`, () => zoneBuilding(z, level, v));
  }
  building(def: BuildingDef): Sprite {
    return this.get(`b|${def.key}`, () => serviceBuilding(def));
  }
  fire(frame: number): Sprite {
    return this.get(`fire|${frame}`, () => fireSprite(frame));
  }
  tornado(frame: number): Sprite {
    return this.get(`tor|${frame}`, () => tornadoSprite(frame));
  }
  bolt(): Sprite {
    return this.get('bolt', () => boltSprite());
  }
  drop(): Sprite {
    return this.get('drop', () => dropSprite());
  }
}

export const ZONE_COLORS = ZONE_COL;
