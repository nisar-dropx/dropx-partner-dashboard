import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import { normalizeAssociateName, type CashReconAssociate } from "@/lib/ops-pulse/cash-recon-types";
import { fetchDriverReconciliation, isCashReconWorkerConfigured } from "@/lib/ops-pulse/cash-recon-worker";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadTechHoldsForDate } from "@/lib/ops-pulse/cod-tech-issues";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function persistRosterRows(params: {
  companyId: string;
  locationId: string;
  stationCode: string;
  date: string;
  associates: CashReconAssociate[];
  baselineAssociates: Array<{ providerEmployeeId: string; name: string }>;
}) {
  if (!supabaseAdmin) return;
  const { companyId, locationId, stationCode, date, associates, baselineAssociates } = params;
  const now = new Date().toISOString();
  // Only persist DB (baseline) employee IDs — never tasId-only cash-recon extras.
  const baselineById = new Map(
    baselineAssociates.map((row) => [row.providerEmployeeId.trim().toUpperCase(), row])
  );
  const rosterById = new Map<string, { associate: CashReconAssociate; baseline: { providerEmployeeId: string; name: string } }>();
  for (const associate of associates) {
    if (associate.source === "extra" || associate.source === "other") continue;
    const key = String(associate.providerEmployeeId ?? "").trim().toUpperCase();
    if (!key || key === "__OTHER__") continue;
    const baseline = baselineById.get(key);
    if (!baseline) continue;
    const current = rosterById.get(key);
    if (!current || Number(associate.expected) > Number(current.associate.expected)) {
      rosterById.set(key, { associate, baseline });
    }
  }
  const rosterRows = Array.from(rosterById.values()).map(({ associate, baseline }) =>
    withCompany({
      location_id: locationId,
      station_code: stationCode,
      portal_station_code: stationCode,
      business_date: date,
      provider_employee_id: baseline.providerEmployeeId,
      associate_name: associate.displayName || associate.name || baseline.name,
      normalized_associate_name: normalizeAssociateName(associate.displayName || associate.name || baseline.name),
      route_code: null,
      reconciliation_state: associate.pendingRecon > 0 ? "Pending recon" : "Cash recon",
      pending_amount: associate.pendingRecon,
      pending_details: associate.breakdown.map((item) => ({
        tracking_id: item.trackingId,
        payment_method: item.paymentMethod,
        money_collection_time: item.moneyCollectionTime,
        amount: item.amount,
        station_time_zone: item.stationTimeZone
      })),
      last_detail_checked_at: now,
      raw_row: {
        source: "cash_recon_worker",
        expected: associate.expected,
        expected_source: "expected_cash",
        pending_recon: associate.pendingRecon,
        associate_source: associate.source,
        employee_id: associate.employeeId
      },
      source: "scc_driver_reconciliation",
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now
    }, companyId)
  );

  if (!rosterRows.length) return;

  // Prefer delete+insert: personal DBs often lack the unique index required by upsert onConflict.
  const { error: deleteError } = await supabaseAdmin
    .from("cod_driver_reconciliation_roster")
    .delete()
    .eq("company_id", companyId)
    .eq("business_date", date)
    .eq("station_code", stationCode);
  if (deleteError) {
    console.error("cash-recon roster delete failed", deleteError.message);
    return;
  }

  const insertRows = rosterRows.map((row) => ({
    ...row,
    id: crypto.randomUUID(),
    created_at: now
  }));
  const { error: insertError } = await supabaseAdmin
    .from("cod_driver_reconciliation_roster")
    .insert(insertRows);
  if (insertError) {
    console.error("cash-recon roster insert failed", insertError.message);
  }
}

export async function POST(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization || !hasPermission(authorization, "cod_executive_reconciliation", "access")) {
      return NextResponse.json({ error: "Executive reconciliation access denied." }, { status: 403 });
    }
    const companyId = requireCompanyId(authorization);
    if (!isCashReconWorkerConfigured()) {
      return NextResponse.json(
        { error: "Cash recon worker is not configured. Set CASH_RECON_WORKER_URL and CASH_RECON_ADMIN_KEY." },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({})) as {
      stationCode?: string;
      date?: string;
      locationId?: string;
      baselineAssociates?: Array<{ providerEmployeeId?: string; name?: string }>;
    };
    const stationCode = String(body.stationCode ?? "").trim().toUpperCase();
    const date = String(body.date ?? "").trim();
    const locationId = String(body.locationId ?? "").trim();
    if (!stationCode || !date) {
      return NextResponse.json({ error: "stationCode and date are required." }, { status: 400 });
    }
    if (!authorization.hasAllLocationAccess && locationId && !authorization.locationScopeIds.includes(locationId)) {
      return NextResponse.json({ error: "You do not have access to this station." }, { status: 403 });
    }

    const baselineAssociates = Array.isArray(body.baselineAssociates)
      ? body.baselineAssociates
        .map((row) => ({
          providerEmployeeId: String(row?.providerEmployeeId ?? "").trim(),
          name: String(row?.name ?? "").trim()
        }))
        .filter((row) => row.providerEmployeeId && row.name)
      : [];

    const techHolds = await loadTechHoldsForDate(companyId, stationCode, date);
    const result = await fetchDriverReconciliation({ stationCode, date, baselineAssociates, techHolds });

    if (locationId) {
      await persistRosterRows({
        companyId,
        locationId,
        stationCode,
        date,
        associates: result.associates,
        baselineAssociates
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load driver reconciliation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
