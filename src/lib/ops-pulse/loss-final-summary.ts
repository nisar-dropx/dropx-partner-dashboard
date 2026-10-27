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
    (!slp && plan.source_status !== row.source_status)
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
export function finalRecoverySummary(
  rows: { amount: number | null; recoverable: boolean; updated: boolean }[],
) {
  const sum = (items: typeof rows) =>
    Math.round(items.reduce((n, r) => n + Number(r.amount || 0), 0) * 100) /
    100;
  const updated = rows.filter((r) => r.recoverable && r.updated),
    pending = rows.filter((r) => r.recoverable && !r.updated),
    excluded = rows.filter((r) => !r.recoverable);
  return {
    count: rows.length,
    amount: sum(rows),
    updated: updated.length,
    updatedAmount: sum(updated),
    pendingUpdate: pending.length,
    pendingUpdateAmount: sum(pending),
    nonrecoverable: excluded.length,
    nonrecoverableAmount: sum(excluded),
  };
}
