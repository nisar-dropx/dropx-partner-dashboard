import { readAllRows } from "./supabase-pagination";

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
};

/** Both registers use paid principal, never requested or merely approved amounts. */
// Supabase's query builder types depend on the selected table.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadPaidAdvanceRegister(db: any, companyId: string) {
  const result = await readAllRows(db.from("pay_advances")
    .select("id,worker_type,worker_id,worker_code,request_id,amount,paid_at,first_due_period,evidence_type,bank_reference,provenance")
    .eq("company_id", companyId)
    .in("evidence_type", ["bank_confirmed", "legacy_recorded"])
    .order("paid_at", { ascending: false }).order("id"));
  if (result.error) throw new Error(result.error.message);
  const advances = (result.data ?? []) as PaidAdvanceRegisterRow[];
  const workers = new Map<string, { full_name: string; location_id: string | null }>();
  for (const [kind, table] of [["employee", "employees"], ["contractor", "contractors"], ["workforce", "workforce"]] as const) {
    const ids = [...new Set(advances.filter(a => a.worker_type === kind && a.worker_id).map(a => a.worker_id!))];
    for (let start = 0; start < ids.length; start += 100) {
      const profiles = await db.from(table).select("id,full_name,location_id").eq("company_id", companyId).in("id", ids.slice(start, start + 100));
      if (profiles.error) throw new Error(profiles.error.message);
      for (const profile of profiles.data ?? []) workers.set(`${kind}:${profile.id}`, profile);
    }
  }
  const stationIds = [...new Set([...workers.values()].map(w => w.location_id).filter(Boolean))];
  const stations = new Map<string, string>();
  for (let start = 0; start < stationIds.length; start += 100) {
    const locations = await db.from("stations").select("id,station_code").eq("company_id", companyId).in("id", stationIds.slice(start, start + 100));
    if (locations.error) throw new Error(locations.error.message);
    for (const station of locations.data ?? []) stations.set(station.id, station.station_code);
  }
  return advances.map(a => {
    const worker = workers.get(`${a.worker_type}:${a.worker_id}`);
    return { ...a, amount: Number(a.amount),
      name: worker?.full_name || String(a.provenance?.worker_name || "Awaiting registration"),
      station: stations.get(worker?.location_id ?? "") ?? "—" };
  });
}
