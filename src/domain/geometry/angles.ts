export const normalizeAngle = (angle: number): number => {
  if (!Number.isFinite(angle)) throw new Error('Angle must be finite');
  let result = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (Object.is(result, -Math.PI) && angle > 0) result = Math.PI;
  return result;
};
export const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;
export const radiansToDegrees = (radians: number): number => (radians * 180) / Math.PI;
