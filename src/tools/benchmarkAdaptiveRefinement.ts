import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MotionStatePlanner } from '../domain/planning/MotionStatePlanner';
import { openRefinementFixture, refinementFixture } from '../tests/fixtures/adaptiveRefinement';
import { sendBoxScaleRequest } from '../tests/fixtures/sendBoxScale';
import type { PlannerResult } from '../domain/types';

// Optional first argument: a saved pre-change planner module in this workspace.
// Without it this is a repeatable benchmark of the current implementation.
const baselinePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const baselineModule = baselinePath ? await import(pathToFileURL(baselinePath).href) as
  { MotionStatePlanner: typeof MotionStatePlanner } : undefined;
const cases = {
  'open-18m': openRefinementFixture(18),
  'warehouse-open': sendBoxScaleRequest('open'),
  'warehouse-clutter': sendBoxScaleRequest('clutter'),
  'warehouse-detour': sendBoxScaleRequest('detour'),
  'tight-turn-0.10-map': refinementFixture(.4, .45, .22, .025),
  'narrow-0.05-map': refinementFixture(.4, .45, .22, .025, .05),
  'medium-passage': refinementFixture(.8, .35, .22, .025),
  'sealed-passage': refinementFixture(.4, .45, .22, .025),
};
for (let row = 0; row < cases['sealed-passage'].grid.metadata.height; row++)
  cases['sealed-passage'].grid.data[row * 40 + 20] = 100;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const summary = (results: PlannerResult[]) => ({
  successes: results.filter((result) => result.success).length,
  runs: results.length,
  medianExpanded: median(results.map((result) => result.statistics.visitedCells)),
  medianPlanningMs: median(results.map((result) => result.statistics.durationMs)),
  medianFinalNodes: median(results.map((result) => result.statistics.finalPointCount)),
  samples: results.map((result) => ({ success: result.success,
    expanded: result.statistics.visitedCells, planningMs: result.statistics.durationMs,
    nodes: result.statistics.finalPointCount })),
  diagnostics: results.at(-1)!.motionPlannerEvents!.find(
    (event) => event.eventType === 'motionplanner.completed'),
});
const comparisons = [];
for (const [name, request] of Object.entries(cases)) {
  const before: PlannerResult[] = []; const after: PlannerResult[] = [];
  // Warm each implementation/fixture; alternate measured execution order to
  // reduce JIT/cache/order bias. Report wall time, including postprocessing.
  if (baselineModule) new baselineModule.MotionStatePlanner().plan(request);
  new MotionStatePlanner().plan(request);
  for (let run = 0; run < 5; run++) {
    if (run % 2 === 0 && baselineModule) before.push(new baselineModule.MotionStatePlanner().plan(request));
    after.push(new MotionStatePlanner().plan(request));
    if (run % 2 !== 0 && baselineModule) before.push(new baselineModule.MotionStatePlanner().plan(request));
  }
  comparisons.push({ name, before: before.length ? summary(before) : undefined, after: summary(after) });
}
console.log(JSON.stringify({ measuredAt: new Date().toISOString(),
  baselineSha256: baselinePath ? createHash('sha256').update(readFileSync(baselinePath)).digest('hex') : undefined,
  method: 'One warmup per implementation/case, five alternating runs; median wall time includes postprocessing. Synthetic maps.',
  comparisons }, null, 2));
