// Stadtsimulation: Strom, Wachstum, Verkehr, Umwelt, Finanzen, Katastrophen.

import {
  COM_JOBS,
  cityRank,
  CITY_RANKS,
  IND_JOBS,
  NET_POWER,
  NET_ROAD,
  RES_POP,
  TICKS_PER_MONTH,
  UPKEEP,
  Zone,
} from './config';
import { World, YearReport } from './world';

export type MsgKind = 'info' | 'good' | 'warn' | 'bad';

export interface SimEvents {
  message(text: string, kind: MsgKind, tile?: number): void;
  yearEnd(report: YearReport): void;
  gameOver(reason: string): void;
  quake(): void;
}

export interface Tornado {
  x: number;
  y: number;
  dx: number;
  dy: number;
  life: number;
}

const ACC_ROAD = 1;
const ACC_R = 2;
const ACC_C = 4;
const ACC_I = 8;
const ACC_EDGE = 16;

export class Simulation {
  burning = new Set<number>();
  tornado: Tornado | null = null;
  private lastMsg = new Map<string, number>();
  private compOf: Int32Array;

  constructor(
    public wd: World,
    public ev: SimEvents,
  ) {
    this.compOf = new Int32Array(wd.w * wd.h);
    for (let i = 0; i < wd.fire.length; i++) if (wd.fire[i]) this.burning.add(i);
    this.computePower();
    this.monthlyMaps();
    this.computeTotals();
  }

  get monthIndex(): number {
    return this.wd.year * 12 + this.wd.month;
  }

  private say(key: string, text: string, kind: MsgKind, everyMonths = 12, tile?: number): void {
    const last = this.lastMsg.get(key);
    if (last !== undefined && this.monthIndex - last < everyMonths) return;
    this.lastMsg.set(key, this.monthIndex);
    this.ev.message(text, kind, tile);
  }

  step(): void {
    const wd = this.wd;
    if (wd.gameOver) return;
    wd.tick++;
    if (wd.powerDirty) this.computePower();
    this.growth();
    this.fireStep();
    this.tornadoStep();
    if (wd.tick % TICKS_PER_MONTH === 0) this.monthly();
  }

  // ---------------- Strom ----------------

