// DOM-Hilfen: Elemente, Dialoge, Symbole.

import { hex, PixBuf } from './pix';
import { Sprite } from './sprites';

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style') e.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') e.innerHTML = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export function fmtMoney(v: number): string {
  return `${Math.round(v).toLocaleString('de-DE')} $`;
}

export function fmtNum(v: number): string {
  return Math.round(v).toLocaleString('de-DE');
}

// ---------------- Dialoge ----------------

interface DialogEntry {
  root: HTMLElement;
  onClose?: () => void;
  modal: boolean;
}

const stack: DialogEntry[] = [];

export function dialogCount(): number {
  return stack.length;
}

export function openDialog(title: string, content: HTMLElement, opts: { onClose?: () => void; wide?: boolean; buttons?: [string, () => void][]; noClose?: boolean } = {}): () => void {
  const host = document.getElementById('dialogs')!;
  const close = () => {
    const idx = stack.findIndex((d) => d.root === root);
    if (idx < 0) return;
    stack.splice(idx, 1);
    root.remove();
    opts.onClose?.();
  };
  const btns = opts.buttons?.length
    ? el(
        'div',
        { class: 'dlg-buttons' },
        ...opts.buttons.map(([label, fn]) =>
          el(
            'button',
            {
              class: 'btn',
              onclick: () => {
                fn();
              },
            },
            label,
          ),
        ),
      )
    : null;
  const win = el(
    'div',
    { class: 'window' + (opts.wide ? ' wide' : '') },
    el('div', { class: 'win-title' }, el('span', {}, title), opts.noClose ? null : el('button', { class: 'btn close', onclick: close, 'aria-label': 'Schließen' }, '✕')),
    el('div', { class: 'win-body' }, content),
    btns,
  );
  const root = el('div', { class: 'overlay' }, win);
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root && !opts.noClose) close();
  });
  host.append(root);
  stack.push({ root, onClose: opts.onClose, modal: true });
  return close;
}

/** Schließt den obersten Dialog. Gibt false zurück, wenn keiner offen war. */
export function closeTopDialog(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  const btn = top.root.querySelector<HTMLButtonElement>('.win-title .close');
  if (btn) btn.click();
  else return false;
  return true;
}

export function closeAllDialogs(): void {
  while (stack.length) {
    const d = stack.pop()!;
    d.root.remove();
    d.onClose?.();
  }
}

export function confirmDialog(title: string, text: string, yes: string, onYes: () => void): void {
  let close = () => {};
  close = openDialog(title, el('p', {}, text), {
    buttons: [
      [
        yes,
        () => {
          close();
          onYes();
        },
      ],
      ['Abbrechen', () => close()],
    ],
  });
}

let toastTimer = 0;
export function toast(text: string): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast' });
    document.getElementById('app')!.append(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), 2600);
}

// ---------------- Symbole ----------------

const iconCache = new Map<string, string>();

/** Pixelsymbol aus Zeichenkette. Jede Ziffer/Buchstabe steht für eine Farbe der Palette. */
export function artIcon(key: string, rows: string[], pal: Record<string, string>): string {
  const c = iconCache.get(key);
  if (c) return c;
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const buf = new PixBuf(w, h);
  rows.forEach((r, y) => [...r].forEach((ch, x) => pal[ch] && buf.set(x, y, hex(pal[ch]))));
  const url = buf.toCanvas().toDataURL();
  iconCache.set(key, url);
  return url;
}

export function spriteIcon(key: string, s: Sprite, size = 40, focusY?: number): string {
  const c = iconCache.get(key);
  if (c) return c;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // Inhaltsgrenzen bestimmen
  const sctx = s.cv.getContext('2d')!;
  const d = sctx.getImageData(0, 0, s.cv.width, s.cv.height).data;
  let x0 = s.cv.width;
  let y0 = s.cv.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < s.cv.height; y++)
    for (let x = 0; x < s.cv.width; x++)
      if (d[(y * s.cv.width + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < x0) return '';
  if (focusY !== undefined) y0 = Math.max(y0, focusY);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const fit = Math.min(size / bw, size / bh);
  const scale = fit >= 1 ? Math.floor(fit) : fit;
  const dw = bw * scale;
  const dh = bh * scale;
  ctx.drawImage(s.cv, x0, y0, bw, bh, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
  const url = cv.toDataURL();
  iconCache.set(key, url);
  return url;
}

export function compositeIcon(key: string, layers: { s: Sprite; x: number; y: number }[], w: number, h: number, size = 40): string {
  const c = iconCache.get(key);
  if (c) return c;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  for (const l of layers) ctx.drawImage(l.s.cv, l.x - l.s.ax, l.y - l.s.ay);
  const url = spriteIcon(key + '#c', { cv, ax: 0, ay: 0 }, size);
  iconCache.set(key, url);
  return url;
}

const P = {
  k: '#111111',
  w: '#ffffff',
  g: '#7b7b7b',
  l: '#c3c3c3',
  y: '#f0d030',
  r: '#d02818',
  b: '#2a5ad8',
  G: '#2f9a3a',
  d: '#5a3a1a',
  c: '#60c0e8',
  o: '#e07820',
};

export const ICONS = {
  menu: () => artIcon('menu', ['kkkkkkkkk', '.........', 'kkkkkkkkk', '.........', 'kkkkkkkkk'], P),
  pause: () => artIcon('pause', ['kk.kk', 'kk.kk', 'kk.kk', 'kk.kk', 'kk.kk', 'kk.kk', 'kk.kk'], P),
  play1: () => artIcon('play1', ['k....', 'kk...', 'kkk..', 'kkkk.', 'kkk..', 'kk...', 'k....'], P),
  play2: () => artIcon('play2', ['k...k...', 'kk..kk..', 'kkk.kkk.', 'kkkkkkkk', 'kkk.kkk.', 'kk..kk..', 'k...k...'], P),
  play3: () => artIcon('play3', ['k..k..k..', 'kk.kk.kk.', 'kkkkkkkkk', 'kk.kk.kk.', 'k..k..k..'], P),
  map: () =>
    artIcon('map', ['....GG....', '..GGGbbG..', 'GGGGbbGGGG', '..GGbGGG..', '....GG....'], P),
  query: () =>
    artIcon('query', ['..kkkk....', '.kccccw...', 'kccccccw..', 'kccccccw..', 'kccccccw..', '.kccccw...', '..kkkkkk..', '......kkk.', '.......kkk', '........kk'], P),
  eye: () => artIcon('eye', ['...kkkkk...', '.kkwwwwwkk.', 'kwwwbbbwwwk', 'kwwbbkbbwwk', 'kwwwbbbwwwk', '.kkwwwwwkk.', '...kkkkk...'], P),
  money: () => artIcon('money', ['...k...', '.kkkkk.', 'kGk....', '.kkkk..', '...kGk.', 'kkkkk..', '...k...'], { ...P, k: '#1a6a2a', G: '#1a6a2a' }),
  chart: () => artIcon('chart', ['k.........', 'k......rr.', 'k.....r...', 'k..rrr....', 'k.r.......', 'kkkkkkkkkk'], P),
  disaster: () => artIcon('disaster', ['....y....', '...yoy...', '..yoroy..', '.yorrroy.', 'yorrrrroy', 'yorrrrroy', '.yyyyyyy.'], P),
  save: () => artIcon('save', ['kkkkkkkk', 'kbwwwwbk', 'kbwwwwbk', 'kbbbbbbk', 'kbkkkkbk', 'kbkwwkbk', 'kkkkkkkk'], P),
};
