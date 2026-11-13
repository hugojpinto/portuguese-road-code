import { runExperiment } from '../shared/experiment';
import type { WorkerRequest } from '../shared/experimentPanel';
import { runRoundabout, type RoundaboutRule } from './model';

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { params, rules, reps, duration } = ev.data;
  const result = runExperiment(params, rules as RoundaboutRule[], reps, duration, runRoundabout, (done, total) => self.postMessage({ type: 'progress', done, total }));
  self.postMessage({ type: 'done', result });
};
