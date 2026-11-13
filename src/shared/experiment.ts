import { summarize, type Summary } from './stats';

export interface MetricDef {
  key: string;
  label: string;
  unit?: string;
  /** which direction is "good" (used for colouring the comparison table) */
  better: 'lower' | 'higher' | 'none';
  digits?: number;
  help?: string;
  /** headline metrics are shown as charts in the comparison view */
  headline?: boolean;
}

export interface RuleDef<R extends string> {
  id: R;
  label: string;
  short: string;
  color: string;
  description: string;
}

export interface ExperimentResult<R extends string> {
  rules: R[];
  reps: number;
  duration: number;
  /** raw per-replicate samples: metric -> rule -> values */
  samples: Record<string, Record<string, number[]>>;
  summary: Record<string, Record<string, Summary>>;
}

export function summarizeSamples<R extends string>(rules: R[], reps: number, duration: number, samples: Record<string, Record<string, number[]>>): ExperimentResult<R> {
  const summary: Record<string, Record<string, Summary>> = {};
  for (const [k, byRule] of Object.entries(samples)) {
    summary[k] = {};
    for (const r of rules) summary[k][r] = summarize(byRule[r] ?? []);
  }
  return { rules, reps, duration, samples, summary };
}

/**
 * Run `reps` replicates of every rule. Replicate i uses seed baseSeed+i for all
 * rules (common random numbers), so pairs are directly comparable.
 */
export function runExperiment<R extends string, P extends { rule: R; seed: number }>(
  base: P,
  rules: R[],
  reps: number,
  duration: number,
  run: (p: P, duration: number) => Record<string, number>,
  onProgress?: (done: number, total: number) => void,
): ExperimentResult<R> {
  const samples: Record<string, Record<string, number[]>> = {};
  const total = rules.length * reps;
  let done = 0;
  for (let i = 0; i < reps; i++) {
    for (const rule of rules) {
      const m = run({ ...base, rule, seed: base.seed + i * 7919 }, duration);
      for (const [k, v] of Object.entries(m)) {
        ((samples[k] ??= {})[rule] ??= []).push(v);
      }
      onProgress?.(++done, total);
    }
  }
  return summarizeSamples(rules, reps, duration, samples);
}
