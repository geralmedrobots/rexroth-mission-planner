import { alignedReverseRequest, auditReverseChoice } from '../tests/fixtures/reverseChoiceAudit';

const reports = [
  { name: 'defaults', reverse: 2, switchCost: 1, goalHeading: true },
  { name: 'UI reverse risk zero, independent switch unchanged', reverse: 0, switchCost: 1, goalHeading: true },
  { name: 'both reverse costs low', reverse: .01, switchCost: .01, goalHeading: true },
  { name: 'no final heading, UI reverse risk zero', reverse: 0, switchCost: 1, goalHeading: false },
].map(({ name, reverse, switchCost, goalHeading }) => {
  const { result, alternatives } = auditReverseChoice(alignedReverseRequest(reverse, switchCost, goalHeading));
  return { name, synthetic: true, start: { x: 3, y: 2, theta: 0 }, goal: { x: 2, y: 2 },
    goalTheta: goalHeading ? 0 : null, alternatives,
    started: result.motionPlannerEvents!.find((event) => event.eventType === 'motionplanner.started'),
    selected: result.motionPlan?.diagnostics?.selected,
    completed: result.motionPlannerEvents!.find((event) => event.eventType === 'motionplanner.completed'),
    initialDirectionChange: result.motionPlannerEvents!.find((event) =>
      event.eventType === 'motionplanner.transition.candidate' && event.transitionType === 'DIRECTION_CHANGE') };
});
console.log(JSON.stringify(reports, null, 2));
