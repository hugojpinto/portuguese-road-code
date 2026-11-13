/**
 * Geometry of a 4-arm, two-lane roundabout with two-lane entries and exits.
 * Right-hand traffic → counter-clockwise circulation. Coordinates in metres,
 * y up, origin at the centre. Arm k points at angle φ_k = k·90° (0 = east).
 *
 * For an arm at angle φ with outward unit vector u and CCW tangent t:
 *  - entry carriageway lies on the +t side of the arm axis (right lane farthest out),
 *  - exit carriageway lies on the −t side,
 *  - so a circulating car passes an arm's EXIT first, then its ENTRY.
 */

export const R_OUT = 30; // outer circulating lane centre-line radius
export const R_IN = 26; // inner circulating lane centre-line radius
export const LANE_W = 4;
export const ARM_R = 37; // yield line / exit start, distance from centre
export const APPROACH_LEN = 120;
export const EXIT_LEN = 80;
export const ARMS = 4;
export const RING_R = [R_OUT, R_IN]; // index 0 = outer, 1 = inner
const deg = (d: number) => (d * Math.PI) / 180;
/** angle past the arm axis where entry connectors join the ring [outer, inner] */
export const JOIN = [deg(24), deg(30)];
/** angle before the arm axis where exit connectors leave the ring [outer, inner] */
export const DIVERGE = [deg(22), deg(28)];
const ENTRY_OFF = [7.5, 2.5]; // lateral offset of entry lanes [right, left]
const EXIT_OFF = [7.5, 2.5]; // lateral offset of exit lanes [right (lane 1), left (lane 2)]
/** band half-width: a vehicle centre this close to a ring-lane centre line occupies that lane */
export const BAND = 2.6;
/** extra clearance used for conflict zones (a waiting car's body must stay this far out of the lane) */
const CLEAR = 1.2;

export type PathKind = 'approach' | 'entry' | 'exitCon' | 'exit';

export interface Path {
  id: number;
  kind: PathKind;
  arm: number;
  lane: number; // 0 = right/outer, 1 = left/inner
  xs: Float64Array;
  ys: Float64Array;
  s: Float64Array;
  len: number;
  next: Path | null;
  /** for connectors: arc-length position where the path crosses the outer lane centre-line (if it does) */
  crossOuterS: number;
  crossOuterAng: number;
  /** where the path first enters the inner-lane footprint (entries to the inner lane) */
  crossInnerS: number;
  crossInnerAng: number;
}

export const armAngle = (k: number) => (k * Math.PI) / 2;
export const mod2pi = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function polyline(kind: PathKind, arm: number, lane: number, pts: [number, number][]): Path {
  const n = pts.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0];
    ys[i] = pts[i][1];
    if (i > 0) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const p: Path = { id: 0, kind, arm, lane, xs, ys, s, len: s[n - 1], next: null, crossOuterS: NaN, crossOuterAng: NaN, crossInnerS: NaN, crossInnerAng: NaN };
  // where does it first enter the outer-lane footprint (only for paths that start outside it)?
  if (Math.abs(Math.hypot(xs[0], ys[0]) - R_OUT) >= BAND + CLEAR)
    for (let i = 0; i < n; i++) {
      if (Math.abs(Math.hypot(xs[i], ys[i]) - R_OUT) < BAND + CLEAR) {
        p.crossOuterS = s[i];
        p.crossOuterAng = mod2pi(Math.atan2(ys[i], xs[i]));
        break;
      }
    }
  if (Math.abs(Math.hypot(xs[0], ys[0]) - R_IN) >= BAND + CLEAR)
    for (let i = 0; i < n; i++) {
      if (Math.abs(Math.hypot(xs[i], ys[i]) - R_IN) < BAND + CLEAR) {
        p.crossInnerS = s[i];
        p.crossInnerAng = mod2pi(Math.atan2(ys[i], xs[i]));
        break;
      }
    }
  return p;
}

function bezier(p0: [number, number], d0: [number, number], p3: [number, number], d3: [number, number], k = 0.42, n = 48): [number, number][] {
  const dist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) * k;
  const p1 = [p0[0] + d0[0] * dist, p0[1] + d0[1] * dist];
  const p2 = [p3[0] - d3[0] * dist, p3[1] - d3[1] * dist];
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) ** 3;
    const b = 3 * (1 - t) ** 2 * t;
    const c = 3 * (1 - t) * t * t;
    const d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

