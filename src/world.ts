// Spielzustand: Gelände, Bebauung, Wirtschaft.

import { BUILDINGS, BuildingDef, Difficulty, DIFFICULTIES, NET_POWER, NET_ROAD, WATER_GRACE_MONTHS } from './config';
import { Rng } from './rng';

export interface Funding {
  police: number;
  fire: number;
  health: number;
  edu: number;
  transport: number;
}

export interface Loan {
  amount: number;
  rate: number;
}

export interface YearReport {
  year: number;
  income: number;
  upkeep: number;
  interest: number;
  balance: number;
}

export interface Settings {
  disasters: boolean;
  yearReport: boolean;
  grid: boolean;
}

export interface History {
  pop: number[];
  funds: number[];
  r: number[];
  c: number[];
  i: number[];
}

const TILE_ARRAYS = [
  'net',
  'zone',
  'dense',
  'level',
  'variant',
  'bld',
  'tree',
  'rubble',
  'fire',
  'powered',
  'landValue',
  'pollution',
  'crime',
  'traffic',
  'covPolice',
  'covFire',
  'covHealth',
  'covEdu',
  'access',
  'pipe',
  'watered',
] as const;
type TileArrayName = (typeof TILE_ARRAYS)[number];

export class World {
  readonly w: number;
  readonly h: number;
  name = 'Neustadt';
  difficulty: Difficulty = 'medium';
  seed = 1;

  corners: Uint8Array;
  net!: Uint8Array;
  zone!: Uint8Array;
  dense!: Uint8Array;
  level!: Uint8Array;
  variant!: Uint8Array;
  bld!: Uint8Array;
  tree!: Uint8Array;
  rubble!: Uint8Array;
  fire!: Uint8Array;
  powered!: Uint8Array;
  landValue!: Uint8Array;
  pollution!: Uint8Array;
  crime!: Uint8Array;
  traffic!: Uint8Array;
  covPolice!: Uint8Array;
  covFire!: Uint8Array;
  covHealth!: Uint8Array;
  covEdu!: Uint8Array;
  access!: Uint8Array; // Straßennetz-Erreichbarkeit (Bitmaske R/C/I/Rand)
  pipe!: Uint8Array; // unterirdische Wasserleitung
  watered!: Uint8Array;
  origin: Int32Array;

  funds = 10000;
  year = 1950;
  month = 0;
  tick = 0;
  taxR = 7;
  taxC = 7;
  taxI = 7;
  funding: Funding = { police: 100, fire: 100, health: 100, edu: 100, transport: 100 };
  loans: Loan[] = [];

  pop = 0;
  jobsC = 0;
  jobsI = 0;
  demandR = 0.5;
  demandC = 0.3;
  demandI = 0.4;
  powerCap = 0;
  powerUsed = 0;
  waterCap = 0;
  waterUsed = 0;
  /** Restmonate ohne Verfall von Hochhäusern ohne Wasser (alte Spielstände). */
  waterGrace = 0;
  monthsNegative = 0;
  gameOver = false;
  yearIncome = 0;
  yearUpkeep = 0;
  yearInterest = 0;
  lastReport: YearReport | null = null;
  history: History = { pop: [], funds: [], r: [], c: [], i: [] };
  milestone = 0;
  settings: Settings = { disasters: true, yearReport: true, grid: true };
  rng: Rng;

  // Laufzeit (nicht gespeichert)
  onTileChanged: ((i: number) => void) | null = null;
  powerDirty = true;

