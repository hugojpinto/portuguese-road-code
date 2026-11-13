import type { ExperimentResult } from '../shared/experiment';
import { fmt, pairedDiff } from '../shared/stats';
import { el } from '../shared/ui';
import type { HighwayRule } from './model';

type Res = ExperimentResult<HighwayRule>;

function cmp(res: Res, key: string, a: HighwayRule, b: HighwayRule) {
  const d = pairedDiff(res.samples[key][a], res.samples[key][b]);
  const base = res.summary[key][b].mean;
  return { ...d, pct: base ? (100 * d.mean) / base : NaN };
}

function phrase(d: ReturnType<typeof cmp>, lowerIsGood = true): string {
  if (!d.significant) return `no statistically significant difference (${d.pct >= 0 ? '+' : ''}${fmt(d.pct, 1)}%, within noise)`;
  const better = lowerIsGood ? d.mean < 0 : d.mean > 0;
  return `<b>${d.pct >= 0 ? '+' : ''}${fmt(d.pct, 1)}%</b> (${better ? 'better' : 'worse'}, significant)`;
}

/** Plain-language read-out of the experiment against each of the user's claims. */
export function highwayVerdict(res: Res): HTMLElement {
  const eu: HighwayRule = 'eu_keep_right';
  const s = res.summary;
  const share = s.share_lc[eu].mean;
  const lcSL = cmp(res, 'lc_per_km', 'speed_lanes', eu);
  const crSL = cmp(res, 'crashes', 'speed_lanes', eu);
  const crSLU = cmp(res, 'crashes', 'speed_lanes_undertake', eu);
  const crFree = cmp(res, 'crashes', 'free_lanes', eu);
  const lcCrSL = cmp(res, 'crashes_lc', 'speed_lanes', eu);
  const prSL = cmp(res, 'pressure_share', 'speed_lanes', eu);
  const stressed = s.share_stressed[eu].mean;
  const undEU = s.crashes_undertaker[eu].mean;
  const undSLU = s.crashes_undertaker.speed_lanes_undertake.mean;
  const totalCrashes = Object.values(res.samples.crash_count).flat().reduce((a, b) => a + b, 0);

  const items: string[] = [
    `<b>Claim 1, most crashes are lane-change related:</b> under the current EU rule, <b>${fmt(100 * share, 1)}%</b> of simulated crashes were lane changes, merges, or rear-ends within 5 s of a cut-in. ${share > 0.5 ? 'In this model that is a majority.' : 'In this model that is <i>not</i> a majority.'} <span class="muted">Caveat: this share mostly reflects how the human-error parameters are calibrated. Real crash databases are the better judge here (see caveats).</span>`,
    `<b>Exposure, lane changes per vehicle-km:</b> speed lanes vs keep-right: ${phrase(lcSL)}.`,
    `<b>Claim 3, flashing and tailgating pressure:</b> time spent being tailgated, speed lanes vs keep-right: ${phrase(prSL)}. Share of crashes involving a stressed driver (EU rule): ${fmt(100 * stressed, 0)}%.`,
    `<b>Lane-change crashes:</b> speed lanes vs keep-right: ${phrase(lcCrSL)}.`,
    `<b>All crashes vs keep-right:</b> speed lanes ${phrase(crSL)}; speed lanes with passing on the right ${phrase(crSLU)}; free lanes ${phrase(crFree)}.`,
    `<b>Passing on the right:</b> crashes where a lane-changer hit a car passing on the right: ${fmt(undEU, 2)} (EU) vs ${fmt(undSLU, 2)} (speed lanes + right pass) per 10k veh·km.`,
  ];
  if (totalCrashes < 150)
    items.push(`<span style="color:var(--bad)">Only ${totalCrashes} crashes in total. Too few for firm conclusions, so increase replicates or minutes.</span>`);
  return el('div', { class: 'verdict', html: `<h3>What this run says</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul><p class="muted" style="font-size:12px">To test whether a result depends on the stress hypothesis, set the three stress gains to 0 under Human factors and run again.</p>` });
}
