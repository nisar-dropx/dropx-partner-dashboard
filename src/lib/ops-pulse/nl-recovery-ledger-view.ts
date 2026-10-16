/** Recovery ledger rows and their summaries; shared by the server loader and the ledger view. */

export type LedgerStatus = "scheduled" | "in_progress" | "recovered" | "needs_review" | "exit_balance" | "written_off";

export type LedgerLine = {
  month: string;
  case_key: string;
  report: "nl" | "slp";
  station_code: string;
  employee_ref: string;
  employee_code: string | null;
  full_name: string | null;
  recovery_mode: "full" | "installments";
  installment_count: number | null;
  monthly_amount: number;
  total: number;
  deducted: number;
  in_payroll: number;
  waived: number;
  outstanding: number;
  deducted_count: number;
  first_salary_month: string | null;
  last_deducted_in: string | null;
  exit_date: string | null;
  cap_override: boolean;
  outcome_label: string;
  assigned_at: string | null;
  updated_by_name: string | null;
  waiver_reason: string | null;
  waived_by_name: string | null;
  status: LedgerStatus;
};

export const LEDGER_STATUS: Record<LedgerStatus, { label: string; tone: "info" | "progress" | "good" | "warn" | "danger" | "muted" }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  in_progress: { label: "Recovering", tone: "progress" },
  recovered: { label: "Recovered", tone: "good" },
  needs_review: { label: "Source changed", tone: "warn" },
  exit_balance: { label: "Exit balance", tone: "danger" },
  written_off: { label: "Written off", tone: "muted" },
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function ledgerTotals(lines: Pick<LedgerLine, "total" | "deducted" | "waived" | "outstanding" | "status" | "employee_ref">[]) {
  const sum = (pick: (l: (typeof lines)[number]) => number) => r2(lines.reduce((n, l) => n + (Number(pick(l)) || 0), 0));
  const exits = lines.filter((l) => l.status === "exit_balance");
  return {
    assigned: sum((l) => l.total),
    deducted: sum((l) => l.deducted),
    waived: sum((l) => l.waived),
    outstanding: sum((l) => l.outstanding),
    people: new Set(lines.map((l) => l.employee_ref)).size,
    exitBalance: r2(exits.reduce((n, l) => n + (Number(l.outstanding) || 0), 0)),
    exitCount: exits.length,
  };
}

/** Recovered share of the assigned amount, 0–100, never NaN. */
export function recoveredPercent(line: Pick<LedgerLine, "total" | "deducted" | "waived">) {
  const total = Number(line.total) || 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((Number(line.deducted) || 0) / total) * 100)));
}

export function filterLedger(lines: LedgerLine[], filter: { status?: string; query?: string; station?: string }) {
  const q = (filter.query ?? "").trim().toLowerCase();
  return lines.filter(
    (l) =>
      (!filter.status || filter.status === "all" || (filter.status === "open" ? l.outstanding > 0 && l.status !== "written_off" : l.status === filter.status)) &&
      (!filter.station || l.station_code === filter.station) &&
      (!q || [l.employee_code, l.full_name, l.case_key, l.station_code].join(" ").toLowerCase().includes(q)),
  );
}
