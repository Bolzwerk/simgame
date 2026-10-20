// Laufendes Spiel: Schleife, Werkzeuge, Bedienoberfläche.

import { BLD_MAX_H, BUILDING_BY_KEY, cityRank, COM_JOBS, IND_JOBS, NET_POWER, NET_ROAD, PUMP_SHORE_BONUS, RES_POP, Zone } from './config';
import { Input } from './input';
import { Minimap } from './minimap';
import { OVERLAYS, Overlay, Renderer } from './render';
import { MsgKind, Simulation } from './sim';
import { Sprite } from './sprites';
import { saveGame, Slot, SLOTS, loadMeta } from './storage';
import { applyPlan, isUnlocked, lockReason, Plan, planTool, TOOLS } from './tools';
import { closeAllDialogs, closeTopDialog, compositeIcon, confirmDialog, dialogCount, el, fmtMoney, fmtNum, ICONS, openDialog, spriteIcon, toast } from './ui';
import { World, YearReport } from './world';

const ZOOMS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8];
const SPEED_MS = [0, 650, 260, 90];

const LEVEL_NAMES: Record<number, string[]> = {
  [Zone.R]: ['Bauland', 'Einfamilienhaus', 'Doppelhaus', 'Mehrfamilienhaus', 'Wohnhochhaus'],
  [Zone.C]: ['Bauland', 'Laden', 'Bürohaus', 'Geschäftshaus', 'Wolkenkratzer'],
  [Zone.I]: ['Bauland', 'Werkstatt', 'Lagerhalle', 'Fabrik', 'Industriekomplex'],
};
const ZONE_NAMES: Record<number, string> = { [Zone.R]: 'Wohngebiet', [Zone.C]: 'Gewerbegebiet', [Zone.I]: 'Industriegebiet' };

interface Category {
  id: string;
  label: string;
  tools?: string[];
  action?: () => void;
  icon: () => string;
}

interface Message {
  text: string;
  kind: MsgKind;
  tile?: number;
  date: string;
}

export interface GameHost {
  toMenu(): void;
  newGame(): void;
}

export class Game {
  readonly sim: Simulation;
  readonly r: Renderer;
  private input: Input;
  private minimap: Minimap;
  tool = 'query';
  private catOfTool: Record<string, string> = {};
  private lastTool: Record<string, string> = {};
  speed = 1;
  private prevSpeed = 1;
  private acc = 0;
  private last = 0;
  private hudAt = 0;
  private raf = 0;
  private dragStart = -1;
  private plan: Plan | null = null;
  private messages: Message[] = [];
  private cats: Category[];
  private autoOverlay = false;
  private openCat: string | null = null;
  private lastAutosaveMonth = -1;
  private hud: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private alive = true;
  private resizeObs: ResizeObserver | null = null;

  constructor(
    public wd: World,
    private canvas: HTMLCanvasElement,
    private host: GameHost,
  ) {
    this.r = new Renderer(wd, canvas);
    this.sim = new Simulation(wd, {
      message: (t, k, tile) => this.message(t, k, tile),
      yearEnd: (rep) => this.yearEnd(rep),
      gameOver: (reason) => this.gameOver(reason),
      quake: () => (this.r.shake = 1),
    });
    this.r.sim = this.sim;
    const dpr = window.devicePixelRatio || 1;
    this.r.cam.z = nearestZoom(Math.max(1, dpr * 1.2));
    this.cats = this.makeCategories();
    for (const c of this.cats) for (const t of c.tools || []) this.catOfTool[t] = c.id;
    this.hud = document.getElementById('hud')!;
    this.buildHud();
    this.minimap = new Minimap(wd, this.r, this.els.minimapCanvas as HTMLCanvasElement);
    this.input = new Input(canvas, {
      mode: () => (this.tool === 'query' ? 'pan' : 'build'),
      tap: (x, y) => this.tap(x, y),
      buildStart: (x, y) => this.buildStart(x, y),
      buildMove: (x, y) => this.buildMove(x, y),
      buildEnd: (x, y) => this.buildEnd(x, y),
      buildCancel: () => this.buildCancel(),
      pan: (dx, dy) => this.pan(dx, dy),
      zoom: (f, x, y) => this.zoom(f, x, y),
      zoomEnd: (x, y) => this.zoomEnd(x, y),
      hover: (x, y) => {
        this.r.hover = x < 0 || this.plan ? -1 : this.r.pick(x, y);
      },
    });
    this.onResize = this.onResize.bind(this);
    window.addEventListener('resize', this.onResize);
    if ('ResizeObserver' in window) {
      this.resizeObs = new ResizeObserver(() => this.onResize());
      this.resizeObs.observe(canvas);
    }
    this.r.resize();
    this.lastAutosaveMonth = wd.year * 12 + wd.month;
    if (!wd.history.pop.length) {
      this.message(`Willkommen in ${wd.name}! Bauen Sie ein Kraftwerk, Straßen und die ersten Zonen.`, 'info');
    }
    this.selectTool('query');
    this.updateHud();
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    this.wd.onTileChanged = null;
    this.hud.innerHTML = '';
    this.hud.classList.add('hidden');
    closeAllDialogs();
  }

  // ---------------- Schleife ----------------

  private loop(t: number): void {
    if (!this.alive) return;
    const dt = Math.min(250, t - this.last);
    this.last = t;
    const paused = this.speed === 0 || dialogCount() > 0 || this.wd.gameOver || document.hidden;
    if (!paused) {
      this.acc += dt;
      const iv = SPEED_MS[this.speed];
      let steps = 0;
      while (this.acc >= iv && steps < 4) {
        this.sim.step();
        this.acc -= iv;
        steps++;
      }
      if (steps === 4) this.acc = 0;
    }
    this.r.frame(t);
    if (t - this.hudAt > 250) {
      this.hudAt = t;
      this.updateHud();
      this.minimap.update(t, this.r.overlay);
      const m = this.wd.year * 12 + this.wd.month;
      if (m - this.lastAutosaveMonth >= 6) {
        this.lastAutosaveMonth = m;
        this.save('autosave', true);
      }
    }
    this.raf = requestAnimationFrame((tt) => this.loop(tt));
  }

