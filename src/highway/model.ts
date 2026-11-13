/**
 * Highway micro-simulation: one direction of a motorway with N lanes, an
 * on-ramp and an off-ramp. Lane 0 is the RIGHTMOST lane (right-hand traffic),
 * lane -1 is the on-ramp acceleration lane.
 *
 * Car following: IDM. Lane changing: MOBIL (Kesting, Treiber & Helbing 2007)
 * with rule-specific biases and imperfect perception (see shared/driver.ts).
 */
import { Rng, probit } from '../shared/rng';
import {
  DEFAULT_HUMAN,
  MAX_BRAKE,
  idmAccel,
  idmStop,
  missProbability,
  newHumanState,
  stepAttention,
  stepStress,
  type HumanFactors,
  type HumanState,
  type IdmParams,
  type MissContext,
} from '../shared/driver';

export type HighwayRule = 'eu_keep_right' | 'speed_lanes' | 'speed_lanes_undertake' | 'free_lanes';

export interface HighwayParams {
  rule: HighwayRule;
  seed: number;
  lanes: number;
  /** mainline + ramp demand, vehicles per hour */
  demand: number;
  rampShare: number;
  exitShare: number;
  truckShare: number;
  speedLimit: number; // km/h (trucks capped at 90)
  speedMean: number; // km/h, desired speed of cars
  speedSd: number;
  /** share of drivers who actually follow the lane rule */
  compliance: number;
  /** share of drivers who tailgate/flash anyone slower in front, rule or no rule */
  aggressiveShare: number;
  /** share of drivers who tailgate/flash when the rule "licenses" it (slower car in the "wrong" lane) */
  flasherShare: number;
  human: HumanFactors;
  warmup: number; // s, not measured
}

export const DEFAULT_HIGHWAY: HighwayParams = {
  rule: 'eu_keep_right',
  seed: 1,
  lanes: 3,
  demand: 4200,
  rampShare: 0.15,
  exitShare: 0.15,
  truckShare: 0.12,
  speedLimit: 120,
  speedMean: 122,
  speedSd: 16,
  compliance: 0.8,
  aggressiveShare: 0.05,
  flasherShare: 0.35,
  human: { ...DEFAULT_HUMAN },
  warmup: 240,
};

// Geometry (metres)
export const ROAD_LEN = 6000;
export const RAMP_APPROACH = 1500; // lane -1 exists from here
export const RAMP_MERGE_START = 1800;
export const RAMP_END = 2100;
export const OFF_START = 4200;
export const OFF_END = 4450;
const EXIT_PREPARE = 1500; // exiting drivers start heading right this far before OFF_START

const DT = 0.1;
const LC_DUR = 3.0;
const V_CRIT_UNDERTAKE = 60 / 3.6; // below this, passing on the right is legal everywhere (queues)

export type LcMotive = 'pass_left' | 'pass_right' | 'return_right' | 'to_pref_lane' | 'yield' | 'exit' | 'merge';
export type CrashType =
  | 'rear_end'
  | 'rear_end_after_cut_in'
  | 'lc_blind_spot'
  | 'lc_undertaker'
  | 'lc_fast_from_behind'
  | 'lc_simultaneous'
  | 'lc_other'
  | 'merge';

export const CRASH_LABELS: Record<CrashType, string> = {
  rear_end: 'Rear-end (plain)',
  rear_end_after_cut_in: 'Rear-end after a cut-in',
  lc_blind_spot: 'Lane change: car in blind spot',
  lc_undertaker: 'Lane change: car passing on the right',
  lc_fast_from_behind: 'Lane change: fast car from behind',
  lc_simultaneous: 'Lane change: two cars into same lane',
  lc_other: 'Lane change: other',
  merge: 'On-ramp merge',
};

interface LcSnap {
  dir: 1 | -1; // +1 = to the left
  motive: LcMotive;
  t: number;
  /** the vehicle that was actually closest behind in the target lane at LC start */
  other: Veh | null;
  ctx: MissContext | 'clear';
  missed: boolean;
}

