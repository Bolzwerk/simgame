// Bauwerkzeuge: Planung (Vorschau, Kosten) und Ausführung.

import { BUILDING_BY_KEY, BuildingDef, COSTS, MAXH, NET_POWER, NET_ROAD, Zone } from './config';
import { planCornerChange, tilesOfCorners } from './terrain';
import { World } from './world';

export type Shape = 'point' | 'line' | 'rect';

export interface ToolDef {
  id: string;
  label: string;
  shape: Shape;
  desc: string;
  sandboxOnly?: boolean;
}

export const TOOLS: Record<string, ToolDef> = {
  query: { id: 'query', label: 'Info', shape: 'point', desc: 'Antippen zeigt Infos, Ziehen verschiebt die Karte' },
  bulldoze: { id: 'bulldoze', label: 'Abreißen', shape: 'rect', desc: `${COSTS.bulldoze} $ pro Feld` },
  road: { id: 'road', label: 'Straße', shape: 'line', desc: `${COSTS.road} $ pro Feld, Brücke ${COSTS.bridge} $` },
  power: { id: 'power', label: 'Stromleitung', shape: 'line', desc: `${COSTS.power} $ pro Feld` },
  pipe: { id: 'pipe', label: 'Wasserrohr', shape: 'line', desc: `${COSTS.pipe} $ pro Feld, unterirdisch` },
  unpipe: { id: 'unpipe', label: 'Rohre entfernen', shape: 'rect', desc: 'Entfernt Wasserrohre kostenlos' },
  zoneR: { id: 'zoneR', label: 'Wohnen leicht', shape: 'rect', desc: `${COSTS.zoneLight} $ pro Feld` },
  zoneRd: { id: 'zoneRd', label: 'Wohnen dicht', shape: 'rect', desc: `${COSTS.zoneDense} $ pro Feld` },
  zoneC: { id: 'zoneC', label: 'Gewerbe leicht', shape: 'rect', desc: `${COSTS.zoneLight} $ pro Feld` },
  zoneCd: { id: 'zoneCd', label: 'Gewerbe dicht', shape: 'rect', desc: `${COSTS.zoneDense} $ pro Feld` },
  zoneI: { id: 'zoneI', label: 'Industrie leicht', shape: 'rect', desc: `${COSTS.zoneLight} $ pro Feld` },
  zoneId: { id: 'zoneId', label: 'Industrie dicht', shape: 'rect', desc: `${COSTS.zoneDense} $ pro Feld` },
  dezone: { id: 'dezone', label: 'Zone entfernen', shape: 'rect', desc: 'Entfernt unbebaute Zonen kostenlos' },
  raise: { id: 'raise', label: 'Anheben', shape: 'point', desc: `${COSTS.terraform} $ pro Eckpunkt` },
  lower: { id: 'lower', label: 'Absenken', shape: 'point', desc: `${COSTS.terraform} $ pro Eckpunkt` },
  level: { id: 'level', label: 'Einebnen', shape: 'rect', desc: 'Ebnet auf die Höhe des Startfelds ein' },
  trees: { id: 'trees', label: 'Bäume', shape: 'rect', desc: `${COSTS.tree} $ pro Feld` },
  water: { id: 'water', label: 'Wasser', shape: 'rect', desc: `${COSTS.water} $ pro Feld` },
  ignite: { id: 'ignite', label: 'Feuer legen', shape: 'point', desc: 'Nur im Sandkasten', sandboxOnly: true },
};

export interface Plan {
  tiles: number[]; // hervorgehobene Kacheln
  apply: number[]; // tatsächlich veränderte Kacheln
  cost: number;
  ok: boolean;
  reason?: string;
  building?: { key: string; x: number; y: number };
  corners?: Map<number, number>;
}

function linePath(wd: World, a: number, b: number): number[] {
  const ax = a % wd.w;
  const ay = (a / wd.w) | 0;
  const bx = b % wd.w;
  const by = (b / wd.w) | 0;
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const sx = Math.sign(bx - ax);
  const sy = Math.sign(by - ay);
  const out: number[] = [];
  if (dx >= dy) {
    for (let k = 0; k <= dx; k++) out.push(wd.idx(ax + k * sx, ay));
    for (let k = 1; k <= dy; k++) out.push(wd.idx(bx, ay + k * sy));
  } else {
    for (let k = 0; k <= dy; k++) out.push(wd.idx(ax, ay + k * sy));
    for (let k = 1; k <= dx; k++) out.push(wd.idx(ax + k * sx, by));
  }
  return out;
}

