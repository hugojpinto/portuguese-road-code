export interface Summary {
  mean: number;
  sd: number;
  n: number;
  /** half-width of the 95% confidence interval of the mean */
  ci95: number;
}

const T95: Record<number, number> = { 1: 12.71, 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 30: 2.04 };

function tCrit(df: number): number {
  if (df <= 0) return NaN;
  const keys = Object.keys(T95).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return T95[k];
  return 1.96;
}

export function summarize(raw: number[]): Summary {
  const xs = raw.filter(Number.isFinite);
  const n = xs.length;
  if (n === 0) return { mean: NaN, sd: NaN, n, ci95: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, n, ci95: n > 1 ? (tCrit(n - 1) * sd) / Math.sqrt(n) : NaN };
}

/**
 * Paired comparison (common random numbers: replicate i of A and B saw the same
 * traffic). Returns mean difference A-B with its 95% CI; "significant" when the
 * CI excludes zero.
 */
export function pairedDiff(a: number[], b: number[]): Summary & { significant: boolean } {
  const d = a.map((x, i) => x - b[i]).filter(Number.isFinite);
  const s = summarize(d);
  return { ...s, significant: Number.isFinite(s.ci95) && Math.abs(s.mean) > s.ci95 };
}

export function fmt(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '–';
  const abs = Math.abs(x);
  if (abs >= 1000) return x.toFixed(0);
  if (abs >= 100) return x.toFixed(Math.max(0, digits - 2));
  if (abs >= 10) return x.toFixed(Math.max(0, digits - 1));
  return x.toFixed(digits);
}
