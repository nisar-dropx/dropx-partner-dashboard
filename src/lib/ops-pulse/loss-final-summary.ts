/** Exact aliases used by Amazon live/historic exports for the same recovery outcome. */
export function recoverySourceStatusKey(status: string | null | undefined) {
  return [
    "Recoverable - Missed SLA by eDSP",
    "Recoverable - Missed SLA by eDSP1",
    "Recoverable - Missed SLA by eDSP2",
  ].includes(status ?? "")
    ? "Recoverable - Missed SLA by eDSP"
    : status;
}

/** A saved recovery update is distinct from money deducted or an Amazon dispute win. */
export function recoveryDetailsUpdated(
  row: { amount: number | null; source_status: string | null },
  plan: any,
  slp = false,
) {
  if (
    !plan ||
    plan.is_deleted ||
    ["returned", "needs_review"].includes(plan.approval_status) ||
    Number(plan.source_amount) !== Number(row.amount) ||
    (!slp && recoverySourceStatusKey(plan.source_status) !== recoverySourceStatusKey(row.source_status))
  )
    return false;
  if (plan.outcome_code === "responsible_left")
    return (
      !!plan.recovery_details?.employee_id && !!plan.recovery_details?.follow_up
    );
  if (plan.outcome_code === "already_recovered")
    return !!plan.recovery_details?.receipt_reference;
  return (
    ["approved", "proposed"].includes(plan.approval_status) &&
    Array.isArray(plan.allocations) &&
    plan.allocations.length > 0 &&
    Math.round(
      plan.allocations.reduce(
        (n: number, a: any) => n + Number(a.amount || 0),
        0,
      ) * 100,
    ) === Math.round(Number(row.amount) * 100)
  );
}

export type RedisputeSummaryState = {
  enabled?: boolean;
  workflow_status?: string | null;
} | null | undefined;

/** Redisputes have their own work queue; they are not missing recovery-plan updates. */
export function isRedisputeSummaryCase(redispute: RedisputeSummaryState) {
  const status = String(redispute?.workflow_status || "legacy");
  return Boolean(
    status === "won" ||
      (redispute?.enabled && !["lost", "cancelled", "closed"].includes(status)),
  );
}

/** Station evidence is still due only before submission or after a returned review. */
export function redisputeNeedsStationUpdate(redispute: RedisputeSummaryState) {
  return Boolean(
    redispute?.enabled &&
      ["awaiting_station", "returned", "legacy"].includes(
        String(redispute.workflow_status || "legacy"),
      ),
  );
}

/** Existing station update views stay binary without exposing the management breakdown. */
export function stationRecoveryUpdateComplete(
  row: {
    amount: number | null;
    source_status: string | null;
    redispute?: RedisputeSummaryState;
  },
  plan: any,
  slp = false,
) {
  return (
    recoveryDetailsUpdated(row, plan, slp) ||
    (isRedisputeSummaryCase(row.redispute) &&
      !redisputeNeedsStationUpdate(row.redispute))
  );
}

export function finalRecoverySummary(
  rows: {
    amount: number | null;
    recoverable: boolean;
    updated: boolean;
    redispute?: boolean;
  }[],
) {
  const sum = (items: typeof rows) =>
    Math.round(items.reduce((n, r) => n + Number(r.amount || 0), 0) * 100) /
    100;
  const updated = rows.filter(
      (r) => r.recoverable && r.updated && !r.redispute,
    ),
    redispute = rows.filter((r) => r.redispute),
    pending = rows.filter(
      (r) => r.recoverable && !r.updated && !r.redispute,
    ),
    excluded = rows.filter((r) => !r.recoverable);
  return {
    count: rows.length,
    amount: sum(rows),
    updated: updated.length,
    updatedAmount: sum(updated),
    redispute: redispute.length,
    redisputeAmount: sum(redispute),
    pendingUpdate: pending.length,
    pendingUpdateAmount: sum(pending),
    nonrecoverable: excluded.length,
    nonrecoverableAmount: sum(excluded),
  };
}
