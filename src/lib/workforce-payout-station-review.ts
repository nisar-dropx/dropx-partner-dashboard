import type { WorkforcePayoutPaymentSummary } from "@/lib/workforce-payout-payment-summary";

export type WorkforcePayoutStationReviewRow = {
  location?: string | null;
  locationId?: string | null;
  status: string;
  netAmount: number;
  paymentDetailsAvailable: boolean;
  publicationPaymentReady?: boolean;
  paymentSummary?: Pick<
    WorkforcePayoutPaymentSummary,
    "paidAmount" | "processingAmount" | "balancePayable" | "eligible" | "eligibilityCode" | "eligibilityMessage" | "status"
  >;
};

export type WorkforceStationReviewStatus =
  | "blocked"
  | "needs_publication"
  | "review_pending"
  | "payable"
  | "settling"
  | "cleared";

export type WorkforceStationReviewSummary = {
  station: string;
  stationId: string | null;
  rows: number;
  payableRows: number;
  blockedRows: number;
  reviewRows: number;
  needsPublicationRows: number;
  settlingRows: number;
  balance: number;
  paid: number;
  processing: number;
  status: WorkforceStationReviewStatus;
  blockerSample: string | null;
};

const REVIEW_STATUSES = new Set([
  "ready for review",
  "under review",
  "notification queued",
  "delivery needs review"
]);

function statusText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isPublicationGap(row: WorkforcePayoutStationReviewRow) {
  const code = statusText(row.paymentSummary?.eligibilityCode);
  const message = String(row.paymentSummary?.eligibilityMessage ?? row.status ?? "");
  return code.includes("publication")
    || /no current published payout|publish the current payout|publication refresh/i.test(message);
}

function isBlockedRow(row: WorkforcePayoutStationReviewRow) {
  const status = statusText(row.status);
  const paymentStatus = statusText(row.paymentSummary?.status);
  if (!row.paymentDetailsAvailable) return true;
  if (status.includes("incomplete") || status.includes("configuration") || status.includes("required")) return true;
  if (paymentStatus.includes("hold") || paymentStatus.includes("pan not linked")) return true;
  if (row.paymentSummary?.eligible === false) {
    if (isPublicationGap(row)) return false;
    const code = statusText(row.paymentSummary.eligibilityCode);
    if (code && !code.includes("balance")) return true;
  }
  return false;
}

function isReviewPendingRow(row: WorkforcePayoutStationReviewRow) {
  return REVIEW_STATUSES.has(statusText(row.status));
}

function isSettlingRow(row: WorkforcePayoutStationReviewRow) {
  const paymentStatus = statusText(row.paymentSummary?.status);
  return paymentStatus === "payment processing"
    || Number(row.paymentSummary?.processingAmount ?? 0) > 0;
}

function isPayableRow(row: WorkforcePayoutStationReviewRow) {
  if (isBlockedRow(row) || isSettlingRow(row)) return false;
  if (!(row.netAmount > 0)) return false;
  if (row.paymentSummary) {
    return row.paymentSummary.eligible !== false
      && Number(row.paymentSummary.balancePayable ?? 0) > 0;
  }
  return row.paymentDetailsAvailable && row.publicationPaymentReady === true;
}

function needsPublicationRow(row: WorkforcePayoutStationReviewRow) {
  if (isBlockedRow(row) || isSettlingRow(row) || isPayableRow(row)) return false;
  if (!(row.netAmount > 0)) return false;
  return isPublicationGap(row) || row.publicationPaymentReady === false;
}

function stationStatus(item: Omit<WorkforceStationReviewSummary, "status" | "blockerSample">): WorkforceStationReviewStatus {
  if (item.blockedRows > 0) return "blocked";
  if (item.needsPublicationRows > 0) return "needs_publication";
  if (item.reviewRows > 0) return "review_pending";
  if (item.settlingRows > 0 && item.payableRows === 0) return "settling";
  if (item.payableRows > 0) return "payable";
  return "cleared";
}

function blockerSample(row: WorkforcePayoutStationReviewRow) {
  return row.paymentSummary?.eligibilityMessage?.trim()
    || (isBlockedRow(row) ? row.status : null)
    || null;
}

export function workforceStationReviewStatusLabel(status: WorkforceStationReviewStatus) {
  switch (status) {
    case "blocked":
      return "Needs attention";
    case "needs_publication":
      return "Publish first";
    case "review_pending":
      return "Review pending";
    case "payable":
      return "Ready for Finance";
    case "settling":
      return "With bank";
    case "cleared":
      return "No payable balance";
  }
}

/**
 * Derive one station control-plane row from worksheet rows already loaded for
 * the page. Must never trigger extra bank/payment queries.
 */
export function summarizeWorkforcePayoutStations(
  rows: readonly WorkforcePayoutStationReviewRow[]
): WorkforceStationReviewSummary[] {
  const grouped = new Map<string, {
    station: string;
    stationId: string | null;
    rows: number;
    payableRows: number;
    blockedRows: number;
    reviewRows: number;
    needsPublicationRows: number;
    settlingRows: number;
    balance: number;
    paid: number;
    processing: number;
    blockerSample: string | null;
  }>();

  for (const row of rows) {
    const station = row.location?.trim() || "Unassigned";
    const key = row.locationId?.trim().toLowerCase() || station.toLowerCase();
    const current = grouped.get(key) ?? {
      station,
      stationId: row.locationId?.trim() || null,
      rows: 0,
      payableRows: 0,
      blockedRows: 0,
      reviewRows: 0,
      needsPublicationRows: 0,
      settlingRows: 0,
      balance: 0,
      paid: 0,
      processing: 0,
      blockerSample: null
    };
    current.rows += 1;
    current.paid += Number(row.paymentSummary?.paidAmount ?? 0) || 0;
    current.processing += Number(row.paymentSummary?.processingAmount ?? 0) || 0;

    if (isBlockedRow(row)) {
      current.blockedRows += 1;
      if (!current.blockerSample) current.blockerSample = blockerSample(row);
    } else if (isSettlingRow(row)) {
      current.settlingRows += 1;
    } else if (isReviewPendingRow(row)) {
      // Worker/station review still open takes priority over a provisional
      // payable balance so Finance is not shown a ready station too early.
      current.reviewRows += 1;
      if (isPayableRow(row)) {
        current.payableRows += 1;
        current.balance += Number(row.paymentSummary?.balancePayable ?? row.netAmount) || 0;
      }
    } else if (isPayableRow(row)) {
      current.payableRows += 1;
      current.balance += Number(row.paymentSummary?.balancePayable ?? row.netAmount) || 0;
    } else if (needsPublicationRow(row)) {
      current.needsPublicationRows += 1;
      if (!current.blockerSample) current.blockerSample = blockerSample(row) || "Publish the current payout before Finance can pay this station.";
    }

    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((item) => ({
      ...item,
      status: stationStatus(item)
    }))
    .sort((left, right) => left.station.localeCompare(right.station));
}
