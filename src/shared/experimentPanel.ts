import type { ExperimentResult, MetricDef, RuleDef } from './experiment';
import { barChart, el, resultsTable } from './ui';

export interface WorkerRequest {
  params: any;
  rules: string[];
  reps: number;
  duration: number;
}
export type WorkerMessage = { type: 'progress'; done: number; total: number } | { type: 'done'; result: ExperimentResult<string> };

export interface ExperimentPanelOptions<R extends string> {
  rules: RuleDef<R>[];
  metrics: MetricDef[];
  baseline: R;
  makeWorker: () => Worker;
  getParams: () => any;
  verdict: (res: ExperimentResult<R>) => HTMLElement;
  defaultReps: number;
  defaultMinutes: number;
  intro: string;
}

export function buildExperimentPanel<R extends string>(host: HTMLElement, o: ExperimentPanelOptions<R>): void {
  const reps = el('input', { type: 'number', min: '2', max: '60', value: String(o.defaultReps), style: 'width:60px' }) as HTMLInputElement;
  const minutes = el('input', { type: 'number', min: '5', max: '240', value: String(o.defaultMinutes), style: 'width:60px' }) as HTMLInputElement;
  const run = el('button', { class: 'primary' }, 'Run comparison') as HTMLButtonElement;
  const bar = el('div');
  const prog = el('div', { class: 'progress' }, bar);
  const status = el('span', { class: 'muted mono', style: 'font-size:12px' });
  const out = el('div');
  let worker: Worker | null = null;

  run.addEventListener('click', () => {
    if (worker) {
      worker.terminate();
      worker = null;
      run.textContent = 'Run comparison';
      status.textContent = 'cancelled';
      return;
    }
    worker = o.makeWorker();
    const t0 = performance.now();
    run.textContent = 'Cancel';
    out.replaceChildren();
    const req: WorkerRequest = {
      params: o.getParams(),
      rules: o.rules.map((r) => r.id),
      reps: Math.max(2, Number(reps.value) || o.defaultReps),
      duration: Math.max(60, (Number(minutes.value) || o.defaultMinutes) * 60),
    };
    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      if (m.type === 'progress') {
        bar.style.width = `${(100 * m.done) / m.total}%`;
        const el_ = (performance.now() - t0) / 1000;
        const eta = (el_ / m.done) * (m.total - m.done);
        status.textContent = `${m.done}/${m.total} runs · ~${Math.ceil(eta)}s left`;
      } else {
        const res = m.result as ExperimentResult<R>;
        worker?.terminate();
        worker = null;
        run.textContent = 'Run again';
        status.textContent = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${res.reps} replicates × ${res.duration / 60} min per rule`;
        out.replaceChildren(
          o.verdict(res),
          el('div', { class: 'charts' }, ...o.metrics.filter((x) => x.headline).map((mt) => barChart(res, mt, o.rules))),
          resultsTable(res, o.metrics, o.rules, o.baseline),
        );
      }
    };
    worker.postMessage(req);
  });

  host.append(
    el('h2', {}, 'Monte-Carlo comparison of all rule sets'),
    el('p', { class: 'muted' }, o.intro),
    el('div', { class: 'btnrow' }, el('label', { class: 'muted' }, 'Replicates ', reps), el('label', { class: 'muted' }, 'Minutes each ', minutes), run, prog, status),
    out,
  );
}
