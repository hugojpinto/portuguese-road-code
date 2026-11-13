/**
 * Two-lane roundabout micro-simulation.
 *
 * Vehicles live either on a Path (approach, entry connector, exit connector,
 * exit lane) or on the circulating ring (lane 0 = outer, 1 = inner) where they
 * are tracked by an unwrapped angle θ.
 *
 * Who is "in" a ring lane is decided purely by GEOMETRY: any vehicle whose
 * centre is within BAND of the lane centre-line occupies it. So a car cutting
 * across the outer lane from the inner one is seen by outer-lane drivers as a
 * car in their lane, at exactly the place it physically is. Collisions are
 * detected with oriented-rectangle overlap, so no conflict type is scripted:
 * they all emerge from where cars actually are.
 */
import { Rng } from '../shared/rng';
import {
  DEFAULT_HUMAN,
  MAX_BRAKE,
  idmAccel,
  missProbability,
  newHumanState,
  stepAttention,
  type HumanFactors,
  type HumanState,
  type IdmParams,
  type MissContext,
} from '../shared/driver';
import { ARMS, BAND, RING_R, R_IN, R_OUT, armAngle, buildGeometry, mod2pi, obbOverlap, pathPose, type Geometry, type Path } from './geometry';

export type RoundaboutRule = 'pt2014' | 'pt2014_ideal' | 'lane_integrity';

export interface RoundaboutParams {
  rule: RoundaboutRule;
  seed: number;
  warmup: number;
  /** veh/h per arm on the main road (east & west arms) */
  demandMain: number;
  /** veh/h per arm on the side road (north & south arms) */
  demandSide: number;
  /** turning split: 1st exit (right), 2nd (straight), 3rd (left), 4th (U-turn) */
  turns: [number, number, number, number];
  /** PT rule: share of drivers who follow it (the rest keep the old habit: lane by queue, stay in lane) */
  compliance: number;
  /** PT rule: share of drivers who exit directly from the inner lane into exit lane 2 */
  cutAcrossShare: number;
  /** PT rule: share of drivers who take the empty right lane when the left queue is long, then stay in the outer lane */
  queueJumpShare: number;
  /** PT rule: chance an inner-lane exiter assumes an un-signalled outer-lane car will exit "because it must" */
  ruleTrust: number;
  /** share of drivers who signal before exiting */
  signalShare: number;
  /** share of drivers who signal misleadingly (blinker left on / signal one exit early) */
  falseSignalShare: number;
  human: HumanFactors;
}

export const DEFAULT_ROUNDABOUT: RoundaboutParams = {
  rule: 'pt2014',
  seed: 1,
  warmup: 300,
  demandMain: 600,
  demandSide: 400,
  turns: [0.25, 0.45, 0.25, 0.05],
  compliance: 0.75,
  cutAcrossShare: 0.25,
  queueJumpShare: 0.2,
  ruleTrust: 0.6,
  signalShare: 0.7,
  falseSignalShare: 0.04,
  human: { ...DEFAULT_HUMAN },
};

const DT = 0.1;
const V_RING = [8.6, 7.6]; // comfortable circulating speeds outer / inner (≈31 / 27 km/h)
const V_CONNECTOR = 8.2;
const RING_LC_DUR = 1.8;
const ZONE_HALF = 3.5; // m of ring arc either side of a conflict point that a crossing/merging car occupies
const ZONE_LEN = 9; // m of my own path spent inside a conflict zone
const PERCEPTION_MEMORY = 2;

export type Phase = 'approach' | 'entry' | 'ring' | 'exitCon' | 'exit';
export type CrashType = 'entry' | 'ring_lane_change' | 'exit_cut_across' | 'rear_end' | 'other';
export const CRASH_LABELS: Record<CrashType, string> = {
  entry: 'Entering car vs circulating car',
  ring_lane_change: 'Lane change inside the roundabout',
  exit_cut_across: 'Inner-lane exiter vs outer-lane car',
  rear_end: 'Rear-end',
  other: 'Other',
};

export interface RVeh extends HumanState {
  id: number;
  len: number;
  wid: number;
  idm: IdmParams;
  reaction: number;
  rbuf: number[];
  ridx: number;
  v: number;
  a: number;
  origin: number;
  exitNo: number; // 1..4
  exitArm: number;
  phase: Phase;
  path: Path | null;
  s: number;
  ringLane: number;
  theta: number; // unwrapped angle on the ring
  thetaTarget: number; // unwrapped angle at which to leave the ring (from current exit lane)
  lcLeft: number;
  lcFrom: number;
  /** ring lane the vehicle intends to leave the ring from */
  exitFrom: number;
  /** PT: wants to move from inner to outer before the exit */
  mergeOut: boolean;
  compliant: boolean;
  cutter: boolean;
  jumper: boolean;
  signals: boolean;
  falseSignal: boolean;
  signaling: boolean;
  cleared: boolean;
  committed: boolean;
  /** distance ahead (along my route) at which I must stop to give way; Infinity = go */
  hold: number;
  yieldWait: number;
  goArounds: number;
  /** violates the PT "outer lane must exit at next exit" rule right now */
  outerViolator: boolean;
  checks: Map<number, [number, boolean]>;
  // pose
  x: number;
  y: number;
  h: number;
  r: number;
  ang: number;
  // bookkeeping
  tSpawn: number;
  freeTime: number;
  inConflict: Set<number>;
  hardBraking: boolean;
  dead: boolean;
}

export interface RCrash {
  t: number;
  x: number;
  y: number;
  type: CrashType;
  greyArea: boolean;
  inLaneVictim: boolean;
  miss: boolean;
  debug?: string;
}

