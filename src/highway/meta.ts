import type { MetricDef, RuleDef } from '../shared/experiment';
import type { HighwayRule } from './model';

export const HIGHWAY_RULES: RuleDef<HighwayRule>[] = [
  {
    id: 'eu_keep_right',
    label: 'EU / PT: keep right',
    short: 'EU keep-right',
    color: '#4f8cff',
    description:
      'Current Portuguese/EU rule. Drive in the rightmost free lane, use the others only to overtake and then return right. Passing on the right is forbidden (except in slow queues). A slower car in a middle or left lane is "in the wrong", so faster drivers feel licensed to tailgate and flash it.',
  },
  {
    id: 'speed_lanes',
    label: 'Speed lanes (overtake left only)',
    short: 'Speed lanes',
    color: '#2fbf71',
    description:
      'Your proposal. Each lane carries a steadier speed, increasing right to left. Pick the lane that matches your cruising speed and stay there. Overtake on the left, then go back to your own lane. Never block the leftmost lane. A car in a middle lane at that lane\'s speed is legal, so nobody is licensed to flash it.',
  },
  {
    id: 'speed_lanes_undertake',
    label: 'Speed lanes + passing on the right allowed',
    short: 'Speed lanes + right pass',
    color: '#f2a93b',
    description:
      'Your variant. Same speed lanes, but passing on the right is legal (like the US). Less weaving to the left, but more cars come up fast on the right of a driver who is changing lanes.',
  },
  {
    id: 'free_lanes',
    label: 'Free lanes (US/Middle-East style)',
    short: 'Free lanes',
    color: '#c46cf0',
    description:
      'Reference case. No lane preference: drivers use whichever lane is fastest and pass on either side. The only courtesy is not blocking the leftmost lane.',
  },
];

export const HIGHWAY_METRICS: MetricDef[] = [
  { key: 'crashes', label: 'Crashes, all', unit: 'per 10k veh·km', better: 'lower', headline: true, help: 'All collisions per 10,000 vehicle-km. Absolute values are inflated on purpose (error rates are exaggerated so crashes happen often enough to count). Compare between rule sets, not against real-world statistics.' },
  { key: 'crashes_lc', label: 'Crashes, lane change', unit: 'per 10k veh·km', better: 'lower', headline: true, help: 'Side-swipes and cut-ins while a car is changing lanes.' },
  { key: 'crashes_rear', label: 'Crashes, rear-end', unit: 'per 10k veh·km', better: 'lower', headline: true, help: 'Rear-end collisions, including those right after a cut-in.' },
  { key: 'crashes_cutin_rear', label: '  of which right after a cut-in', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'crashes_undertaker', label: 'Crashes, hit a car passing on the right', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'crashes_blindspot', label: 'Crashes, car in the blind spot', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'crashes_merge', label: 'Crashes, on-ramp merge', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'share_lc', label: 'Share of crashes linked to lane changes', unit: '0–1', better: 'none', help: 'Lane-change, merge and rear-end-after-cut-in crashes as a share of all crashes. This tests your first claim.' },
  { key: 'share_stressed', label: 'Share of crashes involving a stressed driver', unit: '0–1', better: 'none' },
  { key: 'lc_per_km', label: 'Lane changes per veh·km', better: 'lower', headline: true, help: 'How often drivers are exposed to the risky manoeuvre.' },
  { key: 'lc_overtake', label: '  to overtake', unit: 'per veh·km', better: 'none' },
  { key: 'lc_return', label: '  to return right / to own lane', unit: 'per veh·km', better: 'none' },
  { key: 'lc_yield', label: '  to get away from a tailgater', unit: 'per veh·km', better: 'none' },
  { key: 'aborted', label: 'Aborted lane changes (near misses)', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'conflicts', label: 'Conflicts (time-to-collision < 1.5 s)', unit: 'per 10k veh·km', better: 'lower', headline: true },
  { key: 'hard_brakes', label: 'Hard braking (> 4 m/s²)', unit: 'per 10k veh·km', better: 'lower' },
  { key: 'pressure_share', label: 'Time being tailgated/flashed', unit: '% of driving', better: 'lower', headline: true },
  { key: 'stress_mean', label: 'Mean driver stress', unit: '0–1', better: 'lower', digits: 3 },
  { key: 'speed', label: 'Mean speed', unit: 'km/h', better: 'higher', headline: true },
  { key: 'throughput', label: 'Throughput', unit: 'veh/h', better: 'higher' },
  { key: 'entry_wait', label: 'Mean wait to enter', unit: 's', better: 'lower' },
  { key: 'missed_exits', label: 'Missed the off-ramp', unit: '%', better: 'lower' },
  { key: 'lane_0', label: 'Lane use: right lane', unit: '%', better: 'none' },
  { key: 'lane_1', label: 'Lane use: lane 2', unit: '%', better: 'none' },
  { key: 'lane_2', label: 'Lane use: lane 3', unit: '%', better: 'none' },
  { key: 'crash_count', label: 'Crash count (raw)', better: 'none', digits: 0 },
];