  private onResize(): void {
    const center = this.r.screenToWorld(this.canvas.width / 2, this.canvas.height / 2);
    this.r.resize();
    this.r.cam.x = center[0];
    this.r.cam.y = center[1];
    this.layoutFlyout();
  }

  // ---------------- Kamera ----------------

  private pan(dx: number, dy: number): void {
    this.r.cam.x -= dx / this.r.cam.z;
    this.r.cam.y -= dy / this.r.cam.z;
    this.r.clampCam();
  }

  private zoom(f: number, px: number, py: number): void {
    const before = this.r.screenToWorld(px, py);
    this.r.cam.z = Math.max(0.4, Math.min(9, this.r.cam.z * f));
    const after = this.r.screenToWorld(px, py);
    this.r.cam.x += before[0] - after[0];
    this.r.cam.y += before[1] - after[1];
    this.r.clampCam();
  }

  private zoomEnd(px: number, py: number): void {
    const z = nearestZoom(this.r.cam.z);
    this.zoom(z / this.r.cam.z, px, py);
    this.r.cam.z = z;
  }

  zoomStep(dir: number): void {
    const i = ZOOMS.indexOf(nearestZoom(this.r.cam.z));
    const z = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))];
    this.zoom(z / this.r.cam.z, this.canvas.width / 2, this.canvas.height / 2);
    this.r.cam.z = z;
  }

  // ---------------- Werkzeuge ----------------

  private tap(px: number, py: number): void {
    this.closeFlyout();
    const i = this.r.pick(px, py);
    if (i < 0) return;
    if (this.tool === 'query') this.showInfo(i);
  }

  private buildStart(px: number, py: number): void {
    this.closeFlyout();
    const i = this.r.pick(px, py);
    if (i < 0) return;
    this.dragStart = i;
    this.updatePlan(i);
  }

  private buildMove(px: number, py: number): void {
    if (this.dragStart < 0) return;
    const i = this.r.pick(px, py);
    if (i < 0) return;
    this.updatePlan(i);
  }

  private updatePlan(end: number): void {
    const def = TOOLS[this.tool];
    const start = def && def.shape === 'point' ? end : this.dragStart;
    this.plan = planTool(this.wd, this.tool, start, end);
    this.r.preview = { tiles: this.plan.tiles, ok: this.plan.ok, building: this.plan.building };
    this.showPlanHint();
  }

  private buildEnd(px: number, py: number): void {
    if (this.dragStart < 0) return;
    const i = this.r.pick(px, py);
    if (i >= 0) this.updatePlan(i);
    const plan = this.plan;
    this.buildCancel();
    if (!plan) return;
    if (this.tool === 'ignite') {
      if (plan.ok) this.sim.ignite(plan.apply[0]);
      else if (plan.reason) toast(plan.reason);
      return;
    }
    if (!plan.ok) {
      if (plan.reason) toast(plan.reason);
      return;
    }
    if (!plan.apply.length) return;
    applyPlan(this.wd, this.tool, plan);
    if (this.tool !== 'raise' && this.tool !== 'lower') this.sim.computeAccess();
    if (this.tool.startsWith('bld:')) {
      const def = BUILDING_BY_KEY[this.tool.slice(4)];
      toast(`${def.name} gebaut${this.wd.sandbox ? '' : ` (${fmtMoney(plan.cost)})`}.`);
    }
    this.updateHud();
  }

  private buildCancel(): void {
    this.dragStart = -1;
    this.plan = null;
    this.r.preview = null;
    this.showToolHint();
  }

  selectTool(id: string): void {
    this.tool = id;
    const cat = this.catOfTool[id];
    if (cat) this.lastTool[cat] = id;
    // Rohre liegen unter der Erde: beim Wasserwerkzeug automatisch die Untergrundansicht zeigen
    if (cat === 'water' && this.r.overlay !== 'water') {
      this.autoOverlay = true;
      this.r.setOverlay('water');
      this.minimap.invalidate();
    } else if (cat !== 'water' && this.autoOverlay) {
      this.autoOverlay = false;
      if (this.r.overlay === 'water') {
        this.r.setOverlay(null);
        this.minimap.invalidate();
      }
    }
    this.refreshToolbar();
    this.showToolHint();
  }

  private toolLabel(id: string): string {
    if (id.startsWith('bld:')) return BUILDING_BY_KEY[id.slice(4)].name;
    return TOOLS[id]?.label ?? id;
  }

  private toolDesc(id: string): string {
    if (id.startsWith('bld:')) {
      const d = BUILDING_BY_KEY[id.slice(4)];
      const parts = [fmtMoney(d.cost)];
      if (d.power) parts.push(`${d.power} Stromeinheiten`);
      if (d.water) parts.push(d.key === 'pump' ? `${d.water} Wassereinheiten, am Ufer mehr` : `${d.water} Wassereinheiten`);
      if (d.cat === 'water') parts.push('braucht Strom');
      if (d.upkeep) parts.push(`Unterhalt ${fmtMoney(d.upkeep)}/Jahr`);
      return parts.join(' · ');
    }
    return TOOLS[id]?.desc ?? '';
  }

  private showToolHint(): void {
    const h = this.els.hint;
    if (!h) return;
    if (this.tool === 'query') {
      h.innerHTML = '';
      h.append(el('b', {}, 'Info'), ' Feld antippen · Ziehen verschiebt die Karte');
      return;
    }
    h.innerHTML = '';
    h.append(el('b', {}, this.toolLabel(this.tool)), ` ${this.toolDesc(this.tool)} · Mit einem Finger bauen, mit zwei Fingern verschieben`);
  }

  private showPlanHint(): void {
    const h = this.els.hint;
    const p = this.plan;
    if (!h || !p) return;
    h.innerHTML = '';
    h.append(el('b', {}, this.toolLabel(this.tool)));
    if (!p.ok) h.append(el('span', { class: 'bad' }, ' ' + (p.reason || 'Nicht möglich')));
    else if (this.wd.sandbox) h.append(` ${p.apply.length} Felder`);
    else h.append(` Kosten: ${fmtMoney(p.cost)}`);
  }

  // ---------------- Kategorien und Symbole ----------------

  private tileIcon(key: string, surface: string, rel: [number, number, number, number] = [0, 0, 0, 0]): string {
    return spriteIcon(key, this.r.sprites.terrain(rel[0], rel[1], rel[2], rel[3], surface, 0), 40);
  }

  private composite(key: string, surface: string, objs: Sprite[], size = 1): string {
    const W = size * 32;
    const H = size * 16 + BLD_MAX_H;
    const layers: { s: Sprite; x: number; y: number }[] = [];
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) layers.push({ s: this.r.sprites.terrain(0, 0, 0, 0, surface, 0), x: size * 16 + (dx - dy) * 16, y: BLD_MAX_H + (dx + dy) * 8 });
    for (const o of objs) layers.push({ s: o, x: size * 16, y: BLD_MAX_H });
    return compositeIcon(key, layers, W, H, 40);
  }

  toolIcon(id: string): string {
    const sp = this.r.sprites;
    if (id.startsWith('bld:')) {
      const def = BUILDING_BY_KEY[id.slice(4)];
      const surf = def.key === 'park' || def.key === 'bigpark' ? 'lawn' : def.key === 'coal' || def.key === 'solar' ? 'dirt' : def.key === 'airport' ? 'tarmac' : 'pave';
      return this.composite('i-' + id, surf, [sp.building(def)], def.size);
    }
    switch (id) {
      case 'query':
        return ICONS.query();
      case 'bulldoze':
        return this.tileIcon('i-bulldoze', 'rubble');
      case 'dezone':
        return this.tileIcon('i-dezone', 'zone:1:0');
      case 'raise':
        return this.tileIcon('i-raise', 'grass', [2, 1, 0, 1]);
      case 'lower':
        return this.tileIcon('i-lower', 'grass', [0, 1, 2, 1]);
      case 'level':
        return this.tileIcon('i-level', 'grass');
      case 'trees':
        return this.composite('i-trees', 'grass', [sp.tree(3)]);
      case 'water':
        return this.tileIcon('i-water', 'water');
      case 'ignite':
        return spriteIcon('i-fire', sp.fire(0), 40);
      case 'road':
        return this.tileIcon('i-road', 'road:10');
      case 'pipe':
        return this.composite('i-pipe', 'grass', [sp.terrain(0, 0, 0, 0, 'pipe:10', 0)]);
      case 'unpipe':
        return this.composite('i-unpipe', 'rubble', [sp.terrain(0, 0, 0, 0, 'pipe:10', 0)]);
      case 'power':
        return this.composite('i-power', 'grass', [sp.power(10, 0, [0, 0, 0, 0], false)]);
      case 'zoneR':
        return this.composite('i-zr', 'lot:1', [sp.zone(Zone.R, 1, 0)]);
      case 'zoneRd':
        return this.composite('i-zrd', 'lot:1', [sp.zone(Zone.R, 3, 1)]);
      case 'zoneC':
        return this.composite('i-zc', 'lot:2', [sp.zone(Zone.C, 1, 0)]);
      case 'zoneCd':
        return this.composite('i-zcd', 'lot:2', [sp.zone(Zone.C, 4, 2)]);
      case 'zoneI':
        return this.composite('i-zi', 'lot:3', [sp.zone(Zone.I, 1, 0)]);
      case 'zoneId':
        return this.composite('i-zid', 'lot:3', [sp.zone(Zone.I, 3, 0)]);
    }
    return '';
  }

  private makeCategories(): Category[] {
    const sb = this.wd.sandbox;
    return [
      { id: 'query', label: 'Info', tools: ['query'], icon: () => ICONS.query() },
      { id: 'bulldoze', label: 'Abriss', tools: ['bulldoze', 'dezone'], icon: () => this.toolIcon('bulldoze') },
      { id: 'terrain', label: 'Gelände', tools: ['raise', 'lower', 'level', 'trees', 'water', ...(sb ? ['ignite'] : [])], icon: () => this.toolIcon('raise') },
      { id: 'road', label: 'Straße', tools: ['road'], icon: () => this.toolIcon('road') },
      { id: 'power', label: 'Strom', tools: ['power', 'bld:wind', 'bld:gas', 'bld:coal', 'bld:nuclear', 'bld:solar'], icon: () => this.toolIcon('power') },
      { id: 'water', label: 'Wasser', tools: ['pipe', 'bld:pump', 'bld:watertower', 'unpipe'], icon: () => this.toolIcon('bld:pump') },
      { id: 'res', label: 'Wohnen', tools: ['zoneR', 'zoneRd'], icon: () => this.toolIcon('zoneRd') },
      { id: 'com', label: 'Gewerbe', tools: ['zoneC', 'zoneCd'], icon: () => this.toolIcon('zoneCd') },
      { id: 'ind', label: 'Industrie', tools: ['zoneI', 'zoneId'], icon: () => this.toolIcon('zoneId') },
      { id: 'service', label: 'Dienste', tools: ['bld:police', 'bld:fire', 'bld:hospital', 'bld:school', 'bld:college'], icon: () => this.toolIcon('bld:police') },
      { id: 'park', label: 'Freizeit', tools: ['bld:park', 'bld:bigpark', 'bld:stadium', 'bld:seaport', 'bld:airport'], icon: () => this.toolIcon('bld:park') },
      { id: 'view', label: 'Ansicht', action: () => this.toggleViewFlyout(), icon: () => ICONS.eye() },
      { id: 'budget', label: 'Budget', action: () => this.openBudget(), icon: () => ICONS.money() },
    ];
  }

  // ---------------- HUD ----------------

  private buildHud(): void {
    const hud = this.hud;
    hud.innerHTML = '';
    hud.classList.remove('hidden');
    const speedBtns = [0, 1, 2, 3].map((s) =>
      el('button', { class: 'btn icon speed', 'data-speed': s, onclick: () => this.setSpeed(s), title: ['Pause', 'Langsam', 'Normal', 'Schnell'][s] }, el('img', { src: [ICONS.pause(), ICONS.play1(), ICONS.play2(), ICONS.play3()][s], alt: '' })),
    );
    const rci = el('canvas', { class: 'rci', width: 30, height: 26, title: 'Nachfrage: Wohnen, Gewerbe, Industrie' });
    const funds = el('div', { class: 'stat money', onclick: () => this.openBudget() });
    const pop = el('div', { class: 'stat pop', onclick: () => this.openStats() });
    const date = el('div', { class: 'stat date' });
    const top = el(
      'div',
      { id: 'topbar', class: 'bar' },
      el('button', { class: 'btn icon', onclick: () => this.openMenu(), title: 'Menü' }, el('img', { src: ICONS.menu(), alt: 'Menü' })),
      el('div', { class: 'group info' }, date, funds, pop),
      el('div', { class: 'group ctrl' }, rci, ...speedBtns, el('button', { class: 'btn icon', onclick: () => this.toggleMinimap(), title: 'Übersichtskarte' }, el('img', { src: ICONS.map(), alt: 'Karte' }))),
    );
    const toolbar = el('div', { id: 'toolbar', class: 'bar' });
    const flyout = el('div', { id: 'flyout', class: 'panel hidden' });
    const hint = el('div', { id: 'hint' });
    const ticker = el('div', { id: 'ticker', onclick: () => this.tickerClick() });
    const mmCanvas = el('canvas', { width: 220, height: 120 });
    const minimap = el('div', { id: 'minimap', class: 'panel hidden' }, mmCanvas);
    const zoomCtl = el(
      'div',
      { id: 'zoomctl' },
      el('button', { class: 'btn icon', onclick: () => this.zoomStep(1), title: 'Hineinzoomen' }, '+'),
      el('button', { class: 'btn icon', onclick: () => this.zoomStep(-1), title: 'Herauszoomen' }, '−'),
    );
    hud.append(top, toolbar, flyout, hint, ticker, minimap, zoomCtl);
    this.els = { top, toolbar, flyout, hint, ticker, minimap, minimapCanvas: mmCanvas, rci, funds, pop, date };
    mmCanvas.addEventListener('pointerdown', (e) => {
      const r = mmCanvas.getBoundingClientRect();
      const t = this.minimap.tileAt(((e.clientX - r.left) / r.width) * mmCanvas.width, ((e.clientY - r.top) / r.height) * mmCanvas.height);
      if (t) this.r.centerOn(t[0], t[1]);
    });
    for (const c of this.cats) {
      const b = el(
        'button',
        { class: 'btn tool', 'data-cat': c.id, title: c.label, onclick: () => this.catClick(c) },
        el('img', { src: c.icon(), alt: '' }),
        el('span', {}, c.label),
      );
      toolbar.append(b);
    }
    this.refreshSpeed();
  }

  private catClick(c: Category): void {
    if (c.action) {
      if (this.openCat === c.id) this.closeFlyout();
      else c.action();
      return;
    }
    const tools = c.tools!;
    if (tools.length === 1) {
      this.closeFlyout();
      this.selectTool(tools[0]);
      return;
    }
    if (this.openCat === c.id) {
      this.closeFlyout();
      return;
    }
    this.openFlyout(c);
  }

  private openFlyout(c: Category): void {
    const f = this.els.flyout;
    f.innerHTML = '';
    f.append(el('div', { class: 'fly-title' }, c.label));
    for (const t of c.tools!) {
      let locked = '';
      if (t.startsWith('bld:')) {
        const def = BUILDING_BY_KEY[t.slice(4)];
        if (!isUnlocked(this.wd, def)) locked = lockReason(this.wd, def);
      }
      const item = el(
        'button',
        {
          class: 'btn fly-item' + (t === this.tool ? ' on' : '') + (locked ? ' locked' : ''),
          onclick: () => {
            if (locked) {
              toast(`${this.toolLabel(t)} ist erst ${locked} verfügbar.`);
              return;
            }
            this.selectTool(t);
            this.closeFlyout();
          },
        },
        el('img', { src: this.toolIcon(t), alt: '' }),
        el('div', { class: 'fly-text' }, el('b', {}, this.toolLabel(t)), el('small', {}, locked ? `Gesperrt: ${locked}` : this.toolDesc(t))),
      );
      f.append(item);
    }
    this.showFlyout(c.id);
  }

  private toggleViewFlyout(): void {
    const f = this.els.flyout;
    f.innerHTML = '';
    f.append(el('div', { class: 'fly-title' }, 'Ansicht'));
    const mk = (key: Overlay | null, label: string) =>
      el(
        'button',
        {
          class: 'btn fly-item small' + (this.r.overlay === key ? ' on' : ''),
          onclick: () => {
            this.r.setOverlay(key);
            this.minimap.invalidate();
            this.closeFlyout();
            this.refreshToolbar();
          },
        },
        el('div', { class: 'fly-text' }, el('b', {}, label)),
      );
    f.append(mk(null, 'Normale Ansicht'));
    for (const o of OVERLAYS) f.append(mk(o.key, o.label));
    this.showFlyout('view');
  }

  private showFlyout(catId: string): void {
    this.openCat = catId;
    this.els.flyout.classList.remove('hidden');
    this.layoutFlyout();
    this.refreshToolbar();
  }

  private layoutFlyout(): void {
    const f = this.els.flyout;
    if (!f || f.classList.contains('hidden') || !this.openCat) return;
    const btn = this.els.toolbar.querySelector<HTMLElement>(`[data-cat="${this.openCat}"]`);
    if (!btn) return;
    const tb = this.els.toolbar.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const vertical = tb.height > tb.width;
    f.style.left = f.style.top = f.style.bottom = f.style.right = '';
    if (vertical) {
      f.style.left = `${tb.right + 4}px`;
      const fh = f.offsetHeight;
      const top = Math.max(tb.top, Math.min(br.top, window.innerHeight - fh - 8));
      f.style.top = `${top}px`;
    } else {
      f.style.bottom = `${window.innerHeight - tb.top + 4}px`;
      const fw = f.offsetWidth;
      f.style.left = `${Math.max(4, Math.min(br.left, window.innerWidth - fw - 4))}px`;
    }
  }

  closeFlyout(): void {
    if (!this.openCat) return;
    this.openCat = null;
    this.els.flyout?.classList.add('hidden');
    this.refreshToolbar();
  }

  private refreshToolbar(): void {
    const tb = this.els.toolbar;
    if (!tb) return;
    const activeCat = this.catOfTool[this.tool];
    for (const c of this.cats) {
      const b = tb.querySelector<HTMLElement>(`[data-cat="${c.id}"]`);
      if (!b) continue;
      const on = c.id === activeCat || this.openCat === c.id || (c.id === 'view' && this.r.overlay !== null);
      b.classList.toggle('on', on);
      if (c.tools && c.tools.length > 1) {
        const t = this.lastTool[c.id] || c.tools[0];
        const img = b.querySelector('img')!;
        const src = this.toolIcon(t);
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
      }
    }
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.refreshSpeed();
  }

  private refreshSpeed(): void {
    this.els.top?.querySelectorAll<HTMLElement>('.speed').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === this.speed));
  }

  private updateHud(): void {
    const wd = this.wd;
    const e = this.els;
    if (!e.date) return;
    const th = `${e.top.offsetHeight}px`;
    if (this.hud.style.getPropertyValue('--top-h') !== th) this.hud.style.setProperty('--top-h', th);
    e.date.textContent = `${wd.name} · ${wd.date}`;
    e.funds.textContent = wd.sandbox ? '∞ $' : fmtMoney(wd.funds);
    e.funds.classList.toggle('neg', !wd.sandbox && wd.funds < 0);
    e.pop.textContent = `${fmtNum(wd.pop)} Einw.`;
    const cv = e.rci as HTMLCanvasElement;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 12, 30, 1);
    const bars: [number, string][] = [
      [wd.demandR, '#3cb043'],
      [wd.demandC, '#3a78d8'],
      [wd.demandI, '#e0b020'],
    ];
    bars.forEach(([v, c], k) => {
      const hgt = Math.round(Math.max(-1, Math.min(1, v)) * 11);
      ctx.fillStyle = c;
      if (hgt >= 0) ctx.fillRect(2 + k * 10, 12 - hgt, 7, hgt);
      else ctx.fillRect(2 + k * 10, 13, 7, -hgt);
    });
  }

  private toggleMinimap(): void {
    const m = this.els.minimap;
    m.classList.toggle('hidden');
    this.minimap.visible = !m.classList.contains('hidden');
    this.minimap.invalidate();
  }

  // ---------------- Meldungen ----------------

  private message(text: string, kind: MsgKind, tile?: number): void {
    this.messages.unshift({ text, kind, tile, date: this.wd.date });
    if (this.messages.length > 60) this.messages.pop();
    const t = this.els.ticker;
    if (t) {
      t.innerHTML = '';
      t.className = 'k-' + kind;
      t.append(el('span', { class: 'dot' }), el('span', {}, text));
      if (tile !== undefined) t.append(el('span', { class: 'go' }, ' ➜'));
    }
  }

  private tickerClick(): void {
    const m = this.messages[0];
    if (m && m.tile !== undefined) {
      this.r.centerOn((m.tile % this.wd.w) + 0.5, Math.floor(m.tile / this.wd.w) + 0.5);
      return;
    }
    this.openMessages();
  }

  private openMessages(): void {
    const list = el('div', { class: 'msglist' });
    let close = () => {};
    for (const m of this.messages) {
      list.append(
        el(
          'div',
          {
            class: 'msg k-' + m.kind,
            onclick: () => {
              if (m.tile !== undefined) {
                close();
                this.r.centerOn((m.tile % this.wd.w) + 0.5, Math.floor(m.tile / this.wd.w) + 0.5);
              }
            },
          },
          el('small', {}, m.date),
          el('div', {}, m.text),
        ),
      );
    }
    if (!this.messages.length) list.append(el('p', {}, 'Keine Meldungen.'));
    close = openDialog('Meldungen', list);
  }

  // ---------------- Dialoge ----------------

  private showInfo(i: number): void {
    const wd = this.wd;
    const x = i % wd.w;
    const y = (i / wd.w) | 0;
    const rows: [string, string][] = [];
    let title = 'Unbebautes Land';
    if (wd.isWater(i)) title = 'Wasser';
    if (wd.tree[i] && wd.isEmpty(i)) title = 'Wald';
    if (wd.rubble[i]) title = 'Trümmer';
    if (wd.net[i] & NET_ROAD) title = wd.isWater(i) ? 'Brücke' : 'Straße';
    else if (wd.net[i] & NET_POWER) title = 'Stromleitung';
    else if (wd.pipe[i] && wd.isEmpty(i) && !wd.tree[i]) title = 'Wasserrohr';
    if (wd.zone[i]) {
      const z = wd.zone[i];
      title = `${ZONE_NAMES[z]} (${wd.dense[i] ? 'dicht' : 'leicht'})`;
      rows.push(['Bebauung', LEVEL_NAMES[z][wd.level[i]]]);
      const L = wd.level[i];
      if (z === Zone.R) rows.push(['Einwohner', fmtNum(RES_POP[L])]);
      else rows.push(['Arbeitsplätze', fmtNum(z === Zone.C ? COM_JOBS[L] : IND_JOBS[L])]);
      rows.push(['Straße in Reichweite', wd.access[i] & 1 ? 'ja' : 'nein (max. 3 Felder)']);
    }
    if (wd.bld[i]) {
      const def = wd.bldDef(i)!;
      title = def.name;
      if (def.power) rows.push(['Leistung', `${def.power} Einheiten`]);
      if (def.water) rows.push(['Fördermenge', `${def.water}${def.key === 'pump' ? ' (+' + PUMP_SHORE_BONUS + ' am Ufer)' : ''} Einheiten`]);
      if (def.upkeep) rows.push(['Unterhalt', `${fmtMoney(def.upkeep)}/Jahr`]);
    }
    if (wd.zone[i] || wd.bld[i] || wd.net[i] & NET_POWER) rows.push(['Strom', wd.powered[i] ? 'versorgt' : 'kein Strom']);
    if (wd.isWaterConductor(i)) rows.push(['Wasser', wd.watered[i] ? 'versorgt' : wd.zone[i] ? 'kein Anschluss (nötig ab Stufe 3)' : 'kein Anschluss']);
    if (wd.isRoad(i)) rows.push(['Verkehr', pct(wd.traffic[i])]);
    if (!wd.isWater(i)) {
      rows.push(['Bodenwert', fmtMoney(wd.landValue[i] * 40)]);
      rows.push(['Verschmutzung', pct(wd.pollution[i])]);
      rows.push(['Kriminalität', pct(wd.crime[i])]);
      rows.push(['Polizei', pct(wd.covPolice[i])]);
      rows.push(['Feuerschutz', pct(wd.covFire[i])]);
      rows.push(['Bildung', pct(wd.covEdu[i])]);
      rows.push(['Gesundheit', pct(wd.covHealth[i])]);
    }
    rows.push(['Position', `${x}, ${y} · Höhe ${wd.minH(i) * 25} m`]);
    if (wd.fire[i]) rows.unshift(['Achtung', 'Es brennt!']);
    openDialog(title, table(rows));
  }

  openMenu(): void {
    this.closeFlyout();
    let close = () => {};
    const item = (label: string, fn: () => void) =>
      el(
        'button',
        {
          class: 'btn menu-item',
          onclick: () => {
            close();
            fn();
          },
        },
        label,
      );
    const body = el(
      'div',
      { class: 'menu-list' },
      item('Weiterspielen', () => {}),
      item('Speichern', () => this.openSave()),
      item('Statistik', () => this.openStats()),
      item('Budget', () => this.openBudget()),
      item('Meldungen', () => this.openMessages()),
      item('Katastrophen', () => this.openDisasters()),
      item('Einstellungen', () => this.openSettings()),
      item('Hilfe', () => openHelp()),
      item('Hauptmenü', () => {
        this.save('autosave', true);
        this.host.toMenu();
      }),
    );
    close = openDialog(`${this.wd.name} (${this.wd.diff.label})`, body);
  }

  save(slot: Slot, silent = false): boolean {
    const wd = this.wd;
    const ok = saveGame(slot, wd.serialize(), {
      name: wd.name,
      year: wd.year,
      month: wd.month,
      pop: wd.pop,
      funds: Math.round(wd.funds),
      difficulty: wd.diff.label,
      savedAt: Date.now(),
    });
    if (!silent) toast(ok ? 'Gespeichert.' : 'Speichern fehlgeschlagen.');
    return ok;
  }

  private openSave(): void {
    const list = el('div', { class: 'menu-list' });
    let close = () => {};
    for (const s of SLOTS.filter((s) => s !== 'autosave')) {
      const meta = loadMeta(s);
      const label = meta ? `${meta.name} · ${meta.year} · ${fmtNum(meta.pop)} Einw.` : 'Leerer Platz';
      list.append(
        el(
          'button',
          {
            class: 'btn menu-item',
            onclick: () => {
              const doSave = () => {
                this.save(s);
                close();
              };
              if (meta) confirmDialog('Überschreiben?', `Spielstand „${meta.name}“ überschreiben?`, 'Überschreiben', doSave);
              else doSave();
            },
          },
          el('b', {}, `Platz ${s.slice(4)}`),
          el('small', {}, label),
        ),
      );
    }
    close = openDialog('Speichern', list);
  }

  private openSettings(): void {
    const wd = this.wd;
    const row = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = get();
      cb.addEventListener('change', () => set(cb.checked));
      return el('label', { class: 'check' }, cb, el('span', {}, label));
    };
    const body = el(
      'div',
      { class: 'settings' },
      row('Gitterlinien anzeigen', () => wd.settings.grid, (v) => {
        wd.settings.grid = v;
        this.r.setGrid(v);
      }),
      row(wd.sandbox ? 'Zufällige Katastrophen' : 'Katastrophen', () => wd.settings.disasters, (v) => (wd.settings.disasters = v)),
      row('Jahresbilanz anzeigen', () => wd.settings.yearReport, (v) => (wd.settings.yearReport = v)),
    );
    openDialog('Einstellungen', body);
  }

  private openDisasters(): void {
    let close = () => {};
    const item = (label: string, fn: () => void) =>
      el(
        'button',
        {
          class: 'btn menu-item',
          onclick: () => {
            close();
            fn();
          },
        },
        label,
      );
    const body = el(
      'div',
      { class: 'menu-list' },
      el('p', {}, 'Katastrophe auslösen:'),
      item('Feuer', () => this.sim.randomFire()),
      item('Tornado', () => this.sim.startTornado()),
      item('Erdbeben', () => this.sim.earthquake()),
    );
    close = openDialog('Katastrophen', body);
  }

  openBudget(): void {
    this.closeFlyout();
    const wd = this.wd;
    const body = el('div', { class: 'budget' });
    const render = () => {
      body.innerHTML = '';
      const est = this.sim.budgetEstimate();
      const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, suffix: string, extra: () => string) => {
        const val = el('span', { class: 'val' }, `${get()}${suffix}`);
        const ex = el('span', { class: 'ex' }, extra());
        const inp = el('input', { type: 'range', min, max, step, value: get() }) as HTMLInputElement;
        inp.addEventListener('input', () => {
          set(Number(inp.value));
          val.textContent = `${get()}${suffix}`;
          ex.textContent = extra();
          sum.textContent = summary();
        });
        return el('div', { class: 'slider' }, el('label', {}, label), inp, val, ex);
      };
      const m = (v: number) => (wd.sandbox ? '–' : `${fmtMoney(v)}/M`);
      const summary = () => {
        const e = this.sim.budgetEstimate();
        const inc = e.income.r + e.income.c + e.income.i;
        let up = 0;
        for (const k in e.upkeep) up += e.upkeep[k];
        if (wd.sandbox) return 'Sandkasten: Geld ist unbegrenzt.';
        const bal = inc - up - e.interest;
        return `Einnahmen ${fmtMoney(inc)} · Ausgaben ${fmtMoney(up + e.interest)} · Saldo ${bal >= 0 ? '+' : ''}${fmtMoney(bal)} pro Monat`;
      };
      const sum = el('div', { class: 'sum' }, summary());
      body.append(
        el('h3', {}, 'Steuern'),
        slider('Wohnen', 0, 20, 1, () => wd.taxR, (v) => (wd.taxR = v), ' %', () => m(this.sim.budgetEstimate().income.r)),
        slider('Gewerbe', 0, 20, 1, () => wd.taxC, (v) => (wd.taxC = v), ' %', () => m(this.sim.budgetEstimate().income.c)),
        slider('Industrie', 0, 20, 1, () => wd.taxI, (v) => (wd.taxI = v), ' %', () => m(this.sim.budgetEstimate().income.i)),
        el('h3', {}, 'Ausgaben'),
        slider('Polizei', 0, 100, 10, () => wd.funding.police, (v) => (wd.funding.police = v), ' %', () => m(this.sim.budgetEstimate().upkeep.police)),
        slider('Feuerwehr', 0, 100, 10, () => wd.funding.fire, (v) => (wd.funding.fire = v), ' %', () => m(this.sim.budgetEstimate().upkeep.fire)),
        slider('Gesundheit', 0, 100, 10, () => wd.funding.health, (v) => (wd.funding.health = v), ' %', () => m(this.sim.budgetEstimate().upkeep.health)),
        slider('Bildung', 0, 100, 10, () => wd.funding.edu, (v) => (wd.funding.edu = v), ' %', () => m(this.sim.budgetEstimate().upkeep.edu)),
        slider('Verkehr', 0, 100, 10, () => wd.funding.transport, (v) => (wd.funding.transport = v), ' %', () => m(this.sim.budgetEstimate().upkeep.transport)),
        el('div', { class: 'fixed' }, `Strom & Wasser ${m(est.upkeep.power)} · Sonstiges ${m(est.upkeep.other)} · Zinsen ${m(est.interest)}`),
        sum,
      );
      if (!wd.sandbox) {
        const debt = wd.loans.reduce((a, l) => a + l.amount, 0);
        body.append(el('h3', {}, 'Kredite'), el('p', {}, debt ? `Offene Kredite: ${fmtMoney(debt)}` : 'Keine Kredite.'));
        const btns = el('div', { class: 'row' });
        btns.append(
          el(
            'button',
            {
              class: 'btn',
              disabled: debt >= 50000 ? true : undefined,
              onclick: () => {
                const rate = 4 + wd.loans.length * 1.5;
                wd.loans.push({ amount: 10000, rate });
                wd.funds += 10000;
                toast(`Kredit über 10.000 $ zu ${rate.toLocaleString('de-DE')} % aufgenommen.`);
                render();
              },
            },
            'Kredit 10.000 $ aufnehmen',
          ),
        );
        if (wd.loans.length)
          btns.append(
            el(
              'button',
              {
                class: 'btn',
                disabled: wd.funds < wd.loans[wd.loans.length - 1].amount ? true : undefined,
                onclick: () => {
                  const l = wd.loans.pop()!;
                  wd.funds -= l.amount;
                  toast('Kredit getilgt.');
                  render();
                },
              },
              'Kredit tilgen',
            ),
          );
        body.append(btns);
        if (wd.lastReport) {
          const r = wd.lastReport;
          body.append(el('h3', {}, `Bilanz ${r.year}`), table([
            ['Einnahmen', fmtMoney(r.income)],
            ['Unterhalt', fmtMoney(-r.upkeep)],
            ['Zinsen', fmtMoney(-r.interest)],
            ['Kassenstand', fmtMoney(r.balance)],
          ]));
        }
      }
    };
    render();
    openDialog('Budget', body, { wide: true });
  }

  openStats(): void {
    const wd = this.wd;
    const body = el('div', { class: 'stats' });
    let lv = 0;
    let pol = 0;
    let cr = 0;
    let n = 0;
    for (let i = 0; i < wd.w * wd.h; i++)
      if (wd.zone[i] && wd.level[i]) {
        lv += wd.landValue[i];
        pol += wd.pollution[i];
        cr += wd.crime[i];
        n++;
      }
    const avg = (v: number) => (n ? v / n : 0);
    body.append(
      table([
        ['Stadtgröße', cityRank(wd.pop)],
        ['Einwohner', fmtNum(wd.pop)],
        ['Arbeitsplätze Gewerbe', fmtNum(wd.jobsC)],
        ['Arbeitsplätze Industrie', fmtNum(wd.jobsI)],
        ['Arbeitslosigkeit', wd.pop ? `${Math.max(0, Math.round((1 - (wd.jobsC + wd.jobsI) / (wd.pop * 0.5)) * 100))} %` : '–'],
        ['Strom', `${fmtNum(wd.powerUsed)} / ${fmtNum(wd.powerCap)} Einheiten`],
        ['Wasser', `${fmtNum(wd.waterUsed)} / ${fmtNum(wd.waterCap)} Einheiten`],
        ['Ø Bodenwert', fmtMoney(avg(lv) * 40)],
        ['Ø Verschmutzung', pct(avg(pol))],
        ['Ø Kriminalität', pct(avg(cr))],
      ]),
      chart('Einwohner', [{ data: wd.history.pop, color: '#2a7a2a' }]),
      wd.sandbox ? '' : chart('Kassenstand', [{ data: wd.history.funds, color: '#1a5ab0' }]),
      chart('Nachfrage', [
        { data: wd.history.r, color: '#3cb043' },
        { data: wd.history.c, color: '#3a78d8' },
        { data: wd.history.i, color: '#d0a010' },
      ], true),
    );
    openDialog('Statistik', body, { wide: true });
  }

  private yearEnd(r: YearReport): void {
    this.save('autosave', true);
    if (this.wd.sandbox || !this.wd.settings.yearReport) return;
    const net = r.income - r.upkeep - r.interest;
    openDialog(`Jahresbilanz ${r.year}`, el('div', {}, table([
      ['Steuereinnahmen', fmtMoney(r.income)],
      ['Unterhalt', fmtMoney(-r.upkeep)],
      ['Zinsen', fmtMoney(-r.interest)],
      ['Ergebnis', fmtMoney(net)],
      ['Kassenstand', fmtMoney(r.balance)],
      ['Einwohner', fmtNum(this.wd.pop)],
    ])), { buttons: [['Budget öffnen', () => { closeTopDialog(); this.openBudget(); }], ['Weiter', () => closeTopDialog()]] });
  }

  private gameOver(reason: string): void {
    this.setSpeed(0);
    openDialog('Spiel vorbei', el('p', {}, reason), {
      noClose: true,
      buttons: [
        ['Neues Spiel', () => this.host.newGame()],
        ['Hauptmenü', () => this.host.toMenu()],
      ],
    });
  }

  /** Android-Zurück-Taste: true, wenn behandelt. */
  back(): boolean {
    if (closeTopDialog()) return true;
    if (this.openCat) {
      this.closeFlyout();
      return true;
    }
    if (this.tool !== 'query') {
      this.selectTool('query');
      return true;
    }
    this.openMenu();
    return true;
  }
}