export interface RCounters {
  spawned: number;
  finished: number;
  delaySum: number;
  crashes: Record<CrashType, number>;
  greyArea: number;
  inLaneVictim: number;
  ringLc: number;
  cutAcross: number;
  innerExits: number;
  goArounds: number;
  conflicts: number;
  hardBrakes: number;
  entriesRight: number;
  entriesLeft: number;
  queueSamples: number;
  queueLeftSum: number;
  queueRightSum: number;
  queueMax: number;
  unusedRightSec: number;
  armSeconds: number;
  pendingWaitSum: number;
}

function zero(): RCounters {
  return {
    spawned: 0,
    finished: 0,
    delaySum: 0,
    crashes: { entry: 0, ring_lane_change: 0, exit_cut_across: 0, rear_end: 0, other: 0 },
    greyArea: 0,
    inLaneVictim: 0,
    ringLc: 0,
    cutAcross: 0,
    innerExits: 0,
    goArounds: 0,
    conflicts: 0,
    hardBrakes: 0,
    entriesRight: 0,
    entriesLeft: 0,
    queueSamples: 0,
    queueLeftSum: 0,
    queueRightSum: 0,
    queueMax: 0,
    unusedRightSec: 0,
    armSeconds: 0,
    pendingWaitSum: 0,
  };
}

interface Occupant {
  v: RVeh;
  ang: number;
}

type Traits = Pick<RVeh, 'len' | 'wid' | 'idm' | 'reaction' | 'exitNo' | 'compliant' | 'cutter' | 'jumper' | 'signals' | 'falseSignal'> & HumanState;

export class RoundaboutSim {
  readonly p: RoundaboutParams;
  readonly g: Geometry;
  t = 0;
  vehicles: RVeh[] = [];
  crashes: RCrash[] = [];
  c: RCounters = zero();
  private arr: Rng;
  private beh: Rng;
  private nextId = 1;
  private nextArrival: number[] = [];
  private pending: { tr: Traits; t: number }[][] = [];
  private onPath = new Map<number, RVeh[]>();
  private occ: Occupant[][] = [[], []];
  private lastSample = 0;
  queues: number[][] = [];

  constructor(params: RoundaboutParams) {
    const p = structuredClone(params);
    if (p.rule === 'pt2014_ideal') {
      p.compliance = 1;
      p.cutAcrossShare = 0;
      p.queueJumpShare = 0;
    }
    if (p.rule === 'lane_integrity') {
      p.compliance = 1;
      p.cutAcrossShare = 0;
      p.queueJumpShare = 0;
    }
    this.p = p;
    this.g = buildGeometry();
    const root = new Rng(p.seed);
    this.arr = root.fork(11);
    this.beh = root.fork(12);
    for (let k = 0; k < ARMS; k++) {
      this.nextArrival.push(this.arr.exponential(this.rate(k)));
      this.pending.push([]);
      this.queues.push([0, 0]);
    }
  }

  private rate(k: number): number {
    return Math.max(1e-6, (k % 2 === 0 ? this.p.demandMain : this.p.demandSide) / 3600);
  }

  get measuring(): boolean {
    return this.t >= this.p.warmup;
  }

  resetCounters(): void {
    this.c = zero();
    this.crashes = [];
  }

  get isPT(): boolean {
    return this.p.rule !== 'lane_integrity';
  }

  // ---------------------------------------------------------------- spawning
  private traits(): Traits {
    const r = this.arr;
    const p = this.p;
    const u = r.next();
    const tot = p.turns.reduce((a, b) => a + b, 0);
    let acc = 0;
    let exitNo = 4;
    for (let i = 0; i < 4; i++) {
      acc += p.turns[i] / tot;
      if (u < acc) {
        exitNo = i + 1;
        break;
      }
    }
    const big = r.chance(0.05);
    const compliant = r.chance(p.compliance);
    const cutter = r.chance(p.cutAcrossShare);
    const jumper = r.chance(p.queueJumpShare);
    const signals = r.chance(p.signalShare);
    const falseSignal = r.chance(p.falseSignalShare);
    const v0 = r.normal(13.9, 1.5);
    const T = r.uniform(1.0, 1.6);
    const reaction = r.uniform(p.human.reactionMin, p.human.reactionMax);
    const hs = newHumanState(r, p.human);
    return {
      ...hs,
      len: big ? 10 : 4.5,
      wid: big ? 2.5 : 1.8,
      idm: { v0, T, a: big ? 1.0 : 1.6, b: 2.0, s0: 2 },
      reaction,
      exitNo,
      compliant,
      cutter,
      jumper,
      signals,
      falseSignal,
    };
  }

  /** Queue length (stopped/crawling vehicles near the yield line) for an approach lane. */
  private queueLen(arm: number, lane: number): number {
    const list = this.onPath.get(this.g.approach[arm][lane].id) ?? [];
    let n = 0;
    for (const v of list) if (v.v < 3 && v.s > this.g.approach[arm][lane].len - 100) n++;
    return n;
  }

  private chooseEntryLane(tr: Traits, arm: number): number {
    const qL = this.queues[arm][1];
    const qR = this.queues[arm][0];
    if (tr.exitNo === 1) return 0;
    const habit = () => (tr.exitNo === 2 ? (qR <= qL ? 0 : 1) : 1);
    if (this.p.rule === 'lane_integrity') return habit();
    // PT 2014: exit 2+ must use the left lane…
    if (!tr.compliant) return habit();
    if (tr.jumper && qL - qR >= 3) return 0; // …unless you are a queue jumper
    return 1;
  }