function rectTiles(wd: World, a: number, b: number): number[] {
  const x0 = Math.min(a % wd.w, b % wd.w);
  const x1 = Math.max(a % wd.w, b % wd.w);
  const y0 = Math.min((a / wd.w) | 0, (b / wd.w) | 0);
  const y1 = Math.max((a / wd.w) | 0, (b / wd.w) | 0);
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(wd.idx(x, y));
  return out;
}

export function isUnlocked(wd: World, def: BuildingDef): boolean {
  if (wd.sandbox) return true;
  if (def.unlockYear && wd.year < def.unlockYear) return false;
  if (def.unlockPop && wd.pop < def.unlockPop) return false;
  return true;
}

export function lockReason(wd: World, def: BuildingDef): string {
  if (def.unlockYear && wd.year < def.unlockYear) return `ab ${def.unlockYear}`;
  if (def.unlockPop && wd.pop < def.unlockPop) return `ab ${def.unlockPop.toLocaleString('de-DE')} Einw.`;
  return '';
}

function zoneOf(id: string): [Zone, boolean] | null {
  const m: Record<string, [Zone, boolean]> = {
    zoneR: [Zone.R, false],
    zoneRd: [Zone.R, true],
    zoneC: [Zone.C, false],
    zoneCd: [Zone.C, true],
    zoneI: [Zone.I, false],
    zoneId: [Zone.I, true],
  };
  return m[id] || null;
}

/** Ein Feld ist für Geländearbeiten frei, wenn höchstens Bäume darauf stehen. */
function terraformBlocked(wd: World, tiles: Iterable<number>): boolean {
  for (const t of tiles) if (!wd.isEmpty(t) && !(wd.zone[t] && !wd.level[t])) return true;
  return false;
}