function nearestZoom(z: number): number {
  let best = ZOOMS[0];
  for (const c of ZOOMS) if (Math.abs(Math.log(c / z)) < Math.abs(Math.log(best / z))) best = c;
  return best;
}

function pct(v: number): string {
  return `${Math.round((v / 255) * 100)} %`;
}

function table(rows: [string, string][]): HTMLElement {
  return el('table', { class: 'kv' }, ...rows.map(([k, v]) => el('tr', {}, el('th', {}, k), el('td', {}, v))));
}

function chart(title: string, series: { data: number[]; color: string }[], symmetric = false): HTMLElement {
  const cv = el('canvas', { width: 300, height: 90, class: 'chart' }) as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#10202c';
  ctx.fillRect(0, 0, 300, 90);
  const all = series.flatMap((s) => s.data);
  if (all.length > 1) {
    let lo = Math.min(...all, 0);
    let hi = Math.max(...all, 1);
    if (symmetric) {
      const m = Math.max(Math.abs(lo), Math.abs(hi), 1);
      lo = -m;
      hi = m;
    }
    const y = (v: number) => 85 - ((v - lo) / (hi - lo || 1)) * 80;
    ctx.strokeStyle = '#2c4456';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(0)) + 0.5);
    ctx.lineTo(300, Math.round(y(0)) + 0.5);
    ctx.stroke();
    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.data.forEach((v, k) => {
        const x = (k / Math.max(1, s.data.length - 1)) * 298 + 1;
        if (k === 0) ctx.moveTo(x, y(v));
        else ctx.lineTo(x, y(v));
      });
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#8aa';
    ctx.font = '12px sans-serif';
    ctx.fillText('Noch keine Daten', 100, 50);
  }
  return el('div', { class: 'chart-box' }, el('small', {}, title), cv);
}

