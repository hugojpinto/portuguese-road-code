/** npm run batch:roundabout -- --reps 10 --minutes 30 --main 800 --side 500 */
import { runExperiment } from '../shared/experiment';
import { fmt, pairedDiff } from '../shared/stats';
import { DEFAULT_ROUNDABOUT, runRoundabout, type RoundaboutParams, type RoundaboutRule } from './model';
import { ROUNDABOUT_METRICS, ROUNDABOUT_RULES } from './meta';

const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const num = (k: string, d: number) => (args[k] !== undefined ? Number(args[k]) : d);
const params: RoundaboutParams = {
  ...structuredClone(DEFAULT_ROUNDABOUT),
  demandMain: num('main', DEFAULT_ROUNDABOUT.demandMain),
  demandSide: num('side', DEFAULT_ROUNDABOUT.demandSide),
  ruleTrust: num('trust', DEFAULT_ROUNDABOUT.ruleTrust),
  cutAcrossShare: num('cut', DEFAULT_ROUNDABOUT.cutAcrossShare),
  seed: num('seed', 1),
};
if (args.perfect !== undefined) params.human = { ...params.human, missProb: 0, lapseRate: 1e-6, longLapseRate: 1e-6 };
if (args.jump !== undefined) params.queueJumpShare = Number(args.jump);
if (args.compliance !== undefined) params.compliance = Number(args.compliance);
const reps = num('reps', 8);
const duration = num('minutes', 30) * 60;
const rules = ROUNDABOUT_RULES.map((r) => r.id) as RoundaboutRule[];
const t0 = Date.now();
const res = runExperiment(params, rules, reps, duration, runRoundabout, (d, n) => process.stderr.write(`\r${d}/${n}`));
process.stderr.write(`\rdone in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`main=${params.demandMain} side=${params.demandSide} veh/h/arm, trust=${params.ruleTrust} cut=${params.cutAcrossShare} jump=${params.queueJumpShare} compliance=${params.compliance}${args.perfect !== undefined ? ' PERFECT DRIVERS' : ''}, reps=${reps} x ${duration / 60} min\n`);
console.log(pad('metric', 58) + rules.map((r) => pad(ROUNDABOUT_RULES.find((x) => x.id === r)!.short, 20)).join(''));
for (const m of ROUNDABOUT_METRICS) {
  const row = rules.map((r) => {
    const s = res.summary[m.key]?.[r];
    let sig = '';
    if (r !== 'pt2014') {
      const d = pairedDiff(res.samples[m.key][r], res.samples[m.key].pt2014);
      if (d.significant) sig = d.mean > 0 ? ' ▲' : ' ▼';
    }
    return pad(s ? `${fmt(s.mean, m.digits ?? 2)} ±${fmt(s.ci95, 1)}${sig}` : '-', 20);
  });
  console.log(pad(`${m.label}${m.unit ? ` (${m.unit})` : ''}`.slice(0, 57), 58) + row.join(''));
}