  private spawn(): void {
    for (let k = 0; k < ARMS; k++) {
      while (this.t >= this.nextArrival[k]) {
        this.pending[k].push({ tr: this.traits(), t: this.nextArrival[k] });
        this.nextArrival[k] += this.arr.exponential(this.rate(k));
      }
      while (this.pending[k].length) {
        const { tr, t } = this.pending[k][0];
        const lane = this.chooseEntryLane(tr, k);
        const path = this.g.approach[k][lane];
        const list = this.onPath.get(path.id) ?? [];
        const last = list[0];
        if (last && last.s - last.len < 8) break; // no room: wait upstream
        this.pending[k].shift();
        const v: RVeh = {
          ...tr,
          id: this.nextId++,
          rbuf: new Array(Math.max(1, Math.round(tr.reaction / DT))).fill(0),
          ridx: 0,
          v: last ? Math.min(tr.idm.v0, last.v) : tr.idm.v0,
          a: 0,
          origin: k,
          exitArm: (k + tr.exitNo) % ARMS,
          phase: 'approach',
          path,
          s: 0,
          ringLane: lane,
          theta: 0,
          thetaTarget: 0,
          lcLeft: 0,
          lcFrom: lane,
          exitFrom: lane,
          mergeOut: false,
          signaling: false,
          cleared: false,
          committed: false,
          hold: Infinity,
          yieldWait: 0,
          goArounds: 0,
          outerViolator: false,
          checks: new Map(),
          x: 0,
          y: 0,
          h: 0,
          r: 999,
          ang: 0,
          tSpawn: t,
          freeTime: 0,
          inConflict: new Set(),
          hardBraking: false,
          dead: false,
        };
        if (this.measuring) {
          this.c.spawned++;
          this.c.pendingWaitSum += this.t - t;
          if (lane === 0) this.c.entriesRight++;
          else this.c.entriesLeft++;
        }
        list.unshift(v);
        this.onPath.set(path.id, list);
        this.vehicles.push(v);
        this.pose(v);
      }
    }
  }

  // ---------------------------------------------------------------- geometry helpers
  ringRadius(v: RVeh): number {
    if (v.lcLeft > 0) {
      const f = 1 - v.lcLeft / RING_LC_DUR;
      const sm = f * f * (3 - 2 * f);
      return RING_R[v.lcFrom] + (RING_R[v.ringLane] - RING_R[v.lcFrom]) * sm;
    }
    return RING_R[v.ringLane];
  }

  private pose(v: RVeh): void {
    if (v.phase === 'ring') {
      const r = this.ringRadius(v);
      v.x = r * Math.cos(v.theta);
      v.y = r * Math.sin(v.theta);
      v.h = v.theta + Math.PI / 2;
      if (v.lcLeft > 0) v.h += (RING_R[v.ringLane] < RING_R[v.lcFrom] ? 1 : -1) * 0.12;
    } else if (v.path) {
      const q = pathPose(v.path, v.s);
      v.x = q.x;
      v.y = q.y;
      v.h = q.h;
    }
    v.r = Math.hypot(v.x, v.y);
    v.ang = mod2pi(Math.atan2(v.y, v.x));
  }

