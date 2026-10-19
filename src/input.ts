// Touch-, Maus- und Stiftbedienung der Karte.

export interface InputHandlers {
  mode(): 'pan' | 'build';
  tap(px: number, py: number): void;
  buildStart(px: number, py: number): void;
  buildMove(px: number, py: number): void;
  buildEnd(px: number, py: number): void;
  buildCancel(): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, px: number, py: number): void;
  zoomEnd(px: number, py: number): void;
  hover(px: number, py: number): void;
}

interface Ptr {
  x: number;
  y: number;
  sx: number;
  sy: number;
}

export class Input {
  private ptrs = new Map<number, Ptr>();
  private state: 'idle' | 'pending' | 'panning' | 'building' | 'pinch' | 'ending' = 'idle';
  private pinchDist = 0;
  private pinchMid: [number, number] = [0, 0];
  private mousePan = false;

  constructor(
    private el: HTMLElement,
    private h: InputHandlers,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.cancel(e));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.ptrs.size) this.h.hover(-1, -1);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [x, y] = this.pos(e);
        const f = Math.exp(-e.deltaY * 0.0015);
        this.h.zoom(f, x, y);
        this.h.zoomEnd(x, y);
      },
      { passive: false },
    );
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private pos(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
  }

  private down(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    const [x, y] = this.pos(e);
    if (e.pointerType === 'mouse' && e.button !== 0) {
      this.mousePan = true;
      this.ptrs.set(e.pointerId, { x, y, sx: x, sy: y });
      this.state = 'panning';
      return;
    }
    this.ptrs.set(e.pointerId, { x, y, sx: x, sy: y });
    if (this.ptrs.size === 1) {
      if (this.h.mode() === 'build') {
        this.state = 'building';
        this.h.buildStart(x, y);
      } else this.state = 'pending';
    } else if (this.ptrs.size === 2) {
      if (this.state === 'building') this.h.buildCancel();
      this.state = 'pinch';
      const [a, b] = Array.from(this.ptrs.values());
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchMid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    }
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.pos(e);
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse') this.h.hover(x, y);
      return;
    }
    const dx = x - p.x;
    const dy = y - p.y;
    p.x = x;
    p.y = y;
    const dpr = window.devicePixelRatio || 1;
    switch (this.state) {
      case 'pending':
        if (Math.hypot(x - p.sx, y - p.sy) > 10 * dpr) {
          this.state = 'panning';
          this.h.pan(x - p.sx, y - p.sy);
        }
        break;
      case 'panning':
        this.h.pan(dx, dy);
        break;
      case 'building':
        this.h.buildMove(x, y);
        break;
      case 'pinch': {
        if (this.ptrs.size < 2) break;
        const [a, b] = Array.from(this.ptrs.values());
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        this.h.pan(mid[0] - this.pinchMid[0], mid[1] - this.pinchMid[1]);
        if (this.pinchDist > 0) this.h.zoom(d / this.pinchDist, mid[0], mid[1]);
        this.pinchDist = d;
        this.pinchMid = mid;
        break;
      }
    }
  }

  private up(e: PointerEvent): void {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const [x, y] = this.pos(e);
    this.ptrs.delete(e.pointerId);
    if (this.mousePan) {
      this.mousePan = false;
      this.state = 'idle';
      return;
    }
    switch (this.state) {
      case 'pending':
        this.h.tap(x, y);
        this.state = 'idle';
        break;
      case 'building':
        this.h.buildEnd(x, y);
        this.state = 'idle';
        break;
      case 'pinch':
        this.h.zoomEnd(this.pinchMid[0], this.pinchMid[1]);
        this.state = this.ptrs.size ? 'ending' : 'idle';
        break;
      default:
        if (!this.ptrs.size) this.state = 'idle';
    }
  }

  private cancel(e: PointerEvent): void {
    this.ptrs.delete(e.pointerId);
    if (this.state === 'building') this.h.buildCancel();
    if (!this.ptrs.size) this.state = 'idle';
  }
}
