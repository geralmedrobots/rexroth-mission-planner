import type { RokitErrorHistoryEntry, VdaError } from '../types';

export const getRokitErrorKey = (error: VdaError): string => {
  const references = (error.errorReferences ?? [])
    .map((reference) => `${reference.referenceKey}:${reference.referenceValue}`)
    .sort()
    .join('|');
  return [error.errorType, error.errorLevel, error.errorDescription ?? '', references].join('::');
};

export const deduplicateRokitErrors = (errors: VdaError[]): VdaError[] => {
  const unique = new Map<string, VdaError>();
  errors.forEach((error) => unique.set(getRokitErrorKey(error), error));
  return [...unique.values()];
};

export const newlyRaisedRokitErrors = (
  previousCurrent:VdaError[],
  current:VdaError[],
):VdaError[]=>{
  const previousKeys=new Set(previousCurrent.map(getRokitErrorKey));
  return deduplicateRokitErrors(current).filter(
    (error)=>!previousKeys.has(getRokitErrorKey(error)));
};

export const appendErrorHistory = (
  previous: RokitErrorHistoryEntry[],
  current: VdaError[],
  receivedAt: string,
  orderId: string,
  maximumEntries = 500,
): RokitErrorHistoryEntry[] => [
  ...previous,
  ...deduplicateRokitErrors(current).map((error) => ({
    key: getRokitErrorKey(error),
    error,
    receivedAt,
    orderId: (error.errorReferences ?? []).find((reference) =>
      reference.referenceKey.toLowerCase().endsWith('orderid'))?.referenceValue ?? orderId,
  })),
].slice(-maximumEntries);
