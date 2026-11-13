import { cssVar, fitCanvas } from '../shared/ui';
import { ARMS, LANE_W, RING_R, R_IN, R_OUT, type Path } from './geometry';
import { CRASH_LABELS, type RVeh, type RoundaboutSim } from './model';

export const EXIT_COLORS = ['', '#3ccf8e', '#4f8cff', '#f2a93b', '#e86bd0'];
const VIEW = 78; // metres from centre to canvas edge

export class RoundaboutView {
  constructor(private canvas: HTMLCanvasElement) {}

  draw(sim: RoundaboutSim): void {
    const size = Math.min(this.canvas.clientWidth, 760);
    const { w, h, ctx } = fitCanvas(this.canvas, size);
    const sc = Math.min(w, h) / (2 * VIEW);
    const cx = w / 2;
    const cy = h / 2;
    const X = (x: number) => cx + x * sc;
    const Y = (y: number) => cy - y * sc;
    const asphalt = cssVar('--asphalt');
    const mark = cssVar('--marking');
    const muted = cssVar('--muted');
    ctx.clearRect(0, 0, w, h);

    const strokePath = (p: Path, width: number, color: string, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      for (let i = 0; i < p.xs.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.xs[i]), Y(p.ys[i]));
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // roads
    ctx.lineCap = 'butt';
    for (const p of sim.g.all) strokePath(p, LANE_W * sc * 1.05, asphalt);
    // ring
    ctx.fillStyle = asphalt;
    ctx.beginPath();
    ctx.arc(cx, cy, (R_OUT + LANE_W / 2) * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cssVar('--grass');
    ctx.beginPath();
    ctx.arc(cx, cy, (R_IN - LANE_W / 2) * sc, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = mark;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.arc(cx, cy, ((R_IN + R_OUT) / 2) * sc, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // yield lines + approach lane dividers
    for (let k = 0; k < ARMS; k++) {
      const a0 = sim.g.approach[k][0];
      const a1 = sim.g.approach[k][1];
      const e0 = a0.xs.length - 1;
      ctx.strokeStyle = mark;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const ux = a0.xs[e0] - a1.xs[e0];
      const uy = a0.ys[e0] - a1.ys[e0];
      const n = Math.hypot(ux, uy);
      ctx.moveTo(X(a1.xs[e0] - (ux / n) * 2), Y(a1.ys[e0] - (uy / n) * 2));
      ctx.lineTo(X(a0.xs[e0] + (ux / n) * 2), Y(a0.ys[e0] + (uy / n) * 2));
      ctx.stroke();
      ctx.setLineDash([]);
      // queue counters
      const q = sim.queues[k];
      ctx.fillStyle = muted;
      ctx.font = '11px ' + cssVar('--mono');
      // label beside the entry lanes, outside the carriageway
      const phi = (k * Math.PI) / 2;
      const lx = Math.cos(phi) * 58 - Math.sin(phi) * 36;
      const ly = Math.sin(phi) * 58 + Math.cos(phi) * 36;
      const text = `${sim.armLabel(k)} queue  L ${q[1]} · R ${q[0]}`;
      const tw = ctx.measureText(text).width;
      ctx.fillText(text, Math.min(w - tw - 4, Math.max(4, X(lx) - tw / 2)), Math.min(h - 6, Math.max(14, Y(ly))));
    }

    const blink = Math.floor(sim.t * 2.5) % 2 === 0;
    for (const v of sim.vehicles) this.drawVeh(ctx, v, X, Y, sc, blink, sim);

    for (const c of sim.crashes) {
      const age = sim.t - c.t;
      if (age > 40) continue;
      ctx.globalAlpha = Math.max(0.2, 1 - age / 40);
      ctx.strokeStyle = cssVar('--bad');
      ctx.lineWidth = 3;
      const px = X(c.x);
      const py = Y(c.y);
      ctx.beginPath();
      ctx.moveTo(px - 9, py - 9);
      ctx.lineTo(px + 9, py + 9);
      ctx.moveTo(px + 9, py - 9);
      ctx.lineTo(px - 9, py + 9);
      ctx.stroke();
      ctx.fillStyle = cssVar('--bad');
      ctx.font = '11px ' + cssVar('--sans');
      ctx.fillText(c.greyArea ? 'grey-area crash' : CRASH_LABELS[c.type], px + 12, py + 4);
      ctx.globalAlpha = 1;
    }
    void RING_R;
  }

  private drawVeh(ctx: CanvasRenderingContext2D, v: RVeh, X: (x: number) => number, Y: (y: number) => number, sc: number, blink: boolean, sim: RoundaboutSim): void {
    if (Math.abs(v.x) > 80 || Math.abs(v.y) > 80) return;
    ctx.save();
    ctx.translate(X(v.x), Y(v.y));
    ctx.rotate(-v.h);
    const L = v.len * sc;
    const W = v.wid * sc;
    if (v.outerViolator && sim.isPT) {
      ctx.strokeStyle = '#ff5c8a';
      ctx.lineWidth = 2;
      ctx.strokeRect(-L / 2 - 2, -W / 2 - 2, L + 4, W + 4);
    }
    ctx.fillStyle = EXIT_COLORS[v.exitNo];
    ctx.beginPath();
    ctx.roundRect(-L / 2, -W / 2, L, W, 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(L / 2 - 0.45 * L, -W / 2 + 1.5, 0.12 * L, W - 3);
    if ((v.signaling || v.lcLeft > 0) && blink) {
      ctx.fillStyle = '#ffb020';
      const side = v.lcLeft > 0 && v.ringLane > v.lcFrom ? 1 : -1; // right = negative y in local frame
      ctx.fillRect(L / 2 - 4, side > 0 ? -W / 2 - 1 : W / 2 - 2, 4, 3);
      ctx.fillRect(-L / 2, side > 0 ? -W / 2 - 1 : W / 2 - 2, 4, 3);
    }
    if (v.a < -2) {
      ctx.fillStyle = '#ff3b3b';
      ctx.fillRect(-L / 2 - 1.5, -W / 2, 2, W);
    }
    ctx.restore();
  }
}