  constructor(w: number, h: number, seed = 1) {
    this.w = w;
    this.h = h;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x5eed);
    this.corners = new Uint8Array((w + 1) * (h + 1));
    for (const k of TILE_ARRAYS) (this as unknown as Record<TileArrayName, Uint8Array>)[k] = new Uint8Array(w * h);
    this.origin = new Int32Array(w * h).fill(-1);
  }

  get sandbox(): boolean {
    return this.difficulty === 'sandbox';
  }

  get diff() {
    return DIFFICULTIES[this.difficulty];
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  inb(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  ch(vx: number, vy: number): number {
    return this.corners[vy * (this.w + 1) + vx];
  }
  setCh(vx: number, vy: number, v: number): void {
    this.corners[vy * (this.w + 1) + vx] = v;
  }

  /** Eckhöhen in der Reihenfolge Nord (oben), Ost (rechts), Süd (unten), West (links). */
  tileCorners(x: number, y: number): [number, number, number, number] {
    return [this.ch(x, y), this.ch(x + 1, y), this.ch(x + 1, y + 1), this.ch(x, y + 1)];
  }
  minH(i: number): number {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    return Math.min(this.ch(x, y), this.ch(x + 1, y), this.ch(x + 1, y + 1), this.ch(x, y + 1));
  }
  maxH(i: number): number {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    return Math.max(this.ch(x, y), this.ch(x + 1, y), this.ch(x + 1, y + 1), this.ch(x, y + 1));
  }
  isFlat(i: number): boolean {
    return this.minH(i) === this.maxH(i);
  }
  isWater(i: number): boolean {
    return this.maxH(i) === 0;
  }
  /** Erlaubt Straßen und Leitungen: höchstens eine Stufe Gefälle. */
  isGentle(i: number): boolean {
    return this.maxH(i) - this.minH(i) <= 1;
  }

  /** Kachel ist völlig unbebaut (Bäume zählen nicht). */
  isEmpty(i: number): boolean {
    return this.net[i] === 0 && this.zone[i] === 0 && this.bld[i] === 0 && this.rubble[i] === 0;
  }

  isConductor(i: number): boolean {
    return (this.net[i] & NET_POWER) !== 0 || this.zone[i] !== 0 || this.bld[i] !== 0;
  }

  /** Leitet Wasser: Rohre, Zonen und Gebäude. */
  isWaterConductor(i: number): boolean {
    return this.pipe[i] !== 0 || this.zone[i] !== 0 || this.bld[i] !== 0;
  }

  isRoad(i: number): boolean {
    return (this.net[i] & NET_ROAD) !== 0;
  }

  bldDef(i: number): BuildingDef | null {
    const b = this.bld[i];
    return b ? BUILDINGS[b - 1] : null;
  }

  changed(i: number): void {
    if (this.onTileChanged) this.onTileChanged(i);
  }

  /** Markiert eine Kachel samt Nachbarn als geändert (Straßen- und Leitungsverbindungen). */
  changedWithNeighbors(i: number): void {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    this.changed(i);
    if (x > 0) this.changed(i - 1);
    if (x < this.w - 1) this.changed(i + 1);
    if (y > 0) this.changed(i - this.w);
    if (y < this.h - 1) this.changed(i + this.w);
  }

  /** Entfernt alles auf der Kachel (bei Gebäuden den gesamten Grundriss). Gibt die betroffenen Kacheln zurück. */
  clearTile(i: number): number[] {
    const out: number[] = [];
    if (this.bld[i]) {
      const def = this.bldDef(i)!;
      const o = this.origin[i];
      const ox = o % this.w;
      const oy = (o / this.w) | 0;
      for (let dy = 0; dy < def.size; dy++)
        for (let dx = 0; dx < def.size; dx++) {
          const j = this.idx(ox + dx, oy + dy);
          this.bld[j] = 0;
          this.origin[j] = -1;
          this.fire[j] = 0;
          out.push(j);
        }
      this.powerDirty = true;
    } else {
      if (this.net[i] || this.zone[i]) this.powerDirty = true;
      this.net[i] = 0;
      this.zone[i] = 0;
      this.dense[i] = 0;
      this.level[i] = 0;
      this.rubble[i] = 0;
      this.fire[i] = 0;
      this.tree[i] = 0;
      out.push(i);
    }
    for (const j of out) this.changedWithNeighbors(j);
    return out;
  }

  /** Zerstört eine Kachel durch Katastrophe: Gebäude werden zu Trümmern. */
  destroyTile(i: number): void {
    if (this.bld[i]) {
      const tiles = this.clearTile(i);
      for (const j of tiles) {
        this.rubble[j] = 1;
        this.changed(j);
      }
    } else if (this.zone[i]) {
      if (this.level[i] > 0) {
        this.level[i] = 0;
        this.rubble[i] = 1;
      }
      this.fire[i] = 0;
      this.changed(i);
    } else if (this.net[i]) {
      this.net[i] = 0;
      this.rubble[i] = 1;
      this.powerDirty = true;
      this.changedWithNeighbors(i);
    } else if (this.tree[i]) {
      this.tree[i] = 0;
      this.fire[i] = 0;
      this.changed(i);
    }
  }

  placeBuilding(def: BuildingDef, ox: number, oy: number): void {
    const o = this.idx(ox, oy);
    for (let dy = 0; dy < def.size; dy++)
      for (let dx = 0; dx < def.size; dx++) {
        const j = this.idx(ox + dx, oy + dy);
        this.net[j] = 0;
        this.zone[j] = 0;
        this.level[j] = 0;
        this.tree[j] = 0;
        this.rubble[j] = 0;
        this.bld[j] = def.id;
        this.origin[j] = o;
        this.changedWithNeighbors(j);
      }
    this.powerDirty = true;
  }

  netMask(i: number, flag: number): number {
    const x = i % this.w;
    const y = (i / this.w) | 0;
    let m = 0;
    // Bits: 1 = -y (oben rechts), 2 = +x (unten rechts), 4 = +y (unten links), 8 = -x (oben links)
    const has = (j: number) => (this.net[j] & flag) !== 0 || (flag === NET_POWER && this.bld[j] !== 0 && this.bldDef(j)!.cat === 'power');
    if (y > 0 && has(i - this.w)) m |= 1;
    if (x < this.w - 1 && has(i + 1)) m |= 2;
    if (y < this.h - 1 && has(i + this.w)) m |= 4;
    if (x > 0 && has(i - 1)) m |= 8;
    // Straßen am Kartenrand verbinden zur Nachbarstadt
    if (flag === NET_ROAD) {
      if (y === 0) m |= 1;
      if (x === this.w - 1) m |= 2;
      if (y === this.h - 1) m |= 4;
      if (x === 0) m |= 8;
    }
    return m;
  }

  get date(): string {
    const months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    return `${months[this.month]} ${this.year}`;
  }

  // ---------- Speichern / Laden ----------

  serialize(): string {
    const enc = (a: Uint8Array) => bytesToB64(a);
    const tiles: Record<string, string> = {};
    for (const k of TILE_ARRAYS) tiles[k] = enc((this as unknown as Record<TileArrayName, Uint8Array>)[k]);
    const data = {
      v: 1,
      w: this.w,
      h: this.h,
      name: this.name,
      difficulty: this.difficulty,
      seed: this.seed,
      corners: enc(this.corners),
      origin: enc(new Uint8Array(this.origin.buffer)),
      tiles,
      funds: this.funds,
      year: this.year,
      month: this.month,
      tick: this.tick,
      taxR: this.taxR,
      taxC: this.taxC,
      taxI: this.taxI,
      funding: this.funding,
      loans: this.loans,
      monthsNegative: this.monthsNegative,
      gameOver: this.gameOver,
      yearIncome: this.yearIncome,
      yearUpkeep: this.yearUpkeep,
      yearInterest: this.yearInterest,
      lastReport: this.lastReport,
      history: this.history,
      milestone: this.milestone,
      waterGrace: this.waterGrace,
      settings: this.settings,
      rng: this.rng.state,
    };
    return JSON.stringify(data);
  }

  static deserialize(json: string): World {
    const d = JSON.parse(json);
    const wd = new World(d.w, d.h, d.seed);
    wd.name = d.name;
    wd.difficulty = d.difficulty;
    wd.corners.set(b64ToBytes(d.corners));
    const ob = b64ToBytes(d.origin);
    wd.origin = new Int32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + ob.byteLength));
    for (const k of TILE_ARRAYS) {
      if (d.tiles[k]) (wd as unknown as Record<TileArrayName, Uint8Array>)[k].set(b64ToBytes(d.tiles[k]));
    }
    wd.funds = d.funds;
    wd.year = d.year;
    wd.month = d.month;
    wd.tick = d.tick;
    wd.taxR = d.taxR;
    wd.taxC = d.taxC;
    wd.taxI = d.taxI;
    wd.funding = { ...wd.funding, ...d.funding };
    wd.loans = d.loans || [];
    wd.monthsNegative = d.monthsNegative || 0;
    wd.gameOver = !!d.gameOver;
    wd.yearIncome = d.yearIncome || 0;
    wd.yearUpkeep = d.yearUpkeep || 0;
    wd.yearInterest = d.yearInterest || 0;
    wd.lastReport = d.lastReport || null;
    wd.history = d.history || wd.history;
    wd.milestone = d.milestone || 0;
    // Spielstände von vor der Wasserversorgung bekommen eine Schonfrist
    wd.waterGrace = d.tiles.watered ? d.waterGrace || 0 : WATER_GRACE_MONTHS;
    wd.settings = { ...wd.settings, ...d.settings };
    wd.rng.state = d.rng || 1;
    wd.powerDirty = true;
    return wd;
  }
}

export function bytesToB64(a: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < a.length; i += CH) s += String.fromCharCode.apply(null, Array.from(a.subarray(i, i + CH)));
  return btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

