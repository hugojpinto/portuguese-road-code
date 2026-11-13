import '../shared/style.css';
import { buildExperimentPanel } from '../shared/experimentPanel';
import { buildControls, el, fmtClock, renderKv, setupThemeToggle, type ControlGroup } from '../shared/ui';
import { ROUNDABOUT_METRICS, ROUNDABOUT_RULES } from './meta';
import { CRASH_LABELS, DEFAULT_ROUNDABOUT, RoundaboutSim, roundaboutMetrics, type RoundaboutParams } from './model';
import { RoundaboutView } from './render';
import { roundaboutVerdict } from './verdict';
import RoundaboutWorker from './worker?worker&inline';

if (__STANDALONE__) document.getElementById('home-link')?.remove();

const state: RoundaboutParams = structuredClone(DEFAULT_ROUNDABOUT);
state.seed = Math.floor(Math.random() * 1e6);
const pct = (v: number) => `${Math.round(v * 100)}%`;

const groups: ControlGroup[] = [
  { title: 'Rule', controls: [{ kind: 'select', key: 'rule', label: 'Roundabout rule', options: ROUNDABOUT_RULES.map((r) => ({ value: r.id, label: r.label })) }] },
  {
    title: 'Traffic',
    open: true,
    controls: [
      { kind: 'range', key: 'demandMain', label: 'Main road (E, W), per arm', min: 100, max: 1000, step: 25, format: (v) => `${v} veh/h` },
      { kind: 'range', key: 'demandSide', label: 'Side road (N, S), per arm', min: 50, max: 1000, step: 25, format: (v) => `${v} veh/h` },
      { kind: 'range', key: 'turns.0', label: '1st exit (right)', min: 0, max: 1, step: 0.05, format: pct },
      { kind: 'range', key: 'turns.1', label: '2nd exit (straight)', min: 0, max: 1, step: 0.05, format: pct },
      { kind: 'range', key: 'turns.2', label: '3rd exit (left)', min: 0, max: 1, step: 0.05, format: pct },
      { kind: 'range', key: 'turns.3', label: '4th exit (U-turn)', min: 0, max: 0.5, step: 0.05, format: pct, help: 'Shares are normalised, so they don\'t need to add up to 100%.' },
    ],
  },
  {
    title: 'How drivers really behave under PT 2014',
    open: true,
    controls: [
      { kind: 'range', key: 'compliance', label: 'Follow the lane-by-exit rule', min: 0, max: 1, step: 0.05, format: pct, help: 'The rest keep the old habit: lane by queue length, then stay in their lane.' },
      { kind: 'range', key: 'cutAcrossShare', label: 'Leave straight from the inner lane', min: 0, max: 1, step: 0.05, format: pct, help: 'Instead of moving to the outer lane first, they cut directly into exit lane 2.' },
      { kind: 'range', key: 'queueJumpShare', label: 'Use the empty right lane when the left queues', min: 0, max: 1, step: 0.05, format: pct, help: 'Then they stay in the outer lane past exits, against the rule.' },
      { kind: 'range', key: 'ruleTrust', label: 'Assume outer-lane cars will exit', min: 0, max: 1, step: 0.05, format: pct, help: 'Inner-lane drivers who trust that a non-signalling outer-lane car will exit "because it must".' },
      { kind: 'range', key: 'signalShare', label: 'Signal before exiting', min: 0, max: 1, step: 0.05, format: pct },
      { kind: 'range', key: 'falseSignalShare', label: 'Misleading signals', min: 0, max: 0.3, step: 0.01, format: pct },
    ],
  },
  {
    title: 'Human factors (same for every rule)',
    controls: [
      { kind: 'range', key: 'human.lapseRate', label: 'Short distractions', min: 0, max: 4, step: 0.1, format: (v) => `${v}/min` },
      { kind: 'range', key: 'human.longLapseRate', label: 'Long distractions', min: 0, max: 1.5, step: 0.05, format: (v) => `${v}/min` },
      { kind: 'range', key: 'human.longLapseDur', label: '  mean duration', min: 1, max: 6, step: 0.1, format: (v) => `${v} s` },
      { kind: 'range', key: 'human.missProb', label: 'Miss a car when checking', min: 0, max: 0.02, step: 0.0005, format: (v) => `${(v * 100).toFixed(2)}%` },
      { kind: 'range', key: 'human.blindSpotMult', label: '  ×, if in blind spot', min: 1, max: 20, step: 0.5, format: (v) => `×${v}` },
    ],
  },
];

