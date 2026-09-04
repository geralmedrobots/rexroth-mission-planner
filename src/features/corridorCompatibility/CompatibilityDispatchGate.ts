import type { ValidationIssue, VdaState } from '../../domain/types';

export const hasFiniteMotionFeedback=(state:VdaState|undefined):boolean=>{
  const velocity=state?.velocity;
  return Boolean(velocity&&[velocity.vx,velocity.vy,velocity.omega].every(Number.isFinite));
};

export const getCompatibilitySpecificDispatchIssues=(
  state:VdaState|undefined,
):ValidationIssue[]=>hasFiniteMotionFeedback(state)?[]:[{
  code:'compatibility.motionFeedback',
  message:'Compatibility testing requires finite vx, vy, and omega Motion Feedback in the current state.',
  severity:'error',
}];

