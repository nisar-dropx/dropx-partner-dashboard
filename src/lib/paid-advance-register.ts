import { readAllRows } from "./supabase-pagination";
import type { WorkforceAdvanceRegisterRow } from "../components/workforce-advance-register";

export type PaidAdvanceRegisterRow = {
  id: string;
  worker_type: "employee" | "contractor" | "workforce";
  worker_id: string | null;
  worker_code: string | null;
  request_id: string | null;
  amount: number;
  paid_at: string;
  first_due_period: string;
  evidence_type: string;
  bank_reference: string | null;
  provenance: Record<string, unknown> | null;
  name: string;
  station: string;
  designation: string;
  paidStation: string;
  created_at: string;
};

/** Both registers use paid principal, never requested or merely approved amounts. */
// Supabase's query builder types depend on the selected table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPaidAdvanceRegister(db: any, companyId: string) {
  const result = await readAllRows(db.from("pay_advances")
    .select("id,worker_type,worker_id,worker_code,request_id,amount,paid_at,first_due_period,evidence_type,bank_reference,provenance,created_at")
    .eq("company_id", companyId)
    .in("evidence_type", ["bank_confirmed", "legacy_recorded"])
    .order("paid_at", { ascending: false }).order("id"));
  if (result.error) throw new Error(result.error.message);
  const advances = (result.data ?? []) as PaidAdvanceRegisterRow[];
  const workers = new Map<string, { full_name: string; location_id: string | null; designation?: string; designations?: { name?: string } | { name?: string }[] }>();
  for (const [kind, table] of [["employee", "employees"], ["contractor", "contractors"], ["workforce", "workforce"]] as const) {
    const ids = [...new Set(advances.filter(a => a.worker_type === kind && a.worker_id).map(a => a.worker_id!))];
    for (let start = 0; start < ids.length; start += 100) {
      const designationFields = kind === "employee" ? "designations(name)" : kind === "workforce" ? "designation,designations(name)" : "designation";
      const profiles = await db.from(table).select(`id,full_name,location_id,${designationFields}`).eq("company_id", companyId).in("id", ids.slice(start, start + 100));
      if (profiles.error) throw new Error(profiles.error.message);
      for (const profile of profiles.data ?? []) workers.set(`${kind}:${profile.id}`, profile);
    }
  }
  const stationIds = [...new Set([...workers.values()].map(w => w.location_id).concat(advances.map(a => String(a.provenance?.station_id ?? ""))).filter(Boolean))];
  const stations = new Map<string, string>();
  for (let start = 0; start < stationIds.length; start += 100) {
    const locations = await db.from("stations").select("id,station_code").eq("company_id", companyId).in("id", stationIds.slice(start, start + 100));
    if (locations.error) throw new Error(locations.error.message);
    for (const station of locations.data ?? []) stations.set(station.id, station.station_code);
  }
  return advances.map(a => {
    const worker = workers.get(`${a.worker_type}:${a.worker_id}`);
    const designation = Array.isArray(worker?.designations) ? worker.designations[0] : worker?.designations;
    return { ...a, amount: Number(a.amount),
      name: worker?.full_name || String(a.provenance?.worker_name || "Awaiting registration"),
      designation: designation?.name || worker?.designation || "",
      paidStation: stations.get(String(a.provenance?.station_id ?? "")) ?? "—",
      station: stations.get(worker?.location_id ?? "") ?? "—" };
  });
}

/** Display confirmed recovery only; draft reservations are still pending. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPaidAdvanceRegisterView(db: any, companyId: string): Promise<WorkforceAdvanceRegisterRow[]> {
  const advances = await loadPaidAdvanceRegister(db, companyId);
  const history = new Map<string, WorkforceAdvanceRegisterRow["recoveryHistory"]>();
  const recovered = new Map<string, number>();
  for (let start = 0; start < advances.length; start += 100) {
    const result = await readAllRows(db.from("pay_advance_deductions")
      .select("id,advance_id,period_start,amount,target_kind,status,created_at,provenance")
      .eq("company_id", companyId).in("advance_id", advances.slice(start, start + 100).map(a => a.id))
      .order("created_at").order("id"));
    if (result.error) throw new Error(result.error.message);
    for (const r of result.data ?? []) {
      history.set(r.advance_id, [...(history.get(r.advance_id) ?? []), {
        id: r.id, periodStart: r.period_start, periodEnd: String(r.provenance?.period_end ?? r.period_start),
        amount: Number(r.amount), type: r.target_kind, status: r.status === "confirmed" ? "deducted" : r.status,
        createdAt: r.created_at, reversedAt: null, reversalReason: ""
      }]);
      if (["confirmed", "waived"].includes(r.status)) recovered.set(r.advance_id, (recovered.get(r.advance_id) ?? 0) + Number(r.amount));
    }
  }
  const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  return advances.map(a => {
    const deducted = Math.min(a.amount, money(recovered.get(a.id) ?? 0));
    const pending = Math.max(0, money(a.amount - deducted));
    return {
      id: a.id, workerType: a.worker_type, workforceId: a.worker_id ?? "", advanceNumber: String(a.provenance?.request_number ?? a.provenance?.advance_number ?? `ADV-${a.id.slice(0, 8)}`),
      advanceDate: a.paid_at.slice(0, 10), firstDuePeriod: a.first_due_period.slice(0, 10),
      dropxId: a.worker_code ?? "", originalDropxId: a.worker_code ?? "", identityRevision: 0,
      workforceName: a.name, designation: a.designation, location: a.station, paidLocation: a.paidStation,
      total: a.amount, deducted, pending,
      status: pending <= 0 ? "Fully deducted" : deducted > 0 ? "Partially deducted" : "Pending",
      linkStatus: a.worker_id ? "linked" : "pending", paymentMode: "bank", paymentReference: a.bank_reference ?? "",
      externalReference: "", remark: a.evidence_type === "legacy_recorded" ? "Historical paid advance" : "Bank confirmed",
      source: a.evidence_type, createdAt: a.created_at, recoveryHistory: history.get(a.id) ?? [], reassignmentHistory: []
    };
  });
}
