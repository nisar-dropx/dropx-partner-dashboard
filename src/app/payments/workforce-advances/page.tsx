import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import {
  WorkforceAdvanceRegister,
  type WorkforceAdvanceOption,
  type WorkforceAdvanceRegisterRow
} from "@/components/workforce-advance-register";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { hasPermission, isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const NO_LOCATION = "00000000-0000-0000-0000-000000000000";

async function readAllRows(query: any) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const result = await query.range(from, from + 999);
    if (result.error) return { data: rows, error: result.error as { message: string } };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < 1000) return { data: rows, error: null };
  }
}

function designationLabel(worker: any) {
  const linked = Array.isArray(worker?.designations) ? worker.designations[0] : worker?.designations;
  return String(linked?.name ?? worker?.designation ?? linked?.code ?? "");
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDropxId(value: unknown) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export const dynamic = "force-dynamic";

export default async function WorkforceAdvancesPage() {
  const surface = currentAdminAccessSurface();
  const pageCode = surface === "ops" ? "ops_workforce_advances" : "workforce_advances";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
  const allowedLocationIds = new Set(authorization.locationScopeIds.map(String));
  const canAdd = hasPermission(authorization, pageCode, "add");
  const canEdit = hasPermission(authorization, pageCode, "edit");
  let rows: WorkforceAdvanceRegisterRow[] = [];
  let workforceOptions: WorkforceAdvanceOption[] = [];
  let error: string | null = null;

  if (!supabaseAdmin) {
    error = "Database configuration is unavailable.";
  } else {
    let workforceQuery = supabaseAdmin
      .from("workforce")
      .select("id,dropx_id,full_name,designation,location_id,onboarding_status,lifecycle_status,is_active,deleted_at,designations(code,name)")
      .eq("company_id", companyId)
      .or("migration_state.is.null,migration_state.neq.reclassified")
      .order("dropx_id");
    const stationsQuery = supabaseAdmin
      .from("stations")
      .select("id,station_code,station_name")
      .eq("company_id", companyId)
      .order("station_code");
    if (!allLocations) {
      const scope = authorization.locationScopeIds.length ? authorization.locationScopeIds : [NO_LOCATION];
      workforceQuery = workforceQuery.in("location_id", scope);
    }

    const [workforceResult, stationResult] = await Promise.all([
      readAllRows(workforceQuery),
      readAllRows(stationsQuery)
    ]);
    error = workforceResult.error?.message ?? stationResult.error?.message ?? null;
    if (!error) {
      const visibleWorkforceIds = workforceResult.data.map((worker) => String(worker.id));
      const advances: any[] = [];
      if (allLocations) {
        const advanceResult = await readAllRows(supabaseAdmin
          .from("workforce_advances")
          .select("id,workforce_id,station_id,imported_dropx_id,link_status,identity_revision,opening_deducted_amount,linked_at,advance_number,advance_date,amount,payment_mode,payment_reference,external_reference,remark,source_type,created_at")
          .eq("company_id", companyId)
          .order("advance_date", { ascending: false })
          .order("created_at", { ascending: false }));
        advances.push(...advanceResult.data);
        error = advanceResult.error?.message ?? null;
      } else {
        for (let index = 0; index < visibleWorkforceIds.length; index += 100) {
          const advanceResult = await readAllRows(supabaseAdmin
            .from("workforce_advances")
            .select("id,workforce_id,station_id,imported_dropx_id,link_status,identity_revision,opening_deducted_amount,linked_at,advance_number,advance_date,amount,payment_mode,payment_reference,external_reference,remark,source_type,created_at")
            .eq("company_id", companyId)
            .in("workforce_id", visibleWorkforceIds.slice(index, index + 100))
            .order("advance_date", { ascending: false })
            .order("created_at", { ascending: false }));
          advances.push(...advanceResult.data);
          if (advanceResult.error) { error = advanceResult.error.message; break; }
        }
      }
      advances.sort((left, right) => `${right.advance_date}|${right.created_at}`.localeCompare(`${left.advance_date}|${left.created_at}`));
      const workforceById = new Map(workforceResult.data.map((worker) => [String(worker.id), worker]));
      const stationById = new Map(stationResult.data.map((station) => [String(station.id), station]));
      const recoveredByAdvance = new Map<string, number>();
      const recoveryHistoryByAdvance = new Map<string, WorkforceAdvanceRegisterRow["recoveryHistory"]>();
      const reassignmentHistoryByAdvance = new Map<string, WorkforceAdvanceRegisterRow["reassignmentHistory"]>();
      const advanceIds = advances.map((row) => String(row.id));
      for (let index = 0; index < advanceIds.length; index += 100) {
        const ids = advanceIds.slice(index, index + 100);
        const [recoveries, reassignments] = await Promise.all([
          readAllRows(supabaseAdmin
            .from("workforce_advance_recoveries")
            .select("id,advance_id,period_start,period_end,amount,recovery_type,status,created_at,reversed_at,reversal_reason")
            .eq("company_id", companyId)
            .in("advance_id", ids)
            .order("created_at")),
          readAllRows(supabaseAdmin
            .from("workforce_advance_reassignments")
            .select("id,advance_id,revision,original_imported_dropx_id,from_station_id,from_dropx_id,from_workforce_name,from_location,to_station_id,to_dropx_id,to_workforce_name,to_location,reason,reassigned_at")
            .eq("company_id", companyId)
            .in("advance_id", ids)
            .order("revision", { ascending: false }))
        ]);
        error = recoveries.error?.message ?? reassignments.error?.message ?? null;
        if (error) break;
        for (const recovery of recoveries.data) {
          const key = String(recovery.advance_id);
          recoveryHistoryByAdvance.set(key, [...(recoveryHistoryByAdvance.get(key) ?? []), {
            id: String(recovery.id),
            periodStart: String(recovery.period_start),
            periodEnd: String(recovery.period_end),
            amount: roundMoney(Number(recovery.amount ?? 0)),
            type: String(recovery.recovery_type),
            status: String(recovery.status),
            createdAt: String(recovery.created_at),
            reversedAt: recovery.reversed_at ? String(recovery.reversed_at) : null,
            reversalReason: String(recovery.reversal_reason ?? "")
          }]);
          if (String(recovery.status) === "deducted") {
            recoveredByAdvance.set(key, roundMoney((recoveredByAdvance.get(key) ?? 0) + Number(recovery.amount ?? 0)));
          }
        }
        for (const reassignment of reassignments.data) {
          const reassignmentLocationIds = [reassignment.from_station_id, reassignment.to_station_id]
            .filter((value) => value != null)
            .map(String);
          if (!allLocations && !reassignmentLocationIds.every((locationId) => allowedLocationIds.has(locationId))) {
            continue;
          }
          const key = String(reassignment.advance_id);
          reassignmentHistoryByAdvance.set(key, [...(reassignmentHistoryByAdvance.get(key) ?? []), {
            id: String(reassignment.id),
            revision: Number(reassignment.revision ?? 0),
            originalDropxId: String(reassignment.original_imported_dropx_id ?? ""),
            fromDropxId: String(reassignment.from_dropx_id ?? ""),
            fromWorkforceName: String(reassignment.from_workforce_name ?? ""),
            fromLocation: String(reassignment.from_location ?? ""),
            toDropxId: String(reassignment.to_dropx_id ?? ""),
            toWorkforceName: String(reassignment.to_workforce_name ?? ""),
            toLocation: String(reassignment.to_location ?? ""),
            reason: String(reassignment.reason ?? ""),
            reassignedAt: String(reassignment.reassigned_at)
          }]);
        }
      }
      if (!error) {
        rows = advances.map((advance) => {
          const worker = workforceById.get(String(advance.workforce_id));
          const paidStation = stationById.get(String(advance.station_id));
          const currentStation = stationById.get(String(worker?.location_id ?? ""));
          const linkStatus = String(advance.link_status) === "pending" ? "pending" : "linked";
          const total = roundMoney(Number(advance.amount ?? 0));
          const deducted = Math.min(total, roundMoney(linkStatus === "pending"
            ? Number(advance.opening_deducted_amount ?? 0)
            : recoveredByAdvance.get(String(advance.id)) ?? 0));
          const pending = Math.max(0, roundMoney(total - deducted));
          const externalReference = String(advance.external_reference ?? "");
          return {
            id: String(advance.id),
            workforceId: String(advance.workforce_id ?? ""),
            advanceNumber: String(advance.advance_number),
            advanceDate: String(advance.advance_date),
            dropxId: String(linkStatus === "pending" ? advance.imported_dropx_id ?? "" : worker?.dropx_id ?? advance.imported_dropx_id ?? ""),
            originalDropxId: String(advance.imported_dropx_id ?? ""),
            identityRevision: Number(advance.identity_revision ?? 0),
            workforceName: linkStatus === "pending" ? "Awaiting Workforce registration" : String(worker?.full_name ?? "Workforce record unavailable"),
            designation: linkStatus === "pending" ? "" : designationLabel(worker),
            location: linkStatus === "pending" ? "—" : String(currentStation?.station_code ?? currentStation?.station_name ?? "—"),
            paidLocation: linkStatus === "pending" ? "—" : String(paidStation?.station_code ?? paidStation?.station_name ?? "—"),
            total,
            deducted,
            pending,
            status: linkStatus === "pending" ? "Awaiting Workforce registration" : pending <= 0 ? "Fully deducted" : deducted > 0 ? "Partially deducted" : "Pending",
            linkStatus,
            paymentMode: String(advance.payment_mode ?? "other"),
            paymentReference: String(advance.payment_reference ?? ""),
            externalReference: /^WAI[12]-/.test(externalReference) ? "" : externalReference,
            remark: String(advance.remark ?? ""),
            source: String(advance.source_type ?? "manual"),
            createdAt: String(advance.created_at),
            recoveryHistory: recoveryHistoryByAdvance.get(String(advance.id)) ?? [],
            reassignmentHistory: reassignmentHistoryByAdvance.get(String(advance.id)) ?? []
          } satisfies WorkforceAdvanceRegisterRow;
        });
        workforceOptions = workforceResult.data
          .filter((worker) => !worker.deleted_at
            && worker.location_id
            && stationById.has(String(worker.location_id))
            && normalizeDropxId(worker.dropx_id) !== "")
          .map((worker) => {
            const station = stationById.get(String(worker.location_id));
            return {
              id: String(worker.id),
              dropxId: String(worker.dropx_id ?? ""),
              name: String(worker.full_name ?? "Workforce"),
              designation: designationLabel(worker),
              location: String(station?.station_code ?? station?.station_name ?? "—")
            } satisfies WorkforceAdvanceOption;
          });
      }
    }
  }

  return <AppShell active="Workforce Advance Register" pageCode={pageCode}>
    <PageHead
      eyebrow="Payments"
      title="Workforce Advance Register"
      subtitle="Track paid, recovered, and pending advances. Unregistered DropX IDs remain visible to company-wide users and become deductible only after Workforce registration links them."
    />
    {error
      ? <section className="panel message-panel error"><div className="panel-body"><strong>Advance register unavailable</strong><p className="subtle">{error}</p></div></section>
      : <WorkforceAdvanceRegister canAdd={canAdd} canEdit={canEdit} rows={rows} workforceOptions={workforceOptions} />}
  </AppShell>;
}
