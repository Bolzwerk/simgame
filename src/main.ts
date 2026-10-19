// Einstieg: Hauptmenü, neues Spiel, Laden.

import { Difficulty, DIFFICULTIES } from './config';
import { Game, openHelp } from './game';
import { Renderer } from './render';
import { Rng } from './rng';
import { deleteGame, loadGame, loadMeta, SLOTS, Slot } from './storage';
import { generateTerrain, TerrainOptions } from './terrain';
import { closeAllDialogs, closeTopDialog, confirmDialog, el, fmtNum, openDialog, toast } from './ui';
import { World } from './world';
import { applyPlan, planTool } from './tools';

const NAMES = ['Neustadt', 'Pixelberg', 'Sonnenfeld', 'Lindenau', 'Bolzhausen', 'Kleinhafen', 'Eichenbrück', 'Wiesental', 'Rotenburg', 'Seeheim', 'Altmühl', 'Bergfelden'];

interface NewGameOpts extends TerrainOptions {
  name: string;
  difficulty: Difficulty;
  size: number;
  seed: number;
}

class App {
  private canvas = document.getElementById('view') as HTMLCanvasElement;
  private screens = document.getElementById('screens')!;
  private game: Game | null = null;
  private preview: { wd: World; r: Renderer; raf: number } | null = null;
  private screen: 'menu' | 'new' | 'game' = 'menu';
  private opts: NewGameOpts = {
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    difficulty: 'medium',
    size: 96,
    seed: (Math.random() * 1e9) | 0,
    water: 1,
    hills: 1,
    river: true,
    trees: 1,
  };

