/**
 * Driver model shared by both simulators.
 *
 * Car following uses the Intelligent Driver Model (IDM, Treiber et al. 2000).
 * IDM is collision-free by construction: a perfectly attentive IDM driver
 * never crashes. Every crash in these simulators therefore comes from an
 * explicit, parameterised *human failure*:
 *
 *  1. attention lapses: for a random short time the driver does not update
 *     their pedal input (keeps the previous acceleration);
 *  2. perception misses: when checking a gap before changing lanes / entering /
 *     crossing, each relevant vehicle may go unseen with some probability,
 *     much higher in the blind spot;
 *  3. stress: being tailgated / flashed raises the miss probability, makes
 *     lapses longer, and makes the driver accept tighter gaps.
 *
 * The *same* human-factor parameters apply to every rule set. Rules only change
 * how often, and in which geometric situations, drivers are exposed to these
 * failures.
 */
import { Rng } from './rng';

export interface IdmParams {
  v0: number; // desired speed m/s
  T: number; // desired time headway s
  a: number; // max acceleration m/s²
  b: number; // comfortable deceleration m/s²
  s0: number; // jam distance m
}

export const MAX_BRAKE = 9; // m/s², physical limit (dry asphalt, good tyres)

export function idmAccel(v: number, gap: number, dv: number, p: IdmParams, vLimit = p.v0): number {
  const v0 = Math.max(0.1, Math.min(p.v0, vLimit));
  const free = 1 - Math.pow(v / v0, 4);
  if (!Number.isFinite(gap)) return p.a * free;
  const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(gap, 0.01);
  return p.a * (free - (sStar / g) ** 2);
}

/** IDM acceleration toward a fixed obstacle (stop line, lane end). */
export function idmStop(v: number, dist: number, p: IdmParams, vLimit = p.v0): number {
  return idmAccel(v, dist, v, p, vLimit);
}

export interface HumanFactors {
  /** short distraction episodes (mirror, scenery, passenger) per minute of driving */
  lapseRate: number;
  /** mean short distraction duration (s) */
  lapseDur: number;
  /** long distractions (phone, radio, map) per minute of driving */
  longLapseRate: number;
  /** mean long distraction duration (s) */
  longLapseDur: number;
  /** base probability of not noticing a vehicle when checking a gap */
  missProb: number;
  /** multiplier on missProb when the vehicle sits in the blind spot */
  blindSpotMult: number;
  /** multiplier on missProb for a vehicle closing in fast from behind (speed misjudgement) */
  fastApproachMult: number;
  /** how strongly stress (0..1) raises missProb: p *= 1 + gain*stress */
  stressMissGain: number;
  /** how strongly stress lengthens lapses: dur *= 1 + gain*stress */
  stressLapseGain: number;
  /** extra braking (m/s²) a stressed driver is willing to impose on others when cutting in */
  stressGapGain: number;
  /** perception-reaction time range (s), drawn per driver */
  reactionMin: number;
  reactionMax: number;
}

export const DEFAULT_HUMAN: HumanFactors = {
  lapseRate: 1,
  lapseDur: 1.0,
  longLapseRate: 0.3,
  longLapseDur: 3,
  missProb: 0.0015,
  blindSpotMult: 8,
  fastApproachMult: 2.5,
  stressMissGain: 3,
  stressLapseGain: 1,
  stressGapGain: 2,
  reactionMin: 0.3,
  reactionMax: 0.6,
};

/** Per-vehicle human state; embed in each simulator's vehicle type. */
export interface HumanState {
  lapse: number; // remaining lapse time
  nextLapse: number; // time until next lapse starts
  nextLong: number; // time until next long distraction
  heldAccel: number;
  stress: number; // 0..1
  stressExposure: number; // integral of stress (s)
}

export function newHumanState(rng: Rng, h: HumanFactors): HumanState {
  return {
    lapse: 0,
    nextLapse: rng.exponential(Math.max(1e-6, h.lapseRate) / 60),
    nextLong: rng.exponential(Math.max(1e-6, h.longLapseRate) / 60),
    heldAccel: 0,
    stress: 0,
    stressExposure: 0,
  };
}

/**
 * Advance the attention process. Returns true if the driver is distracted
 * this step (and therefore must keep `heldAccel`).
 */
export function stepAttention(s: HumanState, rng: Rng, h: HumanFactors, dt: number, currentAccel: number): boolean {
  if (s.lapse > 0) {
    s.lapse -= dt;
    return true;
  }
  s.nextLapse -= dt;
  s.nextLong -= dt;
  const k = 1 + h.stressLapseGain * s.stress;
  if (s.nextLapse <= 0) {
    s.lapse = rng.lognormalMean(h.lapseDur * k, 0.6);
    s.nextLapse = rng.exponential(Math.max(1e-6, h.lapseRate) / 60);
  } else if (s.nextLong <= 0) {
    s.lapse = rng.lognormalMean(h.longLapseDur * k, 0.5);
    s.nextLong = rng.exponential(Math.max(1e-6, h.longLapseRate) / 60);
  } else return false;
  s.heldAccel = Math.min(currentAccel, 0.5);
  return true;
}

export function stepStress(s: HumanState, pressured: boolean, dt: number): void {
  if (pressured) s.stress = Math.min(1, s.stress + 0.25 * dt);
  else s.stress *= Math.exp(-dt / 20);
  s.stressExposure += s.stress * dt;
}

export type MissContext = 'normal' | 'blind_spot' | 'fast_approach';

export function missProbability(s: HumanState, h: HumanFactors, ctx: MissContext): number {
  let p = h.missProb;
  if (ctx === 'blind_spot') p *= h.blindSpotMult;
  else if (ctx === 'fast_approach') p *= h.fastApproachMult;
  p *= 1 + h.stressMissGain * s.stress;
  return Math.min(0.95, p);
}
