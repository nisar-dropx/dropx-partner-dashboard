import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import {
  PaymentRecoveryRegister,
  type PaymentRecoveryRegisterRow
} from "@/components/payment-recovery-register";
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

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export const dynamic = "force-dynamic";

export default async function PaymentRecoveriesPage() {
  const pageCode = "payment_recoveries";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const allLocations = authorization.hasAllLocationAccess || isCompanyOwner(authorization);
  const allowedLocationIds = new Set(authorization.locationScopeIds.map(String));
  const canAdd = hasPermission(authorization, pageCode, "add");
  let rows: PaymentRecoveryRegisterRow[] = [];
  let error: string | null = null;

  if (!supabaseAdmin) {
    error = "Database configuration is unavailable.";
  } else {
    let casesQuery = supabaseAdmin
      .from("payment_recovery_cases")
      .select("id,tid,provider_id,station_id,debit_month,debit_amount,recovery_method,status,provider_code_snapshot,provider_name_snapshot,station_code_snapshot,provider_reference,reason,remark,source_type,created_at,updated_at")
      .eq("company_id", companyId)
      .order("debit_month", { ascending: false })
      .order("created_at", { ascending: false });
    if (!allLocations) {
      casesQuery = casesQuery.in(
        "station_id",
        authorization.locationScopeIds.length ? authorization.locationScopeIds : [NO_LOCATION]
      );
    }

    const [caseResult, stationResult] = await Promise.all([
      readAllRows(casesQuery),
      readAllRows(supabaseAdmin
        .from("stations")
        .select("id,station_code,station_name")
        .eq("company_id", companyId))
    ]);
    error = caseResult.error?.message ?? stationResult.error?.message ?? null;

    if (!error) {
      const caseIds = caseResult.data.map((row) => String(row.id));
      const allocations: any[] = [];
      const events: any[] = [];
      for (let index = 0; index < caseIds.length; index += 100) {
        const ids = caseIds.slice(index, index + 100);
        const [allocationResult, eventResult] = await Promise.all([
          readAllRows(supabaseAdmin
            .from("payment_recovery_allocations")
            .select("id,recovery_case_id,imported_dropx_id,target_type,target_id,station_id,person_name_snapshot,category_snapshot,allocation_amount,link_status,allocation_order,linked_at")
            .eq("company_id", companyId)
            .in("recovery_case_id", ids)
            .order("allocation_order")),
          readAllRows(supabaseAdmin
            .from("payment_recovery_events")
            .select("id,recovery_case_id,allocation_id,event_type,status,amount,period_start,period_end,reference,created_at")
            .eq("company_id", companyId)
            .in("recovery_case_id", ids)
            .order("created_at"))
        ]);
        allocations.push(...allocationResult.data);
        events.push(...eventResult.data);
        error = allocationResult.error?.message ?? eventResult.error?.message ?? null;
        if (error) break;
      }

      if (!error) {
        const stationById = new Map(stationResult.data.map((station) => [String(station.id), station]));
        const allocationsByCase = new Map<string, any[]>();
        const recoveredByCase = new Map<string, number>();
        for (const allocation of allocations) {
          const key = String(allocation.recovery_case_id);
          allocationsByCase.set(key, [...(allocationsByCase.get(key) ?? []), allocation]);
        }
        for (const event of events) {
          if (String(event.status) !== "applied") continue;
          const key = String(event.recovery_case_id);
          const signedAmount = String(event.event_type) === "reversal"
            ? -Number(event.amount ?? 0)
            : Number(event.amount ?? 0);
          recoveredByCase.set(key, roundMoney((recoveredByCase.get(key) ?? 0) + signedAmount));
        }

        rows = caseResult.data.flatMap((recovery): PaymentRecoveryRegisterRow[] => {
          const caseAllocations = allocationsByCase.get(String(recovery.id)) ?? [];
          if (!allLocations && caseAllocations.some((allocation) =>
            String(allocation.link_status) !== "linked"
            || !allowedLocationIds.has(String(allocation.station_id ?? "")))) {
            return [];
          }
          const debitAmount = roundMoney(Number(recovery.debit_amount ?? 0));
          const recoveredAmount = Math.max(
            0,
            Math.min(debitAmount, roundMoney(recoveredByCase.get(String(recovery.id)) ?? 0))
          );
          return [{
            id: String(recovery.id),
            tid: String(recovery.tid),
            providerCode: String(recovery.provider_code_snapshot ?? ""),
            providerName: String(recovery.provider_name_snapshot ?? ""),
            location: String(recovery.station_code_snapshot ?? ""),
            debitMonth: String(recovery.debit_month),
            debitAmount,
            recoveredAmount,
            pendingAmount: Math.max(0, roundMoney(debitAmount - recoveredAmount)),
            recoveryMethod: String(recovery.recovery_method) as PaymentRecoveryRegisterRow["recoveryMethod"],
            status: String(recovery.status) as PaymentRecoveryRegisterRow["status"],
            providerReference: String(recovery.provider_reference ?? ""),
            reason: String(recovery.reason ?? ""),
            remark: String(recovery.remark ?? ""),
            source: String(recovery.source_type ?? "bulk_import"),
            createdAt: String(recovery.created_at),
            allocations: caseAllocations.map((allocation) => {
              const station = stationById.get(String(allocation.station_id ?? ""));
              return {
                id: String(allocation.id),
                dropxId: String(allocation.imported_dropx_id ?? ""),
                targetType: String(allocation.target_type),
                personName: String(allocation.person_name_snapshot ?? ""),
                category: String(allocation.category_snapshot ?? ""),
                location: String(station?.station_code ?? station?.station_name ?? "—"),
                amount: roundMoney(Number(allocation.allocation_amount ?? 0)),
                linkStatus: String(allocation.link_status) === "pending" ? "pending" : "linked"
              };
            })
          }];
        });
      }
    }
  }

  return <AppShell active="Recovery" pageCode={pageCode}>
    <PageHead
      eyebrow="Payments"
      title="Payment Recovery"
      subtitle="Track monthly provider-debited TIDs and plan recovery through People payouts or a post-invoice provider dispute."
    />
    {error
      ? <section className="panel message-panel error"><div className="panel-body"><strong>Recovery register unavailable</strong><p className="subtle">{error}</p></div></section>
      : <PaymentRecoveryRegister canAdd={canAdd} rows={rows} />}
  </AppShell>;
}