  constructor() {
    window.onAndroidBack = () => this.back();
    window.onAndroidPause = () => this.game?.save('autosave', true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.game?.save('autosave', true);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.back();
    });
    const params = new URLSearchParams(location.search);
    if (params.get('resume') === '1' && loadGame('autosave')) this.loadSlot('autosave');
    else this.showMenu();
  }

  private back(): boolean {
    if (this.game) return this.game.back();
    if (closeTopDialog()) return true;
    if (this.screen === 'new') {
      this.showMenu();
      return true;
    }
    return false;
  }

  // ---------------- Vorschau im Hintergrund ----------------

  private makeWorld(o: NewGameOpts): World {
    const wd = new World(o.size, o.size, o.seed);
    wd.name = o.name;
    wd.difficulty = o.difficulty;
    generateTerrain(wd, o);
    return wd;
  }

  private showPreview(wd: World, slowPan: boolean): void {
    this.stopPreview();
    const r = new Renderer(wd, this.canvas);
    r.resize();
    const W = this.canvas.width;
    const H = this.canvas.height;
    const portrait = H > W * 1.33;
    const dpr = window.devicePixelRatio || 1;
    // Platz neben bzw. über dem Einstellungsfenster nutzen
    const availW = slowPan || portrait ? W : W - 420 * dpr;
    const availH = slowPan || !portrait ? H : H * 0.36;
    const fit = Math.min(availW / r.worldW, availH / (r.worldH - r.OY + 60));
    r.cam.z = Math.max(0.3, Math.min(3, fit * (slowPan ? 2.2 : 0.95)));
    r.centerOn(wd.w / 2, wd.h / 2);
    if (!slowPan && portrait) r.cam.y += (H - availH) / 2 / r.cam.z;
    if (!slowPan && !portrait) r.cam.x -= (W - availW) / 2 / r.cam.z;
    const start = performance.now();
    const loop = (t: number) => {
      if (!this.preview) return;
      r.resize();
      if (slowPan) {
        const a = (t - start) / 26000;
        r.centerOn(wd.w / 2 + Math.cos(a) * wd.w * 0.22, wd.h / 2 + Math.sin(a) * wd.h * 0.22);
      }
      r.frame(t);
      this.preview.raf = requestAnimationFrame(loop);
    };
    this.preview = { wd, r, raf: requestAnimationFrame(loop) };
  }

  private stopPreview(): void {
    if (this.preview) {
      cancelAnimationFrame(this.preview.raf);
      this.preview.wd.onTileChanged = null;
      this.preview = null;
    }
  }

  // ---------------- Bildschirme ----------------

  showMenu(): void {
    this.screen = 'menu';
    if (this.game) {
      this.game.destroy();
      this.game = null;
    }
    closeAllDialogs();
    const demo = this.makeWorld({ ...this.opts, size: 64, seed: 4242, hills: 1, water: 1, river: true, trees: 1 });
    this.showPreview(demo, true);
    const auto = loadMeta('autosave');
    const anySave = SLOTS.some((s) => loadMeta(s));
    const buttons = el(
      'div',
      { class: 'menu-list' },
      auto ? el('button', { class: 'btn menu-item big', onclick: () => this.loadSlot('autosave') }, el('b', {}, 'Weiterspielen'), el('small', {}, `${auto.name} · ${auto.year} · ${fmtNum(auto.pop)} Einw.`)) : null,
      el('button', { class: 'btn menu-item big', onclick: () => this.showNewGame() }, el('b', {}, 'Neues Spiel')),
      anySave ? el('button', { class: 'btn menu-item', onclick: () => this.openLoad() }, 'Spiel laden') : null,
      el('button', { class: 'btn menu-item', onclick: () => openHelp() }, 'Hilfe'),
      window.AndroidBridge ? el('button', { class: 'btn menu-item', onclick: () => window.AndroidBridge!.exit() }, 'Beenden') : null,
    );
    this.screens.innerHTML = '';
    this.screens.append(
      el(
        'div',
        { class: 'screen center' },
        el('div', { class: 'window title-win' }, el('div', { class: 'logo' }, 'PixelPolis'), el('div', { class: 'sub' }, 'Städtebau im Stil der 90er'), buttons),
      ),
    );
  }

  private openLoad(): void {
    const list = el('div', { class: 'menu-list' });
    let close = () => {};
    for (const s of SLOTS) {
      const meta = loadMeta(s);
      if (!meta) continue;
      const when = new Date(meta.savedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
      list.append(
        el(
          'div',
          { class: 'row slot' },
          el(
            'button',
            {
              class: 'btn menu-item grow',
              onclick: () => {
                close();
                this.loadSlot(s);
              },
            },
            el('b', {}, s === 'autosave' ? 'Automatisch gespeichert' : `Platz ${s.slice(4)}`),
            el('small', {}, `${meta.name} · ${meta.difficulty} · ${meta.year} · ${fmtNum(meta.pop)} Einw. · ${when}`),
          ),
          el(
            'button',
            {
              class: 'btn',
              title: 'Löschen',
              onclick: () =>
                confirmDialog('Löschen?', `Spielstand „${meta.name}“ löschen?`, 'Löschen', () => {
                  deleteGame(s);
                  close();
                  this.showMenu();
                }),
            },
            '✕',
          ),
        ),
      );
    }
    close = openDialog('Spiel laden', list);
  }

  private loadSlot(slot: Slot): void {
    const data = loadGame(slot);
    if (!data) {
      toast('Spielstand nicht gefunden.');
      return;
    }
    try {
      const wd = World.deserialize(data);
      this.startGame(wd);
    } catch (e) {
      console.error(e);
      toast('Spielstand ist beschädigt.');
      this.showMenu();
    }
  }

  showNewGame(): void {
    this.screen = 'new';
    closeAllDialogs();
    const o = this.opts;
    const refresh = () => this.showPreview(this.makeWorld(o), false);
    const choice = <T,>(label: string, values: [T, string][], get: () => T, set: (v: T) => void, regen = true, desc?: (v: T) => string) => {
      const row = el('div', { class: 'choice' });
      const d = desc ? el('div', { class: 'desc' }, desc(get())) : null;
      const btns = values.map(([v, l]) =>
        el(
          'button',
          {
            class: 'btn' + (get() === v ? ' on' : ''),
            onclick: () => {
              set(v);
              btns.forEach((b, k) => b.classList.toggle('on', values[k][0] === v));
              if (d && desc) d.textContent = desc(v);
              if (regen) refresh();
            },
          },
          l,
        ),
      );
      row.append(el('label', {}, label), el('div', { class: 'seg' }, ...btns));
      const wrap = el('div', {}, row);
      if (d) wrap.append(d);
      return wrap;
    };
    const name = el('input', { type: 'text', value: o.name, maxlength: 24 }) as HTMLInputElement;
    name.addEventListener('input', () => (o.name = name.value.trim() || 'Neustadt'));
    const body = el(
      'div',
      { class: 'newgame' },
      el('div', { class: 'choice' }, el('label', {}, 'Stadtname'), name),
      choice<Difficulty>(
        'Schwierigkeit',
        [
          ['easy', 'Leicht'],
          ['medium', 'Mittel'],
          ['hard', 'Schwer'],
          ['sandbox', 'Sandkasten'],
        ],
        () => o.difficulty,
        (v) => (o.difficulty = v),
        false,
        (v) => DIFFICULTIES[v].desc,
      ),
      choice<number>('Kartengröße', [[64, 'Klein'], [96, 'Mittel'], [128, 'Groß']], () => o.size, (v) => (o.size = v)),
      choice<number>('Wasser', [[0, 'Wenig'], [1, 'Mittel'], [2, 'Viel']], () => o.water, (v) => (o.water = v)),
      choice<number>('Gelände', [[0, 'Flach'], [1, 'Hügelig'], [2, 'Bergig']], () => o.hills, (v) => (o.hills = v)),
      choice<boolean>('Fluss', [[true, 'Ja'], [false, 'Nein']], () => o.river, (v) => (o.river = v)),
      choice<number>('Wald', [[0, 'Wenig'], [1, 'Mittel'], [2, 'Viel']], () => o.trees, (v) => (o.trees = v)),
      el(
        'div',
        { class: 'row end' },
        el('button', { class: 'btn', onclick: () => this.showMenu() }, 'Zurück'),
        el(
          'button',
          {
            class: 'btn',
            onclick: () => {
              o.seed = (Math.random() * 1e9) | 0;
              refresh();
            },
          },
          'Andere Karte',
        ),
        el('button', { class: 'btn primary', onclick: () => this.startNew() }, 'Stadt gründen'),
      ),
    );
    this.screens.innerHTML = '';
    this.screens.append(el('div', { class: 'screen side' }, el('div', { class: 'window newgame-win' }, el('div', { class: 'win-title' }, el('span', {}, 'Neue Stadt')), el('div', { class: 'win-body' }, body))));
    refresh();
  }

  private startNew(): void {
    const o = this.opts;
    const wd = this.makeWorld(o);
    const d = DIFFICULTIES[o.difficulty];
    wd.funds = o.difficulty === 'sandbox' ? 0 : d.startFunds;
    wd.year = 1950;
    wd.settings.disasters = o.difficulty !== 'sandbox';
    // nächste Karte bekommt neuen Zufall
    this.opts = { ...o, seed: new Rng(o.seed).int(1e9), name: NAMES[Math.floor(Math.random() * NAMES.length)] };
    this.startGame(wd);
  }

  private startGame(wd: World): void {
    this.stopPreview();
    this.screens.innerHTML = '';
    closeAllDialogs();
    if (this.game) this.game.destroy();
    this.screen = 'game';
    this.game = new Game(wd, this.canvas, {
      toMenu: () => this.showMenu(),
      newGame: () => {
        this.game?.destroy();
        this.game = null;
        this.showNewGame();
      },
    });
    this.game.save('autosave', true);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  (window as unknown as Record<string, unknown>).__app = new App();
  // Test-Hilfen für automatisierte Browsertests
  (window as unknown as Record<string, unknown>).__pp = { planTool, applyPlan, World };
});
