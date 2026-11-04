import { readAllRows } from "./supabase-pagination";
import type { WorkforceAdvanceRegisterRow } from "../components/workforce-advance-register";

type PayoutRow = {
  id: string; reviewSubjectType?: string; reviewSubjectId?: string | null; locationId: string | null;
  deductionBreakdown: Array<{code: string; amount: number; recoveryKey?: string}>;
};
type LoadWorkforce = (from: string, to: string, ids: string[]) => Promise<{rows: PayoutRow[]; error: string | null}>;
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const monthEnd = (start: string) => new Date(Date.UTC(Number(start.slice(0,4)), Number(start.slice(5,7)), 0)).toISOString().slice(0,10);

/** Read-only display reconciliation. Never confirms a bank payment or consumes principal. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyPayoutDeductionsToAdvanceRegister(db: any, companyId: string, rows: WorkforceAdvanceRegisterRow[], loadWorkforce: LoadWorkforce) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const confirmed = new Map<string, number>();
  const applied = new Map<string, number>();
  const live = new Map<string, number>();
  const key = (id: string, period: string) => `${id}|${period.slice(0,7)}-01`;
  const add = (map: Map<string, number>, id: string, period: string, amount: unknown) => {
    const value = Number(amount);
    if (!byId.has(id) || !/^\d{4}-\d{2}-\d{2}/.test(period) || !Number.isFinite(value) || value <= 0) return;
    const k = key(id,period); map.set(k,round((map.get(k) ?? 0) + value));
  };
  for (const row of rows) for (const recovery of row.recoveryHistory) {
    if (["deducted", "confirmed", "waived"].includes(recovery.status)) add(confirmed,row.id,recovery.periodStart,recovery.amount);
  }
  const read = async (query: any) => {
    const result = await readAllRows(query);
    if (result.error) throw new Error(`Payout deductions could not be verified: ${result.error.message}`);
    return result.data ?? [];
  };
  const people = rows.filter(row => row.workerType === "employee" || row.workerType === "contractor");
  const workerIds = [...new Set(people.map(row => row.workforceId).filter(Boolean))];
  for (let start = 0; start < workerIds.length; start += 100) {
    const persons = await read(db.from("hr_payroll_run_people").select("id,run_id,worker_type,worker_id")
      .eq("company_id",companyId).in("worker_id",workerIds.slice(start,start+100)).order("id"));
    const runIds = [...new Set(persons.map(person => person.run_id))];
    const runs = new Map<string, any>();
    for (let index = 0; index < runIds.length; index += 100) {
      for (const run of await read(db.from("hr_payroll_runs").select("id,period_start,status")
        .eq("company_id",companyId).in("id",runIds.slice(index,index+100)).in("status",["calculated","reviewed","approved","locked"]).order("id"))) runs.set(run.id,run);
    }
    const personById = new Map(persons.filter(person => runs.has(person.run_id)).map(person => [person.id,person]));
    const personIds = [...personById.keys()];
    for (let index = 0; index < personIds.length; index += 100) {
      const items = await read(db.from("hr_payroll_run_items").select("id,run_person_id,amount,metadata")
        .eq("company_id",companyId).eq("code","ADVANCE_RECOVERY").in("run_person_id",personIds.slice(index,index+100)).order("id"));
      for (const item of items) {
        const person = personById.get(item.run_person_id);
        const advance = byId.get(String(item.metadata?.advance_id ?? ""));
        if (!person || !advance || advance.workerType !== person.worker_type || advance.workforceId !== person.worker_id) continue;
        add(applied,advance.id,runs.get(person.run_id).period_start,item.amount);
      }
    }
  }
  const workforce = rows.filter(row => (row.workerType ?? "workforce") === "workforce" && row.workforceId);
  const ids = [...new Set(workforce.map(row => row.workforceId))];
  const latest = new Set<string>();
  for (let start = 0; start < ids.length; start += 100) {
    const publications = await read(db.from("workforce_payout_publications")
      .select("id,workforce_id,station_id,period_start,period_end,revision,snapshot")
      .eq("company_id",companyId).eq("publication_kind","worksheet").in("workforce_id",ids.slice(start,start+100))
      .order("revision",{ascending:false}).order("id"));
    for (const publication of publications) {
      const identity = `${publication.workforce_id}|${publication.station_id}|${publication.period_start}|${publication.period_end}`;
      if (latest.has(identity)) continue;
      latest.add(identity);
      for (const line of publication.snapshot?.worksheet?.deduction_breakdown ?? []) {
        if (line.code !== "ADVANCE_RECOVERY" || !String(line.recoveryKey).startsWith("ADVANCE:")) continue;
        const advance = byId.get(String(line.recoveryKey).replace(/^ADVANCE:/,""));
        if (!advance || advance.workforceId !== publication.workforce_id || (advance.workerType ?? "workforce") !== "workforce") continue;
        add(applied,advance.id,publication.period_start,line.amount);
      }
    }
  }
  // The same read-only engine used by the payout page, including capacity limits and holds.
  const periods = [...new Set(workforce.filter(row => row.pending > 0).map(row => row.firstDuePeriod))].filter(period => /^\d{4}-\d{2}-01$/.test(period)).sort();
  for (const period of periods) {
    const periodIds = [...new Set(workforce.filter(row => row.pending > 0 && row.firstDuePeriod === period).map(row => row.workforceId))];
    for (let start = 0; start < periodIds.length; start += 100) {
      const result = await loadWorkforce(period,monthEnd(period),periodIds.slice(start,start+100));
      if (result.error) throw new Error(`Payout deductions could not be verified: ${result.error}`);
      for (const payout of result.rows) for (const line of payout.deductionBreakdown) {
        const advance = byId.get(String(line.recoveryKey ?? "").replace(/^ADVANCE:/,""));
        if (line.code !== "ADVANCE_RECOVERY" || !String(line.recoveryKey).startsWith("ADVANCE:") || !advance || (advance.workerType ?? "workforce") !== "workforce" || (payout.reviewSubjectType ?? "workforce") !== "workforce" || advance.workforceId !== payout.reviewSubjectId) continue;
        // Live due amounts exclude canonical confirmed recoveries; add only that remainder.
        add(live,advance.id,period,line.amount);
      }
    }
  }
  return rows.map(row => {
    let deducted = 0;
    const history = [...row.recoveryHistory];
    const keys = new Set([...confirmed.keys(),...applied.keys(),...live.keys()].filter(k => k.startsWith(`${row.id}|`)));
    for (const k of keys) {
      const base = confirmed.get(k) ?? 0;
      const total = Math.max(base + (live.get(k) ?? 0),applied.get(k) ?? 0);
      deducted = round(deducted + total);
      if (total > base) history.push({id:`payout:${k}`,periodStart:k.split("|")[1],periodEnd:monthEnd(k.split("|")[1]),amount:round(total-base),type:"payout",status:"deducted in payout",createdAt:row.createdAt,reversedAt:null,reversalReason:""});
    }
    deducted = Math.min(row.total,deducted);
    const pending = Math.max(0,round(row.total-deducted));
    return {...row,deducted,pending,status:pending <= 0 ? "Fully deducted" as const : deducted > 0 ? "Partially deducted" as const : row.linkStatus === "pending" ? "Awaiting Workforce registration" as const : "Pending" as const,recoveryHistory:history};
  });
}
