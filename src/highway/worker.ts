import { runExperiment } from '../shared/experiment';
import type { WorkerRequest } from '../shared/experimentPanel';
import { runHighway, type HighwayRule } from './model';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { params, rules, reps, duration } = ev.data;
  const result = runExperiment(params, rules as HighwayRule[], reps, duration, runHighway, (done, total) => self.postMessage({ type: 'progress', done, total }));
  self.postMessage({ type: 'done', result });
};
