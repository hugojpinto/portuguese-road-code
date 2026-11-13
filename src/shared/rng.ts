/**
 * Small, fast, seedable PRNG (mulberry32) plus the distributions we need.
 * Every simulation run is fully reproducible from its seed, which lets us use
 * "common random numbers": each rule set is tested against the *same* traffic
 * (same arrival times, same drivers) so differences come from the rule only.
 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  normal(mean = 0, sd = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Lognormal parametrised by its *mean* and coefficient of variation. */
  lognormalMean(mean: number, cv = 0.5): number {
    const s2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - s2 / 2;
    return Math.exp(this.normal(mu, Math.sqrt(s2)));
  }
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Derive an independent stream (for separating arrivals from behaviour). */
  fork(salt: number): Rng {
    return new Rng(Math.imul(this.s ^ salt, 0x85ebca6b) ^ (salt * 0x27d4eb2d));
  }
}

/** Acklam's approximation of the inverse standard normal CDF. */
export function probit(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
