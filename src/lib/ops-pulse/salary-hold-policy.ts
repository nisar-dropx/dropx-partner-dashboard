/**
 * People salary hold workflow (shared by the server and the desk). The database function
 * ops_salary_hold_transition enforces the same rules; this module decides what to offer.
 *
 *   awaiting_approval → pending → applied → release_requested → released
 *   (reject → rejected, withdraw/cancel → cancelled)
 */

export type SalaryHoldStatus =
  | "awaiting_approval"
  | "rejected"
  | "pending"
  | "applied"
  | "cancel_requested"
  | "cancelled"
  | "release_requested"
  | "released";

export type SalaryHoldAction =
  | "approve"
  | "reject"
  | "withdraw"
  | "request_cancel"
  | "approve_cancel"
  | "reject_cancel"
  | "request_release"
  | "approve_release"
  | "reject_release";

export const HOLD_STATUS: Record<SalaryHoldStatus, { label: string; tone: "info" | "warn" | "good" | "danger" | "muted"; next: string }> = {
  awaiting_approval: { label: "Awaiting approval", tone: "warn", next: "Cluster manager to approve or reject" },
  rejected: { label: "Rejected", tone: "muted", next: "Closed" },
  pending: { label: "Approved · next payroll", tone: "info", next: "Withheld in the next payroll calculation" },
  applied: { label: "Withheld", tone: "danger", next: "Held in payroll until released" },
  cancel_requested: { label: "Cancellation requested", tone: "warn", next: "Cluster manager to decide the cancellation" },
  cancelled: { label: "Cancelled", tone: "muted", next: "Closed" },
  release_requested: { label: "Release requested", tone: "warn", next: "Cluster manager to approve the release" },
  released: { label: "Released", tone: "good", next: "Paid back in payroll" },
};

export const ACTION_COPY: Record<SalaryHoldAction, { label: string; noteRequired: boolean; confirm: string; tone: "primary" | "danger" | "secondary" }> = {
  approve: { label: "Approve hold", noteRequired: false, confirm: "The amount will be withheld in the next payroll.", tone: "primary" },
  reject: { label: "Reject", noteRequired: true, confirm: "The hold will not be applied.", tone: "danger" },
  withdraw: { label: "Withdraw", noteRequired: false, confirm: "Your request will be withdrawn before anyone decides it.", tone: "secondary" },
  request_cancel: { label: "Request cancellation", noteRequired: false, confirm: "The cluster manager decides whether to cancel it before payroll.", tone: "secondary" },
  approve_cancel: { label: "Approve cancellation", noteRequired: false, confirm: "The hold will not reach payroll.", tone: "primary" },
  reject_cancel: { label: "Keep the hold", noteRequired: true, confirm: "The hold stays approved for the next payroll.", tone: "danger" },
  request_release: { label: "Request release", noteRequired: true, confirm: "The cluster manager decides whether the withheld amount is paid back.", tone: "secondary" },
  approve_release: { label: "Approve release", noteRequired: false, confirm: "The withheld amount is paid back in payroll.", tone: "primary" },
  reject_release: { label: "Keep withholding", noteRequired: true, confirm: "The amount stays withheld.", tone: "danger" },
};

export const DECISIONS_BY_STATUS: Partial<Record<SalaryHoldStatus, SalaryHoldAction[]>> = {
  awaiting_approval: ["approve", "reject"],
  cancel_requested: ["approve_cancel", "reject_cancel"],
  release_requested: ["approve_release", "reject_release"],
};

/** What the person who raised a hold can still do with it. */
export function requesterActions(status: SalaryHoldStatus): SalaryHoldAction[] {
  if (status === "awaiting_approval") return ["withdraw"];
  if (status === "pending") return ["request_cancel"];
  if (status === "applied") return ["request_release"];
  return [];
}

/**
 * Decisions a viewer may take: they must be an approver of the hold's station and must not have made
 * the request being decided (raise, cancellation or release).
 */
export function approverActions(
  hold: { status: SalaryHoldStatus; requestedBy: string | null; cancelRequestedBy: string | null; releaseRequestedBy: string | null },
  viewerId: string,
  isApprover: boolean,
): SalaryHoldAction[] {
  if (!isApprover) return [];
  const asked =
    hold.status === "awaiting_approval" ? hold.requestedBy
    : hold.status === "cancel_requested" ? hold.cancelRequestedBy
    : hold.status === "release_requested" ? hold.releaseRequestedBy
    : null;
  if (asked && asked === viewerId) return [];
  return DECISIONS_BY_STATUS[hold.status] ?? [];
}

/**
 * Cluster managers decide; with none mapped, the station's Area Operations Managers do. The person who
 * made the request is never their own approver: when a cluster manager raises it, it goes to the AOM.
 */
export function holdApprovers(
  entry: { clusterManagers?: { personId: string; name: string }[]; areaOperationsManagers?: { personId: string; name: string }[] } | undefined,
  excludePersonIds: ReadonlySet<string> = new Set(),
) {
  const keep = (list: { personId: string; name: string }[] | undefined) => (list ?? []).filter((p) => !excludePersonIds.has(p.personId));
  const cms = keep(entry?.clusterManagers);
  const aoms = keep(entry?.areaOperationsManagers);
  const owners = cms.length ? cms : aoms;
  return {
    level: cms.length ? ("cluster_manager" as const) : owners.length ? ("aom" as const) : ("none" as const),
    personIds: [...new Set(owners.map((p) => p.personId))],
    names: [...new Set(owners.map((p) => p.name))],
  };
}

export function validateRaise(input: { holdType: string; amount: string; days: string; reason: string }) {
  if (input.holdType !== "amount" && input.holdType !== "days") return "Choose whether this hold is an amount or a number of days.";
  if (input.holdType === "amount") {
    const amount = Number(input.amount);
    if (!/^\d+(\.\d{1,2})?$/.test(input.amount.trim()) || amount <= 0 || amount > 1_000_000) return "Enter a hold amount between ₹0.01 and ₹10,00,000.";
  } else {
    const days = Number(input.days);
    if (!/^\d+(\.5)?$/.test(input.days.trim()) || days <= 0 || days > 31) return "Enter between 0.5 and 31 days, in half days.";
  }
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) return "Explain the reason for this hold (5–500 characters).";
  return "";
}

export function noteError(action: SalaryHoldAction, note: string) {
  const n = note.trim();
  if (n.length > 500) return "Keep the note under 500 characters.";
  if (ACTION_COPY[action].noteRequired && n.length < 5) return "Add a reason (at least 5 characters).";
  return "";
}