export interface Veh extends HumanState {
  id: number;
  x: number; // front bumper position
  v: number;
  a: number;
  len: number;
  truck: boolean;
  idm: IdmParams;
  baseT: number;
  lane: number;
  from: number;
  lcLeft: number;
  lcTotal: number;
  compliant: boolean;
  aggressive: boolean;
  flasher: boolean;
  politeness: number;
  pref: number;
  exits: boolean;
  fromRamp: boolean;
  nextDecision: number;
  pressured: boolean;
  pressuring: boolean;
  snap: LcSnap | null;
  lastCutInT: number;
  inConflict: boolean;
  hardBraking: boolean;
  dead: boolean;
  reaction: number;
  /** recent perception results per other vehicle: id -> [time, seen]. Perception is
   * sticky for PERCEPTION_MEMORY seconds: a car you just looked at stays seen
   * (or stays missed) rather than being re-rolled every second. */
  checks: Map<number, [number, boolean]>;
  /** perception-reaction delay line for the longitudinal control */
  rbuf: number[];
  ridx: number;
}

const PERCEPTION_MEMORY = 4;

export interface CrashEvent {
  t: number;
  x: number;
  lane: number;
  type: CrashType;
  perceptionMiss: boolean;
  stressed: boolean;
}

interface PendingArrival {
  traits: Omit<Veh, 'x' | 'v' | 'a' | 'lane' | 'from' | 'lcLeft' | 'lcTotal' | 'nextDecision' | 'pressured' | 'pressuring' | 'snap' | 'lastCutInT' | 'inConflict' | 'hardBraking' | 'dead' | 'checks' | 'rbuf' | 'ridx'>;
  t: number;
}

export interface HighwayCounters {
  vkm: number;
  vehSeconds: number;
  crashes: Record<CrashType, number>;
  crashesWithMiss: number;
  crashesStressed: number;
  lc: Record<LcMotive, number>;
  lcAborted: number;
  conflicts: number;
  hardBrakes: number;
  pressureSeconds: number;
  stressExposure: number;
  exited: number;
  completed: number;
  missedExits: number;
  laneSeconds: number[];
  entryWait: number;
}

function zeroCounters(lanes: number): HighwayCounters {
  return {
    vkm: 0,
    vehSeconds: 0,
    crashes: { rear_end: 0, rear_end_after_cut_in: 0, lc_blind_spot: 0, lc_undertaker: 0, lc_fast_from_behind: 0, lc_simultaneous: 0, lc_other: 0, merge: 0 },
    crashesWithMiss: 0,
    crashesStressed: 0,
    lc: { pass_left: 0, pass_right: 0, return_right: 0, to_pref_lane: 0, yield: 0, exit: 0, merge: 0 },
    lcAborted: 0,
    conflicts: 0,
    hardBrakes: 0,
    pressureSeconds: 0,
    stressExposure: 0,
    exited: 0,
    completed: 0,
    missedExits: 0,
    laneSeconds: new Array(lanes).fill(0),
    entryWait: 0,
  };
}

export class HighwaySim {
  readonly p: HighwayParams;
  t = 0;
  vehicles: Veh[] = [];
  crashes: CrashEvent[] = [];
  c: HighwayCounters;
  private arr: Rng;
  private beh: Rng;
  private nextId = 1;
  private nextMain: number;
  private nextRamp: number;
  private pendingMain: PendingArrival[] = [];
  private pendingRamp: PendingArrival[] = [];
  /** occupancy per lane (index lane+1), sorted by x ascending */
  private occ: Veh[][] = [];
  private bands: number[];

  constructor(params: HighwayParams) {
    this.p = params;
    const root = new Rng(params.seed);
    this.arr = root.fork(1);
    this.beh = root.fork(2);
    this.c = zeroCounters(params.lanes);
    const mainRate = (params.demand * (1 - params.rampShare)) / 3600;
    const rampRate = (params.demand * params.rampShare) / 3600;
    this.nextMain = mainRate > 0 ? this.arr.exponential(mainRate) : Infinity;
    this.nextRamp = rampRate > 0 ? this.arr.exponential(rampRate) : Infinity;
    // speed bands for the "speed lanes" rule: equal shares of drivers per lane
    this.bands = [0];
    for (let i = 1; i < params.lanes; i++) this.bands.push((params.speedMean + params.speedSd * probit(i / params.lanes)) / 3.6);
    for (let i = 0; i <= params.lanes; i++) this.occ.push([]);
  }

  resetCounters(): void {
    this.c = zeroCounters(this.p.lanes);
    this.crashes = [];
  }

  get measuring(): boolean {
    return this.t >= this.p.warmup;
  }

