import type { MetricDef, RuleDef } from '../shared/experiment';
import type { RoundaboutRule } from './model';

export const ROUNDABOUT_RULES: RuleDef<RoundaboutRule>[] = [
  {
    id: 'pt2014',
    label: 'PT 2014 rule, as practised',
    short: 'PT 2014 (real)',
    color: '#4f8cff',
    description:
      'The current Código da Estrada. Use the right lane only for the 1st exit. For any other exit, enter on the left lane and move to the outer lane after passing the exit before yours. A car in the outer lane must leave at the next exit. Drivers are modelled realistically: some keep their old habits, some cut straight from the inner lane into the 2nd exit lane, and some jump the left-lane queue by using the empty right lane.',
  },
  {
    id: 'pt2014_ideal',
    label: 'PT 2014 rule, perfect compliance',
    short: 'PT 2014 (ideal)',
    color: '#2fbf71',
    description:
      'The same rule as everyone is supposed to follow it: no cutting across, no queue jumping, no old habits. This is the rule "in theory". If a driver can\'t merge out in time, they go round again.',
  },
  {
    id: 'lane_integrity',
    label: 'Lane integrity (UK Highway Code style)',
    short: 'Lane integrity',
    color: '#f2a93b',
    description:
      'Your preference, and essentially UK Highway Code rule 186. Right lane for the 1st and (if its queue is shorter) the 2nd exit, left lane for the 2nd, 3rd and 4th. Stay in your lane all the way round. The outer lane can carry on past exits. Inner-lane cars leave directly into the 2nd exit lane, giving way to outer-lane cars that are carrying on.',
  },
  {
    id: 'turbo',
    label: 'Turbo / spiral roundabout (Dutch style)',
    short: 'Turbo',
    color: '#c46cf0',
    description:
      'The PT 2014 idea enforced by geometry instead of by law. Raised lane dividers fix your route at entry: the right lane goes only to the 1st exit, the left lane to every other exit. The outer lane ends at each exit, so every car in it must leave there. Inner-lane cars leave directly into the 2nd exit lane, which is safe because no outer-lane car can carry on past them. No lane changes inside the ring are possible.',
  },
];

export const ROUNDABOUT_METRICS: MetricDef[] = [
  { key: 'crashes', label: 'Crashes, all', unit: 'per 1000 vehicles', better: 'lower', headline: true, help: 'Inflated on purpose. Compare between rules only.' },
  { key: 'crashes_entry', label: 'Crashes, entering car vs circulating car', unit: 'per 1000 veh', better: 'lower' },
  { key: 'crashes_ring_lc', label: 'Crashes, lane change inside the ring', unit: 'per 1000 veh', better: 'lower', headline: true },
  { key: 'crashes_cut', label: 'Crashes, inner-lane exiter vs outer-lane car', unit: 'per 1000 veh', better: 'lower', headline: true },
  { key: 'crashes_grey', label: '  of which the "grey area" (both breaking the PT rule)', unit: 'per 1000 veh', better: 'lower' },
  { key: 'crashes_rear', label: 'Crashes, rear-end', unit: 'per 1000 veh', better: 'lower' },
  { key: 'crashes_in_lane_victim', label: 'Crashes where a car keeping its lane was hit from the side', unit: 'per 1000 veh', better: 'lower', headline: true, help: 'This tests your "sanctity of lane integrity" argument.' },
  { key: 'conflicts', label: 'Near misses (< 0.6 m)', unit: 'per 100 veh', better: 'lower', headline: true },
  { key: 'hard_brakes', label: 'Hard braking (> 4 m/s²)', unit: 'per 100 veh', better: 'lower' },
  { key: 'ring_lc', label: 'Lane changes inside the ring', unit: 'per 100 veh', better: 'lower' },
  { key: 'inner_exits', label: 'Exits straight from the inner lane', unit: 'per 100 veh', better: 'none' },
  { key: 'go_arounds', label: 'Extra laps (missed the exit)', unit: 'per 100 veh', better: 'lower' },
  { key: 'delay', label: 'Mean delay per vehicle', unit: 's', better: 'lower', headline: true },
  { key: 'throughput', label: 'Throughput', unit: 'veh/h', better: 'higher' },
  { key: 'wait_upstream', label: 'Wait before even reaching the approach', unit: 's/veh', better: 'lower', help: 'Queue spill-back beyond the 120 m approach.' },
  { key: 'queue_left', label: 'Mean queue, left entry lane', unit: 'veh', better: 'lower', headline: true },
  { key: 'queue_right', label: 'Mean queue, right entry lane', unit: 'veh', better: 'lower', headline: true },
  { key: 'unused_right', label: 'Time with a left queue ≥4 and an empty right lane', unit: '% of time', better: 'lower', headline: true, help: 'Your "abomination" metric.' },
  { key: 'right_share', label: 'Entering via the right lane', unit: '%', better: 'none' },
  { key: 'crash_count', label: 'Crash count (raw)', better: 'none', digits: 0 },
];
