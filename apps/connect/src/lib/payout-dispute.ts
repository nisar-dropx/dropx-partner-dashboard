export const PAYOUT_DISPUTE_AREAS = [
  { value: "work_days", label: "Work Days", legacyCategory: "training" },
  { value: "attendance_pay", label: "Attendance Pay", legacyCategory: "training" },
  { value: "delivery", label: "Delivery", legacyCategory: "counts" },
  { value: "pickup", label: "Pickup", legacyCategory: "counts" },
  { value: "mfn_seller_pickup", label: "MFN / Seller Pickup", legacyCategory: "counts" },
  { value: "allowances", label: "Allowances", legacyCategory: "other" },
  { value: "incentive", label: "Incentive", legacyCategory: "other" },
  { value: "deduction", label: "Deduction", legacyCategory: "loss" },
  { value: "other", label: "Others", legacyCategory: "other" },
] as const;

export type PayoutDisputeArea = (typeof PAYOUT_DISPUTE_AREAS)[number]["value"];
export type PayoutReviewState = "open" | "expired" | "revising" | "confirmed" | "unavailable";
export type PayoutDisputeWorkflowStatus =
  | "open"
  | "pending_final_approval"
  | "approved_for_processing"
  | "processing"
  | "processing_blocked"
  | "resolved"
  | "rejected"
  | "in_review";

export type AssociatePayoutDispute = {
  id: string;
  category: string;
  reason: string;
  status: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  legacyResolutionUnverified: boolean;
  workflow: {
    label: string;
    detail: string;
    step: number;
    terminal: boolean;
    blocked: boolean;
  };
  correction: null | {
    kind: string | null;
    targetField: string | null;
    note: string | null;
    currentValue: string | number | null;
    proposedValue: string | number | null;
    beforeNetPaise: number | null;
    afterNetPaise: number | null;
    deltaPaise: number | null;
    netChangeVerified: boolean;
  };
  processing: null | {
    claimedAt: string | null;
    processedAt: string | null;
  };
  payment: null | {
    status: string | null;
    date: string | null;
    reference: string | null;
    paidAmountPaise: number | null;
    additionalBalancePaise: number | null;
  };
  timeline: Array<{
    label: string;
    comment: string;
    createdAt: string;
  }>;
};

const areaByValue = new Map(PAYOUT_DISPUTE_AREAS.map((area) => [area.value, area]));
const areaPrefix = "Dispute areas: ";

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value: unknown) {
  const valueText = String(value ?? "").trim();
  return valueText || null;
}

function correctionValue(value: unknown): string | number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function publicationNetPaise(publication: unknown) {
  const row = publication && typeof publication === "object" ? publication as Record<string, any> : {};
  const amount = finiteNumber(row.snapshot?.item?.net_amount);
  return amount === null ? null : Math.round(amount * 100);
}

export function payoutDisputeWorkflow(statusValue: unknown, legacyResolutionUnverified = false) {
  const status = String(statusValue ?? "").trim().toLowerCase() as PayoutDisputeWorkflowStatus;
  if (status === "open") return {
    label: "Awaiting initial approval",
    detail: "Your dispute has been submitted for the first review.",
    step: 1,
    terminal: false,
    blocked: false,
  };
  if (status === "pending_final_approval" || status === "in_review") return {
    label: "Awaiting final approval",
    detail: "The initial review is complete. A different approver is checking the decision.",
    step: 2,
    terminal: false,
    blocked: false,
  };
  if (status === "approved_for_processing") return {
    label: "Approved for payout correction",
    detail: "The correction is approved and waiting for the payout processor.",
    step: 3,
    terminal: false,
    blocked: false,
  };
  if (status === "processing") return {
    label: "Payout correction in progress",
    detail: "The processor is updating the approved payout source and preparing a revised payout.",
    step: 3,
    terminal: false,
    blocked: false,
  };
  if (status === "processing_blocked") return {
    label: "Payout correction needs attention",
    detail: "The approved correction is temporarily blocked. The payout team must clear it before processing continues.",
    step: 3,
    terminal: false,
    blocked: true,
  };
  if (status === "resolved" && legacyResolutionUnverified) return {
    label: "Previous decision recorded",
    detail: "This dispute was closed under the earlier workflow. A revised publication and net payout change were not system-verified.",
    step: 4,
    terminal: true,
    blocked: false,
  };
  if (status === "resolved") return {
    label: "Resolved",
    detail: "The processor applied the approved correction. The revised publication and net payout change were system-verified.",
    step: 4,
    terminal: true,
    blocked: false,
  };
  if (status === "rejected") return {
    label: "Rejected after final review",
    detail: "The final approver did not approve a payout correction.",
    step: 2,
    terminal: true,
    blocked: false,
  };
  return {
    label: "Under review",
    detail: "Workforce is reviewing this payout dispute.",
    step: 1,
    terminal: false,
    blocked: false,
  };
}