  private rebuild(): void {
    this.onPath.clear();
    this.occ[0].length = 0;
    this.occ[1].length = 0;
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.phase !== 'ring' && v.path) {
        const l = this.onPath.get(v.path.id);
        if (l) l.push(v);
        else this.onPath.set(v.path.id, [v]);
      }
      if (v.phase === 'entry' || v.phase === 'ring' || v.phase === 'exitCon') {
        // circulating drivers react to a car nosing into their lane slightly before it is fully in it
        const band = v.phase === 'ring' || v.hold < Infinity || v.v < 2 ? BAND : BAND + 1;
        for (let l = 0; l < 2; l++) if (Math.abs(v.r - RING_R[l]) < band) this.occ[l].push({ v, ang: v.ang });
      }
    }
    for (const l of this.onPath.values()) l.sort((a, b) => a.s - b.s);
  }

  /** Nearest occupant ahead (CCW) of angle `ang` in ring lane l, excluding `me`. */
  private ringLeader(l: number, ang: number, me: RVeh, maxArc = 60): { o: RVeh; arc: number } | null {
    let best: RVeh | null = null;
    let bestD = Infinity;
    const R = RING_R[l];
    for (const o of this.occ[l]) {
      if (o.v === me) continue;
      const d = mod2pi(o.ang - ang);
      if (d > Math.PI) continue;
      const arc = d * R;
      if (arc < bestD && arc < maxArc) {
        bestD = arc;
        best = o.v;
      }
    }
    return best ? { o: best, arc: bestD } : null;
  }

  private followAccel(me: RVeh, leader: RVeh, centreDist: number, vLimit: number): number {
    const gap = centreDist - (me.len + leader.len) / 2;
    const dv = me.v - leader.v;
    const gapPred = gap - me.reaction * dv;
    return idmAccel(me.v, Math.min(gap, gapPred), dv, me.idm, vLimit);
  }

  /** Leader along own path chain (approach→entry, exitCon→exit). */
  private pathLeader(me: RVeh): { o: RVeh; dist: number } | null {
    if (!me.path) return null;
    const list = this.onPath.get(me.path.id) ?? [];
    const i = list.indexOf(me);
    if (i >= 0 && i + 1 < list.length) return { o: list[i + 1], dist: list[i + 1].s - me.s };
    let p: Path | null = me.path.next;
    let base = me.path.len - me.s;
    while (p && base < 80) {
      const l = this.onPath.get(p.id);
      if (l && l.length) return { o: l[0], dist: base + l[0].s };
      base += p.len;
      p = p.next;
    }
    return null;
  }

  // ---------------------------------------------------------------- perception
  private perceive(me: RVeh, o: RVeh, ctx: MissContext): boolean {
    const prev = me.checks.get(o.id);
    if (prev && this.t - prev[0] < PERCEPTION_MEMORY) return prev[1];
    const seen = !this.beh.chance(missProbability(me, this.p.human, ctx));
    me.checks.set(o.id, [this.t, seen]);
    return seen;
  }

  /** Does `me` believe `o` will leave the ring before reaching angle `atAng`? */
  private believesExits(me: RVeh, o: RVeh, armOfConflict: number): boolean {
    const key = -o.id; // separate sticky slot for the "belief" draw
    const prev = me.checks.get(key);
    if (prev && this.t - prev[0] < 3) return prev[1];
    let p: number;
    if (o.signaling) p = 0.9;
    else if (this.isPT && o.ringLane === 0 && o.lcLeft <= 0) p = this.p.ruleTrust; // "the outer lane must exit"
    else p = 0.03;
    const b = this.beh.chance(p);
    me.checks.set(key, [this.t, b]);
    void armOfConflict;
    return b;
  }

  /** Time to cover `dist` from speed v accelerating at the driver's max acceleration up to vMax. */
  private arrivalTime(v: RVeh, dist: number, vMax = V_CONNECTOR): number {
    const a = v.idm.a;
    const v0 = Math.min(v.v, vMax);
    const tAcc = (vMax - v0) / a;
    const dAcc = v0 * tAcc + 0.5 * a * tAcc * tAcc;
    if (dist <= dAcc) return (-v0 + Math.sqrt(v0 * v0 + 2 * a * dist)) / a + (v.v < 1 ? 0.8 : 0);
    return tAcc + (dist - dAcc) / vMax + (v.v < 1 ? 0.8 : 0);
  }

  /**
   * Gap acceptance at a conflict point in ring lane l at angle `cAng`, which I
   * will reach in tMe seconds. Returns true if (as far as I can tell) it's safe.
   */
  /**
   * Conflict-zone gap acceptance (SUMO-style). The zone is ±ZONE_HALF metres of
   * ring arc around angle `cAng` in ring lane l. I will occupy it from tIn to
   * tOut (s from now). It's OK if no priority car's occupancy window overlaps
   * mine, widened by safety margins. Once committed, smaller margins apply
   * (hysteresis), so a driver only aborts for a real threat.
   */
  private gapOk(me: RVeh, l: number, cAng: number, tIn: number, tOut: number, ignoreExitersAtArm: number | null, committed = false): boolean {
    const R = RING_R[l];
    const lead = committed ? 0.3 : 1.0; // other car must be gone this long before I enter
    const lag = committed ? 0.6 : 1.6; // and arrive at least this long after I've cleared
    for (const oc of this.occ[l]) {
      const o = oc.v;
      if (o === me || o.phase === 'exitCon' || (o.phase === 'entry' && o.origin === me.origin)) continue;
      const up = mod2pi(cAng - oc.ang);
      const arcUp = up > Math.PI ? (up - 2 * Math.PI) * R : up * R; // negative = already past the zone centre
      if (arcUp > 70) continue;
      // o occupies the zone while its body overlaps [−ZONE_HALF, +ZONE_HALF] around cAng
      const front = arcUp - o.len / 2 - ZONE_HALF; // distance until it enters
      const back = arcUp + o.len / 2 + ZONE_HALF; // distance until it has left
      if (back <= 0) continue; // already through
      const t1 = Math.max(0, front) / Math.max(o.v, 3);
      const t2 = back / Math.max(o.v, 0.5);
      if (t1 > tOut + lag || t2 < tIn - lead) continue;
      // I'd conflict with it, if I notice it and don't think it's leaving first
      const rel = (mod2pi(oc.ang - me.ang) > Math.PI ? -1 : 1) * Math.min(mod2pi(oc.ang - me.ang), mod2pi(me.ang - oc.ang)) * R;
      const ctx: MissContext = me.phase === 'ring' && rel < me.len * 0.3 && rel > -8 ? 'blind_spot' : o.v - me.v > 3 ? 'fast_approach' : 'normal';
      if (!this.perceive(me, o, ctx)) continue;
      if (ignoreExitersAtArm !== null && o.phase === 'ring' && front > 0) {
        // a signal only means "leaving before my conflict point" if that exit still lies between the car and the zone
        const div = this.g.divergeAng[ignoreExitersAtArm][o.ringLane];
        const canStillExit = mod2pi(div - oc.ang) < up;
        if (canStillExit && this.believesExits(me, o, ignoreExitersAtArm)) continue;
      }
      return false;
    }
    return true;
  }


  // ---------------------------------------------------------------- decisions
  private enterRing(v: RVeh): void {
    const l = v.path!.lane;
    v.hold = Infinity;
    v.phase = 'ring';
    v.ringLane = l;
    v.theta = this.g.joinAng[v.origin][l];
    this.planExit(v);
    v.path = null;
  }

  /** Decide from which ring lane to exit and where to merge, given the rule. */
  private planExit(v: RVeh): void {
    const l = v.ringLane;
    const pt = this.isPT;
    if (l === 0) {
      v.exitFrom = 0;
      v.mergeOut = false;
    } else if (!pt || !v.compliant) {
      v.exitFrom = 1; // lane integrity: exit from the lane you're in
      v.mergeOut = false;
    } else if (v.cutter) {
      v.exitFrom = 1; // PT in practice: cut straight across into exit lane 2
      v.mergeOut = false;
    } else {
      v.exitFrom = 0; // PT in theory: move to the outer lane after passing the previous exit
      v.mergeOut = true;
    }
    const div = this.g.divergeAng[v.exitArm][v.exitFrom];
    let d = mod2pi(div - mod2pi(v.theta));
    if (d < 0.05) d += 2 * Math.PI;
    v.thetaTarget = v.theta + d;
  }

  private goAround(v: RVeh): void {
    v.thetaTarget += 2 * Math.PI;
    v.goArounds++;
    v.committed = false;
    v.yieldWait = 0;
    if (this.measuring) this.c.goArounds++;
  }

  private ringDecisions(v: RVeh): void {
    const p = this.p;
    const remaining = v.thetaTarget - v.theta; // rad to my diverge
    const R = RING_R[v.ringLane];
    // signalling: from roughly the previous arm onward
    const tgtArc = remaining * R;
    v.signaling = v.signals && tgtArc < 30 + (v.falseSignal ? 35 : 0);
    // PT: outer lane must exit at the next exit
    v.outerViolator = this.isPT && v.ringLane === 0 && v.lcLeft <= 0 && remaining > Math.PI / 2 + 0.2;
    if (v.lapse > 0 || v.lcLeft > 0) return;

    // PT merge outward (inner → outer) after passing the exit before mine
    if (v.mergeOut && v.ringLane === 1) {
      const thetaOuterDiv = v.thetaTarget; // planned outer diverge (unwrapped)
      const zoneEnd = thetaOuterDiv - (RING_LC_DUR * Math.max(v.v, 5)) / R_OUT - 0.15;
      const zoneStart = thetaOuterDiv - Math.PI / 2 + 0.05;
      if (v.theta >= zoneStart && v.theta < zoneEnd) {
        v.signaling = v.signals || v.signaling;
        if (this.mergeGapOk(v)) {
          v.lcFrom = 1;
          v.ringLane = 0;
          v.lcLeft = RING_LC_DUR;
          v.mergeOut = false;
          if (this.measuring) this.c.ringLc++;
        }
      } else if (v.theta >= zoneEnd) {
        // couldn't merge in time: cut across from the inner lane, or go around
        v.mergeOut = false;
        if (this.beh.chance(0.5)) {
          v.exitFrom = 1;
          const div = this.g.divergeAng[v.exitArm][1];
          let d = mod2pi(div - mod2pi(v.theta));
          if (d < 0.02) d += 2 * Math.PI;
          v.thetaTarget = v.theta + d;
        } else {
          this.goAround(v);
          v.mergeOut = true;
        }
      }
    }

    // inner-lane exit: must cross the outer lane
    if (v.ringLane === 1 && v.exitFrom === 1) {
      const arcToDiv = (v.thetaTarget - v.theta) * R_IN;
      const canStop = arcToDiv - v.len / 2 > (v.v * v.v) / (2 * 4.5);
      if (arcToDiv < 22 && (canStop || !v.committed)) {
        const xc = this.g.exitCon[v.exitArm][1];
        const d = arcToDiv + xc.crossOuterS;
        const ok = this.gapOk(v, 0, xc.crossOuterAng, this.arrivalTime(v, d, V_RING[1]), this.arrivalTime(v, d + ZONE_LEN + v.len, V_RING[1]), v.exitArm, v.committed);
        if (ok) v.yieldWait = 0;
        v.committed = ok;
      }
    }
    void p;
  }

  private mergeGapOk(v: RVeh): boolean {
    // look at the outer lane next to me: leader and follower
    let lead: { o: RVeh; arc: number } | null = null;
    let fol: { o: RVeh; arc: number } | null = null;
    for (const oc of this.occ[0]) {
      const o = oc.v;
      if (o === v) continue;
      const d = mod2pi(oc.ang - v.ang);
      if (d < Math.PI) {
        const arc = d * R_OUT;
        if (arc < 40 && (!lead || arc < lead.arc)) lead = { o, arc };
      } else {
        const arc = (2 * Math.PI - d) * R_OUT;
        if (arc < 50 && (!fol || arc < fol.arc)) fol = { o, arc };
      }
    }
    if (lead && lead.arc - (lead.o.len + v.len) / 2 < 1.5) return false;
    // cars about to enter the outer lane just ahead of me (right-lane entrants of the next arm)
    for (const o of this.vehicles) {
      if (o.phase !== 'entry' && !(o.phase === 'approach' && o.cleared)) continue;
      const en = this.g.entry[o.origin][0];
      if (o.path!.lane !== 0) continue;
      const ahead = mod2pi(en.crossOuterAng - v.ang) * R_OUT;
      if (ahead > 25) continue;
      const oDist = (o.phase === 'approach' ? o.path!.len - o.s : 0) + en.crossOuterS - (o.phase === 'entry' ? o.s : 0);
      const tO = oDist / Math.max(o.v, 3);
      const tMe = ahead / Math.max(v.v, 3);
      if (Math.abs(tO - tMe) < 2.5 && this.perceive(v, o, 'normal')) return false;
    }
    if (fol) {
      const gap = fol.arc - (fol.o.len + v.len) / 2;
      const ctx: MissContext = gap < 5 ? 'blind_spot' : fol.o.v - v.v > 3 ? 'fast_approach' : 'normal';
      if (this.perceive(v, fol.o, ctx)) {
        if (gap < 1) return false;
        const need = idmAccel(fol.o.v, gap, fol.o.v - v.v, fol.o.idm);
        if (need < -(3 + this.p.human.stressGapGain * v.stress)) return false;
      }
    }
    return true;
  }

  /**
   * Give-way logic for entering cars and for inner-lane exiters once on their
   * exit connector. Re-evaluated every step (unless distracted) until the
   * driver is past the point where they could still stop.
   */
  private crossingDecision(v: RVeh): void {
    if (v.lapse > 0) return; // distracted: keeps doing whatever it was doing
    type C = { dist: number; lane: number; ang: number; ignore: number };
    const cs: C[] = [];
    let lineDist = Infinity;
    if (v.phase === 'approach' || v.phase === 'entry') {
      const l = v.path!.lane;
      const en = this.g.entry[v.origin][l];
      const pre = v.phase === 'approach' ? v.path!.len - v.s : 0;
      const sOn = v.phase === 'entry' ? v.s : 0;
      if (v.phase === 'approach') {
        lineDist = pre;
        if (pre > 18) return;
        const lead = this.pathLeader(v);
        if (lead && lead.o.phase === 'approach') {
          v.hold = Infinity;
          return; // not first in line: just follow
        }
      }
      // once in the outer lane you complete the manoeuvre (stopping there would block the roundabout)
      if (sOn > en.crossOuterS - 0.5) {
        v.hold = Infinity;
        return;
      }
      cs.push({ dist: Math.max(0.1, pre + en.crossOuterS - sOn), lane: 0, ang: en.crossOuterAng, ignore: v.origin });
      if (l === 1 && en.len - sOn > 0)
        cs.push({ dist: Math.max(0.1, pre + en.crossInnerS - sOn), lane: 1, ang: en.crossInnerAng, ignore: v.origin });
    } else if (v.phase === 'exitCon' && v.path!.lane === 1 && v.s < v.path!.crossOuterS) {
      const xc = v.path!;
      cs.push({ dist: xc.crossOuterS - v.s, lane: 0, ang: xc.crossOuterAng, ignore: v.exitArm });
    }
    if (!cs.length) {
      v.hold = Infinity;
      return;
    }
    // don't enter if the lane right after my merge point is blocked (I'd end up stuck across the lane)
    if (v.phase === 'approach' && !v.cleared) {
      const tl = v.path!.lane;
      const en = this.g.entry[v.origin][tl];
      const RL = this.ringLeader(tl, tl === 0 ? en.crossOuterAng : en.crossInnerAng, v, 18);
      if (RL && RL.o.v < 2 && RL.o.phase === 'ring') {
        v.hold = Math.max(0.1, lineDist - v.len / 2 - 0.5);
        return;
      }
    }
    const failing = cs.find((c) => !this.gapOk(v, c.lane, c.ang, this.arrivalTime(v, c.dist), this.arrivalTime(v, c.dist + ZONE_LEN + v.len), c.ignore, v.cleared && v.v > 2));
    if (!failing) {
      v.hold = Infinity;
      v.cleared = true;
      return;
    }
    const brake = (v.v * v.v) / (2 * 6);
    const before = failing.dist - v.len / 2 - 1.5;
    if (Number.isFinite(lineDist) && lineDist - v.len / 2 - 0.5 > brake) v.hold = lineDist - v.len / 2 - 0.5; // stop at the yield line
    else if (before > brake || v.v < 1) v.hold = Math.max(0.1, before); // stop short of the conflict
    else v.hold = Infinity; // past the point of no return
    v.cleared = v.hold === Infinity;
  }

  // ---------------------------------------------------------------- accelerations
  private desiredAccel(v: RVeh): number {
    let a = Infinity;
    const take = (x: number) => (a = Math.min(a, x));
    if (v.phase === 'approach') {
      const dist = v.path!.len - v.s;
      const vLim = Math.min(v.idm.v0, V_CONNECTOR + dist * 0.25);
      take(idmAccel(v.v, Infinity, 0, v.idm, vLim));
      const L = this.pathLeader(v);
      if (L) take(this.followAccel(v, L.o, L.dist, vLim));
      if (v.hold < Infinity) take(idmAccel(v.v, Math.max(0.1, v.hold), v.v, v.idm, vLim));
      else if (!v.cleared && dist > 18) take(idmAccel(v.v, Math.max(0.1, dist - v.len / 2 - 0.5), v.v, v.idm, vLim));
    } else if (v.phase === 'entry') {
      take(idmAccel(v.v, Infinity, 0, v.idm, V_CONNECTOR));
      if (v.hold < Infinity) take(idmAccel(v.v, Math.max(0.1, v.hold), v.v, v.idm, V_CONNECTOR));
      const L = this.pathLeader(v);
      if (L) take(this.followAccel(v, L.o, L.dist, V_CONNECTOR));
      // merging: follow whoever is ahead in the target lane near the join point, and any lane I'm in
      const tl = v.path!.lane;
      const bS = tl === 0 ? v.path!.crossOuterS : v.path!.crossInnerS;
      const bA = tl === 0 ? v.path!.crossOuterAng : v.path!.crossInnerAng;
      if (bS - v.s < 15) {
        // follow whoever is ahead of my merge point in the target lane, as if I were already there
        const back = Math.max(0, bS - v.s);
        const from = back > 0 ? bA - back / RING_R[tl] : v.ang;
        const RL = this.ringLeader(tl, from, v, 40);
        // never "follow" a car that is physically behind me
        if (RL && mod2pi(RL.o.ang - v.ang) < Math.PI) take(this.followAccel(v, RL.o, RL.arc, V_CONNECTOR));
      }
      for (let l = 0; l < 2; l++)
        if (Math.abs(v.r - RING_R[l]) < BAND) {
          const RL = this.ringLeader(l, v.ang, v, 30);
          if (RL) take(this.followAccel(v, RL.o, RL.arc, V_CONNECTOR));
        }
    } else if (v.phase === 'ring') {
      const vLim = V_RING[v.ringLane];
      take(idmAccel(v.v, Infinity, 0, v.idm, vLim));
      const lanes = v.lcLeft > 0 ? [v.ringLane, v.lcFrom] : [v.ringLane];
      for (const l of lanes) {
        const RL = this.ringLeader(l, v.ang, v);
        if (RL) take(this.followAccel(v, RL.o, RL.arc, vLim));
      }
      // vehicles ahead on my exit connector once I'm about to leave
      const arcTo = (v.thetaTarget - v.theta) * RING_R[v.exitFrom];
      if (arcTo < 15 && v.ringLane === v.exitFrom) {
        const xc = this.g.exitCon[v.exitArm][v.exitFrom];
        const l = this.onPath.get(xc.id);
        if (l && l.length) take(this.followAccel(v, l[0], arcTo + l[0].s, vLim));
      }
      // yielding before crossing the outer lane
      if (v.ringLane === 1 && v.exitFrom === 1 && !v.committed) {
        const arcToDiv = (v.thetaTarget - v.theta) * R_IN;
        // ease off (to slot in behind the outer-lane car) but don't stop dead inside the roundabout
        if (arcToDiv < 22) take(Math.max(-2, idmAccel(v.v, Math.max(0.1, arcToDiv - v.len / 2), v.v, v.idm, vLim)));
      }
    } else {
      // exitCon / exit
      const vLim = v.phase === 'exitCon' ? V_CONNECTOR + v.s * 0.2 : v.idm.v0;
      take(idmAccel(v.v, Infinity, 0, v.idm, vLim));
      const L = this.pathLeader(v);
      if (L) take(this.followAccel(v, L.o, L.dist, vLim));
      if (v.hold < Infinity) take(idmAccel(v.v, Math.max(0.1, v.hold), v.v, v.idm, vLim));
      if (v.phase === 'exitCon')
        for (let l = 0; l < 2; l++)
          if (Math.abs(v.r - RING_R[l]) < BAND) {
            const RL = this.ringLeader(l, v.ang, v, 25);
            if (RL && RL.o.phase !== 'ring') take(this.followAccel(v, RL.o, RL.arc, vLim));
          }
    }
    return a;
  }

  // ---------------------------------------------------------------- main step
  step(): void {
    const dt = DT;
    const measuring = this.measuring;
    this.rebuild();
    this.spawn();
    this.rebuild();

    // queues (sampled every second)
    if (this.t - this.lastSample >= 1) {
      this.lastSample = this.t;
      for (let k = 0; k < ARMS; k++) {
        const qR = this.queueLen(k, 0);
        const qL = this.queueLen(k, 1);
        this.queues[k] = [qR, qL];
        if (measuring) {
          this.c.queueSamples++;
          this.c.queueLeftSum += qL;
          this.c.queueRightSum += qR;
          this.c.queueMax = Math.max(this.c.queueMax, qL + qR + this.pending[k].length);
          this.c.armSeconds++;
          if (qL >= 4 && qR === 0) this.c.unusedRightSec++;
        }
      }
    }

    // decisions
    for (const v of this.vehicles) {
      if (v.phase === 'ring') this.ringDecisions(v);
      else {
        v.signaling = false;
        this.crossingDecision(v);
      }
    }

    // accelerations
    for (const v of this.vehicles) {
      let a = this.desiredAccel(v);
      if (stepAttention(v, this.beh, this.p.human, dt, a)) a = v.heldAccel;
      const applied = v.rbuf[v.ridx];
      v.rbuf[v.ridx] = Math.max(-MAX_BRAKE, Math.min(v.idm.a, a));
      v.ridx = (v.ridx + 1) % v.rbuf.length;
      v.a = applied;
      if (measuring) {
        if (v.a < -4 && !v.hardBraking) this.c.hardBrakes++;
        v.hardBraking = v.a < -4;
      }
    }

    // integrate + transitions
    for (const v of this.vehicles) {
      const vNew = Math.max(0, v.v + v.a * dt);
      const ds = (v.v + vNew) * 0.5 * dt;
      v.v = vNew;
      v.freeTime += ds / (v.phase === 'approach' || v.phase === 'exit' ? v.idm.v0 : V_RING[0]);
      if (v.phase === 'ring') {
        v.theta += ds / this.ringRadius(v);
        if (v.lcLeft > 0) v.lcLeft = Math.max(0, v.lcLeft - dt);
        // waiting too long to cross: give up and go around
        if (v.ringLane === 1 && v.exitFrom === 1 && !v.committed) {
          if (v.v < 0.5) v.yieldWait += dt;
          if (v.theta >= v.thetaTarget) this.goAround(v);
        }
        if (v.theta >= v.thetaTarget && v.lcLeft <= 0) {
          if (v.ringLane === v.exitFrom) {
            v.phase = 'exitCon';
            v.path = this.g.exitCon[v.exitArm][v.exitFrom];
            v.s = v.theta - v.thetaTarget;
            v.signaling = false;
            if (measuring && v.exitFrom === 1) {
              this.c.innerExits++;
              if (this.isPT) this.c.cutAcross++;
            }
          } else this.goAround(v);
        }
      } else if (v.path) {
        v.s += ds;
        while (v.path && v.s >= v.path.len) {
          const over = v.s - v.path.len;
          if (v.phase === 'approach') {
            v.phase = 'entry';
            v.path = v.path.next;
            v.s = over;
          } else if (v.phase === 'entry') {
            this.enterRing(v);
            v.theta += over / RING_R[v.ringLane];
            break;
          } else if (v.phase === 'exitCon') {
            v.phase = 'exit';
            v.path = v.path.next;
            v.s = over;
          } else {
            v.dead = true;
            if (measuring && v.tSpawn >= this.p.warmup) {
              this.c.finished++;
              this.c.delaySum += Math.max(0, this.t - v.tSpawn - v.freeTime);
            }
            break;
          }
        }
      }
      if (!v.dead) this.pose(v);
    }

    this.detectCollisions();
    this.vehicles = this.vehicles.filter((v) => !v.dead);
    for (const v of this.vehicles) if (v.checks.size > 40) for (const [id, [t]] of v.checks) if (this.t - t > 5) v.checks.delete(id);
    this.t += dt;
  }

  // ---------------------------------------------------------------- collisions
  private detectCollisions(): void {
    const vs = this.vehicles;
    const measuring = this.measuring;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      if (a.dead) continue;
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j];
        if (b.dead) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy > 144) {
          a.inConflict.delete(b.id);
          continue;
        }
        if (obbOverlap(a.x, a.y, a.h, a.len / 2, a.wid / 2, b.x, b.y, b.h, b.len / 2, b.wid / 2)) {
          this.crash(a, b);
          break;
        }
        // near miss: footprints within ~0.6 m with closing motion
        const near = obbOverlap(a.x, a.y, a.h, a.len / 2 + 0.6, a.wid / 2 + 0.4, b.x, b.y, b.h, b.len / 2 + 0.6, b.wid / 2 + 0.4);
        const sameLine = a.path && a.path === b.path;
        if (near && !sameLine) {
          if (!a.inConflict.has(b.id) && measuring) this.c.conflicts++;
          a.inConflict.add(b.id);
        } else if (!near) a.inConflict.delete(b.id);
      }
    }
  }

  private isInnerExiter(v: RVeh): boolean {
    return (v.phase === 'exitCon' && v.path!.lane === 1) || (v.phase === 'ring' && v.ringLane === 1 && v.exitFrom === 1 && v.committed);
  }

  private crash(a: RVeh, b: RVeh): void {
    a.dead = true;
    b.dead = true;
    let type: CrashType = 'other';
    let grey = false;
    let victim = false;
    const keepsOuterLane = (v: RVeh) => v.phase === 'ring' && v.ringLane === 0 && v.lcLeft <= 0;
    const keepsLane = (v: RVeh) => v.phase === 'ring' && v.lcLeft <= 0 && !this.isInnerExiter(v);
    const pair = [a, b];
    const lc = pair.find((v) => v.phase === 'ring' && v.lcLeft > 0);
    const ix = pair.find((v) => this.isInnerExiter(v));
    const en = pair.find((v) => v.phase === 'entry' || (v.phase === 'approach' && v.cleared));
    if (en && pair.some((v) => v !== en && (v.phase === 'ring' || v.phase === 'exitCon'))) {
      type = 'entry';
      victim = pair.some((v) => v !== en && keepsLane(v));
    } else if (lc) {
      type = 'ring_lane_change';
      victim = pair.some((v) => v !== lc && keepsLane(v));
    } else if (ix) {
      const other = ix === a ? b : a;
      if (keepsOuterLane(other) || (other.phase === 'exitCon' && other.path!.lane === 0)) {
        type = 'exit_cut_across';
        victim = keepsOuterLane(other);
        // grey area: under the PT rule the outer car "should" have exited, the inner car "shouldn't" exit from there
        grey = this.isPT && keepsOuterLane(other);
      }
    }
    if (type === 'other' && a.path && b.path && a.path === b.path) type = 'rear_end';
    if (type === 'other' && a.phase === 'ring' && b.phase === 'ring' && a.ringLane === b.ringLane && a.lcLeft <= 0 && b.lcLeft <= 0) type = 'rear_end';
    const miss = [a, b].some((v) => [...v.checks.values()].some(([t, seen]) => this.t - t < 3 && !seen));
    const d = (v: RVeh) => `#${v.id} ${v.phase}${v.path ? `/${v.path.kind}${v.path.lane}@${v.s.toFixed(1)}` : `/ring${v.ringLane}${v.lcLeft > 0 ? 'LC' : ''}`} arm${v.origin}->${v.exitArm} v=${v.v.toFixed(1)} a=${v.a.toFixed(1)} hold=${v.hold.toFixed(1)} clr=${v.cleared} lapse=${v.lapse.toFixed(1)}`;
    this.crashes.push({ t: this.t, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, type, greyArea: grey, inLaneVictim: victim, miss, debug: `${d(a)} | ${d(b)}` });
    if (this.crashes.length > 200) this.crashes.shift();
    if (this.measuring) {
      this.c.crashes[type]++;
      if (grey) this.c.greyArea++;
      if (victim) this.c.inLaneVictim++;
    }
  }

  armLabel(k: number): string {
    return ['E', 'N', 'W', 'S'][k];
  }
}

