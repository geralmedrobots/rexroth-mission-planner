import type { PlannerRequest } from '../../../domain/planner/PlannerService';
import type { PlannerResult } from '../../../domain/types';

/** Same worker entry point as PlannerService. Cancellation affects only this
 * isolated diagnostic run, never an operational planner or mission. */
export class DiagnosticPlannerRunner {
  private pending?: { worker: Worker; reject: (reason: Error) => void };
  public cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { pending.worker.terminate(); pending.reject(new Error('Diagnostic planning cancelled.')); }
  }
  public plan(request: PlannerRequest): Promise<PlannerResult> {
    this.cancel();
    const worker = new Worker(new URL('../../../workers/planner.worker.ts', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      this.pending = { worker, reject };
      const finish = () => {
        if (this.pending?.worker === worker) this.pending = undefined;
        worker.terminate();
      };
      worker.onmessage = (event: MessageEvent<PlannerResult>) => { finish(); resolve(event.data); };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      try { worker.postMessage(request); }
      catch (error) { finish(); reject(error); }
    });
  }
}
