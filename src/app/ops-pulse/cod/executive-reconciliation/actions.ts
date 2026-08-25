"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { waitUntil } from "@vercel/functions";
import { requireCompanyId, withCompany } from "@/lib/company-scope";
import {
  clean,
  required,
} from "@/lib/ops-pulse/cod";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { finalizeCodClosure, notifyCodManager } from "@/lib/ops-pulse/cod-day-closure";
import { canAccessCodAudit, writeCodAudit } from "@/lib/ops-pulse/cod-audit";
import { fetchLiabilitySummary, fetchRemittance, isCashReconWorkerConfigured } from "@/lib/ops-pulse/cash-recon-worker";

const pagePath = "/ops-pulse/cod/executive-reconciliation";
const publicPagePath = "/cod/executive-reconciliation";
// Keep in sync with DIFFERENCE_REMARKS_RUPEES in deposit-remittance-panel.tsx and
// the final-submit gate in cod-day-closure.ts — small variance needs no explanation.
const DIFFERENCE_REMARKS_RUPEES = 5;

export type CashEntryActionResult = {
  ok: boolean;
  notice?: string;
  error?: string;
  nextHref?: string;
};

function setFlashCookie(params: { error?: string; notice?: string }) {
  cookies().set("dropx_cod_executive_reconciliation_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 25,
    path: "/",
    sameSite: "lax"
  });
}

function redirectWithFlash(params: { error?: string; notice?: string }, href = publicPagePath): never {
  // path "/" so flash works on both /cod/* (ops host) and /ops-pulse/cod/* URLs
  setFlashCookie(params);
  redirect(href);
}

function safeReturnHref(value: FormDataEntryValue | null) {
  const href = clean(value);
  if (!href) return publicPagePath;
  if (href.startsWith(publicPagePath) || href.startsWith(pagePath)) return href;
  return publicPagePath;
}

function withStep(href: string, step: number) {
  try {
    const url = new URL(href, "https://dropx.local");
    url.searchParams.set("step", String(step));
    return `${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

function wantsClientResponse(formData: FormData) {
  return clean(formData.get("response_mode")) === "client";
}

function appBaseUrl() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || process.env.VERCEL_URL;
  if (!appUrl) return "";
  return appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function isMissingPortalCheckSetup(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? error ?? "").toLowerCase();
  return message.includes("ops_portal_check_runs") ||
    message.includes("ops_portal_check_events") ||
    (message.includes("schema cache") && message.includes("portal_check"));
}

function optionalAmount(value: FormDataEntryValue | null, field = "Amount") {
  const text = clean(value);
  if (!text) return 0;
  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} must be a valid amount.`);
  return Number(parsed.toFixed(2));
}