export interface Geometry {
  approach: Path[][]; // [arm][lane]
  entry: Path[][]; // [arm][lane] lane 0 → outer ring, lane 1 → inner ring
  exitCon: Path[][]; // [arm][ringLane] ringLane 0 → exit lane 1, ringLane 1 → exit lane 2
  exit: Path[][]; // [arm][lane]
  all: Path[];
  joinAng: number[][]; // [arm][ringLane]
  divergeAng: number[][]; // [arm][ringLane]
}

export function buildGeometry(): Geometry {
  const g: Geometry = { approach: [], entry: [], exitCon: [], exit: [], all: [], joinAng: [], divergeAng: [] };
  for (let k = 0; k < ARMS; k++) {
    const phi = armAngle(k);
    const u: [number, number] = [Math.cos(phi), Math.sin(phi)];
    const t: [number, number] = [-Math.sin(phi), Math.cos(phi)];
    const at = (r: number, off: number): [number, number] => [u[0] * r + t[0] * off, u[1] * r + t[1] * off];
    g.approach[k] = [];
    g.entry[k] = [];
    g.exitCon[k] = [];
    g.exit[k] = [];
    g.joinAng[k] = [];
    g.divergeAng[k] = [];
    for (let l = 0; l < 2; l++) {
      // approach: from far out to the yield line
      const ap = polyline('approach', k, l, [at(ARM_R + APPROACH_LEN, ENTRY_OFF[l]), at(ARM_R, ENTRY_OFF[l])]);
      const ja = phi + JOIN[l];
      const R = RING_R[l];
      const en = polyline('entry', k, l, bezier(at(ARM_R, ENTRY_OFF[l]), [-u[0], -u[1]], [R * Math.cos(ja), R * Math.sin(ja)], [-Math.sin(ja), Math.cos(ja)]));
      ap.next = en;
      const da = phi - DIVERGE[l];
      const xc = polyline('exitCon', k, l, bezier([R * Math.cos(da), R * Math.sin(da)], [-Math.sin(da), Math.cos(da)], at(ARM_R, -EXIT_OFF[l]), u));
      const ex = polyline('exit', k, l, [at(ARM_R, -EXIT_OFF[l]), at(ARM_R + EXIT_LEN, -EXIT_OFF[l])]);
      xc.next = ex;
      g.approach[k][l] = ap;
      g.entry[k][l] = en;
      g.exitCon[k][l] = xc;
      g.exit[k][l] = ex;
      g.joinAng[k][l] = mod2pi(ja);
      g.divergeAng[k][l] = mod2pi(da);
      g.all.push(ap, en, xc, ex);
    }
  }
  g.all.forEach((p, i) => (p.id = i));
  return g;
}

/** Position + heading at arc length s along a path. */
export function pathPose(p: Path, s: number): { x: number; y: number; h: number } {
  const n = p.s.length;
  if (s <= 0) return { x: p.xs[0], y: p.ys[0], h: Math.atan2(p.ys[1] - p.ys[0], p.xs[1] - p.xs[0]) };
  if (s >= p.len) return { x: p.xs[n - 1], y: p.ys[n - 1], h: Math.atan2(p.ys[n - 1] - p.ys[n - 2], p.xs[n - 1] - p.xs[n - 2]) };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (p.s[m] <= s) lo = m;
    else hi = m;
  }
  const f = (s - p.s[lo]) / (p.s[hi] - p.s[lo] || 1);
  return { x: p.xs[lo] + f * (p.xs[hi] - p.xs[lo]), y: p.ys[lo] + f * (p.ys[hi] - p.ys[lo]), h: Math.atan2(p.ys[hi] - p.ys[lo], p.xs[hi] - p.xs[lo]) };
}

/** Separating-axis overlap test for two oriented rectangles (centre, heading, half-length, half-width). */
export function obbOverlap(ax: number, ay: number, ah: number, al: number, aw: number, bx: number, by: number, bh: number, bl: number, bw: number): boolean {
  const axes = [ah, ah + Math.PI / 2, bh, bh + Math.PI / 2];
  const dx = bx - ax;
  const dy = by - ay;
  for (const ang of axes) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const dist = Math.abs(dx * c + dy * s);
    const ra = al * Math.abs(Math.cos(ah - ang)) + aw * Math.abs(Math.sin(ah - ang));
    const rb = bl * Math.abs(Math.cos(bh - ang)) + bw * Math.abs(Math.sin(bh - ang));
    if (dist > ra + rb) return false;
  }
  return true;
}
