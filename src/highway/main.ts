import '../shared/style.css';
import { buildExperimentPanel } from '../shared/experimentPanel';
import { buildControls, el, fmtClock, renderKv, setupThemeToggle, type ControlGroup } from '../shared/ui';
import { HIGHWAY_METRICS, HIGHWAY_RULES } from './meta';
import { CRASH_LABELS, DEFAULT_HIGHWAY, HighwaySim, LC_CRASH_TYPES, type HighwayParams } from './model';
import { HighwayView, type ColorMode } from './render';
import { highwayVerdict } from './verdict';
import HighwayWorker from './worker?worker&inline';

if (__STANDALONE__) document.getElementById('home-link')?.remove();

const state: HighwayParams = structuredClone(DEFAULT_HIGHWAY);
state.seed = Math.floor(Math.random() * 1e6);

const pct = (v: number) => `${Math.round(v * 100)}%`;
const groups: ControlGroup[] = [
  {
    title: 'Rule',
    controls: [
      { kind: 'select', key: 'rule', label: 'Lane rule', options: HIGHWAY_RULES.map((r) => ({ value: r.id, label: r.label })) },
    ],
  },
  {
    title: 'Traffic',
    open: true,
    controls: [
      { kind: 'range', key: 'demand', label: 'Demand', min: 800, max: 6500, step: 100, format: (v) => `${v} veh/h` },
      { kind: 'range', key: 'lanes', label: 'Lanes', min: 2, max: 4, step: 1 },
      { kind: 'range', key: 'truckShare', label: 'Trucks', min: 0, max: 0.4, step: 0.01, format: pct },
      { kind: 'range', key: 'speedMean', label: 'Desired speed (mean)', min: 90, max: 150, step: 1, format: (v) => `${v} km/h` },
      { kind: 'range', key: 'speedSd', label: 'Desired speed (spread)', min: 0, max: 30, step: 1, format: (v) => `±${v} km/h`, help: 'Larger spread means more speed differences, so more reasons to overtake.' },
      { kind: 'range', key: 'rampShare', label: 'Entering at on-ramp', min: 0, max: 0.4, step: 0.01, format: pct },
      { kind: 'range', key: 'exitShare', label: 'Leaving at off-ramp', min: 0, max: 0.4, step: 0.01, format: pct },
    ],
  },
  {
    title: 'Driver behaviour',
    open: true,
    controls: [
      { kind: 'range', key: 'compliance', label: 'Rule compliance', min: 0, max: 1, step: 0.05, format: pct, help: 'The rest ignore lane discipline (e.g. middle-lane hoggers) and may pass on the right.' },
      { kind: 'range', key: 'flasherShare', label: 'Flash when the rule allows it', min: 0, max: 1, step: 0.05, format: pct, help: 'Drivers who tailgate and flash a slower car that is "in the wrong lane" under the current rule.' },
      { kind: 'range', key: 'aggressiveShare', label: 'Flash anyone, rule or not', min: 0, max: 0.3, step: 0.01, format: pct },
    ],
  },
  {
    title: 'Human factors (same for every rule)',
    controls: [
      { kind: 'range', key: 'human.lapseRate', label: 'Short distractions', min: 0, max: 4, step: 0.1, format: (v) => `${v}/min` },
      { kind: 'range', key: 'human.lapseDur', label: '  mean duration', min: 0.2, max: 3, step: 0.1, format: (v) => `${v} s` },
      { kind: 'range', key: 'human.longLapseRate', label: 'Long distractions (phone…)', min: 0, max: 1.5, step: 0.05, format: (v) => `${v}/min` },
      { kind: 'range', key: 'human.longLapseDur', label: '  mean duration', min: 1, max: 6, step: 0.1, format: (v) => `${v} s` },
      { kind: 'range', key: 'human.reactionMax', label: 'Max reaction time', min: 0.3, max: 1.2, step: 0.05, format: (v) => `${v} s` },
      { kind: 'range', key: 'human.missProb', label: 'Miss a car when checking', min: 0, max: 0.02, step: 0.0005, format: (v) => `${(v * 100).toFixed(2)}%` },
      { kind: 'range', key: 'human.blindSpotMult', label: '  ×, if in blind spot', min: 1, max: 20, step: 0.5, format: (v) => `×${v}` },
      { kind: 'range', key: 'human.fastApproachMult', label: '  ×, if approaching fast', min: 1, max: 10, step: 0.5, format: (v) => `×${v}` },
      { kind: 'range', key: 'human.stressMissGain', label: 'Stress → misses', min: 0, max: 8, step: 0.5, help: 'Your hypothesis: stress raises the miss probability by up to (1 + this)×. Set to 0 to switch it off.' },
      { kind: 'range', key: 'human.stressLapseGain', label: 'Stress → longer distractions', min: 0, max: 3, step: 0.1 },
      { kind: 'range', key: 'human.stressGapGain', label: 'Stress → forcing gaps', min: 0, max: 4, step: 0.5, format: (v) => `+${v} m/s²` },
    ],
  },
];

const controlsHost = document.getElementById('controls')!;
const ruleDesc = el('div', { class: 'rule-desc' });
const updateRuleDesc = () => (ruleDesc.textContent = HIGHWAY_RULES.find((r) => r.id === state.rule)!.description);
buildControls(controlsHost, groups, state, () => {
  updateRuleDesc();
  reset();
});
controlsHost.children[0].after(ruleDesc);
updateRuleDesc();