  laneExists(lane: number, x: number): boolean {
    if (lane === -1) return x >= RAMP_APPROACH && x <= RAMP_END;
    return lane >= 0 && lane < this.p.lanes;
  }

  /** Lane-band lower speed bound (m/s) for the speed-lane rule. */
  bandMin(lane: number): number {
    return this.bands[Math.max(0, lane)] ?? 0;
  }

  private makeTraits(fromRamp: boolean): PendingArrival['traits'] {
    const r = this.arr;
    const p = this.p;
    const truck = r.chance(p.truckShare);
    // draw every random trait unconditionally so that the arrival stream is identical across rules
    const vCar = Math.min(180, Math.max(85, r.normal(p.speedMean, p.speedSd))) / 3.6;
    const vTruck = Math.min(90, r.normal(86, 3)) / 3.6;
    const T = r.uniform(1.0, 1.8);
    const compliant = r.chance(p.compliance);
    const aggressive = r.chance(p.aggressiveShare);
    const flasher = r.chance(p.flasherShare);
    const exits = r.chance(p.exitShare);
    const politeness = r.uniform(0.1, 0.5);
    const human = newHumanState(r, p.human);
    const reaction = r.uniform(p.human.reactionMin, p.human.reactionMax);
    const v0 = truck ? vTruck : vCar;
    let pref = 0;
    if (!truck) for (let i = 1; i < p.lanes; i++) if (v0 >= this.bands[i]) pref = i;
    if (truck && p.lanes >= 3) pref = 0;
    return {
      ...human,
      id: 0,
      len: truck ? 16.5 : 4.5,
      truck,
      idm: { v0, T: truck ? 1.6 : T, a: truck ? 0.6 : 1.5, b: truck ? 1.5 : 2.0, s0: 2 },
      baseT: truck ? 1.6 : T,
      compliant,
      aggressive: aggressive && !truck,
      flasher: flasher && !truck,
      politeness: aggressive ? 0 : politeness,
      pref,
      exits,
      fromRamp,
      reaction,
    };
  }

  private rebuildOccupancy(): void {
    for (const l of this.occ) l.length = 0;
    for (const v of this.vehicles) {
      this.occ[v.lane + 1].push(v);
      if (v.lcLeft > 0 && v.from !== v.lane) this.occ[v.from + 1].push(v);
    }
    for (const l of this.occ) l.sort((a, b) => a.x - b.x);
  }