export function openHelp(): void {
  const body = el(
    'div',
    { class: 'help' },
    el('h3', {}, 'Bedienung'),
    el('ul', {},
      el('li', {}, 'Ein Finger: mit dem Info-Werkzeug die Karte verschieben, mit Bauwerkzeugen bauen (ziehen für Straßen, Leitungen und Zonen).'),
      el('li', {}, 'Zwei Finger: Karte verschieben und zoomen. Die Tasten + und − zoomen ebenfalls.'),
      el('li', {}, 'Zurück-Taste: schließt Fenster, wählt das Info-Werkzeug oder öffnet das Menü.'),
    ),
    el('h3', {}, 'So wächst Ihre Stadt'),
    el('ul', {},
      el('li', {}, 'Bauen Sie ein Kraftwerk und verbinden Sie es mit Stromleitungen. Zonen leiten Strom an benachbarte Zonen weiter.'),
      el('li', {}, 'Weisen Sie Wohn-, Gewerbe- und Industriezonen aus. Jede Zone braucht eine Straße in höchstens drei Feldern Entfernung.'),
      el('li', {}, 'Wohngebiete brauchen Arbeitsplätze (Gewerbe oder Industrie) im selben Straßennetz, oder eine Straße zum Kartenrand.'),
      el('li', {}, 'Die Nachfrage-Anzeige oben (grün Wohnen, blau Gewerbe, gelb Industrie) zeigt, was gebraucht wird.'),
      el('li', {}, 'Leichte Zonen wachsen bis zu Häusern, dichte Zonen bis zu Hochhäusern, wenn Bodenwert und Einwohnerzahl hoch genug sind.'),
      el('li', {}, 'Ab der dritten Stufe brauchen Gebäude Wasser: Wasserpumpen (am Ufer fördern sie mehr) oder Wassertürme bauen, mit Strom versorgen und mit Rohren an die Zonen anschließen. Zonen leiten Wasser wie Strom an Nachbarzonen weiter. Ein blauer Tropfen zeigt Gebäude ohne Wasser.'),
      el('li', {}, 'Polizei, Feuerwehr, Schulen, Krankenhäuser und Parks erhöhen den Bodenwert und senken Kriminalität und Brandgefahr.'),
      el('li', {}, 'Gebäude brauchen ebenen Boden. Das Werkzeug „Einebnen“ unter „Gelände“ hilft bei Hügeln.'),
    ),
    el('h3', {}, 'Schwierigkeit'),
    el('p', {}, 'Leicht, Mittel und Schwer unterscheiden sich in Startkapital, Nachfrage, Unterhaltskosten und Katastrophen. Bleibt die Kasse zu lange im Minus, wird man abgewählt. Im Sandkasten ist Geld unbegrenzt und alles freigeschaltet.'),
  );
  openDialog('Hilfe', body, { wide: true });
}