const view = new HighwayView(document.getElementById('main') as HTMLCanvasElement, document.getElementById('zoom') as HTMLCanvasElement);
let sim = new HighwaySim(structuredClone(state));
let running = true;
let acc = 0;
let lastFrame = performance.now();
let lastPanel = 0;
let loggedCrashes = 0;
const logHost = document.getElementById('log')!;
const liveHost = document.getElementById('live')!;
const clock = document.getElementById('clock')!;
const speedSel = document.getElementById('speed') as HTMLSelectElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;

function reset(): void {
  sim = new HighwaySim(structuredClone({ ...state, warmup: 0 }));
  // pre-fill the road (3 simulated minutes) so the animation starts with traffic, then zero the counters
  while (sim.t < 180) sim.step();
  sim.resetCounters();
  loggedCrashes = 0;
  logHost.innerHTML = '<span class="muted">no crashes yet</span>';
}

playBtn.addEventListener('click', () => {
  running = !running;
  playBtn.textContent = running ? 'Pause' : 'Play';
});
document.getElementById('reset')!.addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 1e6);
  reset();
});
(document.getElementById('color') as HTMLSelectElement).addEventListener('change', (e) => (view.colorMode = (e.target as HTMLSelectElement).value as ColorMode));
setupThemeToggle(document.getElementById('theme') as HTMLButtonElement);

function updatePanels(): void {
  const c = sim.c;
  const total = Object.values(c.crashes).reduce((a, b) => a + b, 0);
  const lcCr = LC_CRASH_TYPES.reduce((s, k) => s + c.crashes[k], 0) + c.crashes.merge;
  const lcTot = Object.values(c.lc).reduce((a, b) => a + b, 0);
  const laneTot = c.laneSeconds.reduce((a, b) => a + b, 0) || 1;
  renderKv(liveHost, [
    ['vehicles on road', String(sim.vehicles.length)],
    ['vehicle-km', c.vkm.toFixed(0)],
    ['mean speed', `${c.vehSeconds ? ((c.vkm * 3600) / c.vehSeconds).toFixed(0) : '–'} km/h`],
    'sep',
    ['crashes', String(total), total > 0],
    ['  lane change / merge', String(lcCr)],
    ['  rear-end', String(c.crashes.rear_end)],
    ['  rear-end after cut-in', String(c.crashes.rear_end_after_cut_in)],
    ['near misses (aborted LC)', String(c.lcAborted)],
    'sep',
    ['lane changes', String(lcTot)],
    ['  to overtake (left)', String(c.lc.pass_left)],
    ['  to pass on the right', String(c.lc.pass_right)],
    ['  back to the right', String(c.lc.return_right)],
    ['  to own speed lane', String(c.lc.to_pref_lane)],
    ['  escaping a tailgater', String(c.lc.yield)],
    ['  ramps', String(c.lc.merge + c.lc.exit)],
    ['per veh-km', c.vkm ? (lcTot / c.vkm).toFixed(2) : '–'],
    'sep',
    ['time being tailgated', `${c.vehSeconds ? ((100 * c.pressureSeconds) / c.vehSeconds).toFixed(1) : '–'}%`],
    ['flashing right now', String(sim.vehicles.filter((v) => v.pressuring).length)],
    ['stressed right now', String(sim.vehicles.filter((v) => v.stress > 0.3).length)],
    'sep',
    ...c.laneSeconds.map((s, i) => [`lane use: ${i === 0 ? 'right' : i === sim.p.lanes - 1 ? 'left' : `lane ${i + 1}`}`, `${((100 * s) / laneTot).toFixed(0)}%`] as [string, string]),
  ]);
  const newCrashes = sim.crashes.filter((x) => x.t > (loggedCrashes ? loggedCrashes : -1));
  if (newCrashes.length) {
    if (!loggedCrashes) logHost.replaceChildren();
    for (const cr of newCrashes) {
      const tags = [cr.perceptionMiss ? 'didn’t see the other car' : '', cr.stressed ? 'stressed driver' : ''].filter(Boolean).join(', ');
      logHost.prepend(el('div', {}, el('span', { class: 't' }, fmtClock(cr.t)), `${CRASH_LABELS[cr.type]} @ ${(cr.x / 1000).toFixed(2)} km`, tags ? el('span', { class: 'muted' }, ` (${tags})`) : null));
      loggedCrashes = cr.t;
    }
  }
}

function frame(now: number): void {
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running) {
    acc += dtReal * Number(speedSel.value);
    let n = 0;
    while (acc >= 0.1 && n < 600) {
      sim.step();
      acc -= 0.1;
      n++;
    }
    if (n >= 600) acc = 0;
  }
  view.draw(sim);
  clock.textContent = `sim time ${fmtClock(sim.t)}`;
  if (now - lastPanel > 300) {
    updatePanels();
    lastPanel = now;
  }
  requestAnimationFrame(frame);
}
reset();
requestAnimationFrame(frame);

buildExperimentPanel(document.getElementById('experiment')!, {
  rules: HIGHWAY_RULES,
  metrics: HIGHWAY_METRICS,
  baseline: 'eu_keep_right',
  makeWorker: () => new HighwayWorker(),
  getParams: () => structuredClone(state),
  verdict: highwayVerdict,
  defaultReps: 8,
  defaultMinutes: 20,
  intro:
    'Runs every rule set against exactly the same random traffic, using the parameters on the left, then reports means with 95% confidence intervals. The live animation above is one random sample. Use this comparison to draw conclusions. The first 4 simulated minutes of each run are warm-up and are not counted.',
});
