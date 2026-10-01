type OngoingMappingEdit = {
  existingEffectiveFrom: string;
  existingEffectiveTo: string | null;
  requestedEffectiveFrom: string;
  requestedEffectiveTo: string | null;
};

export function ongoingMappingClosureError(edit: OngoingMappingEdit) {
  const closesExistingPeriod = edit.existingEffectiveTo === null
    && Boolean(edit.requestedEffectiveTo)
    && edit.requestedEffectiveFrom <= edit.existingEffectiveFrom;

  return closesExistingPeriod
    ? "An ongoing mapping cannot end without its next payment period. To change the rate, set Effective from to the next period start; the previous period will close on the preceding day. Use offboarding to end the assignment."
    : null;
}