  /** First index in sorted lane array with x > pos. */
  private upper(arr: Veh[], pos: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (arr[m].x > pos) hi = m;
      else lo = m + 1;
    }
    return lo;
  }

  leaderIn(lane: number, me: Veh): Veh | null {
    const arr = this.occ[lane + 1];
    if (!arr) return null;
    for (let i = this.upper(arr, me.x); i < arr.length; i++) if (arr[i] !== me) return arr[i];
    return null;
  }

  followerIn(lane: number, me: Veh): Veh | null {
    const arr = this.occ[lane + 1];
    if (!arr) return null;
    for (let i = this.upper(arr, me.x) - 1; i >= 0; i--) if (arr[i] !== me) return arr[i];
    return null;
  }

  private accelBehind(me: Veh, leader: Veh | null, vLimit: number): number {
    if (!leader) return idmAccel(me.v, Infinity, 0, me.idm, vLimit);
    // anticipation (Human Driver Model): compensate own reaction delay by extrapolating the gap
    const dv = me.v - leader.v;
    const gap = leader.x - leader.len - me.x;
    const gapPred = gap - me.reaction * (dv + 0.5 * me.reaction * (me.a - leader.a));
    return idmAccel(me.v, Math.min(gap, gapPred), dv, me.idm, vLimit);
  }

  private bansUndertaking(me: Veh): boolean {
    const r = this.p.rule;
    return (r === 'eu_keep_right' || r === 'speed_lanes') && me.compliant;
  }

  /** Acceleration `me` would have if it were in `lane` behind `leader`. */
  private accelInLane(me: Veh, lane: number, leader: Veh | null): number {
    const vLimit = this.p.speedLimit / 3.6 + (me.compliant ? 0 : 15 / 3.6);
    let a = this.accelBehind(me, leader, vLimit);
    // no passing on the right: match a slower car in the lane to your left
    if (this.bansUndertaking(me) && me.v > V_CRIT_UNDERTAKE && lane + 1 < this.p.lanes && lane >= 0) {
      const ll = this.leaderIn(lane + 1, me);
      const gapL = ll ? ll.x - ll.len - me.x : Infinity;
      if (ll && ll.v < me.v && gapL > 0 && gapL < 80) a = Math.min(a, this.accelBehind(me, ll, vLimit));
    }
    if (lane === -1) a = Math.min(a, idmStop(me.v, RAMP_END - me.x, me.idm));
    return a;
  }

  /** Is the slower car `lead` in a lane where the rule says it should make way? */
  private pressureLicensed(lead: Veh): boolean {
    const N = this.p.lanes;
    switch (this.p.rule) {
      case 'eu_keep_right':
        return lead.lane > 0;
      case 'speed_lanes':
      case 'speed_lanes_undertake':
        return lead.lane === N - 1 || lead.v < this.bandMin(lead.lane) - 15 / 3.6;
      case 'free_lanes':
        return lead.lane === N - 1;
    }
  }

  private spawn(): void {
    const p = this.p;
    const mainRate = (p.demand * (1 - p.rampShare)) / 3600;
    const rampRate = (p.demand * p.rampShare) / 3600;
    while (this.t >= this.nextMain) {
      this.pendingMain.push({ traits: this.makeTraits(false), t: this.nextMain });
      this.nextMain += this.arr.exponential(mainRate);
    }
    while (this.t >= this.nextRamp) {
      this.pendingRamp.push({ traits: this.makeTraits(true), t: this.nextRamp });
      this.nextRamp += this.arr.exponential(rampRate);
    }
    this.tryInsert(this.pendingMain, 0);
    this.tryInsert(this.pendingRamp, RAMP_APPROACH);
  }

  private entryGap(lane: number, x: number): { gap: number; leader: Veh | null } {
    const arr = this.occ[lane + 1];
    const i = this.upper(arr, x - 0.01);
    const leader = arr[i] ?? null;
    return { gap: leader ? leader.x - leader.len - x : Infinity, leader };
  }

  private tryInsert(queue: PendingArrival[], x: number): void {
    while (queue.length) {
      const pa = queue[0];
      const tr = pa.traits;
      let candidates: number[];
      if (x > 0) candidates = [-1];
      else {
        const all = [...Array(this.p.lanes).keys()].filter((l) => !(tr.truck && this.p.lanes >= 3 && l === this.p.lanes - 1));
        const rule = this.p.rule;
        if (rule === 'eu_keep_right' && tr.compliant) candidates = all;
        else if ((rule === 'speed_lanes' || rule === 'speed_lanes_undertake') && tr.compliant)
          candidates = [...all].sort((a, b) => Math.abs(a - tr.pref) - Math.abs(b - tr.pref));
        else candidates = [...all].sort((a, b) => this.entryGap(b, x).gap - this.entryGap(a, x).gap);
      }
      let placed = false;
      for (const lane of candidates) {
        const { gap, leader } = this.entryGap(lane, x);
        const v = Math.min(x > 0 ? 22 : tr.idm.v0, leader ? leader.v + 2 : tr.idm.v0);
        if (gap > 8 + v * 0.9) {
          const veh: Veh = {
            ...tr,
            idm: { ...tr.idm },
            id: this.nextId++,
            x,
            v,
            a: 0,
            lane,
            from: lane,
            lcLeft: 0,
            lcTotal: LC_DUR,
            nextDecision: this.t + this.beh.uniform(0.5, 1.5),
            pressured: false,
            pressuring: false,
            snap: null,
            lastCutInT: -99,
            inConflict: false,
            hardBraking: false,
            dead: false,
            checks: new Map(),
            rbuf: new Array(Math.max(1, Math.round(tr.reaction / DT))).fill(0),
            ridx: 0,
          };
          this.vehicles.push(veh);
          this.occ[lane + 1].splice(this.upper(this.occ[lane + 1], x), 0, veh);
          if (this.measuring) this.c.entryWait += this.t - pa.t;
          queue.shift();
          placed = true;
          break;
        }
      }
      if (!placed) return;
    }
  }

  /** Perceive the closest follower in `lane` behind `me`, with possible misses. */
  private perceiveFollower(me: Veh, lane: number): { seen: Veh | null; truth: Veh | null; ctx: MissContext | 'clear'; missed: boolean } {
    const arr = this.occ[lane + 1];
    let truth: Veh | null = null;
    let truthCtx: MissContext | 'clear' = 'clear';
    let missed = false;
    const rear = me.x - me.len;
    for (let i = this.upper(arr, me.x) - 1; i >= 0; i--) {
      const f = arr[i];
      if (f === me) continue;
      if (rear - f.x > 150) break;
      // blind spot: the other car's front is between ~5 m behind our rear bumper and
      // the middle of our car (mirror dead angle). Further forward it is in peripheral view.
      const ahead = f.x - rear; // how far its front is past our rear bumper
      let ctx: MissContext = 'normal';
      if (ahead > -5 && ahead < me.len * 0.6) ctx = 'blind_spot';
      else if (f.v - me.v > 5) ctx = 'fast_approach';
      if (!truth) {
        truth = f;
        truthCtx = ctx;
      }
      const prev = me.checks.get(f.id);
      let seen: boolean;
      if (prev && this.t - prev[0] < PERCEPTION_MEMORY) seen = prev[1];
      else {
        seen = !this.beh.chance(missProbability(me, this.p.human, ctx));
        me.checks.set(f.id, [this.t, seen]);
      }
      if (!seen) {
        if (f === truth) missed = true;
        continue;
      }
      return { seen: f, truth, ctx: truthCtx, missed };
    }
    return { seen: null, truth, ctx: truthCtx, missed };
  }

  private decideLaneChange(me: Veh): void {
    const p = this.p;
    const N = p.lanes;
    const h = p.human;
    const curLeader = this.leaderIn(me.lane, me);
    const aCur = this.accelInLane(me, me.lane, curLeader);
    const oldFollower = this.followerIn(me.lane, me);
    const exitZone = me.exits && me.x > OFF_START - EXIT_PREPARE && me.x < OFF_END;
    let best: { lane: number; score: number; motive: LcMotive; snap: ReturnType<HighwaySim['perceiveFollower']> } | null = null;

    for (const dir of [1, -1] as const) {
      const target = me.lane + dir;
      if (target < 0 || target >= N) continue; // never into the ramp lane
      if (me.lane === -1 && me.x < RAMP_MERGE_START) continue;
      if (me.truck && N >= 3 && target === N - 1) continue;
      if (exitZone && dir === 1) continue;

      const tLeader = this.leaderIn(target, me);
      if (tLeader && tLeader.x - tLeader.len - me.x < 1) continue; // car ahead/alongside in plain view: blocked
      const aNew = this.accelInLane(me, target, tLeader);
      const per = this.perceiveFollower(me, target);
      const nf = per.seen;
      let bSafe = 4 + h.stressGapGain * me.stress;
      if (me.lane === -1) bSafe = 4 + 3 * Math.min(1, (me.x - RAMP_MERGE_START) / (RAMP_END - RAMP_MERGE_START));
      if (exitZone) bSafe = 4 + 2 * Math.min(1, (me.x - (OFF_START - EXIT_PREPARE)) / EXIT_PREPARE);
      let dNew = 0;
      if (nf) {
        const gapNf = me.x - me.len - nf.x;
        if (gapNf < 0.5) continue;
        const aNfNew = idmAccel(nf.v, gapNf, nf.v - me.v, nf.idm);
        if (aNfNew < -bSafe) continue;
        dNew = aNfNew - nf.a;
      }
      let dOld = 0;
      if (oldFollower && me.lane >= 0) {
        const aOldNew = this.accelBehind(oldFollower, curLeader, Infinity);
        dOld = aOldNew - oldFollower.a;
      }
      let incentive = aNew - aCur + me.politeness * (dNew + dOld);
      let motive: LcMotive = dir === 1 ? 'pass_left' : aNew - aCur > 0.3 ? 'pass_right' : 'return_right';

      // ---- rule-specific biases ----
      const rule = p.rule;
      if (me.lane === -1) {
        incentive += 3;
        motive = 'merge';
      } else if (exitZone) {
        incentive += 1 + 2 * Math.min(1, (me.x - (OFF_START - EXIT_PREPARE)) / EXIT_PREPARE);
        motive = 'exit';
      } else if (rule === 'eu_keep_right') {
        if (me.compliant) incentive += dir === -1 ? 0.4 : -0.4;
        else incentive += dir === -1 ? -0.3 : 0; // lane hoggers: reluctant to move right
      } else if (rule === 'speed_lanes' || rule === 'speed_lanes_undertake') {
        if (me.compliant) {
          const d0 = Math.abs(me.lane - me.pref);
          const d1 = Math.abs(target - me.pref);
          if (d1 < d0) {
            incentive += 0.4;
            if (aNew - aCur < 0.3 && dir === -1) motive = 'to_pref_lane';
            if (dir === 1 && aNew - aCur < 0.3) motive = 'to_pref_lane';
          } else if (d1 > d0) incentive -= 0.4;
          // never block the leftmost lane
          if (me.lane === N - 1 && dir === -1 && oldFollower && oldFollower.idm.v0 > me.v + 2 && me.x - me.len - oldFollower.x < 60) {
            incentive += 0.6;
            motive = 'yield';
          }
        } else incentive += dir === -1 ? -0.3 : 0;
      } else {
        // free lanes: no lane preference at all, just keep the leftmost lane free when someone wants by
        if (me.lane === N - 1 && dir === -1 && me.compliant && oldFollower && oldFollower.idm.v0 > me.v + 2 && me.x - me.len - oldFollower.x < 60) {
          incentive += 0.6;
          motive = 'yield';
        }
      }
      if (me.pressured && dir === -1 && me.lane > 0) {
        incentive += 0.8; // being flashed: get out of the way
        motive = 'yield';
      }
      const threshold = 0.2;
      if (incentive > threshold && (!best || incentive > best.score)) best = { lane: target, score: incentive, motive, snap: per };
    }

    if (best) {
      const dir = (best.lane > me.lane ? 1 : -1) as 1 | -1;
      me.snap = { dir, motive: best.motive, t: this.t, other: best.snap.truth, ctx: best.snap.ctx, missed: best.snap.missed };
      me.from = me.lane;
      me.lane = best.lane;
      me.lcLeft = me.lcTotal = LC_DUR * (1 - 0.25 * me.stress);
      this.occ[me.lane + 1].splice(this.upper(this.occ[me.lane + 1], me.x), 0, me);
      if (this.measuring) this.c.lc[best.motive]++;
      me.nextDecision = this.t + me.lcLeft + this.beh.uniform(1.5, 3);
    } else me.nextDecision = this.t + this.beh.uniform(0.6, 1.2);
  }

  step(): void {
    const p = this.p;
    const dt = DT;
    const N = p.lanes;
    const measuring = this.measuring;
    this.spawn();
    this.rebuildOccupancy();

    // 1. pressure (tailgating + flashing)
    for (const v of this.vehicles) {
      v.pressured = false;
      v.pressuring = false;
    }
    for (const f of this.vehicles) {
      if (f.lcLeft > 0 || f.truck || f.lane < 0) continue;
      const l = this.leaderIn(f.lane, f);
      if (!l || l.lcLeft > 0) continue;
      const gap = l.x - l.len - f.x;
      if (gap > 3 + f.v * 1.6 || f.idm.v0 < l.v + 10 / 3.6) continue;
      if (f.aggressive || (f.flasher && this.pressureLicensed(l))) {
        f.pressuring = true;
        l.pressured = true;
      }
    }

    // 2. accelerations
    for (const v of this.vehicles) {
      v.idm.T = v.pressuring ? 0.6 : v.baseT;
      let a: number;
      if (v.lcLeft > 0) {
        a = Math.min(this.accelInLane(v, v.lane, this.leaderIn(v.lane, v)), this.accelBehind(v, this.leaderIn(v.from, v), p.speedLimit / 3.6 + 4));
      } else a = this.accelInLane(v, v.lane, this.leaderIn(v.lane, v));
      const distracted = stepAttention(v, this.beh, p.human, dt, a);
      if (distracted) a = v.heldAccel;
      // perception-reaction delay: the pedal follows what the driver decided `reaction` s ago
      const applied = v.rbuf[v.ridx];
      v.rbuf[v.ridx] = Math.max(-MAX_BRAKE, Math.min(v.idm.a, a));
      v.ridx = (v.ridx + 1) % v.rbuf.length;
      v.a = applied;
      if (measuring) {
        if (v.a < -4 && !v.hardBraking) this.c.hardBrakes++;
        v.hardBraking = v.a < -4;
      }
    }

    // 3. lane changes (decisions + aborts)
    for (const v of this.vehicles) {
      if (v.lcLeft > 0) {
        // second look during the first second of the manoeuvre: the driver may still spot the problem and abort
        const prog = 1 - v.lcLeft / v.lcTotal;
        if (prog < 0.35 && v.snap && v.lane >= 0) {
          const f = this.followerIn(v.lane, v);
          const danger = f && (v.x - v.len - f.x < 1 || idmAccel(f.v, v.x - v.len - f.x, f.v - v.v, f.idm) < -7);
          if (danger && v.lapse <= 0 && this.beh.chance(dt * 1.5 * (1 - missProbability(v, p.human, 'blind_spot')))) {
            v.lane = v.from;
            v.lcLeft = 0;
            if (measuring) {
              this.c.lcAborted++;
              this.c.lc[v.snap.motive]--;
            }
            v.snap = null;
          }
        }
        continue;
      }
      if (v.lapse > 0 || this.t < v.nextDecision) continue;
      if (v.checks.size > 30) for (const [id, [t]] of v.checks) if (this.t - t > PERCEPTION_MEMORY) v.checks.delete(id);
      this.decideLaneChange(v);
    }

    // 4. integrate
    for (const v of this.vehicles) {
      const vNew = Math.max(0, v.v + v.a * dt);
      v.x += (v.v + vNew) * 0.5 * dt;
      v.v = vNew;
      if (v.lcLeft > 0) {
        v.lcLeft -= dt;
        if (v.lcLeft <= 0) {
          v.lcLeft = 0;
          v.lastCutInT = this.t;
          v.from = v.lane;
        }
      }
      stepStress(v, v.pressured, dt);
      if (measuring) {
        this.c.vkm += (v.v * dt) / 1000;
        this.c.vehSeconds += dt;
        if (v.pressured) this.c.pressureSeconds += dt;
        this.c.stressExposure += v.stress * dt;
        if (v.lane >= 0) this.c.laneSeconds[v.lane] += dt;
      }
    }

    // 5. collisions + conflicts
    this.rebuildOccupancy();
    this.detectCollisions();

    // 6. exits / removal
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.exits && v.lane === 0 && v.lcLeft === 0 && v.x >= OFF_START && v.x <= OFF_END) {
        v.dead = true;
        if (measuring) this.c.exited++;
      } else if (v.x > ROAD_LEN) {
        v.dead = true;
        if (measuring) {
          this.c.completed++;
          if (v.exits) this.c.missedExits++;
        }
      }
    }
    this.vehicles = this.vehicles.filter((v) => !v.dead);
    void N;
    this.t += dt;
  }

  /** Does vehicle v physically occupy `lane` right now (for collision purposes)? */
  private physicallyIn(v: Veh, lane: number): boolean {
    if (v.lcLeft <= 0 || v.from === v.lane) return v.lane === lane;
    const prog = 1 - v.lcLeft / v.lcTotal;
    if (lane === v.lane) return prog >= 0.35;
    if (lane === v.from) return prog < 0.65;
    return false;
  }

  private detectCollisions(): void {
    const measuring = this.measuring;
    for (let li = 0; li < this.occ.length; li++) {
      const lane = li - 1;
      const arr = this.occ[li].filter((v) => !v.dead && this.physicallyIn(v, lane));
      for (let i = 0; i + 1 < arr.length; i++) {
        const back = arr[i];
        const front = arr[i + 1];
        const gap = front.x - front.len - back.x;
        // surrogate safety: time-to-collision < 1.5 s episodes
        const closing = back.v - front.v;
        const ttc = closing > 0 ? gap / closing : Infinity;
        if (ttc < 1.5 && gap >= 0) {
          if (!back.inConflict && measuring) this.c.conflicts++;
          back.inConflict = true;
        } else if (ttc > 3) back.inConflict = false;
        if (gap < 0) this.crash(back, front, lane);
      }
    }
  }

  private crash(back: Veh, front: Veh, lane: number): void {
    if (back.dead || front.dead) return;
    back.dead = true;
    front.dead = true;
    let type: CrashType = 'rear_end';
    let miss = false;
    const bLC = back.lcLeft > 0 && back.lane === lane && back.from !== lane;
    const fLC = front.lcLeft > 0 && front.lane === lane && front.from !== lane;
    const changer = fLC ? front : bLC ? back : null;
    const other = changer === front ? back : front;
    if (lane === -1 || changer?.from === -1) type = 'merge';
    else if (bLC && fLC) type = 'lc_simultaneous';
    else if (changer && changer.snap) {
      const s = changer.snap;
      miss = s.missed && s.other === other;
      if (s.other === other) {
        if (s.dir === -1 && other.v > changer.v + 1) type = 'lc_undertaker';
        else if (s.ctx === 'blind_spot') type = 'lc_blind_spot';
        else if (s.ctx === 'fast_approach') type = 'lc_fast_from_behind';
        else type = 'lc_other';
      } else type = 'lc_other';
    } else if (this.t - front.lastCutInT < 5) type = 'rear_end_after_cut_in';
    const stressed = Math.max(back.stress, front.stress) > 0.3;
    this.crashes.push({ t: this.t, x: back.x, lane, type, perceptionMiss: miss, stressed });
    if (this.crashes.length > 200) this.crashes.shift();
    if (this.measuring) {
      this.c.crashes[type]++;
      if (miss) this.c.crashesWithMiss++;
      if (stressed) this.c.crashesStressed++;
    }
  }

  /** Bands for rendering/explaining the speed-lane rule (km/h lower bounds). */
  get bandLowerKmh(): number[] {
    return this.bands.map((b) => b * 3.6);
  }
}