export function planTool(wd: World, toolId: string, a: number, b: number): Plan {
  const plan: Plan = { tiles: [], apply: [], cost: 0, ok: true };
  const fail = (reason: string) => {
    plan.ok = false;
    plan.reason = reason;
    return plan;
  };

  if (toolId.startsWith('bld:')) {
    const def = BUILDING_BY_KEY[toolId.slice(4)];
    const S = def.size;
    const off = Math.floor((S - 1) / 2);
    let ox = (b % wd.w) - off;
    let oy = ((b / wd.w) | 0) - off;
    ox = Math.max(0, Math.min(wd.w - S, ox));
    oy = Math.max(0, Math.min(wd.h - S, oy));
    plan.building = { key: def.key, x: ox, y: oy };
    plan.cost = def.cost;
    let h = -1;
    let nearWater = false;
    for (let dy = 0; dy < S; dy++)
      for (let dx = 0; dx < S; dx++) {
        const i = wd.idx(ox + dx, oy + dy);
        plan.tiles.push(i);
        plan.apply.push(i);
      }
    if (!isUnlocked(wd, def)) return fail(`${def.name} ist erst ${lockReason(wd, def)} verfügbar.`);
    for (const i of plan.tiles) {
      if (wd.isWater(i)) return fail('Gebäude können nicht im Wasser stehen.');
      if (!wd.isFlat(i)) return fail('Der Boden muss eben sein. Nutzen Sie „Einebnen“.');
      const mh = wd.minH(i);
      if (h < 0) h = mh;
      else if (h !== mh) return fail('Der Boden muss eben sein. Nutzen Sie „Einebnen“.');
      if (!wd.isEmpty(i) && !(wd.zone[i] && !wd.level[i])) return fail('Der Platz ist belegt.');
    }
    if (def.needsWater) {
      for (let dy = -1; dy <= S; dy++)
        for (let dx = -1; dx <= S; dx++) {
          const x = ox + dx;
          const y = oy + dy;
          if (wd.inb(x, y) && wd.isWater(wd.idx(x, y))) nearWater = true;
        }
      if (!nearWater) return fail('Ein Hafen muss direkt am Wasser liegen.');
    }
    return checkMoney(wd, plan);
  }

  const zone = zoneOf(toolId);
  switch (toolId) {
    case 'road':
    case 'power': {
      const path = linePath(wd, a, b);
      const flag = toolId === 'road' ? NET_ROAD : NET_POWER;
      const straight = a % wd.w === b % wd.w || ((a / wd.w) | 0) === ((b / wd.w) | 0);
      plan.tiles = path;
      for (const i of path) {
        if (wd.net[i] & flag) continue;
        if (flag === NET_POWER && (wd.zone[i] || wd.bld[i])) continue; // leitet ohnehin
        if (wd.bld[i]) return fail('Ein Gebäude ist im Weg.');
        if (wd.zone[i] && wd.level[i]) return fail('Ein Gebäude ist im Weg. Erst abreißen.');
        if (wd.rubble[i]) return fail('Trümmer im Weg. Erst abreißen.');
        if (!wd.isGentle(i)) return fail('Zu steil.');
        if (wd.isWater(i)) {
          if (flag === NET_ROAD && !straight) return fail('Brücken müssen gerade verlaufen.');
          plan.cost += flag === NET_ROAD ? COSTS.bridge : COSTS.power * 3;
        } else plan.cost += flag === NET_ROAD ? COSTS.road : COSTS.power;
        if (wd.net[i] && flag === NET_ROAD && wd.isWater(i)) return fail('Brücken können nicht über Leitungen gebaut werden.');
        plan.apply.push(i);
      }
      return checkMoney(wd, plan);
    }
    case 'pipe': {
      const path = linePath(wd, a, b);
      plan.tiles = path;
      for (const i of path) {
        if (wd.pipe[i] || wd.zone[i] || wd.bld[i]) continue; // Zonen und Gebäude leiten ohnehin
        plan.cost += wd.isWater(i) ? COSTS.pipe * 3 : COSTS.pipe;
        plan.apply.push(i);
      }
      return checkMoney(wd, plan);
    }
    case 'unpipe': {
      plan.tiles = rectTiles(wd, a, b);
      for (const i of plan.tiles) if (wd.pipe[i]) plan.apply.push(i);
      return plan;
    }
    case 'bulldoze': {
      plan.tiles = rectTiles(wd, a, b);
      const done = new Set<number>();
      for (const i of plan.tiles) {
        if (done.has(i)) continue;
        if (wd.bld[i]) {
          const def = wd.bldDef(i)!;
          const o = wd.origin[i];
          if (!done.has(o)) {
            plan.cost += COSTS.bulldozeBuilding * def.size * def.size;
            plan.apply.push(o);
            for (let dy = 0; dy < def.size; dy++) for (let dx = 0; dx < def.size; dx++) done.add(o + dy * wd.w + dx);
          }
          continue;
        }
        if (wd.isEmpty(i) && !wd.tree[i]) continue;
        plan.cost += wd.level[i] ? COSTS.bulldozeBuilding : wd.isEmpty(i) ? COSTS.tree : COSTS.bulldoze;
        plan.apply.push(i);
        done.add(i);
      }
      return checkMoney(wd, plan);
    }
    case 'dezone': {
      plan.tiles = rectTiles(wd, a, b);
      for (const i of plan.tiles) if (wd.zone[i] && !wd.level[i]) plan.apply.push(i);
      return plan;
    }
    case 'trees': {
      plan.tiles = rectTiles(wd, a, b);
      for (const i of plan.tiles) {
        if (!wd.isEmpty(i) || wd.isWater(i) || wd.tree[i] >= 3) continue;
        plan.apply.push(i);
        plan.cost += COSTS.tree;
      }
      return checkMoney(wd, plan);
    }
    case 'raise':
    case 'lower':
    case 'level':
    case 'water': {
      const tiles = toolId === 'raise' || toolId === 'lower' ? [b] : rectTiles(wd, a, b);
      plan.tiles = tiles;
      const vw = wd.w + 1;
      const targets = new Map<number, number>();
      let target = 0;
      if (toolId === 'level') {
        const [n, e, s, w] = wd.tileCorners(a % wd.w, (a / wd.w) | 0);
        target = Math.max(1, Math.round((n + e + s + w) / 4));
      }
      for (const t of tiles) {
        const x = t % wd.w;
        const y = (t / wd.w) | 0;
        for (const [vx, vy] of [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
        ]) {
          const ci = vy * vw + vx;
          const cur = wd.corners[ci];
          let nv = cur;
          if (toolId === 'raise') nv = Math.min(MAXH, Math.max(...wd.tileCorners(x, y)) + (wd.isFlat(t) ? 1 : 0));
          else if (toolId === 'lower') nv = Math.max(0, Math.min(...wd.tileCorners(x, y)) - (wd.isFlat(t) ? 1 : 0));
          else if (toolId === 'level') nv = target;
          else nv = 0;
          targets.set(ci, nv);
        }
      }
      const changes = planCornerChange(wd, targets);
      if (!changes.size) return fail(toolId === 'raise' ? 'Höher geht es nicht.' : toolId === 'lower' ? 'Tiefer geht es nicht.' : 'Hier ist nichts zu tun.');
      const affected = tilesOfCorners(wd, changes.keys());
      if (terraformBlocked(wd, affected)) return fail('Bebauung im Weg. Erst abreißen.');
      plan.corners = changes;
      plan.apply = Array.from(affected);
      plan.cost = toolId === 'water' ? tiles.length * COSTS.water : changes.size * COSTS.terraform;
      return checkMoney(wd, plan);
    }
    case 'ignite': {
      plan.tiles = [b];
      plan.apply = [b];
      if (!wd.sandbox) return fail('Nur im Sandkasten möglich.');
      return plan;
    }
    case 'query':
      plan.tiles = [b];
      return plan;
  }

  if (zone) {
    plan.tiles = rectTiles(wd, a, b);
    const [z, dense] = zone;
    for (const i of plan.tiles) {
      if (wd.isWater(i) || !wd.isFlat(i)) continue;
      if (wd.zone[i] === z && wd.dense[i] === (dense ? 1 : 0)) continue;
      if (wd.zone[i] && wd.level[i]) continue;
      if (!wd.isEmpty(i) && !wd.zone[i]) continue;
      plan.apply.push(i);
      plan.cost += dense ? COSTS.zoneDense : COSTS.zoneLight;
    }
    return checkMoney(wd, plan);
  }
  return fail('Unbekanntes Werkzeug');
}

