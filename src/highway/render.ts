import { cssVar, fitCanvas } from '../shared/ui';
import { CRASH_LABELS, OFF_END, OFF_START, RAMP_APPROACH, RAMP_END, RAMP_MERGE_START, ROAD_LEN, type HighwaySim, type Veh } from './model';

const STRIP_LEN = 1000;
const STRIPS = ROAD_LEN / STRIP_LEN;
const LANE_PX = 9;
const STRIP_GAP = 22;
const ZOOM_WINDOW = 220; // metres shown in the magnifier

function speedColor(v: number): string {
  // 0 km/h red → 60 amber → 130+ green/teal
  const kmh = v * 3.6;
  const t = Math.max(0, Math.min(1, kmh / 130));
  const hue = 0 + t * 150;
  return `hsl(${hue} 70% 55%)`;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

function lateral(v: Veh): number {
  if (v.lcLeft <= 0) return v.lane;
  const p = smooth(1 - v.lcLeft / v.lcTotal);
  return v.from + (v.lane - v.from) * p;
}

export type ColorMode = 'speed' | 'stress';

export class HighwayView {
  focusX = (RAMP_MERGE_START + RAMP_END) / 2;
  pinned = false;
  colorMode: ColorMode = 'speed';
  constructor(
    private main: HTMLCanvasElement,
    private zoom: HTMLCanvasElement,
  ) {
    const pick = (ev: MouseEvent) => {
      const r = main.getBoundingClientRect();
      const y = ev.clientY - r.top;
      const x = ev.clientX - r.left;
      const stripH = this.stripH;
      const k = Math.floor((y - 6) / stripH);
      if (k < 0 || k >= STRIPS) return null;
      return k * STRIP_LEN + (x / r.width) * STRIP_LEN;
    };
    main.addEventListener('mousemove', (ev) => {
      if (this.pinned) return;
      const x = pick(ev);
      if (x != null) this.focusX = x;
    });
    main.addEventListener('click', (ev) => {
      const x = pick(ev);
      if (x != null) {
        this.focusX = x;
        this.pinned = !this.pinned;
      }
    });
    main.style.cursor = 'crosshair';
  }

  private lanes = 3;
  private get stripH(): number {
    return (this.lanes + 1) * LANE_PX + STRIP_GAP;
  }

  draw(sim: HighwaySim): void {
    this.lanes = sim.p.lanes;
    this.drawOverview(sim);
    this.drawZoom(sim);
  }

  private vehColor(v: Veh): string {
    if (this.colorMode === 'stress') {
      return `hsl(${200 - 200 * v.stress} ${30 + 50 * v.stress}% ${55}%)`;
    }
    return speedColor(v.v);
  }

  private drawOverview(sim: HighwaySim): void {
    const N = sim.p.lanes;
    const H = STRIPS * this.stripH + 10;
    const { w, ctx } = fitCanvas(this.main, H);
    const sx = w / STRIP_LEN;
    const asphalt = cssVar('--asphalt');
    const mark = cssVar('--marking');
    const muted = cssVar('--muted');
    ctx.clearRect(0, 0, w, H);
    ctx.font = '10px ' + cssVar('--mono');
    for (let k = 0; k < STRIPS; k++) {
      const top = 6 + k * this.stripH + 12;
      const x0 = k * STRIP_LEN;
      ctx.fillStyle = muted;
      ctx.fillText(`${(x0 / 1000).toFixed(0)} km`, 2, top - 3);
      // main carriageway
      ctx.fillStyle = asphalt;
      ctx.fillRect(0, top, w, N * LANE_PX);
      // ramp
      const rs = Math.max(RAMP_APPROACH, x0);
      const re = Math.min(RAMP_END, x0 + STRIP_LEN);
      if (re > rs) {
        ctx.fillStyle = cssVar('--asphalt-2');
        ctx.fillRect((rs - x0) * sx, top + N * LANE_PX, (re - rs) * sx, LANE_PX);
        ctx.fillStyle = muted;
        ctx.fillText('on-ramp', (re - x0) * sx - 46, top + (N + 1) * LANE_PX + 10);
      }
      const os = Math.max(OFF_START, x0);
      const oe = Math.min(OFF_END, x0 + STRIP_LEN);
      if (oe > os) {
        ctx.fillStyle = cssVar('--asphalt-2');
        ctx.fillRect((os - x0) * sx, top + N * LANE_PX, (oe - os) * sx, LANE_PX);
        ctx.fillStyle = muted;
        ctx.fillText('off-ramp', (oe - x0) * sx - 50, top + (N + 1) * LANE_PX + 10);
      }
      // lane lines
      ctx.strokeStyle = mark;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      for (let l = 1; l < N; l++) {
        const y = top + l * LANE_PX;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // focus window
      if (this.focusX >= x0 - ZOOM_WINDOW && this.focusX < x0 + STRIP_LEN + ZOOM_WINDOW) {
        ctx.strokeStyle = cssVar('--accent');
        ctx.lineWidth = this.pinned ? 2 : 1;
        ctx.strokeRect((this.focusX - ZOOM_WINDOW / 2 - x0) * sx, top - 2, ZOOM_WINDOW * sx, (N + 1) * LANE_PX + 4);
      }
    }
    // vehicles
    for (const v of sim.vehicles) {
      const k = Math.floor((v.x - v.len / 2) / STRIP_LEN);
      if (k < 0 || k >= STRIPS) continue;
      const top = 6 + k * this.stripH + 12;
      const lat = lateral(v);
      const y = top + (N - 1 - lat) * LANE_PX + 2;
      const x = (v.x - v.len - k * STRIP_LEN) * sx;
      ctx.fillStyle = this.vehColor(v);
      ctx.fillRect(x, y, Math.max(2.5, v.len * sx), LANE_PX - 4);
      if (v.pressuring) {
        ctx.fillStyle = '#fff6a0';
        ctx.fillRect(x + v.len * sx, y - 1, 2, LANE_PX - 2);
      }
    }
    // crashes
    for (const c of sim.crashes) {
      const age = sim.t - c.t;
      if (age > 60) continue;
      const k = Math.floor(c.x / STRIP_LEN);
      if (k < 0 || k >= STRIPS) continue;
      const top = 6 + k * this.stripH + 12;
      const y = top + (N - 1 - c.lane) * LANE_PX + LANE_PX / 2;
      const x = (c.x - k * STRIP_LEN) * sx;
      ctx.globalAlpha = Math.max(0.15, 1 - age / 60);
      ctx.strokeStyle = cssVar('--bad');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawZoom(sim: HighwaySim): void {
    const N = sim.p.lanes;
    const LP = 34; // lane px in zoom
    const H = (N + 1) * LP + 40;
    const { w, ctx } = fitCanvas(this.zoom, H);
    const x0 = this.focusX - ZOOM_WINDOW / 2;
    const s = w / ZOOM_WINDOW;
    const top = 22;
    const blink = Math.floor(sim.t * 2.5) % 2 === 0;
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = cssVar('--asphalt');
    ctx.fillRect(0, top, w, N * LP);
    const rampVisible = (a: number, b: number) => [Math.max(a, x0), Math.min(b, x0 + ZOOM_WINDOW)];
    for (const [a, b] of [rampVisible(RAMP_APPROACH, RAMP_END), rampVisible(OFF_START, OFF_END)]) {
      if (b > a) {
        ctx.fillStyle = cssVar('--asphalt-2');
        ctx.fillRect((a - x0) * s, top + N * LP, (b - a) * s, LP);
      }
    }
    ctx.strokeStyle = cssVar('--marking');
    ctx.lineWidth = 2;
    ctx.setLineDash([18, 24]);
    ctx.lineDashOffset = x0 * s;
    for (let l = 1; l < N; l++) {
      ctx.beginPath();
      ctx.moveTo(0, top + l * LP);
      ctx.lineTo(w, top + l * LP);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(w, top);
    ctx.moveTo(0, top + N * LP);
    ctx.lineTo(w, top + N * LP);
    ctx.stroke();
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px ' + cssVar('--mono');
    ctx.fillText(`magnifier · ${(x0 / 1000).toFixed(2)}–${((x0 + ZOOM_WINDOW) / 1000).toFixed(2)} km · ${this.pinned ? 'pinned (click to release)' : 'hover the road above, click to pin'}`, 4, 14);
    for (let l = 0; l < N; l++) ctx.fillText(l === 0 ? 'right lane' : l === N - 1 ? 'left lane' : `lane ${l + 1}`, 4, top + (N - 1 - l) * LP + LP - 4);

    for (const v of sim.vehicles) {
      if (v.x < x0 - 5 || v.x - v.len > x0 + ZOOM_WINDOW + 5) continue;
      const lat = lateral(v);
      const cy = top + (N - 1 - lat) * LP + LP / 2;
      const xr = (v.x - v.len - x0) * s;
      const len = v.len * s;
      const wid = (v.truck ? 2.5 : 1.8) * s;
      // stress halo
      if (v.stress > 0.2) {
        ctx.fillStyle = `rgba(255,120,60,${0.35 * v.stress})`;
        ctx.beginPath();
        ctx.ellipse(xr + len / 2, cy, len / 2 + 6, wid / 2 + 6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      // headlight flash
      if (v.pressuring && blink) {
        ctx.fillStyle = 'rgba(255,246,160,0.55)';
        ctx.beginPath();
        ctx.moveTo(xr + len, cy - wid / 3);
        ctx.lineTo(xr + len + 40, cy - wid);
        ctx.lineTo(xr + len + 40, cy + wid);
        ctx.lineTo(xr + len, cy + wid / 3);
        ctx.fill();
      }
      ctx.fillStyle = this.vehColor(v);
      ctx.beginPath();
      ctx.roundRect(xr, cy - wid / 2, len, wid, 3);
      ctx.fill();
      // windscreen
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(xr + len - (v.truck ? 2.2 : 1.6) * s, cy - wid / 2 + 2, 0.5 * s, wid - 4);
      // blinker
      if (v.lcLeft > 0 && blink) {
        ctx.fillStyle = '#ffb020';
        const yb = v.lane > v.from ? cy - wid / 2 - 2 : cy + wid / 2 - 2;
        ctx.fillRect(xr, yb, 6, 4);
        ctx.fillRect(xr + len - 6, yb, 6, 4);
      }
      // brake lights
      if (v.a < -2) {
        ctx.fillStyle = '#ff3b3b';
        ctx.fillRect(xr - 2, cy - wid / 2 + 1, 3, 4);
        ctx.fillRect(xr - 2, cy + wid / 2 - 5, 3, 4);
      }
      if (v.lapse > 0) {
        ctx.fillStyle = cssVar('--text');
        ctx.font = '10px ' + cssVar('--mono');
        ctx.fillText('zz', xr + len / 2 - 6, cy - wid / 2 - 3);
      }
    }
    for (const c of sim.crashes) {
      const age = sim.t - c.t;
      if (age > 60 || c.x < x0 || c.x > x0 + ZOOM_WINDOW) continue;
      const cx = (c.x - x0) * s;
      const cy = top + (N - 1 - c.lane) * LP + LP / 2;
      ctx.globalAlpha = Math.max(0.2, 1 - age / 60);
      ctx.strokeStyle = cssVar('--bad');
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - 10, cy - 10);
      ctx.lineTo(cx + 10, cy + 10);
      ctx.moveTo(cx + 10, cy - 10);
      ctx.lineTo(cx - 10, cy + 10);
      ctx.stroke();
      ctx.fillStyle = cssVar('--bad');
      ctx.font = '11px ' + cssVar('--sans');
      ctx.fillText(CRASH_LABELS[c.type], cx + 14, cy + 4);
      ctx.globalAlpha = 1;
    }
  }
}