export function runRoundabout(params: RoundaboutParams, duration: number): Record<string, number> {
  const sim = new RoundaboutSim(params);
  while (sim.t < params.warmup + duration) sim.step();
  return roundaboutMetrics(sim);
}

export function roundaboutMetrics(sim: RoundaboutSim): Record<string, number> {
  const c = sim.c;
  const hours = Math.max(1e-9, (sim.t - sim.p.warmup) / 3600);
  const n = Math.max(1, c.spawned);
  const per1000 = (x: number) => (1000 * x) / n;
  const total = Object.values(c.crashes).reduce((a, b) => a + b, 0);
  return {
    crashes: per1000(total),
    crashes_entry: per1000(c.crashes.entry),
    crashes_ring_lc: per1000(c.crashes.ring_lane_change),
    crashes_cut: per1000(c.crashes.exit_cut_across),
    crashes_rear: per1000(c.crashes.rear_end),
    crashes_grey: per1000(c.greyArea),
    crashes_in_lane_victim: per1000(c.inLaneVictim),
    conflicts: (100 * c.conflicts) / n,
    hard_brakes: (100 * c.hardBrakes) / n,
    ring_lc: (100 * c.ringLc) / n,
    inner_exits: (100 * c.innerExits) / n,
    go_arounds: (100 * c.goArounds) / n,
    throughput: c.finished / hours,
    delay: c.finished ? c.delaySum / c.finished : NaN,
    wait_upstream: c.pendingWaitSum / n,
    queue_left: c.queueSamples ? c.queueLeftSum / c.queueSamples : 0,
    queue_right: c.queueSamples ? c.queueRightSum / c.queueSamples : 0,
    unused_right: c.armSeconds ? (100 * c.unusedRightSec) / c.armSeconds : 0,
    right_share: c.entriesLeft + c.entriesRight ? (100 * c.entriesRight) / (c.entriesLeft + c.entriesRight) : 0,
    crash_count: total,
  };
}

export { R_IN, R_OUT, armAngle };
