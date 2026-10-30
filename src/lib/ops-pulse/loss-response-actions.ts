/** UI surfaces are deliberately separate; the API independently enforces role/scope. */
export function responseActions({enabled, state, canManage, stationView, readOnly}: {
  enabled: boolean; state: string; canManage: boolean; stationView: boolean; readOnly: boolean;
}): string[] {
  if (!enabled || readOnly) return [];
  if (stationView) return ["awaiting_station", "returned", "legacy"].includes(state) ? ["response"] : [];
  if (!canManage) return [];
  if (state === "awaiting_review") return ["approve", "return"];
  if (["approved", "with_vendor"].includes(state)) return ["tracking", "won", "lost"];
  // Enable/disable belongs to Manage exceptions and the tracking queue, never this form.
  return [];
}
