// Kartenerzeugung und Geländebearbeitung.

import { MAXH } from './config';
import { fbm, Rng } from './rng';
import { World } from './world';

export interface TerrainOptions {
  water: number; // 0 wenig, 1 mittel, 2 viel
  hills: number; // 0 flach, 1 hügelig, 2 bergig
  river: boolean;
  trees: number; // 0..2
}

export function generateTerrain(wd: World, opt: TerrainOptions): void {
  const { w, h } = wd;
  const seed = wd.seed;
  const rng = new Rng(seed);
  const levels = [3, 6, MAXH][opt.hills];
  const waterFrac = [0.08, 0.2, 0.36][opt.water];
  const scale = 1 / (10 + w / 8);

  const vw = w + 1;
  const vh = h + 1;
  const raw = new Float32Array(vw * vh);
  // Küstenverlauf: eine zufällige Kartenseite fällt zum Meer ab
  const coastSide = rng.int(5); // 4 = keine Küste
  for (let y = 0; y < vh; y++)
    for (let x = 0; x < vw; x++) {
      let n = fbm(x * scale, y * scale, seed, 5);
      if (coastSide < 4) {
        const t = [x / w, y / h, 1 - x / w, 1 - y / h][coastSide];
        n -= Math.max(0, 0.35 - t) * 1.2 * (opt.water + 0.5);
      }
      raw[y * vw + x] = n;
    }

  // Wasserschwelle über Quantil bestimmen
  const sorted = Array.from(raw).sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * waterFrac)];
  const top = sorted[sorted.length - 1];

  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    if (n <= thr) {
      wd.corners[i] = 0;
    } else {
      let t = (n - thr) / (top - thr + 1e-6);
      // Plateaus begünstigen: in Stufen quantisieren
      t = Math.pow(t, opt.hills === 2 ? 1.1 : 1.4);
      wd.corners[i] = 1 + Math.min(levels - 1, Math.floor(t * levels));
    }
  }

  if (opt.river) carveRiver(wd, rng);
  relaxCorners(wd);

  // Bäume
  const treeAmt = [0.66, 0.58, 0.5][opt.trees];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = wd.idx(x, y);
      if (wd.isWater(i)) continue;
      const f = fbm(x * 0.09 + 50, y * 0.09 + 50, seed + 7, 3);
      if (f > treeAmt) wd.tree[i] = Math.min(3, 1 + Math.floor((f - treeAmt) * 18));
      else if (rng.chance(0.015)) wd.tree[i] = 1;
    }
}

function carveRiver(wd: World, rng: Rng): void {
  const { w, h } = wd;
  const horizontal = rng.chance(0.5);
  const len = horizontal ? w : h;
  let pos = (horizontal ? h : w) * rng.range(0.3, 0.7);
  let dir = 0;
  const width = 1 + rng.int(2);
  for (let t = 0; t <= len; t++) {
    dir += rng.range(-0.25, 0.25);
    dir = Math.max(-0.8, Math.min(0.8, dir));
    pos += dir;
    const lim = horizontal ? h : w;
    if (pos < 4) {
      pos = 4;
      dir = Math.abs(dir);
    }
    if (pos > lim - 4) {
      pos = lim - 4;
      dir = -Math.abs(dir);
    }
    for (let k = -width; k <= width + 1; k++) {
      const p = Math.round(pos) + k;
      if (p < 0 || p > lim) continue;
      if (horizontal) wd.setCh(t, p, 0);
      else wd.setCh(p, t, 0);
    }
  }
}

/** Erzwingt höchstens eine Stufe Unterschied zwischen benachbarten Ecken, indem höhere Ecken abgesenkt werden. */
export function relaxCorners(wd: World): void {
  const vw = wd.w + 1;
  const vh = wd.h + 1;
  const c = wd.corners;
  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 0; y < vh; y++)
      for (let x = 0; x < vw; x++) {
        const i = y * vw + x;
        let m = 255;
        if (x > 0) m = Math.min(m, c[i - 1]);
        if (x < vw - 1) m = Math.min(m, c[i + 1]);
        if (y > 0) m = Math.min(m, c[i - vw]);
        if (y < vh - 1) m = Math.min(m, c[i + vw]);
        if (c[i] > m + 1) {
          c[i] = m + 1;
          changed = true;
        }
      }
  }
}

/**
 * Setzt Eckhöhen und gleicht die Umgebung aus. Liefert die Menge der betroffenen Ecken
 * (als Index in corners) mit neuen Höhen, ohne die Welt zu verändern.
 */
export function planCornerChange(wd: World, targets: Map<number, number>): Map<number, number> {
  const vw = wd.w + 1;
  const vh = wd.h + 1;
  const res = new Map<number, number>(targets);
  const get = (i: number) => (res.has(i) ? res.get(i)! : wd.corners[i]);
  const queue = Array.from(targets.keys());
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % vw;
    const y = (i / vw) | 0;
    const v = get(i);
    const nb: number[] = [];
    if (x > 0) nb.push(i - 1);
    if (x < vw - 1) nb.push(i + 1);
    if (y > 0) nb.push(i - vw);
    if (y < vh - 1) nb.push(i + vw);
    for (const j of nb) {
      const u = get(j);
      if (u > v + 1) {
        res.set(j, v + 1);
        queue.push(j);
      } else if (u < v - 1) {
        res.set(j, v - 1);
        queue.push(j);
      }
    }
  }
  for (const [k, v] of Array.from(res)) if (v === wd.corners[k]) res.delete(k);
  return res;
}

/** Kacheln, die von geänderten Ecken berührt werden. */
export function tilesOfCorners(wd: World, corners: Iterable<number>): Set<number> {
  const vw = wd.w + 1;
  const out = new Set<number>();
  for (const c of corners) {
    const x = c % vw;
    const y = (c / vw) | 0;
    for (const [tx, ty] of [
      [x, y],
      [x - 1, y],
      [x, y - 1],
      [x - 1, y - 1],
    ])
      if (wd.inb(tx, ty)) out.add(wd.idx(tx, ty));
  }
  return out;
}
