/**
 * Live NL/SLP loss case workflow. Money still moves only after SLP approval via payroll/payouts.
 * Approver identity is enforced in the app; the database enforces the state machine and no self-approve.
 */
export const LIFECYCLE_STATUSES = [
  "imported",
  "station_dispute_or_clarification_window",
  "cluster_validation_pending",
  "slp_final_confirmation_pending",
  "recovery_approved_scheduled",
  "recovery_in_progress",
  "recovered",
  "returned_to_station",
  "rejected",
  "not_recoverable",
  "on_hold",
  "needs_review",
  "exit_balance",
  "written_off",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  imported: "Imported",
  station_dispute_or_clarification_window: "Station dispute / clarification",
  cluster_validation_pending: "Awaiting cluster validation",
  slp_final_confirmation_pending: "Awaiting exception approval",
  recovery_approved_scheduled: "Recovery approved · scheduled",
  recovery_in_progress: "Recovery in progress",
  recovered: "Recovered",
  returned_to_station: "Returned to station",
  rejected: "Rejected",
  not_recoverable: "Not recoverable",
  on_hold: "On hold",
  needs_review: "Needs review",
  exit_balance: "Exit balance",
  written_off: "Written off",
};

export type LifecycleAction =
  | "open_station_window"
  | "ready_for_cluster"
  | "return_to_station"
  | "reject"
  | "hold"
  | "resume"
  | "mark_needs_review"
  | "clear_needs_review"
  | "propose"
  | "approve"
  | "clarify";

const CLUSTER_ACTIONS = new Set<LifecycleAction>([
  "ready_for_cluster",
  "return_to_station",
  "propose",
  "clear_needs_review",
  "mark_needs_review",
]);
const SLP_ACTIONS = new Set<LifecycleAction>([
  "approve",
  "return_to_station",
  "hold",
  "resume",
  "mark_needs_review",
]);
const STATION_ACTIONS = new Set<LifecycleAction>(["clarify", "propose"]);

export function lifecycleLabel(status: string | null | undefined) {
  if (status && status in LIFECYCLE_LABELS) return LIFECYCLE_LABELS[status as LifecycleStatus];
  return status || "Unknown";
}

/** Station users may submit updates; final approval and write-off remain restricted. */
export function stationMayAct(action: LifecycleAction) {
  return STATION_ACTIONS.has(action);
}

export function clusterMayAct(action: LifecycleAction) {
  return CLUSTER_ACTIONS.has(action);
}

export function slpMayAct(action: LifecycleAction) {
  return SLP_ACTIONS.has(action);
}

export function lossesDeepLink(input: {
  report?: string | null;
  month: string;
  station?: string | null;
  caseKey?: string | null;
  lifecycle?: string | null;
  /** When report is slp: false → slp-initial, true/omit → slp-final. */
  slpFinal?: boolean | null;
}) {
  // Losses tabs are nl | slp-initial | slp-final — never a bare /slp path.
  const section =
    input.report === "slp"
      ? input.slpFinal === false
        ? "slp-initial"
        : "slp-final"
      : "nl";
  const q = new URLSearchParams({ month: input.month });
  if (input.station) q.set("station", input.station);
  if (input.caseKey) q.set("case", input.caseKey);
  if (input.lifecycle) q.set("lifecycle", input.lifecycle);
  return `/team-ops/losses/${section}?${q}`;
}
