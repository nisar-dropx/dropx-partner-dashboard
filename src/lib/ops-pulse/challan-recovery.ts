import "server-only";
import type { AuthorizationContext } from "@/lib/authorization";
import { hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { nlStationScope } from "./nl-loss";

export type ChallanRecoveryAllocation = {
  id: string;
  personRef: string;
  personName: string;
  utr: string;
  amount: number;
  salaryMonth: string;
  installmentNo: number;
  installmentCount: number;
  status: string;
  remarks: string;
};

export type ChallanRecoveryCase = {
  id: string;
  challanId: string;
  challanNumber: string;
  vehicleNo: string;
  stationCode: string;
  month: string;
  amount: number;
  status: string;
  offenseDescription: string;
  evidenceUrl: string;
  issuingAuthority: string;
  approvedByName: string;
  approvedAt: string;
  createdAt: string;
  splitMode: "equal" | "custom";
  allocations: ChallanRecoveryAllocation[];
  allocated: number;
};

export type ChallanRecoveryPerson = {
  ref: string;
  employeeCode: string;
  fullName: string;
  designation: string;
  stationCodes: string[];
};

export type ChallanRecoveryView = {
  ready: boolean;
  cases: ChallanRecoveryCase[];
  people: ChallanRecoveryPerson[];
  payrollMonths: string[];
  canEdit: boolean;
};

const num = (v: unknown) => Number(v) || 0;
const text = (v: unknown) => String(v ?? "").trim();

/** Load the challan recovery queue, station-scoped, with assignable associates + open months. */
export async function loadChallanRecovery(auth: AuthorizationContext): Promise<ChallanRecoveryView> {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const { company, stations } = await nlStationScope(auth);
  const codes = stations.map((s) => s.source_code);
  const stationIds = stations.map((s) => s.id);

  const casesResult = codes.length
    ? await readAllRows(
        supabaseAdmin
          .from("fleet_challan_recovery_cases")
          .select("*")
          .eq("company_id", company)
          .in("station_code", codes)
          .order("month", { ascending: false })
          .order("created_at", { ascending: false })
      )
    : { data: [], error: null };
  if (casesResult.error) throw new Error("Challan recovery cases could not be loaded.");
  const cases = casesResult.data ?? [];

  const caseIds = cases.map((c) => c.id);
  const allocResult = caseIds.length
    ? await readAllRows(
        supabaseAdmin
          .from("fleet_challan_recovery_allocations")
          .select("*")
          .eq("company_id", company)
          .in("case_id", caseIds)
          .neq("status", "cancelled")
          .order("installment_no")
      )
    : { data: [], error: null };
  if (allocResult.error) throw new Error("Challan recovery allocations could not be loaded.");
  const allocByCase = new Map<string, any[]>();
  for (const a of allocResult.data ?? []) {
    const list = allocByCase.get(a.case_id) ?? [];
    list.push(a);
    allocByCase.set(a.case_id, list);
  }

  // Assignable associates across the scoped stations (dedup by ref).
  const peopleByRef = new Map<string, ChallanRecoveryPerson>();
  for (const sid of stationIds) {
    const r = await supabaseAdmin.rpc("loss_recovery_people_with_locations", { p_company: company, p_station: sid });
    if (r.error) continue;
    for (const p of (r.data ?? []) as any[]) {
      if (!p.is_active) continue;
      if (!peopleByRef.has(p.ref)) {
        peopleByRef.set(p.ref, {
          ref: text(p.ref),
          employeeCode: text(p.employee_code),
          fullName: text(p.full_name),
          designation: text(p.designation),
          stationCodes: Array.isArray(p.station_codes) ? p.station_codes.map(text) : []
        });
      }
    }
  }
  const people = [...peopleByRef.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));

  // Open payroll months the associates can be deducted in.
  let payrollMonths: string[] = [];
  if (people.length) {
    const win = await supabaseAdmin.rpc("loss_recovery_payroll_windows", {
      p_company: company,
      p_refs: people.map((p) => p.ref)
    });
    if (!win.error) {
      payrollMonths = [
        ...new Set(
          ((win.data ?? []) as any[])
            .filter((w) => w.payroll_open && (w.payable == null || Number(w.payable) > 0))
            .map((w) => text(w.salary_month))
        )
      ].sort().reverse();
    }
  }

  const mappedCases: ChallanRecoveryCase[] = cases.map((c) => {
    const allocs = (allocByCase.get(c.id) ?? []).map(
      (a): ChallanRecoveryAllocation => ({
        id: a.id,
        personRef: text(a.person_ref),
        personName: text(a.person_name),
        utr: text(a.utr),
        amount: num(a.amount),
        salaryMonth: text(a.salary_month),
        installmentNo: Number(a.installment_no) || 1,
        installmentCount: Number(a.installment_count) || 1,
        status: text(a.status),
        remarks: text(a.remarks)
      })
    );
    return {
      id: c.id,
      challanId: c.challan_id,
      challanNumber: text(c.challan_number),
      vehicleNo: text(c.vehicle_no),
      stationCode: text(c.station_code),
      month: text(c.month),
      amount: num(c.amount),
      status: text(c.status),
      offenseDescription: text(c.offense_description),
      evidenceUrl: text(c.evidence_url),
      issuingAuthority: text(c.issuing_authority),
      approvedByName: text(c.approved_by_name),
      approvedAt: c.approved_at,
      createdAt: c.created_at,
      splitMode: (allocs[0]?.personRef && allocs.every((x) => x.amount === allocs[0].amount) ? "equal" : "custom") as "equal" | "custom",
      allocations: allocs,
      allocated: allocs.reduce((s, a) => s + a.amount, 0)
    };
  });

  return {
    ready: true,
    cases: mappedCases,
    people,
    payrollMonths,
    canEdit: !auth.readOnly && hasPermission(auth, "ops_losses", "edit")
  };
}
