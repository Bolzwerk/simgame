// Übersichtskarte in Rautenform.

import { HH, HW, NET_POWER, NET_ROAD, Zone } from './config';
import type { Overlay, Renderer } from './render';
import { World } from './world';

export class Minimap {
  visible = false;
  private tiles: HTMLCanvasElement;
  private img: ImageData;
  private at = -1e9;
  private sx: number;
  private sy: number;
  private ox: number;

  constructor(
    private wd: World,
    private r: Renderer | null,
    private cv: HTMLCanvasElement,
  ) {
    this.tiles = document.createElement('canvas');
    this.tiles.width = wd.w;
    this.tiles.height = wd.h;
    this.img = this.tiles.getContext('2d')!.createImageData(wd.w, wd.h);
    this.sx = cv.width / (wd.w + wd.h);
    this.sy = this.sx / 2;
    this.ox = wd.h * this.sx;
  }

  invalidate(): void {
    this.at = -1e9;
  }

  update(t: number, overlay: Overlay | null): void {
    if (!this.visible) return;
    if (t - this.at < 1000) {
      this.drawView();
      return;
    }
    this.at = t;
    this.paintTiles(overlay);
    this.drawView();
  }

  paintTiles(overlay: Overlay | null = null): void {
    const wd = this.wd;
    const d = this.img.data;
    for (let i = 0; i < wd.w * wd.h; i++) {
      let c: [number, number, number];
      const h = wd.minH(i);
      if (wd.isWater(i)) c = [40, 80, 170];
      else if (wd.fire[i]) c = [255, 80, 20];
      else if (wd.net[i] & NET_ROAD) c = [70, 70, 74];
      else if (wd.zone[i]) {
        const L = wd.level[i];
        const base: Record<number, [number, number, number]> = { [Zone.R]: [70, 190, 70], [Zone.C]: [70, 120, 220], [Zone.I]: [220, 180, 50] };
        const b = base[wd.zone[i]];
        const f = L ? 1 - L * 0.12 : 1.15;
        c = [b[0] * f, b[1] * f, b[2] * f];
      } else if (wd.bld[i]) c = [170, 160, 180];
      else if (wd.net[i] & NET_POWER) c = [150, 120, 80];
      else if (wd.rubble[i]) c = [120, 90, 60];
      else if (wd.tree[i]) c = [30, 90 + h * 4, 30];
      else c = [80 + h * 6, 140 + h * 6, 60];
      if (overlay) {
        let v = -1;
        if (overlay === 'landValue') v = wd.landValue[i];
        else if (overlay === 'pollution') v = 255 - wd.pollution[i];
        else if (overlay === 'crime') v = 255 - wd.crime[i];
        else if (overlay === 'traffic') v = wd.isRoad(i) ? 255 - wd.traffic[i] : -1;
        else if (overlay === 'police') v = wd.covPolice[i];
        else if (overlay === 'fire') v = wd.covFire[i];
        else if (overlay === 'edu') v = wd.covEdu[i];
        else if (overlay === 'health') v = wd.covHealth[i];
        else if (overlay === 'power') v = wd.isConductor(i) ? (wd.powered[i] ? 255 : 0) : -1;
        else if (overlay === 'water') v = wd.isWaterConductor(i) ? (wd.watered[i] ? 255 : 0) : -1;
        if (v >= 0 && !wd.isWater(i)) {
          const t = v / 255;
          c = [230 - t * 170, 60 + t * 160, 50];
        } else if (!wd.isWater(i)) c = [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5];
      }
      d[i * 4] = c[0];
      d[i * 4 + 1] = c[1];
      d[i * 4 + 2] = c[2];
      d[i * 4 + 3] = 255;
    }
    this.tiles.getContext('2d')!.putImageData(this.img, 0, 0);
  }

  drawView(): void {
    const ctx = this.cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1a2b';
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(this.sx, this.sy, -this.sx, this.sy, this.ox, 0);
    ctx.drawImage(this.tiles, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const r = this.r;
    if (!r) return;
    const [x0, y0] = r.screenToWorld(0, 0);
    const [x1, y1] = r.screenToWorld(r.canvas.width, r.canvas.height);
    const mx = (wx: number) => ((wx - r.OX) / HW) * this.sx + this.ox;
    const my = (wy: number) => ((wy - r.OY) / HH) * this.sy;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(mx(x0)) + 0.5, Math.round(my(y0)) + 0.5, Math.round(mx(x1) - mx(x0)), Math.round(my(y1) - my(y0)));
  }

  tileAt(px: number, py: number): [number, number] | null {
    const rx = (px - this.ox) / this.sx;
    const ry = py / this.sy;
    const x = (ry + rx) / 2;
    const y = (ry - rx) / 2;
    if (x < 0 || y < 0 || x >= this.wd.w || y >= this.wd.h) return null;
    return [x, y];
  }
}