function optionalCount(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) return 0;
  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${field} must be a valid count.`);
  return parsed;
}

function optionalNumber(value: FormDataEntryValue | null) {
  const text = clean(value);
  if (!text) return 0;
  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Activity count must be a valid number.");
  return Number(parsed.toFixed(2));
}

function manualExecutiveId(stationCode: string, businessDate: string, associateName: string) {
  const slug = associateName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `MANUAL-${stationCode}-${businessDate}-${slug || "ASSOCIATE"}`;
}

function reconciliationStatus(expectedAmount: number, collectedAmount: number) {
  if (expectedAmount === 0 && collectedAmount === 0) return "Pending";
  const difference = Number((collectedAmount - expectedAmount).toFixed(2));
  if (Math.abs(difference) < 0.01) return "Completed";
  return difference < 0 ? "Pending Amount" : "Mismatch";
}

async function stationForInput(companyId: string, locationId: string | null, stationCode: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const columns = "id, station_code, station_name, state";
  const query = supabaseAdmin.from("stations").select(columns).eq("company_id", companyId);
  const result = locationId
    ? await query.eq("id", locationId).maybeSingle()
    : await query.eq("station_code", stationCode ?? "").maybeSingle();

  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new Error("Select a valid station from Location Master.");
  return result.data as { id: string; station_code: string; station_name: string | null; state: string | null };
}

function assertLocationAccess(authorization: AuthorizationContext, locationId: string) {
  if (authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(locationId)) return;
  throw new Error("You do not have access to update this station.");
}

async function assertClosureEditable(companyId: string, businessDate: string, locationId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { data, error } = await supabaseAdmin
    .from("cod_day_closures")
    .select("is_final_submitted")
    .eq("company_id", companyId)
    .eq("business_date", businessDate)
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.is_final_submitted) {
    throw new Error("This COD day is finally submitted and locked. Reopen it through manager approval before editing.");
  }
}

async function markCashSubmissionStale(companyId: string, businessDate: string, locationId: string) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("cod_day_closures")
    .update({
      submission_status: "Draft",
      validation_status: "Validation required",
      driver_check_status: "Not run",
      deposit_check_status: "Locked",
      updated_at: new Date().toISOString()
    })
    .eq("company_id", companyId)
    .eq("business_date", businessDate)
    .eq("location_id", locationId)
    .eq("is_final_submitted", false);
}

async function savePayload(
  formData: FormData,
  authorization: AuthorizationContext,
  companyId: string,
  successMessage: string
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const returnHref = safeReturnHref(formData.get("return_href"));
  const businessDate = required(formData.get("business_date"), "Business date");
  const stationCode = clean(formData.get("station_code"))?.trim().toUpperCase() ?? "";
  const locationId = clean(formData.get("location_id"));
  if (!locationId && !stationCode) throw new Error("Station is required.");
  const station = await stationForInput(companyId, locationId, stationCode || null);
  assertLocationAccess(authorization, station.id);
  await assertClosureEditable(companyId, businessDate, station.id);

  const sourceAssociateName = clean(formData.get("source_associate_name"));
  const manualAssociateName = clean(formData.get("manual_associate_name"));
  if (!sourceAssociateName && !manualAssociateName) {
    throw new Error("Associate name is required when the executive is not available in SCC Driver Reconciliation.");
  }
  const providerEmployeeIdInput = clean(formData.get("provider_employee_id"))?.trim();
  const providerEmployeeId = !providerEmployeeIdInput
    || providerEmployeeIdInput === "__manual__"
    || providerEmployeeIdInput === "__other__"
    ? manualExecutiveId(
      station.station_code,
      businessDate,
      required(manualAssociateName || formData.get("manual_associate_name"), "Associate name")
    )
    : providerEmployeeIdInput;

  const expectedOriginalText = clean(formData.get("expected_original"));
  const expectedAmount = optionalAmount(formData.get("expected_amount"), "Expected COD amount");
  const expectedOriginal = expectedOriginalText == null || expectedOriginalText === ""
    ? expectedAmount
    : optionalAmount(expectedOriginalText, "Original expected COD");
  const expectedEdited = Math.abs(expectedAmount - expectedOriginal) >= 0.01;
  const pendingRecon = optionalAmount(formData.get("pending_recon_amount") ?? "0", "Pending recon");
  const pendingOverrideRemarks = clean(formData.get("pending_override_remarks"));
  if (pendingRecon > 0.01 && !pendingOverrideRemarks) {
    throw new Error("Pending cash recon is above zero. Clear it in SCC or provide manual override remarks.");
  }

  const cash500Input = optionalCount(formData.get("cash_500_count"), "Rs 500 note count");
  const cash200Input = optionalCount(formData.get("cash_200_count"), "Rs 200 note count");
  const cash100Input = optionalCount(formData.get("cash_100_count"), "Rs 100 note count");
  const cash50Input = optionalCount(formData.get("cash_50_count"), "Rs 50 note count");
  const cash20Input = optionalCount(formData.get("cash_20_count"), "Rs 20 note count");
  const cash10Input = optionalCount(formData.get("cash_10_count"), "Rs 10 note count");
  const cashOtherInput = optionalAmount(formData.get("cash_other_amount"), "Other cash amount");
  const returnCash500Input = optionalCount(formData.get("return_cash_500_count"), "Returned Rs 500 note count");
  const returnCash200Input = optionalCount(formData.get("return_cash_200_count"), "Returned Rs 200 note count");
  const returnCash100Input = optionalCount(formData.get("return_cash_100_count"), "Returned Rs 100 note count");
  const returnCash50Input = optionalCount(formData.get("return_cash_50_count"), "Returned Rs 50 note count");
  const returnCash20Input = optionalCount(formData.get("return_cash_20_count"), "Returned Rs 20 note count");
  const returnCash10Input = optionalCount(formData.get("return_cash_10_count"), "Returned Rs 10 note count");
  const returnCashOtherInput = optionalAmount(formData.get("return_cash_other_amount"), "Returned other cash amount");
  const accumulateExisting = String(formData.get("accumulate_existing") ?? "").trim() === "1";

  const existing = await supabaseAdmin
    .from("cod_executive_reconciliations")
    .select("*")
    .eq("company_id", companyId)
    .eq("business_date", businessDate)
    .eq("station_code", station.station_code)
    .eq("provider_employee_id", providerEmployeeId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  const addToExisting = accumulateExisting && Boolean(existing.data);
  const prior = addToExisting && existing.data ? existing.data : null;
  const cash500 = cash500Input + (prior ? Number(prior.cash_500_count ?? 0) : 0);
  const cash200 = cash200Input + (prior ? Number(prior.cash_200_count ?? 0) : 0);
  const cash100 = cash100Input + (prior ? Number(prior.cash_100_count ?? 0) : 0);
  const cash50 = cash50Input + (prior ? Number(prior.cash_50_count ?? 0) : 0);
  const cash20 = cash20Input + (prior ? Number(prior.cash_20_count ?? 0) : 0);
  const cash10 = cash10Input + (prior ? Number(prior.cash_10_count ?? 0) : 0);
  const cashOther = Number((
    cashOtherInput + (prior ? Number(prior.cash_other_amount ?? 0) : 0)
  ).toFixed(2));
  const returnCash500 = returnCash500Input + (prior ? Number(prior.return_cash_500_count ?? 0) : 0);
  const returnCash200 = returnCash200Input + (prior ? Number(prior.return_cash_200_count ?? 0) : 0);
  const returnCash100 = returnCash100Input + (prior ? Number(prior.return_cash_100_count ?? 0) : 0);
  const returnCash50 = returnCash50Input + (prior ? Number(prior.return_cash_50_count ?? 0) : 0);
  const returnCash20 = returnCash20Input + (prior ? Number(prior.return_cash_20_count ?? 0) : 0);
  const returnCash10 = returnCash10Input + (prior ? Number(prior.return_cash_10_count ?? 0) : 0);
  const returnCashOther = Number((
    returnCashOtherInput + (prior ? Number(prior.return_cash_other_amount ?? 0) : 0)
  ).toFixed(2));
  const thisTripReceived = Number((
    cash500Input * 500 +
    cash200Input * 200 +
    cash100Input * 100 +
    cash50Input * 50 +
    cash20Input * 20 +
    cash10Input * 10 +
    cashOtherInput
  ).toFixed(2));
  const thisTripReturned = Number((
    returnCash500Input * 500 +
    returnCash200Input * 200 +
    returnCash100Input * 100 +
    returnCash50Input * 50 +
    returnCash20Input * 20 +
    returnCash10Input * 10 +
    returnCashOtherInput
  ).toFixed(2));
  if (thisTripReturned - thisTripReceived > 0.009) {
    throw new Error("Returned amount cannot be greater than received cash for this entry.");
  }
  const receivedAmount = Number((
    cash500 * 500 +
    cash200 * 200 +
    cash100 * 100 +
    cash50 * 50 +
    cash20 * 20 +
    cash10 * 10 +
    cashOther
  ).toFixed(2));
  const returnedAmount = Number((
    returnCash500 * 500 +
    returnCash200 * 200 +
    returnCash100 * 100 +
    returnCash50 * 50 +
    returnCash20 * 20 +
    returnCash10 * 10 +
    returnCashOther
  ).toFixed(2));
  const collectedAmount = Number((receivedAmount - returnedAmount).toFixed(2));
  if (collectedAmount < -0.009) {
    throw new Error("Net collected amount cannot be negative.");
  }
  const storedExpected = addToExisting && prior
    ? Number(prior.expected_amount ?? 0)
    : expectedAmount;
  const differenceAmount = Number((collectedAmount - storedExpected).toFixed(2));
  const baseRemarks = clean(formData.get("remarks"));
  if (expectedEdited && !addToExisting && !baseRemarks) {
    throw new Error("Remarks are required when Expected COD is edited.");
  }
  const remarkParts = [
    baseRemarks,
    expectedEdited && !addToExisting ? `Expected edited from ₹${expectedOriginal.toFixed(2)} to ₹${expectedAmount.toFixed(2)}.` : null,
    pendingOverrideRemarks ? `Pending recon override: ${pendingOverrideRemarks}` : null,
    addToExisting
      ? `Additional received ₹${thisTripReceived.toFixed(2)}${thisTripReturned > 0 ? ` with ₹${thisTripReturned.toFixed(2)} returned` : ""} added to saved cash.`
      : null
  ].filter(Boolean);
  const remarks = remarkParts.length ? remarkParts.join(" ") : null;

  const payload = withCompany({
    business_date: businessDate,
    location_id: station.id,
    station_code: station.station_code,
    provider_employee_id: providerEmployeeId,
    source_associate_name: sourceAssociateName ?? manualAssociateName,
    manual_associate_name: manualAssociateName,
    shipment_type: clean(formData.get("shipment_type")),
    total_delivery: optionalNumber(formData.get("total_delivery")),
    total_activity: optionalNumber(formData.get("total_activity")),
    reconciliation_status: reconciliationStatus(storedExpected, collectedAmount),
    pending_amount: Math.max(0, Number((storedExpected - collectedAmount).toFixed(2))),
    expected_amount: storedExpected,
    cash_500_count: cash500,
    cash_200_count: cash200,
    cash_100_count: cash100,
    cash_50_count: cash50,
    cash_20_count: cash20,
    cash_10_count: cash10,
    cash_other_amount: cashOther,
    return_cash_500_count: returnCash500,
    return_cash_200_count: returnCash200,
    return_cash_100_count: returnCash100,
    return_cash_50_count: returnCash50,
    return_cash_20_count: returnCash20,
    return_cash_10_count: returnCash10,
    return_cash_other_amount: returnCashOther,
    collected_amount: collectedAmount,
    difference_amount: differenceAmount,
    remarks,
    updated_by: authorization.userId
  }, companyId);

  // Avoid PostgREST ON CONFLICT: personal DBs may lack the unique index, and
  // id/created_at defaults may be missing after incomplete schema setup.
  const now = new Date().toISOString();
  const saveResult = existing.data
    ? await supabaseAdmin
      .from("cod_executive_reconciliations")
      .update({ ...payload, updated_at: now })
      .eq("id", existing.data.id)
      .select("*")
      .single()
    : await supabaseAdmin
      .from("cod_executive_reconciliations")
      .insert({
        ...payload,
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now
      })
      .select("*")
      .single();
  const { data: saved, error } = saveResult;
  if (error) throw new Error(error.message);
  await writeCodAudit({
    action: existing.data ? "Executive updated" : "Executive created",
    before: (existing.data ?? {}) as Record<string, unknown>,
    after: saved as Record<string, unknown>,
    authorization,
    businessDate,
    locationId: station.id,
    stationCode: station.station_code,
    reconciliationId: saved.id,
    providerEmployeeId,
    associateName: sourceAssociateName ?? manualAssociateName
  });
  await markCashSubmissionStale(companyId, businessDate, station.id);

  revalidatePath(pagePath);
  revalidatePath(publicPagePath);
  return { notice: successMessage, returnHref };
}

export async function saveExecutiveReconciliation(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const clientResponse = wantsClientResponse(formData);

  try {
    const result = await savePayload(formData, authorization, companyId, "Executive reconciliation saved.");
    if (clientResponse) return { ok: true, notice: result.notice } satisfies CashEntryActionResult;
    redirectWithFlash({ notice: result.notice }, result.returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = (error as Error).message;
    if (clientResponse) return { ok: false, error: message } satisfies CashEntryActionResult;
    redirectWithFlash({ error: message }, safeReturnHref(formData.get("return_href")));
  }
}

export async function addManualExecutiveReconciliation(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "add");
  const companyId = requireCompanyId(authorization);

  try {
    await savePayload(formData, authorization, companyId, "Manual executive reconciliation added.");
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: (error as Error).message }, safeReturnHref(formData.get("return_href")));
  }
}

export async function submitCodCashCollection(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);

    const [reconciliations, existingClosure, settingResult] = await Promise.all([
      supabaseAdmin
        .from("cod_executive_reconciliations")
        .select("id, provider_employee_id, source_associate_name, manual_associate_name, expected_amount, collected_amount, difference_amount, reconciliation_status")
        .eq("company_id", companyId)
        .eq("business_date", businessDate)
        .eq("location_id", locationId)
        .order("source_associate_name"),
      supabaseAdmin
        .from("cod_day_closures")
        .select("id, is_final_submitted, manager_status, validation_snapshot")
        .eq("company_id", companyId)
        .eq("business_date", businessDate)
        .eq("location_id", locationId)
        .maybeSingle(),
      supabaseAdmin
        .from("cod_station_settings")
        .select("id, portal_station_code, is_active")
        .eq("company_id", companyId)
        .eq("location_id", locationId)
        .maybeSingle()
    ]);

    if (reconciliations.error) throw new Error(reconciliations.error.message);
    if (existingClosure.error) throw new Error(existingClosure.error.message);
    if (settingResult.error) throw new Error(settingResult.error.message);
    if (existingClosure.data?.is_final_submitted) {
      throw new Error("This COD day is finally submitted and locked.");
    }
    const cashReconReady = isCashReconWorkerConfigured();
    const codMaster = settingResult.data?.id && settingResult.data.is_active !== false
      ? settingResult.data
      : null;
    // Cash-recon worker liability check replaces COD Master for submit.
    // Old portal SCC queue still needs COD Master when that worker path is used.
    if (!cashReconReady && !codMaster) {
      throw new Error("Add this station in COD Master before submitting cash and running SCC.");
    }

    const liabilityOverrideRemarks = clean(formData.get("liability_override_remarks"));
    if (cashReconReady) {
      const liability = await fetchLiabilitySummary({
        stationCode: station.station_code,
        date: businessDate
      });
      if (!liability.isClear && !liabilityOverrideRemarks) {
        const cash = liability.cashSummary;
        throw new Error(
          `SCC cash liability is not clear (expected ₹${cash.expectedAmount.toFixed(2)}, actual ₹${cash.actualAmount.toFixed(2)}, short/excess ₹${cash.shortExcessAmount.toFixed(2)}, count ${cash.count}). Clear cash liability in SCC or submit with override remarks.`
        );
      }
    }

    const rows = reconciliations.data ?? [];
    if (!rows.length) throw new Error("Save at least one associate cash entry before submitting.");

    const expectedCod = Number(rows.reduce((sum: number, row: { expected_amount?: unknown }) => sum + optionalAmount(String(row.expected_amount ?? 0)), 0).toFixed(2));
    const collectedCod = Number(rows.reduce((sum: number, row: { collected_amount?: unknown }) => sum + optionalAmount(String(row.collected_amount ?? 0)), 0).toFixed(2));
    const difference = Number((collectedCod - expectedCod).toFixed(2));
    const shortAmount = Math.max(0, Number((-difference).toFixed(2)));
    const excessAmount = Math.max(0, difference);
    const varianceRows = rows.filter((row: { difference_amount?: unknown }) => Math.abs(Number(row.difference_amount ?? 0)) >= 0.01);
    const now = new Date().toISOString();
    const previousSnapshot = existingClosure.data?.validation_snapshot &&
      typeof existingClosure.data.validation_snapshot === "object" &&
      !Array.isArray(existingClosure.data.validation_snapshot)
      ? existingClosure.data.validation_snapshot as Record<string, unknown>
      : {};
    const previousCash = previousSnapshot.cash_submission &&
      typeof previousSnapshot.cash_submission === "object" &&
      !Array.isArray(previousSnapshot.cash_submission)
      ? previousSnapshot.cash_submission as Record<string, unknown>
      : {};
    const cashSnapshot = {
      expected_cod: expectedCod,
      collected_cod: collectedCod,
      difference_amount: difference,
      short_amount: shortAmount,
      excess_amount: excessAmount,
      associate_count: rows.length,
      variance_count: varianceRows.length,
      submitted_at: now,
      submitted_by: authorization.userId,
      liability_override_remarks: liabilityOverrideRemarks,
      rows: rows.map((row) => ({
        reconciliation_id: row.id,
        provider_employee_id: row.provider_employee_id,
        associate_name: row.source_associate_name ?? row.manual_associate_name,
        expected_amount: Number(row.expected_amount ?? 0),
        collected_amount: Number(row.collected_amount ?? 0),
        difference_amount: Number(row.difference_amount ?? 0),
        status: row.reconciliation_status
      }))
    };

    const closurePayload = {
      company_id: companyId,
      business_date: businessDate,
      location_id: locationId,
      station_code: station.station_code,
      collected_cod: collectedCod,
      amazon_open_remittance_expected: 0,
      amazon_open_remittance_count: 0,
      difference_amount: difference,
      driver_reconciliation_pending: 0,
      no_deposit_liability: false,
      is_final_submitted: false,
      validation_status: Math.abs(difference) >= 0.01
        ? "Mismatch"
        : cashReconReady
          ? "Matched"
          : "Validation required",
      submission_status: "Submitted",
      manager_status: Math.abs(difference) >= 0.01 ? "Pending" : "Not required",
      validation_snapshot: { ...previousSnapshot, cash_submission: cashSnapshot },
      submitted_by: authorization.userId,
      submitted_at: now,
      // Driver validation must confirm today's CIA pending (or record feedback)
      // before Deposit & summary. Do not auto-pass this gate.
      driver_check_status: cashReconReady ? "Pending" : "Queued",
      deposit_check_status: "Locked",
      updated_at: now
    };

    let closureId = existingClosure.data?.id as string | undefined;
    if (closureId) {
      const updated = await supabaseAdmin
        .from("cod_day_closures")
        .update(closurePayload)
        .eq("id", closureId)
        .select("id")
        .single();
      if (updated.error) throw new Error(updated.error.message);
    } else {
      const inserted = await supabaseAdmin
        .from("cod_day_closures")
        .insert({
          ...closurePayload,
          id: crypto.randomUUID(),
          created_at: now
        })
        .select("id")
        .single();
      if (inserted.error) throw new Error(inserted.error.message);
      closureId = inserted.data.id as string;
    }
    if (!closureId) throw new Error("Could not create the cash submission record.");

    let driverCheckRunId: string | null = null;
    let driverCheckStatus = cashReconReady ? "Pending" : "Queued";
    // Only queue the old SCC portal path when cash-recon worker is not available.
    if (!cashReconReady && codMaster) {
      const run = await supabaseAdmin
        .from("ops_portal_check_runs")
        .upsert({
          company_id: companyId,
          location_id: locationId,
          cod_master_id: codMaster.id,
          station_code: station.station_code,
          portal_station_code: codMaster.portal_station_code ?? station.station_code,
          check_date: businessDate,
          check_type: "driver_reconciliation",
          status: "Queued",
          pending_count: 0,
          pending_amount: 0,
          summary: "Queued automatically after COD cash submission.",
          evidence: {},
          raw_result: {},
          attempt_count: 0,
          next_check_at: now,
          error_message: null,
          updated_at: now,
          created_by: authorization.userId
        }, { onConflict: "company_id,location_id,check_date,check_type" })
        .select("id")
        .single();
      if (run.error) throw new Error(run.error.message);
      driverCheckRunId = run.data.id as string;
      driverCheckStatus = "Queued";

      const baseUrl = appBaseUrl();
      if (baseUrl) {
        waitUntil(fetch(`${baseUrl}/api/cron/ops-pulse-portal-checks`, {
          method: "POST",
          headers: {
            ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ run_id: driverCheckRunId }),
          cache: "no-store"
        }).catch(() => undefined));
      }
    }

    const previousDifference = Number(previousCash.difference_amount ?? Number.NaN);
    const varianceChanged = !Number.isFinite(previousDifference) || Math.abs(previousDifference - difference) >= 0.01;
    const activeVarianceNotification = await supabaseAdmin
      .from("cod_manager_notifications")
      .select("id")
      .eq("closure_id", closureId)
      .eq("notification_type", "COD variance")
      .in("status", ["Unread", "Read"])
      .limit(1)
      .maybeSingle();
    if (activeVarianceNotification.error) throw new Error(activeVarianceNotification.error.message);
    if (Math.abs(difference) >= 0.01 && (varianceChanged || !activeVarianceNotification.data?.id)) {
      await supabaseAdmin
        .from("cod_manager_notifications")
        .update({ status: "Resolved", resolved_at: now })
        .eq("closure_id", closureId)
        .eq("notification_type", "COD variance")
        .in("status", ["Unread", "Read"]);
      const varianceLabel = difference < 0
        ? `short by ₹${shortAmount.toFixed(2)}`
        : `excess by ₹${excessAmount.toFixed(2)}`;
      await notifyCodManager({
        closureId,
        companyId,
        locationId,
        stationCode: station.station_code,
        notificationType: "COD variance",
        title: `COD ${difference < 0 ? "shortage" : "excess"}: ${station.station_code} on ${businessDate}`,
        message: `Cash was submitted ${varianceLabel}. Expected ₹${expectedCod.toFixed(2)}; collected ₹${collectedCod.toFixed(2)} across ${rows.length} associates. ${varianceRows.length} associate row${varianceRows.length === 1 ? "" : "s"} require manager review.${cashReconReady ? " Cash liability was checked via cash recon worker." : " SCC Driver Reconciliation has been queued."}`
      });
    } else if (Math.abs(difference) < 0.01) {
      await supabaseAdmin
        .from("cod_manager_notifications")
        .update({ status: "Resolved", resolved_at: now })
        .eq("closure_id", closureId)
        .eq("notification_type", "COD variance")
        .in("status", ["Unread", "Read"]);
    }

    await writeCodAudit({
      action: Math.abs(difference) >= 0.01 ? "COD cash submitted with variance" : "COD cash submitted",
      after: {
        ...cashSnapshot,
        driver_check_run_id: driverCheckRunId,
        driver_check_status: driverCheckStatus,
        cash_recon_liability_checked: cashReconReady
      },
      authorization,
      businessDate,
      closureId,
      locationId,
      stationCode: station.station_code
    });

    revalidatePath(pagePath);
    revalidatePath("/ops-pulse/cod/portal-checks");
    const notice = difference < 0
      ? `COD submitted with shortage ₹${shortAmount.toFixed(2)}. Manager notified${cashReconReady ? "; cash liability checked." : "; Driver Reconciliation is running."}`
      : difference > 0
        ? `COD submitted with excess ₹${excessAmount.toFixed(2)}. Manager notified${cashReconReady ? "; cash liability checked." : "; Driver Reconciliation is running."}`
        : cashReconReady
          ? "COD submitted with no variance. Confirm Driver validation before Deposit & summary."
          : "COD submitted with no variance. Driver Reconciliation is running.";
    const nextHref = withStep(returnHref, 2);
    if (wantsClientResponse(formData)) {
      setFlashCookie({ notice });
      return { ok: true, notice, nextHref } satisfies CashEntryActionResult;
    }
    redirectWithFlash({ notice }, nextHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unable to submit COD cash.";
    if (wantsClientResponse(formData)) {
      setFlashCookie({ error: message });
      return { ok: false, error: message } satisfies CashEntryActionResult;
    }
    redirectWithFlash({ error: message }, returnHref);
  }
}

export async function refreshExecutiveReconciliationRoster(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const returnHref = safeReturnHref(formData.get("return_href"));
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = clean(formData.get("location_id"));
    if (!locationId) throw new Error("Select one station before fetching SCC roster.");

    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);

    const settingResult = await supabaseAdmin
      .from("cod_station_settings")
      .select("id, portal_station_code, portal_check_interval_minutes, is_active")
      .eq("company_id", companyId)
      .eq("location_id", station.id)
      .maybeSingle();

    if (settingResult.error) throw new Error(settingResult.error.message);
    const setting = settingResult.data as {
      id: string;
      portal_station_code: string | null;
      portal_check_interval_minutes: number | string | null;
      is_active: boolean | null;
    } | null;

    if (!setting?.id || setting.is_active === false) {
      throw new Error("Add this station in COD Master before SCC refresh.");
    }

    const workerUrl = process.env.OPS_PORTAL_WORKER_URL?.trim();
    const workerSecret = process.env.OPS_PORTAL_WORKER_SECRET?.trim();
    if (!workerUrl || !workerSecret) {
      throw new Error(
        "Automatic SCC sync is not configured. Set OPS_PORTAL_WORKER_URL and OPS_PORTAL_WORKER_SECRET in .env.local."
      );
    }

    const payload = withCompany({
      location_id: station.id,
      cod_master_id: setting.id,
      station_code: station.station_code,
      portal_station_code: setting.portal_station_code ?? station.station_code,
      check_date: businessDate,
      check_type: "driver_reconciliation",
      status: "Queued",
      pending_count: 0,
      pending_amount: 0,
      summary: "Queued from Executive Reconciliation.",
      evidence: {},
      raw_result: {},
      attempt_count: 0,
      error_message: null,
      next_check_at: new Date().toISOString()
    }, companyId);

    let runId = "";
    const existingRun = await supabaseAdmin
      .from("ops_portal_check_runs")
      .select("id")
      .eq("company_id", companyId)
      .eq("location_id", station.id)
      .eq("check_date", businessDate)
      .eq("check_type", "driver_reconciliation")
      .maybeSingle();

    if (existingRun.error) {
      if (isMissingPortalCheckSetup(existingRun.error)) {
        redirectWithFlash(
          {
            error: "SCC roster automation is not installed yet. Run scripts/ops_pulse_cod_portal_checks_v1.sql in Supabase SQL Editor."
          },
          returnHref
        );
      }
      throw new Error(existingRun.error.message);
    }

    if (existingRun.data?.id) {
      const updated = await supabaseAdmin
        .from("ops_portal_check_runs")
        .update({
          cod_master_id: setting.id,
          station_code: station.station_code,
          portal_station_code: setting.portal_station_code ?? station.station_code,
          status: "Queued",
          pending_count: 0,
          pending_amount: 0,
          summary: "Queued from Executive Reconciliation.",
          evidence: {},
          raw_result: {},
          attempt_count: 0,
          error_message: null,
          next_check_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq("id", existingRun.data.id)
        .select("id")
        .single();

      if (updated.error) throw new Error(updated.error.message);
      runId = updated.data.id as string;
    } else {
      const inserted = await supabaseAdmin
        .from("ops_portal_check_runs")
        .insert(payload)
        .select("id")
        .single();

      if (inserted.error?.code === "23505") {
        const racedRun = await supabaseAdmin
          .from("ops_portal_check_runs")
          .select("id")
          .eq("company_id", companyId)
          .eq("location_id", station.id)
          .eq("check_date", businessDate)
          .eq("check_type", "driver_reconciliation")
          .maybeSingle();

        if (racedRun.error) throw new Error(racedRun.error.message);
        if (racedRun.data?.id) {
          const resetRun = await supabaseAdmin
            .from("ops_portal_check_runs")
            .update({
              cod_master_id: setting.id,
              station_code: station.station_code,
              portal_station_code: setting.portal_station_code ?? station.station_code,
              status: "Queued",
              pending_count: 0,
              pending_amount: 0,
              summary: "Queued from Executive Reconciliation.",
              evidence: {},
              raw_result: {},
              attempt_count: 0,
              error_message: null,
              next_check_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("id", racedRun.data.id)
            .select("id")
            .single();

          if (resetRun.error) throw new Error(resetRun.error.message);
          runId = resetRun.data.id as string;
        }
      } else if (inserted.error) {
        if (isMissingPortalCheckSetup(inserted.error)) {
          redirectWithFlash(
            {
              error: "SCC roster automation is not installed yet. Run scripts/ops_pulse_cod_portal_checks_v1.sql in Supabase SQL Editor."
            },
            returnHref
          );
        }
        throw new Error(inserted.error.message);
      } else {
        runId = inserted.data.id as string;
      }
    }

    if (!runId) {
      const existing = await supabaseAdmin
        .from("ops_portal_check_runs")
        .select("id")
        .eq("company_id", companyId)
        .eq("location_id", station.id)
        .eq("check_date", businessDate)
        .eq("check_type", "driver_reconciliation")
        .maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      runId = existing.data?.id as string;
    }

    if (!runId) throw new Error("Could not create SCC refresh run.");

    const baseUrl = appBaseUrl();
    if (baseUrl) {
      waitUntil(fetch(`${baseUrl}/api/cron/ops-pulse-portal-checks`, {
        method: "POST",
        headers: {
          ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ run_id: runId }),
        cache: "no-store"
      }).catch(() => undefined));
    }

    revalidatePath(pagePath);
    redirectWithFlash({
      notice: `SCC refresh queued for ${station.station_code}. You can keep working; this sheet updates automatically.`
    }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: (error as Error).message }, safeReturnHref(formData.get("return_href")));
  }
}

export async function deleteExecutiveReconciliation(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  const clientResponse = wantsClientResponse(formData);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const providerEmployeeId = required(formData.get("provider_employee_id"), "Associate");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);
    const existing = await supabaseAdmin
      .from("cod_executive_reconciliations")
      .select("*")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .eq("provider_employee_id", providerEmployeeId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) throw new Error("COD reconciliation entry was not found.");
    const { error } = await supabaseAdmin
      .from("cod_executive_reconciliations")
      .delete()
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .eq("provider_employee_id", providerEmployeeId);
    if (error) throw new Error(error.message);
    await writeCodAudit({
      action: "Executive deleted",
      before: existing.data as Record<string, unknown>,
      authorization,
      businessDate,
      locationId,
      stationCode: station.station_code,
      reconciliationId: existing.data.id,
      providerEmployeeId,
      associateName: existing.data.source_associate_name ?? existing.data.manual_associate_name
    });
    await markCashSubmissionStale(companyId, businessDate, locationId);
    revalidatePath(pagePath);
    if (clientResponse) return { ok: true, notice: `${providerEmployeeId} reconciliation entry deleted.` } satisfies CashEntryActionResult;
    redirectWithFlash({ notice: `${providerEmployeeId} reconciliation entry deleted.` }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unable to delete reconciliation entry.";
    if (clientResponse) return { ok: false, error: message } satisfies CashEntryActionResult;
    redirectWithFlash({ error: message }, returnHref);
  }
}

export async function queueCodClosureCheck(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const checkType = required(formData.get("check_type"), "Check type");
    if (!["driver_reconciliation", "prepared_deposit"].includes(checkType)) throw new Error("Invalid COD validation step.");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);

    const settingResult = await supabaseAdmin
      .from("cod_station_settings")
      .select("id, portal_station_code, is_active")
      .eq("company_id", companyId)
      .eq("location_id", locationId)
      .maybeSingle();
    if (settingResult.error) throw new Error(settingResult.error.message);
    if (!settingResult.data?.id || settingResult.data.is_active === false) {
      throw new Error("Add this station in COD Master before running Amazon validation.");
    }

    let closureResult = await supabaseAdmin
      .from("cod_day_closures")
      .select("id, driver_check_status, is_final_submitted")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .maybeSingle();
    if (closureResult.error) throw new Error(closureResult.error.message);

    if (checkType === "prepared_deposit") {
      const driverRun = await supabaseAdmin
        .from("ops_portal_check_runs")
        .select("status, pending_amount")
        .eq("company_id", companyId)
        .eq("location_id", locationId)
        .eq("check_date", businessDate)
        .eq("check_type", "driver_reconciliation")
        .maybeSingle();
      if (driverRun.error) throw new Error(driverRun.error.message);
      const driverPassed = driverRun.data?.status === "Pass" && Number(driverRun.data.pending_amount ?? 0) === 0;
      const driverApproved = closureResult.data?.driver_check_status === "Exception approved";
      if (!driverPassed && !driverApproved) {
        throw new Error("Complete Driver Reconciliation or obtain manager exception approval before Bank Deposit.");
      }
    }

    if (!closureResult.data) {
      const nowDraft = new Date().toISOString();
      closureResult = await supabaseAdmin
        .from("cod_day_closures")
        .insert({
          id: crypto.randomUUID(),
          company_id: companyId,
          business_date: businessDate,
          location_id: locationId,
          station_code: station.station_code,
          collected_cod: 0,
          amazon_open_remittance_expected: 0,
          amazon_open_remittance_count: 0,
          difference_amount: 0,
          driver_reconciliation_pending: 0,
          no_deposit_liability: false,
          is_final_submitted: false,
          validation_status: "Pending",
          validation_snapshot: {},
          submission_status: "Draft",
          manager_status: "Not required",
          driver_check_status: checkType === "driver_reconciliation" ? "Queued" : "Passed",
          deposit_check_status: checkType === "prepared_deposit" ? "Queued" : "Locked",
          submitted_by: authorization.userId,
          submitted_at: nowDraft,
          created_at: nowDraft,
          updated_at: nowDraft
        })
        .select("id, driver_check_status, is_final_submitted")
        .single();
      if (closureResult.error) throw new Error(closureResult.error.message);
    } else {
      const gateColumn = checkType === "driver_reconciliation" ? "driver_check_status" : "deposit_check_status";
      const { error } = await supabaseAdmin
        .from("cod_day_closures")
        .update({ [gateColumn]: "Queued", updated_at: new Date().toISOString() })
        .eq("id", closureResult.data.id);
      if (error) throw new Error(error.message);
    }

    const now = new Date().toISOString();
    const run = await supabaseAdmin
      .from("ops_portal_check_runs")
      .upsert({
        company_id: companyId,
        location_id: locationId,
        cod_master_id: settingResult.data.id,
        station_code: station.station_code,
        portal_station_code: settingResult.data.portal_station_code ?? station.station_code,
        check_date: businessDate,
        check_type: checkType,
        status: "Queued",
        pending_count: 0,
        pending_amount: 0,
        summary: `Queued from COD closure step: ${checkType}.`,
        evidence: {},
        raw_result: {},
        attempt_count: 0,
        next_check_at: now,
        error_message: null,
        updated_at: now,
        created_by: authorization.userId
      }, { onConflict: "company_id,location_id,check_date,check_type" })
      .select("id")
      .single();
    if (run.error) throw new Error(run.error.message);
    const closureId = closureResult.data?.id;
    if (!closureId) throw new Error("Could not create the COD closure audit record.");
    await writeCodAudit({
      action: checkType === "driver_reconciliation" ? "Driver check queued" : "Bank Deposit check queued",
      after: { run_id: run.data.id, check_type: checkType, status: "Queued" },
      authorization,
      businessDate,
      closureId,
      locationId,
      stationCode: station.station_code
    });

    const baseUrl = appBaseUrl();
    if (baseUrl) {
      waitUntil(fetch(`${baseUrl}/api/cron/ops-pulse-portal-checks`, {
        method: "POST",
        headers: {
          ...(process.env.CRON_SECRET ? { Authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ run_id: run.data.id }),
        cache: "no-store"
      }).catch(() => undefined));
    }
    revalidatePath(pagePath);
    redirectWithFlash({
      notice: checkType === "driver_reconciliation"
        ? `Driver Reconciliation queued for ${station.station_code}.`
        : `Bank Deposit validation queued for ${station.station_code}.`
    }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: error instanceof Error ? error.message : "Unable to queue COD validation." }, returnHref);
  }
}

export async function requestCodGateException(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const gate = required(formData.get("gate"), "Validation gate");
    const reason = required(formData.get("exception_reason"), "Exception reason");
    if (!["driver", "deposit"].includes(gate)) throw new Error("Invalid exception gate.");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);

    const { data: closure, error: closureError } = await supabaseAdmin
      .from("cod_day_closures")
      .select("id, driver_check_status")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .maybeSingle();
    if (closureError) throw new Error(closureError.message);
    if (!closure) throw new Error("Run the validation step before requesting an exception.");
    if (gate === "deposit" && !["Passed", "Exception approved"].includes(closure.driver_check_status)) {
      throw new Error("Driver Reconciliation must be cleared before requesting a Bank Deposit exception.");
    }

    const prefix = gate === "driver" ? "driver" : "deposit";
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin.from("cod_day_closures").update({
      [`${prefix}_check_status`]: "Exception requested",
      [`${prefix}_exception_reason`]: reason,
      [`${prefix}_exception_requested_by`]: authorization.userId,
      [`${prefix}_exception_requested_at`]: now,
      submission_status: "Manager approval required",
      manager_status: "Pending",
      updated_at: now
    }).eq("id", closure.id);
    if (error) throw new Error(error.message);

    const label = gate === "driver" ? "Driver Reconciliation" : "Bank Deposit";
    await writeCodAudit({
      action: `${label} exception requested`,
      after: { gate, reason, status: "Exception requested" },
      authorization,
      businessDate,
      closureId: closure.id,
      locationId,
      stationCode: station.station_code
    });
    await notifyCodManager({
      closureId: closure.id,
      companyId,
      locationId,
      stationCode: station.station_code,
      notificationType: `${label} exception`,
      title: `COD ${label} exception: ${station.station_code} on ${businessDate}`,
      message: `${label} is pending, but the station requested permission to continue. Reason: ${reason}`
    });
    revalidatePath(pagePath);
    redirectWithFlash({ notice: `${label} exception sent to the manager for approval.` }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: error instanceof Error ? error.message : "Unable to request manager approval." }, returnHref);
  }
}

export async function confirmDriverReconForDeposit(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const clientResponse = wantsClientResponse(formData);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const pendingAmount = optionalAmount(formData.get("pending_cia_amount") ?? "0", "Pending recon");
    const remarks = clean(formData.get("cia_pending_remarks"));
    if (pendingAmount > 0.01 && !remarks) {
      throw new Error("Today's Cash In Associate is still pending. Add feedback like the cash sheet override, then continue to Deposit & summary.");
    }
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);

    const closureResult = await supabaseAdmin
      .from("cod_day_closures")
      .select("id, driver_check_status, is_final_submitted, validation_snapshot")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .maybeSingle();
    if (closureResult.error) throw new Error(closureResult.error.message);
    if (!closureResult.data?.id) throw new Error("Submit cash first, then confirm driver validation.");
    if (closureResult.data.is_final_submitted) throw new Error("This COD day is locked.");

    const now = new Date().toISOString();
    const stillPending = pendingAmount > 0.01;
    const snapshot = closureResult.data.validation_snapshot
      && typeof closureResult.data.validation_snapshot === "object"
      && !Array.isArray(closureResult.data.validation_snapshot)
      ? closureResult.data.validation_snapshot as Record<string, unknown>
      : {};
    const continuationReason = stillPending
      ? `Continued with Cash In Associate pending ₹${pendingAmount.toFixed(2)}. ${remarks}`
      : "Driver validation confirmed. No Cash In Associate pending.";
    const updated = await supabaseAdmin.from("cod_day_closures").update({
      driver_check_status: stillPending ? "Exception approved" : "Passed",
      driver_exception_reason: continuationReason,
      driver_exception_requested_by: authorization.userId,
      driver_exception_requested_at: now,
      driver_exception_manager_remarks: stillPending
        ? "Operational continuation recorded; manager notified."
        : "Driver recon cleared from Cash In Associate ageing.",
      deposit_check_status: "Not run",
      validation_snapshot: {
        ...snapshot,
        driver_cia_confirmation: {
          pending_amount: pendingAmount,
          remarks: remarks || null,
          confirmed_at: now,
          confirmed_by: authorization.userId
        }
      },
      updated_at: now
    }).eq("id", closureResult.data.id);
    if (updated.error) throw new Error(updated.error.message);

    if (stillPending) {
      await notifyCodManager({
        closureId: closureResult.data.id,
        companyId,
        locationId,
        stationCode: station.station_code,
        notificationType: "Driver Reconciliation pending continuation",
        title: `CIA pending continuation: ${station.station_code} on ${businessDate}`,
        message: `The station continued to Deposit & summary with ₹${pendingAmount.toFixed(2)} Cash In Associate still pending. Reason: ${remarks}.`
      });
    }
    await writeCodAudit({
      action: stillPending
        ? "Continued with Cash In Associate pending"
        : "Confirmed driver recon for deposit",
      after: { pending_amount: pendingAmount, remarks, status: stillPending ? "Exception approved" : "Passed" },
      authorization,
      businessDate,
      closureId: closureResult.data.id,
      locationId,
      stationCode: station.station_code
    });
    revalidatePath(pagePath);
    revalidatePath(publicPagePath);
    const notice = stillPending
      ? "Feedback recorded. Deposit & summary is unlocked; pending Cash In Associate stays visible."
      : "Driver validation cleared. Continue to Deposit & summary.";
    const nextHref = withStep(returnHref, 3);
    if (clientResponse) return { ok: true, notice, nextHref } satisfies CashEntryActionResult;
    redirectWithFlash({ notice }, nextHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unable to confirm driver validation.";
    if (clientResponse) return { ok: false, error: message } satisfies CashEntryActionResult;
    redirectWithFlash({ error: message }, returnHref);
  }
}

export async function continueCodWithPendingDriverReconciliation(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const reason = required(formData.get("exception_reason"), "Reason");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, locationId);

    const [closureResult, runResult] = await Promise.all([
      supabaseAdmin.from("cod_day_closures").select("id,driver_check_status")
        .eq("company_id", companyId).eq("business_date", businessDate).eq("location_id", locationId).maybeSingle(),
      supabaseAdmin.from("ops_portal_check_runs").select("status,pending_count,pending_amount,summary")
        .eq("company_id", companyId).eq("check_date", businessDate).eq("location_id", locationId)
        .eq("check_type", "driver_reconciliation").maybeSingle()
    ]);
    if (closureResult.error) throw new Error(closureResult.error.message);
    if (runResult.error) throw new Error(runResult.error.message);
    if (!closureResult.data?.id) throw new Error("Submit COD and run Driver Reconciliation first.");
    if (!runResult.data || runResult.data.status === "Pass") throw new Error("No pending Driver Reconciliation exception is available.");

    const pendingCount = Number(runResult.data.pending_count ?? 0);
    const pendingAmount = Number(runResult.data.pending_amount ?? 0);
    const now = new Date().toISOString();
    const continuationReason = `Continued with SCC pending. ${reason}`;
    const updated = await supabaseAdmin.from("cod_day_closures").update({
      driver_check_status: "Exception approved",
      driver_exception_reason: continuationReason,
      driver_exception_requested_by: authorization.userId,
      driver_exception_requested_at: now,
      driver_exception_manager_remarks: "Operational continuation recorded; manager and Control Tower notified.",
      deposit_check_status: "Not run",
      manager_status: "Pending",
      updated_at: now
    }).eq("id", closureResult.data.id);
    if (updated.error) throw new Error(updated.error.message);

    await notifyCodManager({
      closureId: closureResult.data.id,
      companyId,
      locationId,
      stationCode: station.station_code,
      notificationType: "Driver Reconciliation pending continuation",
      title: `SCC pending continuation: ${station.station_code} on ${businessDate}`,
      message: `The station continued with ${pendingCount} SCC associate reconciliation${pendingCount === 1 ? "" : "s"} pending for ₹${pendingAmount.toFixed(2)}. Reason: ${reason}. Bank Deposit validation is now permitted; the pending SCC remains visible in the closure summary.`
    });
    await writeCodAudit({
      action: "Continued with Driver Reconciliation pending",
      after: { pending_count: pendingCount, pending_amount: pendingAmount, reason, status: "Exception approved" },
      authorization,
      businessDate,
      closureId: closureResult.data.id,
      locationId,
      stationCode: station.station_code
    });
    revalidatePath(pagePath);
    redirectWithFlash({ notice: "Continued with SCC pending. Manager and Control Tower notifications were created." }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: error instanceof Error ? error.message : "Unable to continue with SCC pending." }, returnHref);
  }
}

export async function reviewCodGateException(formData: FormData) {
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    if (!canAccessCodAudit(authorization)) throw new Error("Only a manager or administrator can review COD exceptions.");
    const closureId = required(formData.get("closure_id"), "Closure");
    const gate = required(formData.get("gate"), "Validation gate");
    const decision = required(formData.get("decision"), "Decision");
    const remarks = clean(formData.get("manager_remarks"));
    if (!["driver", "deposit"].includes(gate) || !["approve", "reject"].includes(decision)) {
      throw new Error("Invalid manager decision.");
    }
    const { data: closure, error: closureError } = await supabaseAdmin
      .from("cod_day_closures")
      .select("id, location_id, business_date, station_code")
      .eq("id", closureId)
      .eq("company_id", companyId)
      .maybeSingle();
    if (closureError) throw new Error(closureError.message);
    if (!closure) throw new Error("COD closure was not found.");
    assertLocationAccess(authorization, closure.location_id);

    const prefix = gate === "driver" ? "driver" : "deposit";
    const approved = decision === "approve";
    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      [`${prefix}_check_status`]: approved ? "Exception approved" : "Exception rejected",
      [`${prefix}_exception_reviewed_by`]: authorization.userId,
      [`${prefix}_exception_reviewed_at`]: now,
      [`${prefix}_exception_manager_remarks`]: remarks,
      manager_status: approved ? "Approved" : "Rejected",
      submission_status: approved ? "Draft" : "Rejected",
      updated_at: now
    };
    if (gate === "driver" && approved) update.deposit_check_status = "Not run";
    const { error } = await supabaseAdmin.from("cod_day_closures").update(update).eq("id", closureId);
    if (error) throw new Error(error.message);
    await writeCodAudit({
      action: `COD ${gate} exception ${approved ? "approved" : "rejected"}`,
      after: { gate, decision, remarks, status: approved ? "Exception approved" : "Exception rejected" },
      authorization,
      businessDate: closure.business_date,
      closureId,
      locationId: closure.location_id,
      stationCode: closure.station_code
    });
    await supabaseAdmin.from("cod_manager_notifications").update({
      status: "Resolved",
      resolved_at: now
    }).eq("closure_id", closureId).eq("status", "Unread");
    revalidatePath(pagePath);
    redirectWithFlash({ notice: `COD ${gate} exception ${approved ? "approved" : "rejected"}.` }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    redirectWithFlash({ error: error instanceof Error ? error.message : "Unable to review COD exception." }, returnHref);
  }
}

export async function validateCodRemittanceDeposit(formData: FormData): Promise<CashEntryActionResult | void> {
  const clientResponse = wantsClientResponse(formData);
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    if (!isCashReconWorkerConfigured()) {
      throw new Error("Cash recon worker is not configured.");
    }
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    await assertClosureEditable(companyId, businessDate, station.id);

    const overrideRemarks = clean(formData.get("remittance_override_remarks"))?.trim() ?? "";
    const collectedCash = Number(String(formData.get("collected_cash") ?? "0").replace(/[,₹\s]/g, ""));
    const collected = Number.isFinite(collectedCash) ? Number(collectedCash.toFixed(2)) : 0;

    let remittance = await fetchRemittance({ stationCode: station.station_code, date: businessDate });
    const payloadRaw = clean(formData.get("remittance_payload"));
    if (payloadRaw) {
      try {
        const parsed = JSON.parse(payloadRaw) as typeof remittance;
        if (parsed && typeof parsed === "object" && Array.isArray(parsed.submitted)) {
          remittance = parsed;
        }
      } catch {
        // Prefer live fetch when payload is invalid.
      }
    }

    const difference = Number((collected - remittance.remittanceTotalCash).toFixed(2));
    // Short > ₹10 is confirmed on final Submit via override popup — allow validate without remarks.
    const isShortOverLimit = difference < -10;
    const needsRemarks = !isShortOverLimit && (Math.abs(difference) > DIFFERENCE_REMARKS_RUPEES || remittance.createdCount > 0);
    if (needsRemarks && !overrideRemarks) {
      throw new Error(`Remarks are required when cash differs from remittance total by more than ₹${DIFFERENCE_REMARKS_RUPEES} or remittance is still pending.`);
    }

    const now = new Date().toISOString();
    const existing = await supabaseAdmin
      .from("cod_day_closures")
      .select("id, validation_snapshot, driver_check_status")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", station.id)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (!existing.data) throw new Error("Submit cash and complete driver reconciliation before validating deposit.");
    if (!["Passed", "Exception approved"].includes(String(existing.data.driver_check_status))) {
      throw new Error("Driver reconciliation must pass before validating deposit.");
    }

    const snapshot = (existing.data.validation_snapshot && typeof existing.data.validation_snapshot === "object"
      ? existing.data.validation_snapshot
      : {}) as Record<string, unknown>;

    const saved = await supabaseAdmin.from("cod_day_closures").update({
      amazon_open_remittance_expected: remittance.remittanceTotalCash,
      amazon_open_remittance_count: remittance.remittanceCodes.length || remittance.submittedCount,
      difference_amount: difference,
      no_deposit_liability: remittance.createdCount === 0,
      deposit_check_status: "Passed",
      validation_snapshot: {
        ...snapshot,
        remittance: {
          ...remittance,
          difference_amount: difference,
          collected_cash: collected,
          override_remarks: overrideRemarks || null,
          validated_at: now,
          validated_by: authorization.userId
        }
      },
      updated_at: now
    }).eq("id", existing.data.id);
    if (saved.error) throw new Error(saved.error.message);

    await writeCodAudit({
      action: "Remittance deposit validated",
      after: {
        remittance_total_cash: remittance.remittanceTotalCash,
        collected_cash: collected,
        difference_amount: difference,
        created_count: remittance.createdCount,
        submitted_count: remittance.submittedCount,
        override_remarks: overrideRemarks || null
      },
      authorization,
      businessDate,
      closureId: existing.data.id,
      locationId: station.id,
      stationCode: station.station_code
    });

    revalidatePath(pagePath);
    revalidatePath("/ops-pulse/cod");
    const formatInr = (value: number) => {
      const absolute = Math.abs(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (Math.abs(value) < 0.01) return `₹${absolute}`;
      return value < 0 ? `-₹${absolute}` : `₹${absolute}`;
    };
    const notice = Math.abs(difference) < 0.01
      ? `Remittance validated for ${station.station_code}. Total ${formatInr(remittance.remittanceTotalCash)} matched collected cash.`
      : `Remittance validated for ${station.station_code} with a cash difference of ${formatInr(difference)}.`;
    if (clientResponse) return { ok: true, notice } satisfies CashEntryActionResult;
    redirectWithFlash({ notice }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unable to validate remittance deposit.";
    if (clientResponse) return { ok: false, error: message } satisfies CashEntryActionResult;
    redirectWithFlash({ error: message }, returnHref);
  }
}

export async function submitCodDayClosure(formData: FormData): Promise<CashEntryActionResult | void> {
  const clientResponse = wantsClientResponse(formData);
  const authorization = await requirePagePermission("cod_executive_reconciliation", "edit");
  const companyId = requireCompanyId(authorization);
  const returnHref = safeReturnHref(formData.get("return_href"));
  try {
    const businessDate = required(formData.get("business_date"), "Business date");
    const locationId = required(formData.get("location_id"), "Station");
    const station = await stationForInput(companyId, locationId, null);
    assertLocationAccess(authorization, station.id);
    const remittanceOverrideRemarks = clean(formData.get("remittance_override_remarks"));
    const result = await finalizeCodClosure({
      businessDate,
      companyId,
      locationId,
      stationCode: station.station_code,
      userId: authorization.userId,
      remittanceOverrideRemarks
    });
    const closure = await supabaseAdmin
      ?.from("cod_day_closures")
      .select("id")
      .eq("company_id", companyId)
      .eq("business_date", businessDate)
      .eq("location_id", locationId)
      .maybeSingle();
    await writeCodAudit({
      action: "Final COD closure submitted",
      after: {
        collected_cod: result.collectedCod,
        difference_amount: result.difference,
        locked: true,
        remittance_override_remarks: remittanceOverrideRemarks || null
      },
      authorization,
      businessDate,
      closureId: closure?.data?.id ?? null,
      locationId,
      stationCode: station.station_code
    });
    revalidatePath(pagePath);
    revalidatePath("/ops-pulse/cod");
    const notice = `COD day closure submitted for ${station.station_code}. Collected ₹${result.collectedCod.toFixed(2)}.`;
    if (clientResponse) return { ok: true, notice, nextHref: returnHref } satisfies CashEntryActionResult;
    redirectWithFlash({ notice }, returnHref);
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unable to submit COD day closure.";
    if (clientResponse) return { ok: false, error: message } satisfies CashEntryActionResult;
    redirectWithFlash({ error: message }, returnHref);
  }
}

/** Form-action wrapper for legacy portal submit (always redirects; no client JSON return). */
export async function submitCodDayClosureForm(formData: FormData): Promise<void> {
  formData.delete("response_mode");
  await submitCodDayClosure(formData);
}