function checkMoney(wd: World, plan: Plan): Plan {
  if (!wd.sandbox && plan.cost > wd.funds) {
    plan.ok = false;
    plan.reason = 'Nicht genug Geld.';
  }
  return plan;
}

export function applyPlan(wd: World, toolId: string, plan: Plan): void {
  if (!plan.ok) return;
  if (!wd.sandbox) wd.funds -= plan.cost;

  if (toolId.startsWith('bld:') && plan.building) {
    const def = BUILDING_BY_KEY[plan.building.key];
    wd.placeBuilding(def, plan.building.x, plan.building.y);
    return;
  }
  const zone = zoneOf(toolId);
  if (zone) {
    for (const i of plan.apply) {
      wd.zone[i] = zone[0];
      wd.dense[i] = zone[1] ? 1 : 0;
      wd.level[i] = 0;
      wd.tree[i] = 0;
      wd.changed(i);
    }
    wd.powerDirty = true;
    return;
  }
  switch (toolId) {
    case 'road':
    case 'power': {
      const flag = toolId === 'road' ? NET_ROAD : NET_POWER;
      for (const i of plan.apply) {
        if (wd.zone[i]) {
          wd.zone[i] = 0;
          wd.dense[i] = 0;
        }
        wd.tree[i] = 0;
        wd.net[i] |= flag;
        wd.changedWithNeighbors(i);
      }
      wd.powerDirty = true;
      break;
    }
    case 'pipe':
    case 'unpipe':
      for (const i of plan.apply) {
        wd.pipe[i] = toolId === 'pipe' ? 1 : 0;
        wd.changedWithNeighbors(i);
      }
      wd.powerDirty = true;
      break;
    case 'bulldoze':
      for (const i of plan.apply) wd.clearTile(i);
      break;
    case 'dezone':
      for (const i of plan.apply) wd.clearTile(i);
      break;
    case 'trees':
      for (const i of plan.apply) {
        wd.tree[i] = Math.min(3, wd.tree[i] + 2);
        wd.changed(i);
      }
      break;
    case 'raise':
    case 'lower':
    case 'level':
    case 'water':
      if (plan.corners) {
        for (const [c, v] of plan.corners) wd.corners[c] = v;
        for (const t of plan.apply) {
          if (wd.zone[t] && !wd.isFlat(t)) {
            wd.zone[t] = 0;
            wd.dense[t] = 0;
          }
          if (wd.isWater(t)) wd.tree[t] = 0;
          if (toolId !== 'raise' && toolId !== 'lower') wd.tree[t] = 0;
          wd.changed(t);
          // Nachbarn wegen Kartenrand und Brücken neu zeichnen
          wd.changedWithNeighbors(t);
        }
      }
      break;
  }
}