/**
 * Associate-safe dispute projection. Internal reviewer identities, workflow
 * routing and free-form processing notes deliberately stay on the server.
 */
export function associatePayoutDispute(
  disputeValue: unknown,
  originalPublication?: unknown,
  processedPublication?: unknown,
  payoutPayment?: { status?: unknown; date?: unknown; reference?: unknown } | null,
  eventValues: unknown[] = [],
): AssociatePayoutDispute {
  const dispute = disputeValue && typeof disputeValue === "object"
    ? disputeValue as Record<string, any>
    : {};
  const correctionPlan = dispute.correction_plan && typeof dispute.correction_plan === "object"
    ? dispute.correction_plan as Record<string, any>
    : {};
  const processingResult = dispute.processing_result && typeof dispute.processing_result === "object"
    ? dispute.processing_result as Record<string, any>
    : {};
  const status = String(dispute.status ?? "").trim().toLowerCase();
  const legacyResolutionUnverified = Boolean(dispute.legacy_resolution_unverified)
    || (status === "resolved" && !dispute.processed_publication_id && !processedPublication
      && Object.keys(processingResult).length === 0);
  const workflow = payoutDisputeWorkflow(status, legacyResolutionUnverified);
  const correctionVisible = !legacyResolutionUnverified && [
    "approved_for_processing",
    "processing",
    "processing_blocked",
    "resolved",
  ].includes(status);
  const beforeNetPaise = finiteNumber(processingResult.verified_before_net_paise)
    ?? finiteNumber(processingResult.before_net_paise)
    ?? publicationNetPaise(originalPublication);
  const verifiedAfterNetPaise = finiteNumber(processingResult.verified_after_net_paise)
    ?? finiteNumber(processingResult.after_net_paise)
    ?? publicationNetPaise(processedPublication);
  const expectedDeltaPaise = finiteNumber(correctionPlan.expected_delta_paise);
  const afterNetPaise = verifiedAfterNetPaise
    ?? (beforeNetPaise !== null && expectedDeltaPaise !== null ? beforeNetPaise + expectedDeltaPaise : null);
  const deltaPaise = finiteNumber(processingResult.verified_delta_paise)
    ?? finiteNumber(processingResult.delta_paise)
    ?? (beforeNetPaise !== null && verifiedAfterNetPaise !== null ? verifiedAfterNetPaise - beforeNetPaise : null)
    ?? expectedDeltaPaise;
  const netChangeVerified = processingResult.publication_net_change_verified === true
    || (processingResult.publication_net_change_verified == null
      && verifiedAfterNetPaise !== null
      && status === "resolved");
  const additionalBalancePaise = finiteNumber(processingResult.additional_balance_paise);
  const paidAmountPaise = finiteNumber(processingResult.paid_amount_paise);
  const paymentStatus = cleanText(processingResult.payment_status) ?? cleanText(payoutPayment?.status);
  const paymentDate = cleanText(processingResult.payment_date) ?? cleanText(payoutPayment?.date);
  const paymentReference = cleanText(processingResult.payment_reference) ?? cleanText(payoutPayment?.reference);
  const hasPayment = paymentStatus !== null
    || paymentDate !== null
    || paymentReference !== null
    || paidAmountPaise !== null
    || additionalBalancePaise !== null;
  const timeline = eventValues.flatMap((eventValue) => {
    const event = eventValue && typeof eventValue === "object" ? eventValue as Record<string, any> : {};
    const eventType = String(event.event_type ?? "").trim().toLowerCase();
    const finance = /process|payment|disburs/.test(eventType)
      || /processor|processing|payment/i.test(String(event.message ?? ""));
    const actorName = cleanText(event.actor_name);
    let comment = cleanText(event.message) ?? "Status updated.";
    if (finance && actorName) comment = comment.replaceAll(actorName, "Finance");
    if (finance) comment = comment.replace(/claimed by [^.]+/i, "claimed by Finance");
    const label = finance ? "Finance"
      : /final/.test(eventType) ? "Final review"
        : /initial|propose|review/.test(eventType) ? "Initial review"
          : event.portal === "one" ? "Submitted" : "Update";
    return [{ label, comment, createdAt: String(event.created_at ?? "") }];
  });

  return {
    id: String(dispute.id ?? ""),
    category: String(dispute.category ?? "other"),
    reason: String(dispute.reason ?? ""),
    status,
    resolution: ["resolved", "rejected"].includes(status) ? cleanText(dispute.resolution) : null,
    created_at: String(dispute.created_at ?? ""),
    updated_at: String(dispute.updated_at ?? ""),
    legacyResolutionUnverified,
    workflow,
    correction: correctionVisible ? {
      kind: cleanText(correctionPlan.kind),
      targetField: cleanText(correctionPlan.target_field),
      note: cleanText(correctionPlan.note),
      currentValue: correctionValue(correctionPlan.current_value),
      proposedValue: correctionValue(correctionPlan.proposed_value),
      beforeNetPaise,
      afterNetPaise,
      deltaPaise,
      netChangeVerified,
    } : null,
    processing: ["processing", "processing_blocked", "resolved"].includes(status) ? {
      claimedAt: cleanText(dispute.processor_claimed_at),
      processedAt: cleanText(dispute.processed_at),
    } : null,
    payment: hasPayment ? {
      status: paymentStatus,
      date: paymentDate,
      reference: paymentReference,
      paidAmountPaise,
      additionalBalancePaise,
    } : null,
    timeline,
  };
}

