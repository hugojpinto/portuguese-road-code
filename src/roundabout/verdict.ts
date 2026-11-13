import type { ExperimentResult } from '../shared/experiment';
import { fmt, pairedDiff } from '../shared/stats';
import { el } from '../shared/ui';
import type { RoundaboutRule } from './model';

type Res = ExperimentResult<RoundaboutRule>;

function cmp(res: Res, key: string, a: RoundaboutRule, b: RoundaboutRule) {
  const d = pairedDiff(res.samples[key][a], res.samples[key][b]);
  const base = res.summary[key][b].mean;
  return { ...d, pct: base ? (100 * d.mean) / base : NaN };
}
function phrase(d: ReturnType<typeof cmp>, lowerIsGood = true): string {
  if (!d.significant) return `no statistically significant difference (${d.pct >= 0 ? '+' : ''}${fmt(d.pct, 1)}%)`;
  const better = lowerIsGood ? d.mean < 0 : d.mean > 0;
  return `<b>${d.pct >= 0 ? '+' : ''}${fmt(d.pct, 1)}%</b> (${better ? 'better' : 'worse'}, significant)`;
}

export function roundaboutVerdict(res: Res): HTMLElement {
  const s = res.summary;
  const LI: RoundaboutRule = 'lane_integrity';
  const PT: RoundaboutRule = 'pt2014';
  const total = Object.values(res.samples.crash_count).flat().reduce((a, b) => a + b, 0);
  const items = [
    `<b>Lane integrity, cars keeping their lane hit from the side:</b> lane integrity vs PT 2014 as practised: ${phrase(cmp(res, 'crashes_in_lane_victim', LI, PT))}. vs PT 2014 with perfect compliance: ${phrase(cmp(res, 'crashes_in_lane_victim', LI, 'pt2014_ideal'))}.`,
    `<b>Lane changes inside the roundabout:</b> ${fmt(s.ring_lc[PT].mean, 1)} per 100 vehicles under PT 2014 as practised, ${fmt(s.ring_lc.pt2014_ideal.mean, 1)} under perfect compliance, 0 under lane integrity. In return, lane integrity has ${fmt(s.inner_exits[LI].mean, 1)} per 100 vehicles leaving from the inner lane across the outer one (vs ${fmt(s.inner_exits[PT].mean, 1)} under PT 2014 as practised).`,
    `<b>The left-lane queue:</b> share of time a left lane has 4+ cars queued while the right lane is empty: ${fmt(s.unused_right[PT].mean, 0)}% (PT as practised), ${fmt(s.unused_right.pt2014_ideal.mean, 0)}% (perfect compliance), ${fmt(s.unused_right[LI].mean, 0)}% (lane integrity). Mean delay per vehicle: ${fmt(s.delay[PT].mean, 0)} s / ${fmt(s.delay.pt2014_ideal.mean, 0)} s / ${fmt(s.delay[LI].mean, 0)} s.`,
    `<b>The grey-area crash</b> (inner-lane car leaving across an outer-lane car that didn't exit, with both breaking the PT rule): ${fmt(s.crashes_grey[PT].mean, 2)} per 1000 vehicles under PT 2014 as practised. Under lane integrity the same geometric conflict exists, but it isn't grey: the car leaving the inner lane must give way. Rate: ${fmt(s.crashes_cut[LI].mean, 2)} per 1000.`,
    `<b>All crashes:</b> lane integrity vs PT 2014 as practised: ${phrase(cmp(res, 'crashes', LI, PT))}. vs PT 2014 with perfect compliance: ${phrase(cmp(res, 'crashes', LI, 'pt2014_ideal'))}. Near misses: ${phrase(cmp(res, 'conflicts', LI, PT))}.`,
  ];
  if (s.crashes.turbo)
    items.push(
      `<b>Turbo roundabout</b> (the PT idea enforced by dividers): crashes vs PT 2014 as practised: ${phrase(cmp(res, 'crashes', 'turbo', PT))}. vs lane integrity: ${phrase(cmp(res, 'crashes', 'turbo', LI))}. Mean delay: ${fmt(s.delay.turbo.mean, 0)} s. Left queue ≥4 with the right lane empty: ${fmt(s.unused_right.turbo.mean, 0)}% of the time.`,
    );
  if (total < 150) items.push(`<span style="color:var(--bad)">Only ${total} crashes in total, so increase replicates or minutes for firmer conclusions.</span>`);
  return el('div', { class: 'verdict', html: `<h3>What this run says</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` });
}