const controlsHost = document.getElementById('controls')!;
const ruleDesc = el('div', { class: 'rule-desc' });
const updateRuleDesc = () => (ruleDesc.textContent = ROUNDABOUT_RULES.find((r) => r.id === state.rule)!.description);
buildControls(controlsHost, groups, state, () => {
  updateRuleDesc();
  reset();
});
controlsHost.children[0].after(ruleDesc);
updateRuleDesc();

const view = new RoundaboutView(document.getElementById('main') as HTMLCanvasElement);
let sim = new RoundaboutSim(structuredClone({ ...state, warmup: 0 }));
let running = true;
let acc = 0;
let lastFrame = performance.now();
let lastPanel = 0;
let lastLogged = -1;
const logHost = document.getElementById('log')!;
const liveHost = document.getElementById('live')!;
const clock = document.getElementById('clock')!;
const speedSel = document.getElementById('speed') as HTMLSelectElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;

function reset(): void {
  sim = new RoundaboutSim(structuredClone({ ...state, warmup: 0 }));
  while (sim.t < 120) sim.step();
  sim.resetCounters();
  lastLogged = -1;
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
setupThemeToggle(document.getElementById('theme') as HTMLButtonElement);

function updatePanels(): void {
  const c = sim.c;
  const m = roundaboutMetrics(sim);
  const total = Object.values(c.crashes).reduce((a, b) => a + b, 0);
  renderKv(liveHost, [
    ['vehicles finished', String(c.finished)],
    ['mean delay', `${Number.isFinite(m.delay) ? m.delay.toFixed(1) : '–'} s`],
    ['throughput', `${c.finished ? m.throughput.toFixed(0) : '–'} veh/h`],
    'sep',
    ['crashes', String(total), total > 0],
    ...(Object.keys(c.crashes) as (keyof typeof c.crashes)[]).map((k) => [`  ${CRASH_LABELS[k].toLowerCase()}`, String(c.crashes[k])] as [string, string]),
    ['  grey-area', String(c.greyArea)],
    ['  car in its lane hit from side', String(c.inLaneVictim)],
    ['near misses', String(c.conflicts)],
    'sep',
    ['lane changes in the ring', String(c.ringLc)],
    ['exits from the inner lane', String(c.innerExits)],
    ['extra laps', String(c.goArounds)],
    'sep',
    ['avg queue, left lanes', m.queue_left.toFixed(1)],
    ['avg queue, right lanes', m.queue_right.toFixed(1)],
    ['left queue ≥4, right empty', `${m.unused_right.toFixed(0)}% of time`],
    ['entering via right lane', `${m.right_share.toFixed(0)}%`],
  ]);
  const fresh = sim.crashes.filter((x) => x.t > lastLogged);
  if (fresh.length) {
    if (lastLogged < 0) logHost.replaceChildren();
    for (const cr of fresh) {
      const tags = [cr.greyArea ? 'grey area: both broke the PT rule' : '', cr.inLaneVictim ? 'victim was keeping its lane' : '', cr.miss ? 'a car was not seen' : ''].filter(Boolean).join(', ');
      logHost.prepend(el('div', {}, el('span', { class: 't' }, fmtClock(cr.t)), CRASH_LABELS[cr.type], tags ? el('span', { class: 'muted' }, ` (${tags})`) : null));
      lastLogged = cr.t;
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
  rules: ROUNDABOUT_RULES,
  metrics: ROUNDABOUT_METRICS,
  baseline: 'pt2014',
  makeWorker: () => new RoundaboutWorker(),
  getParams: () => structuredClone(state),
  verdict: roundaboutVerdict,
  defaultReps: 8,
  defaultMinutes: 30,
  intro:
    'Runs every rule against exactly the same random traffic, using the parameters on the left, then reports means with 95% confidence intervals. The first 5 simulated minutes of each run are warm-up. The two PT 2014 columns isolate the effect of the rule itself (perfect compliance) from the effect of how people actually drive under it.',
});
