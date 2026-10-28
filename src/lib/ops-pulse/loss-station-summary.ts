import { recoveryDetailsUpdated } from "./loss-final-summary";
import { hasFinalLossOutcome } from "./loss-recovery-controls";
import { casePhase } from "./nl-dispute-policy";
import { isRecoverable, type NlCase } from "./nl-loss-policy";
import type { LedgerLine } from "./nl-recovery-ledger-view";

export type LossFact = {
  key: string; station: string; report: "nl" | "slp"; period: string; month: string;
  stage: "initial" | "final"; amount: number; updated: boolean; recoverable: boolean;
  waitingStation: boolean; waitingAmazon: boolean; recovered: number; waived: number; draft: number;
  remaining: number; updatedAt: string; sourceAt: string;
};
export type LossSummaryStationDimension = {
  station: string;
  clusterKeys: string[];
  region: string;
};
export type LossFactSort = "amount" | "station" | "count" | "pending" | "remaining" | "recovered" | "updatedAt";
export type LossFactSortDirection = "asc" | "desc";
type SourceCase = NlCase & { final_seen_at?: string | null; last_seen_at?: string };
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const keyOf = (r: { report?: string; month: string; case_key: string; station_code: string }) =>
  `${r.report || "nl"}|${r.month}|${r.station_code}|${r.case_key}`;

/** One fact per source case, never one per payroll allocation. Draft payroll is not recovered. */
export function lossFacts(rows: SourceCase[], lines: LedgerLine[], accepted: string[]): LossFact[] {
  const collections = new Map<string, { paid: number; waived: number; draft: number; stopped: boolean }>();
  const seenLines = new Set<string>();
  for (const line of lines) {
    const key = keyOf(line), allocation = `${key}|${line.employee_ref}`;
    if (seenLines.has(allocation)) continue;
    seenLines.add(allocation);
    const sum = collections.get(key) || { paid: 0, waived: 0, draft: 0, stopped: false };
    sum.draft += Math.max(0, cents(line.in_payroll));
    sum.paid += cents(line.deducted); sum.waived += cents(line.waived); sum.stopped ||= line.status === "redispute_won";
    collections.set(key, sum);
  }
  const unique = new Map<string, LossFact>();
  for (const row of rows) {
    if (row.report === "station" || (row.source_present === false && (!row.recovery || row.recovery.is_deleted) && !collections.has(keyOf(row)))) continue;
    const report = row.report === "slp" ? "slp" : "nl";
    const recoverable = report === "slp" || isRecoverable(row.source_status, accepted);
    const final = report === "slp" ? Boolean(row.final_seen_at || row.details.in_final)
      : hasFinalLossOutcome(recoverable, row.source_status, row.details.case_status, row.details.extra?.current_sla_stage);
    const phase = casePhase({ case_status: row.details.case_status, nl_status: row.source_status, extra: row.details.extra });
    const stopped = row.redispute?.workflow_status === "won" || collections.get(keyOf(row))?.stopped || row.source_final_nonrecoverable;
    const updated = final && recoverable && !stopped && recoveryDetailsUpdated(row, row.recovery, report === "slp");
    const amount = Math.max(0, cents(row.amount));
    const collection = collections.get(keyOf(row));
    // Approved receipts settle the same case as payroll; do not add the receipt a second time.
    const receipt = updated && row.lifecycle_status !== "needs_review" && row.recovery?.approval_status === "approved" && row.recovery.outcome_code === "already_recovered"
      ? cents(row.recovery.recovery_details.received_amount) : 0;
    const paid = Math.max(0, collection?.paid || 0, receipt);
    const waived = Math.max(0, collection?.waived || 0);
    unique.set(keyOf(row), {
      key: keyOf(row), station: row.station_code, report, period: report === "nl" ? row.month : row.details.period || row.month, month: row.month,
      stage: final ? "final" : "initial", amount: amount / 100, updated, recoverable: final && recoverable && !stopped,
      waitingStation: !final && report === "nl" && ["action", "respond"].includes(phase.key),
      waitingAmazon: !final && (report === "slp" || phase.key === "amazon"),
      recovered: paid / 100, waived: waived / 100, draft: (collection?.draft || 0) / 100,
      remaining: final && recoverable && !stopped ? Math.max(0, amount - paid - waived) / 100 : 0,
      updatedAt: row.recovery && !row.recovery.is_deleted ? row.recovery.updated_at || "" : "",
      sourceAt: row.last_seen_at || row.source_updated_at || "",
    });
  }
  return [...unique.values()];
}

