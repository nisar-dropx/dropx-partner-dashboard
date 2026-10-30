export const rosterPendencyEvents = ["roster_pendency_morning"] as const;
export type RosterPendencyEvent = (typeof rosterPendencyEvents)[number];

export type RosterPendencyStatus = "draft" | "returned" | "pending_approval";

export type RosterPendencyRow = {
  key: string;
  planId: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  status: RosterPendencyStatus;
  statusLabel: string;
  periodStart: string;
  periodEnd: string;
  revisionNo: number;
  waitingOn: string;
  ageDays: number;
  submittedAt: string | null;
};

export type RosterPendencyRecipient = {
  email: string;
  name: string;
  roles: string[];
  stationIds: string[];
  planKeys: string[];
};

export type RosterPendencySnapshot = {
  date: string;
  checkedAt: string;
  rows: RosterPendencyRow[];
  recipients: RosterPendencyRecipient[];
  unroutedStationIds: string[];
};

export function rosterStatusLabel(status: RosterPendencyStatus) {
  if (status === "pending_approval") return "Awaiting approval";
  if (status === "returned") return "Returned · resubmit needed";
  return "Draft · not submitted";
}

export function rosterWaitingOn(status: RosterPendencyStatus, stageType: string | null) {
  if (status === "draft") return "Station planner must submit";
  if (status === "returned") return "Station planner must fix and resubmit";
  if (stageType === "hr") return "HR approval";
  if (stageType === "level_2") return "Cluster / next manager approval";
  if (stageType === "level_1") return "Station manager approval";
  return "Manager approval";
}

export function rosterAgeDays(asOf: string, fromIso: string | null) {
  if (!fromIso || !/^\d{4}-\d{2}-\d{2}/.test(fromIso)) return 0;
  const start = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / 86_400_000);
}

export function uniqueManagerEmail(emails: Array<string | null | undefined>) {
  const cleaned = [...new Set(emails.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean))];
  return cleaned.length === 1 ? cleaned[0] : null;
}

export function buildRosterPendencySnapshot(input: {
  date: string;
  checkedAt: string;
  rows: RosterPendencyRow[];
  recipients: RosterPendencyRecipient[];
  unroutedStationIds?: string[];
}): RosterPendencySnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("Invalid roster pendency date.");
  const keys = new Set(input.rows.map((row) => row.key));
  if (keys.size !== input.rows.length) throw new Error("Duplicate roster pendency rows.");
  const recipients = input.recipients
    .map((recipient) => ({
      ...recipient,
      email: recipient.email.trim().toLowerCase(),
      stationIds: [...new Set(recipient.stationIds)].sort(),
      planKeys: [...new Set(recipient.planKeys.filter((key) => keys.has(key)))].sort(),
      roles: [...new Set(recipient.roles)].sort()
    }))
    .filter((recipient) => recipient.planKeys.length > 0)
    .sort((left, right) => left.email.localeCompare(right.email));
  if (new Set(recipients.map((row) => row.email)).size !== recipients.length) {
    throw new Error("Conflicting roster reminder recipients.");
  }
  return {
    date: input.date,
    checkedAt: input.checkedAt,
    rows: [...input.rows].sort((left, right) =>
      left.stationCode.localeCompare(right.stationCode) ||
      left.status.localeCompare(right.status) ||
      left.periodStart.localeCompare(right.periodStart)
    ),
    recipients,
    unroutedStationIds: [...new Set(input.unroutedStationIds ?? [])].sort()
  };
}
