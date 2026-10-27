/** Recovery ledger rows and their summaries; shared by the server loader and the ledger view. */

export type LedgerStatus = "redispute_pending" | "redispute_won" | "awaiting_approval" | "returned" | "scheduled" | "in_progress" | "recovered" | "needs_review" | "exit_balance" | "written_off";

export type LedgerLine = {
  month: string;
  case_key: string;
  report: "nl" | "slp" | "station";
  station_code: string;
  employee_ref: string;
  employee_code: string | null;
  full_name: string | null;
  designation?: string | null;
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
  redispute_pending: { label: "Redispute · recovery paused", tone: "warn" },
  redispute_won: { label: "Redispute won · recovery stopped", tone: "good" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  returned: { label: "Returned for update", tone: "warn" },
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
      (!q || [l.employee_code, l.full_name, l.case_key, l.station_code, l.designation].join(" ").toLowerCase().includes(q)),
  );
}

/** Group only scoped ledger lines; a shared case counts once, money stays per allocation. */
export function groupRecoveryReview(lines: LedgerLine[], by: 'station' | 'person' | 'designation') {
  const groups = new Map<string, { key:string; label:string; detail:string; cases:Set<string>; people:Set<string>; lineKeys:Set<string>; assigned:number; deducted:number; draft:number; outstanding:number; pending:number }>();
  for (const l of lines) {
    const designation = l.designation || 'Not recorded';
    const key = by === 'station' ? l.station_code : by === 'person' ? `${l.station_code}|${l.employee_ref}` : `${l.station_code}|${designation}`;
    const g = groups.get(key) || { key, label:by==='station'?l.station_code:by==='person'?(l.full_name||l.employee_code||l.employee_ref):designation,
      detail:by==='station'?'':by==='person'?`${l.station_code} · ${l.employee_code||''} · ${designation}`:l.station_code,
      cases:new Set<string>(),people:new Set<string>(),lineKeys:new Set<string>(),assigned:0,deducted:0,draft:0,outstanding:0,pending:0 };
    g.cases.add(`${l.month}|${l.case_key}`); g.people.add(l.employee_ref); g.lineKeys.add(`${l.month}|${l.case_key}|${l.employee_ref}`);
    g.assigned+=Number(l.total)||0; g.deducted+=Number(l.deducted)||0; g.draft+=Number(l.in_payroll)||0; g.outstanding+=Number(l.outstanding)||0;
    if(['awaiting_approval','returned','needs_review'].includes(l.status)) g.pending+=Number(l.outstanding)||0;
    groups.set(key,g);
  }
  return [...groups.values()].map(g=>({...g,cases:g.cases.size,people:g.people.size,lineKeys:[...g.lineKeys],station:g.key.split('|')[0],assigned:r2(g.assigned),deducted:r2(g.deducted),draft:r2(g.draft),outstanding:r2(g.outstanding),pending:r2(g.pending)})).sort((a,b)=>b.outstanding-a.outstanding||a.label.localeCompare(b.label));
}