  computePower(): void {
    const wd = this.wd;
    wd.powerDirty = false;
    const n = wd.w * wd.h;
    const powered = wd.powered;
    const prev = powered.slice();
    powered.fill(0);
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let qh = 0;
    let qt = 0;
    let cap = 0;
    const counted = new Set<number>();
    for (let i = 0; i < n; i++) {
      const def = wd.bldDef(i);
      if (def && def.cat === 'power') {
        seen[i] = 1;
        powered[i] = 1;
        queue[qt++] = i;
        const o = wd.origin[i];
        if (!counted.has(o)) {
          counted.add(o);
          cap += def.power || 0;
        }
      }
    }
    let used = 0;
    let demand = 0;
    const w = wd.w;
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i / w) | 0;
      for (let k = 0; k < 4; k++) {
        let j: number;
        if (k === 0) {
          if (y === 0) continue;
          j = i - w;
        } else if (k === 1) {
          if (x === w - 1) continue;
          j = i + 1;
        } else if (k === 2) {
          if (y === wd.h - 1) continue;
          j = i + w;
        } else {
          if (x === 0) continue;
          j = i - 1;
        }
        if (seen[j] || !wd.isConductor(j)) continue;
        seen[j] = 1;
        queue[qt++] = j;
        let cons = 0;
        if (wd.zone[j]) cons = wd.level[j];
        else if (wd.bld[j]) cons = wd.bldDef(j)!.cat === 'power' ? 0 : 2;
        demand += cons;
        if (used + cons <= cap) {
          used += cons;
          powered[j] = 1;
        }
      }
    }
    // Gebäude, die mit Strom versorgt sind, aber noch nicht erreicht wurden, zählen als Nachfrage
    wd.powerCap = cap;
    wd.powerUsed = Math.max(used, demand);
    for (let i = 0; i < n; i++) if (prev[i] !== powered[i] && wd.bld[i]) wd.changed(i);
  }

  // ---------------- Wachstum ----------------

  private levelCap(z: Zone, lv: number): number {
    const pop = this.wd.pop;
    let cap = 1;
    if (lv >= 35) cap = 2;
    if (lv >= 80 && pop >= (z === Zone.R ? 1200 : 1800)) cap = 3;
    if (lv >= 120 && pop >= (z === Zone.R ? 6000 : 8000)) cap = 4;
    if (z === Zone.I) cap = Math.min(4, Math.max(cap, lv >= 20 ? 2 : 1));
    return cap;
  }

  private growth(): void {
    const wd = this.wd;
    const rng = wd.rng;
    const n = wd.w * wd.h;
    const g = wd.diff.growth;
    for (let i = 0; i < n; i++) {
      const z = wd.zone[i] as Zone;
      if (!z) continue;
      if (wd.fire[i]) continue;
      if (wd.rubble[i]) {
        if (rng.chance(0.03)) {
          wd.rubble[i] = 0;
          wd.changed(i);
        }
        continue;
      }
      const L = wd.level[i];
      const acc = wd.access[i];
      const ok = (acc & ACC_ROAD) !== 0 && wd.powered[i] !== 0 && wd.isFlat(i);
      if (!ok) {
        if (L > 0 && rng.chance(0.015)) this.setLevel(i, L - 1);
        continue;
      }
      const lv = wd.landValue[i];
      let score = z === Zone.R ? wd.demandR : z === Zone.C ? wd.demandC : wd.demandI;
      if (z === Zone.R) {
        score += (lv - 90) / 400;
        score -= wd.pollution[i] / 300;
        score -= wd.crime[i] / 500;
        if (!(acc & (ACC_C | ACC_I | ACC_EDGE))) score -= 0.7;
      } else if (z === Zone.C) {
        score += (lv - 80) / 500;
        score -= wd.crime[i] / 600;
        if (!(acc & (ACC_R | ACC_EDGE))) score -= 0.7;
      } else {
        score -= wd.crime[i] / 900;
        if (!(acc & (ACC_R | ACC_EDGE))) score -= 0.7;
      }
      score -= Math.max(0, this.nearTraffic(i) - 160) / 400;
      const maxL = Math.min(wd.dense[i] ? 4 : 2, this.levelCap(z, lv));
      if (score > 0 && L < maxL) {
        const p = Math.min(1, score) * 0.06 * g * (L === 0 ? 1.5 : 1 / L);
        if (rng.chance(p)) this.setLevel(i, L + 1);
      } else if (L > maxL && rng.chance(0.01)) {
        this.setLevel(i, L - 1);
      } else if (score < -0.25 && L > 0) {
        if (rng.chance(-score * 0.012)) this.setLevel(i, L - 1);
      }
    }
  }

  private nearTraffic(i: number): number {
    const wd = this.wd;
    const x = i % wd.w;
    const y = (i / wd.w) | 0;
    let t = 0;
    if (x > 0 && wd.isRoad(i - 1)) t = Math.max(t, wd.traffic[i - 1]);
    if (x < wd.w - 1 && wd.isRoad(i + 1)) t = Math.max(t, wd.traffic[i + 1]);
    if (y > 0 && wd.isRoad(i - wd.w)) t = Math.max(t, wd.traffic[i - wd.w]);
    if (y < wd.h - 1 && wd.isRoad(i + wd.w)) t = Math.max(t, wd.traffic[i + wd.w]);
    return t;
  }

  private setLevel(i: number, L: number): void {
    const wd = this.wd;
    if (L > wd.level[i]) wd.variant[i] = wd.rng.int(256);
    wd.level[i] = L;
    wd.changed(i);
  }

  // ---------------- Feuer und Katastrophen ----------------

  isFlammable(i: number): boolean {
    const wd = this.wd;
    if (wd.fire[i] || wd.isWater(i)) return false;
    return (wd.zone[i] !== 0 && wd.level[i] > 0) || wd.bld[i] !== 0 || wd.tree[i] !== 0;
  }

  ignite(i: number): void {
    const wd = this.wd;
    if (!this.isFlammable(i)) return;
    wd.fire[i] = 10 + wd.rng.int(8);
    this.burning.add(i);
    wd.changed(i);
  }

  private fireStep(): void {
    if (!this.burning.size) return;
    const wd = this.wd;
    const rng = wd.rng;
    const fund = wd.funding.fire / 100;
    for (const i of Array.from(this.burning)) {
      const cov = (wd.covFire[i] / 255) * fund;
      if (rng.chance(0.04 + cov * 0.35)) {
        wd.fire[i] = 0;
        this.burning.delete(i);
        if (wd.zone[i] && wd.level[i] > 1) wd.level[i]--;
        wd.changed(i);
        continue;
      }
      wd.fire[i]--;
      if (wd.fire[i] <= 0) {
        wd.fire[i] = 0;
        this.burning.delete(i);
        wd.destroyTile(i);
        continue;
      }
      const x = i % wd.w;
      const y = (i / wd.w) | 0;
      const spread = 0.07 * (1 - cov * 0.8);
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ])
        if (wd.inb(nx, ny) && rng.chance(spread)) this.ignite(wd.idx(nx, ny));
    }
  }

  startTornado(): void {
    const wd = this.wd;
    const rng = wd.rng;
    const side = rng.int(4);
    let x = rng.range(5, wd.w - 5);
    let y = rng.range(5, wd.h - 5);
    if (side === 0) x = 1;
    if (side === 1) y = 1;
    if (side === 2) x = wd.w - 2;
    if (side === 3) y = wd.h - 2;
    const ang = Math.atan2(wd.h / 2 - y, wd.w / 2 - x) + rng.range(-0.5, 0.5);
    this.tornado = { x, y, dx: Math.cos(ang) * 0.6, dy: Math.sin(ang) * 0.6, life: 50 + rng.int(30) };
    this.ev.message('Ein Tornado wurde gesichtet!', 'bad', wd.idx(Math.floor(x), Math.floor(y)));
  }

  private tornadoStep(): void {
    const t = this.tornado;
    if (!t) return;
    const wd = this.wd;
    t.x += t.dx;
    t.y += t.dy;
    t.dx += wd.rng.range(-0.15, 0.15);
    t.dy += wd.rng.range(-0.15, 0.15);
    const sp = Math.hypot(t.dx, t.dy);
    if (sp > 0.8) {
      t.dx *= 0.8 / sp;
      t.dy *= 0.8 / sp;
    }
    t.life--;
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    if (t.life <= 0 || !wd.inb(tx, ty)) {
      this.tornado = null;
      return;
    }
    const i = wd.idx(tx, ty);
    if (!wd.isWater(i) && !wd.isEmpty(i)) wd.destroyTile(i);
    else if (wd.tree[i]) wd.destroyTile(i);
  }

  earthquake(): void {
    const wd = this.wd;
    const rng = wd.rng;
    const cx = rng.int(wd.w);
    const cy = rng.int(wd.h);
    const r = 18;
    let hits = 0;
    for (let y = Math.max(0, cy - r); y < Math.min(wd.h, cy + r); y++)
      for (let x = Math.max(0, cx - r); x < Math.min(wd.w, cx + r); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const i = wd.idx(x, y);
        if (wd.isEmpty(i)) continue;
        const p = 0.25 * (1 - d / r);
        if (rng.chance(p)) {
          if (rng.chance(0.3)) this.ignite(i);
          else wd.destroyTile(i);
          hits++;
        }
      }
    this.ev.quake();
    this.ev.message(`Erdbeben! ${hits} Kacheln wurden beschädigt.`, 'bad', wd.idx(cx, cy));
  }

  randomFire(): void {
    const wd = this.wd;
    const cands: number[] = [];
    for (let i = 0; i < wd.w * wd.h; i++) if (this.isFlammable(i) && !wd.tree[i]) cands.push(i);
    if (!cands.length) {
      for (let i = 0; i < wd.w * wd.h; i++) if (this.isFlammable(i)) cands.push(i);
    }
    if (!cands.length) return;
    const i = wd.rng.pick(cands);
    this.ignite(i);
    this.ev.message('Feuer ausgebrochen!', 'bad', i);
  }

  // ---------------- Monatliche Auswertung ----------------

  private monthly(): void {
    const wd = this.wd;
    this.computePower();
    this.monthlyMaps();
    this.computeTotals();
    this.computeDemand();
    this.finances();
    this.disasters();
    this.advise();

    wd.month++;
    const h = wd.history;
    h.pop.push(wd.pop);
    h.funds.push(Math.round(wd.funds));
    h.r.push(Math.round(wd.demandR * 100));
    h.c.push(Math.round(wd.demandC * 100));
    h.i.push(Math.round(wd.demandI * 100));
    for (const k of ['pop', 'funds', 'r', 'c', 'i'] as const) if (h[k].length > 240) h[k].shift();

    if (wd.month >= 12) {
      wd.month = 0;
      const report: YearReport = {
        year: wd.year,
        income: Math.round(wd.yearIncome),
        upkeep: Math.round(wd.yearUpkeep),
        interest: Math.round(wd.yearInterest),
        balance: Math.round(wd.funds),
      };
      wd.lastReport = report;
      wd.yearIncome = 0;
      wd.yearUpkeep = 0;
      wd.yearInterest = 0;
      wd.year++;
      this.ev.yearEnd(report);
    }
  }

  computeAccess(): void {
    const wd = this.wd;
    const { w, h } = wd;
    const n = w * h;
    const comp = this.compOf;
    comp.fill(-1);
    const flags: number[] = [];
    const queue = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0 || !wd.isRoad(s)) continue;
      const id = flags.length;
      let f = 0;
      let qh = 0;
      let qt = 0;
      queue[qt++] = s;
      comp[s] = id;
      while (qh < qt) {
        const i = queue[qh++];
        const x = i % w;
        const y = (i / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) f |= ACC_EDGE;
        const nb = [y > 0 ? i - w : -1, x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1];
        for (const j of nb) {
          if (j < 0 || comp[j] >= 0 || !wd.isRoad(j)) continue;
          comp[j] = id;
          queue[qt++] = j;
        }
      }
      flags.push(f);
    }
    // Zonen der nächstgelegenen Straße zuordnen (Umkreis 3)
    const near = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (!wd.zone[i] && !wd.bld[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      let best = -1;
      let bd = 99;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d > 3 || d >= bd) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (comp[j] >= 0) {
            best = j;
            bd = d;
          }
        }
      near[i] = best;
      if (best >= 0 && wd.zone[i]) {
        const c = comp[best];
        const z = wd.zone[i];
        flags[c] |= z === Zone.R ? ACC_R : z === Zone.C ? ACC_C : ACC_I;
      }
    }
    for (let i = 0; i < n; i++) {
      const r = near[i];
      wd.access[i] = r >= 0 ? ACC_ROAD | flags[comp[r]] : 0;
    }
  }

  monthlyMaps(): void {
    const wd = this.wd;
    const { w, h } = wd;
    const n = w * h;
    this.computeAccess();

    // Verkehr
    const trips = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = wd.level[i];
      if (!wd.zone[i] || !L) continue;
      const x = i % w;
      const y = (i / w) | 0;
      // nächste Straße suchen
      let best = -1;
      let bd = 99;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const d = Math.abs(dx) + Math.abs(dy);
          if (d > 3 || d >= bd) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (wd.isRoad(j)) {
            best = j;
            bd = d;
          }
        }
      if (best >= 0) trips[best] += L * L * (wd.zone[i] === Zone.C ? 4 : 3);
    }
    let t = trips;
    for (let it = 0; it < 6; it++) {
      const nt = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (!wd.isRoad(i)) continue;
        const x = i % w;
        const y = (i / w) | 0;
        let sum = 0;
        let cnt = 0;
        const nb = [y > 0 ? i - w : -1, x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1, x > 0 ? i - 1 : -1];
        for (const j of nb)
          if (j >= 0 && wd.isRoad(j)) {
            sum += t[j];
            cnt++;
          }
        nt[i] = t[i] * 0.55 + (cnt ? (sum / cnt) * 0.45 : 0) + trips[i] * 0.3;
      }
      t = nt;
    }
    const transport = wd.funding.transport / 100;
    for (let i = 0; i < n; i++) {
      const v = wd.isRoad(i) ? (t[i] * 2.2) / (0.6 + 0.4 * transport) : 0;
      wd.traffic[i] = Math.min(255, v);
    }

    // Abdeckung durch Dienste
    wd.covPolice.fill(0);
    wd.covFire.fill(0);
    wd.covHealth.fill(0);
    wd.covEdu.fill(0);
    const lvBonus = new Float32Array(n);
    const polSrc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (wd.origin[i] !== i) continue;
      const def = wd.bldDef(i)!;
      const ox = i % w;
      const oy = (i / w) | 0;
      const cx = ox + (def.size - 1) / 2;
      const cy = oy + (def.size - 1) / 2;
      if (def.pollution) polSrc[i] += def.pollution * def.size;
      if (!def.radius) continue;
      const powered = wd.powered[i] !== 0;
      const r = def.radius;
      let arr: Uint8Array | null = null;
      let fund = 1;
      if (def.coverage === 'police') (arr = wd.covPolice), (fund = wd.funding.police / 100);
      if (def.coverage === 'fire') (arr = wd.covFire), (fund = wd.funding.fire / 100);
      if (def.coverage === 'health') (arr = wd.covHealth), (fund = wd.funding.health / 100);
      if (def.coverage === 'edu') (arr = wd.covEdu), (fund = wd.funding.edu / 100);
      const eff = (powered ? 1 : 0.3) * fund;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > r) continue;
          const f = 1 - d / r;
          const j = y * w + x;
          if (arr) arr[j] = Math.max(arr[j], Math.min(255, 255 * Math.min(1, f * 1.6) * eff));
          if (def.landValue) lvBonus[j] += def.landValue * f * 2;
        }
    }

    // Verschmutzung
    for (let i = 0; i < n; i++) {
      if (wd.zone[i] === Zone.I) polSrc[i] += wd.level[i] * 30;
      if (wd.zone[i] === Zone.C) polSrc[i] += wd.level[i] * 4;
      polSrc[i] += wd.traffic[i] * 0.35;
      if (wd.tree[i]) polSrc[i] -= wd.tree[i] * 6;
      if (wd.bld[i] && wd.bldDef(i)!.cat === 'park') polSrc[i] -= 25;
    }
    const pol = blur(polSrc, w, h, 3);
    for (let i = 0; i < n; i++) wd.pollution[i] = clamp255(pol[i] * 1.6);

    // Bodenwert
    const waterNear = new Float32Array(n);
    for (let i = 0; i < n; i++) if (wd.isWater(i)) waterNear[i] = 60;
    const wn = blur(waterNear, w, h, 2);
    const trees = new Float32Array(n);
    for (let i = 0; i < n; i++) trees[i] = wd.tree[i] * 8;
    const tr = blur(trees, w, h, 1);
    const lvb = lvBonus;
    for (let i = 0; i < n; i++) {
      if (wd.isWater(i)) {
        wd.landValue[i] = 0;
        continue;
      }
      let v = 65 + wd.minH(i) * 5 + wn[i] * 1.6 + tr[i] + lvb[i];
      v += (wd.covPolice[i] + wd.covEdu[i] + wd.covHealth[i]) * 0.1;
      v -= wd.pollution[i] * 0.5;
      v -= wd.crime[i] * 0.2;
      v -= this.nearTraffic(i) * 0.15;
      if (wd.zone[i] && wd.level[i] >= 3) v += 15;
      wd.landValue[i] = clamp255(v);
    }
    const lvs = blur(Float32Array.from(wd.landValue), w, h, 1);
    for (let i = 0; i < n; i++) if (!wd.isWater(i)) wd.landValue[i] = clamp255(lvs[i] * 0.5 + wd.landValue[i] * 0.5);

    // Kriminalität
    const crimeSrc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const L = wd.level[i];
      if (!wd.zone[i] || !L) continue;
      crimeSrc[i] = L * 22 + (255 - wd.landValue[i]) * 0.25 + (wd.zone[i] === Zone.C ? 15 : 0);
    }
    const cr = blur(crimeSrc, w, h, 2);
    for (let i = 0; i < n; i++) wd.crime[i] = clamp255(cr[i] * 1.6 - wd.covPolice[i] * 0.9);
  }

  computeTotals(): void {
    const wd = this.wd;
    let pop = 0;
    let jc = 0;
    let ji = 0;
    for (let i = 0; i < wd.w * wd.h; i++) {
      const L = wd.level[i];
      if (!L) continue;
      const z = wd.zone[i];
      const eff = wd.powered[i] ? 1 : 0.5;
      if (z === Zone.R) pop += RES_POP[L] * eff;
      else if (z === Zone.C) jc += COM_JOBS[L] * eff;
      else if (z === Zone.I) ji += IND_JOBS[L] * eff;
    }
    wd.pop = Math.round(pop);
    wd.jobsC = Math.round(jc);
    wd.jobsI = Math.round(ji);
  }

  private computeDemand(): void {
    const wd = this.wd;
    const pop = wd.pop;
    const workers = pop * 0.5;
    const jobs = wd.jobsC + wd.jobsI;
    let r = (jobs + 120 - workers) / (workers * 0.6 + 80);
    let c = (pop * 0.22 + 40 - wd.jobsC) / (wd.jobsC * 0.6 + 50);
    let ind = (pop * 0.3 + 70 - wd.jobsI) / (wd.jobsI * 0.6 + 50);
    const bonus = wd.diff.demandBonus;
    r += bonus + (7 - wd.taxR) * 0.06;
    c += bonus + (7 - wd.taxC) * 0.06;
    ind += bonus + (7 - wd.taxI) * 0.06;
    // Sondergebäude
    const seen = new Set<number>();
    for (let i = 0; i < wd.w * wd.h; i++) {
      if (!wd.bld[i] || seen.has(wd.origin[i])) continue;
      seen.add(wd.origin[i]);
      const def = wd.bldDef(i)!;
      if (def.demand && wd.powered[i]) {
        r += def.demand.r || 0;
        c += def.demand.c || 0;
        ind += def.demand.i || 0;
      }
    }
    // Bildung und Gesundheit beeinflussen Zuzug
    const clampD = (v: number) => Math.max(-1, Math.min(1, v));
    wd.demandR = wd.demandR * 0.5 + clampD(r) * 0.5;
    wd.demandC = wd.demandC * 0.5 + clampD(c) * 0.5;
    wd.demandI = wd.demandI * 0.5 + clampD(ind) * 0.5;
  }

  /** Geschätzte Monatswerte für die Budgetanzeige. */
  budgetEstimate(): { income: { r: number; c: number; i: number }; upkeep: Record<string, number>; interest: number } {
    const wd = this.wd;
    const mult = wd.diff.incomeMult;
    const income = {
      r: ((wd.pop * wd.taxR) / 100) * 0.7 * mult,
      c: ((wd.jobsC * wd.taxC) / 100) * 0.7 * mult,
      i: ((wd.jobsI * wd.taxI) / 100) * 0.7 * mult,
    };
    let roads = 0;
    let power = 0;
    const svc: Record<string, number> = { police: 0, fire: 0, health: 0, edu: 0, transport: 0, power: 0, other: 0 };
    for (let i = 0; i < wd.w * wd.h; i++) {
      if (wd.net[i] & NET_ROAD) roads += wd.isWater(i) ? 4 : 1;
      if (wd.net[i] & NET_POWER) power++;
      if (wd.origin[i] === i) {
        const def = wd.bldDef(i)!;
        const key = def.coverage || (def.cat === 'power' ? 'power' : 'other');
        svc[key] += def.upkeep;
      }
    }
    const um = wd.diff.upkeepMult / 12;
    const upkeep: Record<string, number> = {
      police: svc.police * um * (wd.funding.police / 100),
      fire: svc.fire * um * (wd.funding.fire / 100),
      health: svc.health * um * (wd.funding.health / 100),
      edu: svc.edu * um * (wd.funding.edu / 100),
      transport: (roads * UPKEEP.road + power * UPKEEP.power) * um * (wd.funding.transport / 100),
      power: svc.power * um,
      other: svc.other * um,
    };
    let interest = 0;
    for (const l of wd.loans) interest += (l.amount * l.rate) / 100 / 12;
    return { income, upkeep, interest };
  }

  private finances(): void {
    const wd = this.wd;
    if (wd.sandbox) return;
    const est = this.budgetEstimate();
    const inc = est.income.r + est.income.c + est.income.i;
    let up = 0;
    for (const k in est.upkeep) up += est.upkeep[k];
    wd.funds += inc - up - est.interest;
    wd.yearIncome += inc;
    wd.yearUpkeep += up;
    wd.yearInterest += est.interest;

    // Straßenverfall bei Unterfinanzierung
    if (wd.funding.transport < 80) {
      const p = (80 - wd.funding.transport) / 2000;
      for (let i = 0; i < wd.w * wd.h; i++)
        if (wd.isRoad(i) && wd.rng.chance(p)) {
          wd.destroyTile(i);
          this.say('potholes', 'Straßen verfallen wegen fehlender Mittel für Verkehr.', 'warn', 6, i);
        }
    }

    if (wd.funds < 0) {
      wd.monthsNegative++;
      const left = wd.diff.bankruptMonths - wd.monthsNegative;
      if (left <= 0) {
        wd.gameOver = true;
        this.ev.gameOver('Die Stadtkasse ist zu lange im Minus. Der Stadtrat hat Sie abgewählt.');
      } else this.say('debt', `Die Stadtkasse ist im Minus! Noch ${left} Monate bis zur Abwahl. Erhöhen Sie Steuern oder nehmen Sie einen Kredit auf.`, 'bad', 3);
    } else wd.monthsNegative = 0;
  }

  private disasters(): void {
    const wd = this.wd;
    if (wd.sandbox && !wd.settings.disasters) return;
    if (!wd.settings.disasters) return;
    const rng = wd.rng;
    const d = wd.diff;
    // Brände
    const fireRate = wd.sandbox ? 0.00005 : d.fireRate;
    for (let i = 0; i < wd.w * wd.h; i++) {
      if (!wd.level[i] && !wd.bld[i]) continue;
      const cov = (wd.covFire[i] / 255) * (wd.funding.fire / 100);
      if (rng.chance(fireRate * wd.level[i] * (1 - cov * 0.9))) {
        this.ignite(i);
        this.say('fire', 'Feuer in der Stadt!', 'bad', 1, i);
      }
    }
    const rate = wd.sandbox ? 0.004 : d.disasterRate;
    if (wd.pop > 300 && rng.chance(rate)) {
      if (rng.chance(0.6)) this.startTornado();
      else this.earthquake();
    }
  }

  private advise(): void {
    const wd = this.wd;
    // Meilensteine
    let rank = 0;
    for (let k = 0; k < CITY_RANKS.length; k++) if (wd.pop >= CITY_RANKS[k][0]) rank = k;
    if (rank > wd.milestone) {
      wd.milestone = rank;
      this.ev.message(`Glückwunsch! ${wd.name} ist jetzt eine ${cityRank(wd.pop)} mit ${wd.pop.toLocaleString('de-DE')} Einwohnern.`, 'good');
    }
    let zones = 0;
    let unpowered = 0;
    let noRoad = 0;
    for (let i = 0; i < wd.w * wd.h; i++) {
      if (!wd.zone[i]) continue;
      zones++;
      if (!wd.powered[i]) unpowered++;
      if (!(wd.access[i] & ACC_ROAD)) noRoad++;
    }
    if (zones > 8 && wd.powerCap === 0) this.say('noplant', 'Ihre Zonen brauchen Strom. Bauen Sie ein Kraftwerk und verbinden Sie es mit Leitungen.', 'warn', 6);
    else if (zones > 8 && unpowered > zones * 0.2) this.say('nopower', 'Viele Zonen haben keinen Strom. Prüfen Sie Leitungen und Kraftwerkskapazität.', 'warn', 6);
    if (wd.powerCap > 0 && wd.powerUsed > wd.powerCap * 0.92) this.say('cap', 'Die Kraftwerke sind fast ausgelastet. Bauen Sie bald ein weiteres.', 'warn', 6);
    if (zones > 8 && noRoad > zones * 0.3) this.say('noroad', 'Zonen brauchen eine Straße in höchstens 3 Feldern Entfernung.', 'warn', 6);
    if (wd.pop > 2000) {
      let pol = 0;
      let crime = 0;
      let cnt = 0;
      let fireCov = 0;
      for (let i = 0; i < wd.w * wd.h; i++)
        if (wd.zone[i] && wd.level[i]) {
          pol += wd.pollution[i];
          crime += wd.crime[i];
          fireCov += wd.covFire[i];
          cnt++;
        }
      if (cnt) {
        if (crime / cnt > 90) this.say('crime', 'Die Bürger klagen über Kriminalität. Bauen Sie Polizeiwachen.', 'warn', 12);
        if (pol / cnt > 90) this.say('pol', 'Die Luftverschmutzung ist hoch. Trennen Sie Industrie und Wohngebiete.', 'warn', 12);
        if (fireCov / cnt < 30) this.say('firecov', 'Große Teile der Stadt haben keinen Brandschutz.', 'warn', 12);
      }
    }
    if (wd.demandR > 0.6 && wd.pop > 200) this.say('demR', 'Es gibt Nachfrage nach Wohngebieten.', 'info', 18);
    if (wd.demandI > 0.6 && wd.pop > 200) this.say('demI', 'Die Industrie sucht nach Flächen.', 'info', 18);
    if (wd.demandC > 0.6 && wd.pop > 500) this.say('demC', 'Händler wünschen sich mehr Gewerbeflächen.', 'info', 18);
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function blur(src: Float32Array, w: number, h: number, passes: number): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += a[yy * w + xx];
            c++;
          }
        }
        b[y * w + x] = s / c;
      }
    a = b;
  }
  return a;
}

