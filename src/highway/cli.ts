/**
 * Headless Monte-Carlo comparison of the highway rule sets.
 *   npm run batch:highway -- --reps 10 --minutes 30 --demand 4200 --stress 1
 */
import { runExperiment } from '../shared/experiment';
import { fmt, pairedDiff } from '../shared/stats';
import { DEFAULT_HIGHWAY, runHighway, type HighwayParams, type HighwayRule } from './model';
import { HIGHWAY_METRICS, HIGHWAY_RULES } from './meta';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const num = (k: string, d: number) => (args[k] !== undefined ? Number(args[k]) : d);

const params: HighwayParams = {
  ...DEFAULT_HIGHWAY,
  demand: num('demand', DEFAULT_HIGHWAY.demand),
  lanes: num('lanes', DEFAULT_HIGHWAY.lanes),
  compliance: num('compliance', DEFAULT_HIGHWAY.compliance),
  seed: num('seed', 1),
  human: { ...DEFAULT_HIGHWAY.human },
};
if (args.stress !== undefined) {
  const s = Number(args.stress);
  params.human.stressMissGain = DEFAULT_HIGHWAY.human.stressMissGain * s;
  params.human.stressLapseGain = DEFAULT_HIGHWAY.human.stressLapseGain * s;
  params.human.stressGapGain = DEFAULT_HIGHWAY.human.stressGapGain * s;
}
if (args.flash !== undefined) params.flasherShare = Number(args.flash);
if (args.speedsd !== undefined) params.speedSd = Number(args.speedsd);
const reps = num('reps', 8);
const duration = num('minutes', 30) * 60;
const rules = HIGHWAY_RULES.map((r) => r.id) as HighwayRule[];

const t0 = Date.now();
const res = runExperiment(params, rules, reps, duration, runHighway, (d, n) => process.stderr.write(`\r${d}/${n}`));
process.stderr.write(`\rdone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`demand=${params.demand} veh/h, lanes=${params.lanes}, compliance=${params.compliance}, flashers=${params.flasherShare}, stressGain=${params.human.stressMissGain}, speedSd=${params.speedSd}, reps=${reps} x ${duration / 60} min\n`);
console.log(pad('metric', 44) + rules.map((r) => pad(HIGHWAY_RULES.find((x) => x.id === r)!.short, 20)).join(''));
for (const m of HIGHWAY_METRICS) {
  const row = rules.map((r) => {
    const s = res.summary[m.key]?.[r];
    return pad(s ? `${fmt(s.mean, m.digits ?? 2)} ±${fmt(s.ci95, 1)}` : '-', 20);
  });
  console.log(pad(`${m.label}${m.unit ? ` (${m.unit})` : ''}`, 44) + row.join(''));
}
console.log('\nPaired differences vs EU keep-right (negative = fewer than EU):');
for (const key of ['crashes', 'crashes_lc', 'crashes_rear', 'conflicts', 'lc_per_km']) {
  const line = rules.slice(1).map((r) => {
    const d = pairedDiff(res.samples[key][r], res.samples[key][rules[0]]);
    return pad(`${fmt(d.mean, 2)} ±${fmt(d.ci95, 1)}${d.significant ? ' *' : ''}`, 20);
  });
  console.log(pad(key, 44) + pad('', 20) + line.join(''));
}