/** Summary covers confirmed recoverable cases, including fully settled cases. */
export function recoverableLossFacts(rows: LossFact[]): LossFact[] {
  return rows.filter(row => row.stage === "final" && row.recoverable);
}

export const LOSS_SUMMARY_STATUSES = [
  ["all", "All statuses"], ["pending_update", "Pending update"], ["updated", "Details updated"],
  ["station", "Waiting on station"], ["amazon", "Awaiting Amazon / final"],
  ["recovered", "Recovery received"], ["outstanding", "Pending recovery"], ["nonrecoverable", "Non-recoverable"],
] as const;
export function filterLossFacts(rows: LossFact[], filter: { station?: string; period?: string; stage?: string; status?: string }) {
  return rows.filter(r => (!filter.station || r.station === filter.station) && (!filter.period || r.period === filter.period || r.month === filter.period)
    && (!filter.stage || r.stage === filter.stage) && (
      !filter.status || filter.status === "all" ||
      (filter.status === "pending_update" && r.recoverable && !r.updated) ||
      (filter.status === "updated" && r.updated) || (filter.status === "station" && r.waitingStation) ||
      (filter.status === "amazon" && r.waitingAmazon) || (filter.status === "recovered" && r.recovered > 0) ||
      (filter.status === "outstanding" && r.remaining > 0) || (filter.status === "nonrecoverable" && r.stage === "final" && !r.recoverable)
    ));
}

/** Apply current People ownership and station-region dimensions after the case-level filters. */
export function filterLossFactsByOwnership(
  rows: LossFact[],
  stations: LossSummaryStationDimension[],
  filter: { cluster?: string; region?: string },
) {
  if (!filter.cluster && !filter.region) return rows;
  const allowed = new Set(stations.filter((station) => (
    (!filter.cluster || station.clusterKeys.includes(filter.cluster)) &&
    (!filter.region || station.region === filter.region)
  )).map((station) => station.station));
  return rows.filter((row) => allowed.has(row.station));
}
export function totalLossFacts(rows: LossFact[]) {
  const amount = (pick: (r: LossFact) => number) => rows.reduce((n,r) => n + cents(pick(r)), 0) / 100;
  const group = (predicate: (r: LossFact) => boolean) => {
    const selected = rows.filter(predicate);
    return { count: selected.length, amount: selected.reduce((n,r) => n + cents(r.amount), 0) / 100 };
  };
  return { count: rows.length, amount: amount(r=>r.amount), recovered: amount(r=>r.recovered), remaining: amount(r=>r.remaining), waived: amount(r=>r.waived), draft: amount(r=>r.draft), draftCount: rows.filter(r=>r.draft>0).length,
    recoveredCount: rows.filter(r=>r.recovered>0).length, remainingCount: rows.filter(r=>r.remaining>0).length,
    updated: group(r=>r.updated), pending: group(r=>r.recoverable&&!r.updated),
    stationPending: group(r=>r.waitingStation), amazon: group(r=>r.waitingAmazon),
    nonrecoverable: group(r=>r.stage==="final"&&!r.recoverable),
    updatedAt: rows.map(r=>r.updatedAt).sort().at(-1)||"", sourceAt: rows.map(r=>r.sourceAt).sort().at(-1)||"" };
}
export function groupLossFacts(
  rows: LossFact[],
  sort: LossFactSort = "amount",
  direction: LossFactSortDirection = sort === "station" ? "asc" : "desc",
) {
  const groups = [...new Set(rows.map(r=>r.station))].map(station=>({ station, ...totalLossFacts(rows.filter(r=>r.station===station)) }));
  const factor = direction === "asc" ? 1 : -1;
  return groups.sort((a,b) => {
    if (sort === "station") return factor * a.station.localeCompare(b.station);
    if (sort === "updatedAt") return factor * a.updatedAt.localeCompare(b.updatedAt) || a.station.localeCompare(b.station);
    const left = sort === "count" ? a.count : sort === "recovered" ? a.recovered : sort === "remaining" ? a.remaining : sort === "pending" ? a.pending.amount : a.amount;
    const right = sort === "count" ? b.count : sort === "recovered" ? b.recovered : sort === "remaining" ? b.remaining : sort === "pending" ? b.pending.amount : b.amount;
    return factor * (left - right) || a.station.localeCompare(b.station);
  });
}
