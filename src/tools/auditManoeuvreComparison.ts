import { compareManoeuvres, manoeuvreRequest } from '../tests/fixtures/manoeuvreComparison';

for (const obstacle of [false, true]) {
  const { result, selection } = compareManoeuvres(manoeuvreRequest(-3.5186, .254, obstacle));
  console.log(JSON.stringify({ synthetic: true, obstacle, selection,
    actions: result.motionPlan?.actions.map((a) => ({ type: a.type,
      rotationRad: a.rotationRad, distanceM: a.distanceM })),
    selectedCost: result.motionPlan?.metadata.cost }, null, 2));
}