export const LC_CRASH_TYPES: CrashType[] = ['lc_blind_spot', 'lc_undertaker', 'lc_fast_from_behind', 'lc_simultaneous', 'lc_other'];

/** Headless run: simulate warmup + duration and return per-run metrics. */
export function runHighway(params: HighwayParams, duration: number): Record<string, number> {
  const sim = new HighwaySim(params);
  const end = params.warmup + duration;
  while (sim.t < end) sim.step();
  return highwayMetrics(sim);
}

export function highwayMetrics(sim: HighwaySim): Record<string, number> {
  const c = sim.c;
  const per = (x: number) => (c.vkm > 0 ? (x / c.vkm) * 10000 : 0); // per 10,000 veh-km
  const lcCrash = LC_CRASH_TYPES.reduce((s, k) => s + c.crashes[k], 0);
  const rear = c.crashes.rear_end + c.crashes.rear_end_after_cut_in;
  const total = Object.values(c.crashes).reduce((a, b) => a + b, 0);
  const lcTotal = Object.values(c.lc).reduce((a, b) => a + b, 0);
  const hours = (sim.t - sim.p.warmup) / 3600;
  const out: Record<string, number> = {
    crashes: per(total),
    crashes_lc: per(lcCrash),
    crashes_merge: per(c.crashes.merge),
    crashes_rear: per(rear),
    crashes_cutin_rear: per(c.crashes.rear_end_after_cut_in),
    crashes_undertaker: per(c.crashes.lc_undertaker),
    crashes_blindspot: per(c.crashes.lc_blind_spot),
    share_lc: total > 0 ? (lcCrash + c.crashes.merge + c.crashes.rear_end_after_cut_in) / total : NaN,
    share_stressed: total > 0 ? c.crashesStressed / total : NaN,
    lc_per_km: c.vkm > 0 ? lcTotal / c.vkm : 0,
    lc_overtake: c.vkm > 0 ? (c.lc.pass_left + c.lc.pass_right) / c.vkm : 0,
    lc_return: c.vkm > 0 ? (c.lc.return_right + c.lc.to_pref_lane) / c.vkm : 0,
    lc_yield: c.vkm > 0 ? c.lc.yield / c.vkm : 0,
    aborted: per(c.lcAborted),
    conflicts: per(c.conflicts),
    hard_brakes: per(c.hardBrakes),
    pressure_share: c.vehSeconds > 0 ? (100 * c.pressureSeconds) / c.vehSeconds : 0,
    stress_mean: c.vehSeconds > 0 ? c.stressExposure / c.vehSeconds : 0,
    speed: c.vehSeconds > 0 ? (c.vkm * 3600) / c.vehSeconds : 0,
    throughput: hours > 0 ? (c.exited + c.completed) / hours : 0,
    entry_wait: c.exited + c.completed > 0 ? c.entryWait / (c.exited + c.completed) : 0,
    missed_exits: c.exited + c.missedExits > 0 ? (100 * c.missedExits) / (c.exited + c.missedExits) : 0,
    vkm: c.vkm,
    crash_count: total,
  };
  const laneTot = c.laneSeconds.reduce((a, b) => a + b, 0);
  c.laneSeconds.forEach((s, i) => (out[`lane_${i}`] = laneTot > 0 ? (100 * s) / laneTot : 0));
  return out;
}
