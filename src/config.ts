// Grundkonstanten, Gebäude- und Schwierigkeitsdefinitionen.

export const HW = 16; // halbe Kachelbreite in Weltpixeln
export const HH = 8; // halbe Kachelhöhe
export const HS = 8; // Pixel pro Höhenstufe
export const MAXH = 10; // höchste Eckhöhe
export const BLD_MAX_H = 120; // maximale Sprite-Höhe über dem Boden
export const CHUNK = 256; // Kantenlänge eines Render-Chunks in Weltpixeln

export enum Zone {
  None = 0,
  R = 1,
  C = 2,
  I = 3,
}

export const NET_ROAD = 1;
export const NET_POWER = 2;

export const TICKS_PER_MONTH = 4;
export const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

export type Difficulty = 'easy' | 'medium' | 'hard' | 'sandbox';

export interface DiffSettings {
  label: string;
  desc: string;
  startFunds: number;
  demandBonus: number; // addiert auf alle Nachfragewerte
  upkeepMult: number;
  incomeMult: number;
  disasterRate: number; // Wahrscheinlichkeit pro Monat für Tornado/Erdbeben
  fireRate: number; // Brandwahrscheinlichkeit pro Gebäude und Monat
  bankruptMonths: number; // Monate im Minus bis zur Abwahl (0 = nie)
  growth: number; // Wachstumsgeschwindigkeit
}

export const DIFFICULTIES: Record<Difficulty, DiffSettings> = {
  easy: {
    label: 'Leicht',
    desc: '20.000 $ Startkapital, hohe Nachfrage, selten Katastrophen.',
    startFunds: 20000,
    demandBonus: 0.15,
    upkeepMult: 0.8,
    incomeMult: 1.2,
    disasterRate: 0.002,
    fireRate: 0.00003,
    bankruptMonths: 24,
    growth: 1.3,
  },
  medium: {
    label: 'Mittel',
    desc: '10.000 $ Startkapital, ausgeglichene Wirtschaft.',
    startFunds: 10000,
    demandBonus: 0,
    upkeepMult: 1,
    incomeMult: 1,
    disasterRate: 0.006,
    fireRate: 0.00008,
    bankruptMonths: 12,
    growth: 1,
  },
  hard: {
    label: 'Schwer',
    desc: '5.000 $ Startkapital, teurer Unterhalt, häufige Katastrophen.',
    startFunds: 5000,
    demandBonus: -0.12,
    upkeepMult: 1.3,
    incomeMult: 0.85,
    disasterRate: 0.015,
    fireRate: 0.00016,
    bankruptMonths: 6,
    growth: 0.8,
  },
  sandbox: {
    label: 'Sandkasten',
    desc: 'Unbegrenztes Geld, alles freigeschaltet, Katastrophen nur auf Knopfdruck.',
    startFunds: 0,
    demandBonus: 0.25,
    upkeepMult: 0,
    incomeMult: 1,
    disasterRate: 0,
    fireRate: 0,
    bankruptMonths: 0,
    growth: 1.5,
  },
};

export type Category = 'power' | 'service' | 'park' | 'special';

export interface BuildingDef {
  id: number;
  key: string;
  name: string;
  cat: Category;
  size: number;
  cost: number;
  upkeep: number; // pro Jahr
  power?: number; // Kapazität in Stromeinheiten
  pollution?: number;
  radius?: number;
  coverage?: 'police' | 'fire' | 'health' | 'edu';
  landValue?: number; // Bodenwertbonus im Radius
  unlockYear?: number;
  unlockPop?: number;
  needsWater?: boolean;
  demand?: { r?: number; c?: number; i?: number };
}

const defs: Omit<BuildingDef, 'id'>[] = [
  { key: 'wind', name: 'Windrad', cat: 'power', size: 1, cost: 100, upkeep: 10, power: 50 },
  { key: 'gas', name: 'Gaskraftwerk', cat: 'power', size: 2, cost: 2000, upkeep: 80, power: 500, pollution: 25 },
  { key: 'coal', name: 'Kohlekraftwerk', cat: 'power', size: 3, cost: 4000, upkeep: 150, power: 1400, pollution: 90 },
  { key: 'nuclear', name: 'Atomkraftwerk', cat: 'power', size: 3, cost: 15000, upkeep: 400, power: 4500, pollution: 5, unlockYear: 1960 },
  { key: 'solar', name: 'Solarkraftwerk', cat: 'power', size: 2, cost: 6000, upkeep: 100, power: 700, unlockYear: 1990 },
  { key: 'police', name: 'Polizeiwache', cat: 'service', size: 2, cost: 500, upkeep: 100, radius: 14, coverage: 'police' },
  { key: 'fire', name: 'Feuerwache', cat: 'service', size: 2, cost: 500, upkeep: 100, radius: 14, coverage: 'fire' },
  { key: 'hospital', name: 'Krankenhaus', cat: 'service', size: 2, cost: 1000, upkeep: 150, radius: 16, coverage: 'health', landValue: 10 },
  { key: 'school', name: 'Schule', cat: 'service', size: 2, cost: 500, upkeep: 100, radius: 12, coverage: 'edu', landValue: 10 },
  { key: 'college', name: 'Hochschule', cat: 'service', size: 3, cost: 3000, upkeep: 300, radius: 24, coverage: 'edu', landValue: 25, unlockPop: 3000 },
  { key: 'park', name: 'Park', cat: 'park', size: 1, cost: 30, upkeep: 2, radius: 4, landValue: 20 },
  { key: 'bigpark', name: 'Großer Park', cat: 'park', size: 2, cost: 150, upkeep: 10, radius: 7, landValue: 30 },
  { key: 'stadium', name: 'Stadion', cat: 'park', size: 3, cost: 6000, upkeep: 200, radius: 20, landValue: 15, demand: { r: 0.15 }, unlockPop: 10000 },
  { key: 'seaport', name: 'Hafen', cat: 'special', size: 3, cost: 5000, upkeep: 150, pollution: 30, needsWater: true, demand: { i: 0.25 }, unlockPop: 2500 },
  { key: 'airport', name: 'Flughafen', cat: 'special', size: 4, cost: 10000, upkeep: 300, pollution: 20, demand: { c: 0.25 }, unlockPop: 6000 },
];

export const BUILDINGS: BuildingDef[] = defs.map((d, i) => ({ ...d, id: i + 1 }));
export const BUILDING_BY_KEY: Record<string, BuildingDef> = Object.fromEntries(BUILDINGS.map((b) => [b.key, b]));

// Einwohner bzw. Arbeitsplätze pro Kachel je Stufe
export const RES_POP = [0, 12, 40, 140, 360];
export const COM_JOBS = [0, 8, 30, 100, 260];
export const IND_JOBS = [0, 14, 40, 100, 200];

export const COSTS = {
  road: 10,
  bridge: 50,
  power: 5,
  zoneLight: 5,
  zoneDense: 10,
  bulldoze: 5,
  bulldozeBuilding: 20,
  terraform: 25,
  tree: 3,
  water: 100,
};

export const UPKEEP = {
  road: 0.6, // pro Kachel und Jahr
  power: 0.2,
};

export const CITY_RANKS: [number, string][] = [
  [0, 'Siedlung'],
  [500, 'Dorf'],
  [2000, 'Kleinstadt'],
  [10000, 'Stadt'],
  [50000, 'Großstadt'],
  [100000, 'Metropole'],
  [250000, 'Megalopolis'],
];

export function cityRank(pop: number): string {
  let r = CITY_RANKS[0][1];
  for (const [p, n] of CITY_RANKS) if (pop >= p) r = n;
  return r;
}