export function normalizePayoutDisputeAreas(value: unknown): PayoutDisputeArea[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(values.map((item) => String(item).trim()).filter((item): item is PayoutDisputeArea => areaByValue.has(item as PayoutDisputeArea)))];
}

export function payoutDisputeAreaLabels(areas: readonly PayoutDisputeArea[]) {
  return areas.map((area) => areaByValue.get(area)!.label);
}

/**
 * The production RPC stores one legacy category. Keep that contract stable while
 * preserving every selected area in the dispute reason for old and new reviewers.
 */
export function legacyPayoutDisputeCategory(areas: readonly PayoutDisputeArea[]) {
  const categories = areas.map((area) => areaByValue.get(area)?.legacyCategory).filter(Boolean);
  if (categories.includes("counts")) return "counts";
  if (categories.includes("training")) return "training";
  if (categories.includes("loss")) return "loss";
  return "other";
}

export function encodePayoutDisputeReason(areas: readonly PayoutDisputeArea[], reason: string) {
  const labels = payoutDisputeAreaLabels(areas);
  return `${areaPrefix}${labels.join(", ")}\n\n${reason.trim()}`;
}

export function decodePayoutDisputeReason(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith(areaPrefix)) return { areas: [] as string[], reason: text };
  const [heading, ...body] = text.split(/\r?\n/);
  return {
    areas: heading.slice(areaPrefix.length).split(",").map((item) => item.trim()).filter(Boolean),
    reason: body.join("\n").trim(),
  };
}

export function payoutReviewState(
  input: { hasPublication: boolean; reviewUntil?: string | null; runStatus?: string | null; revisionPending?: boolean },
  now = Date.now(),
): PayoutReviewState {
  if (!input.hasPublication) return "unavailable";
  if (["approved", "paid"].includes(String(input.runStatus ?? ""))) return "confirmed";
  if (input.runStatus !== "review") return "unavailable";
  if (input.revisionPending) return "revising";
  const deadline = Date.parse(String(input.reviewUntil ?? ""));
  if (!Number.isFinite(deadline)) return "unavailable";
  return deadline > now ? "open" : "expired";
}

export function isCompleteCalendarMonth(from: string, to: string) {
  const match = /^(\d{4})-(\d{2})-01$/.exec(from);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  return to === new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function currentPayoutMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : now.toISOString().slice(0, 7);
}

export function normalizePayoutMonth(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100 ? text : null;
}

export function shiftPayoutMonth(value: string, amount: number) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return currentPayoutMonth();
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + amount, 1));
  return shifted.toISOString().slice(0, 7);
}

export function payoutMonthLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en", { month: "short", year: "2-digit", timeZone: "UTC" })
    .format(new Date(`${value}-01T00:00:00Z`))
    .replace(" ", "-");
}

export function payoutMonthLongLabel(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}-01T00:00:00Z`));
}

/** Cross-month pay periods are filed under the month in which the period ends. */
export function payoutMonthForPeriod(from: string, to: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) return to.slice(0, 7);
  return /^\d{4}-\d{2}-\d{2}$/.test(from) ? from.slice(0, 7) : "";
}
