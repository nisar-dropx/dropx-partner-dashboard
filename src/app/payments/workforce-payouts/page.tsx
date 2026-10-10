import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { WorkforcePayoutBulkUpload } from "@/components/workforce-payout-bulk-upload";
import {
  WorkforcePayoutTable,
  type WorkforcePayoutMappingUnlock,
  type WorkforcePayoutRow
} from "@/components/workforce-payout-table";
import { WorkforcePayoutPeriodFilter } from "@/components/workforce-payout-period-filter";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { chunkedValues, mapWithConcurrency } from "@/lib/bounded-concurrency";
import { requireCompanyId } from "@/lib/company-scope";
import { loadHelperPayoutRows } from "@/lib/helper-payout-loader";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isProvisionalPayoutDependencyHash,
  loadStablePayoutWorksheet
} from "@/lib/stable-payout-worksheet";
import { workforcePayoutDependencyHash } from "@/lib/workforce-payout-dependency";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import type { WorkforcePayoutPaymentSummary } from "@/lib/workforce-payout-payment-summary";
import { readAllRows } from "@/lib/supabase-pagination";
import { isWorkforcePayoutCalculationPublishable } from "@/lib/workforce-payout-publication-eligibility";
import {
  workforcePayoutCalculationHash,
  workforcePayoutPublicationSnapshotHash
} from "@/lib/workforce-payout-publication";
import { buildWorkforcePayoutPublicationSnapshot } from "@/lib/workforce-payout-publication-snapshot";
import {
  createWorkforcePayoutReviewToken,
  payoutReviewPresentation,
  workforcePayoutLocationSetHash
} from "@/lib/workforce-payout-review-token";

type ReportPeriod = { mode: "monthly" | "daily" | "range"; month: string; day: string; from: string; to: string };

function today() { return todayKolkata(); }
function currentMonth() { return today().slice(0, 7); }
function validDate(value?: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value! : ""; }
function validMonth(value?: string) { return /^\d{4}-\d{2}$/.test(value ?? "") ? value! : ""; }

function resolvePeriod(params: Record<string, string | string[] | undefined>): ReportPeriod & { fromDate: string; toDate: string; title: string } {
  const mode = params.period === "daily" || params.period === "range" ? params.period : "monthly";
  const month = validMonth(typeof params.month === "string" ? params.month : "") || currentMonth();
  const day = validDate(typeof params.day === "string" ? params.day : "") || today();
  const from = validDate(typeof params.from === "string" ? params.from : "") || `${month}-01`;
  const to = validDate(typeof params.to === "string" ? params.to : "") || today();
  if (mode === "daily") return { mode, month, day, from, to, fromDate: day, toDate: day, title: `Daily payout worksheet · ${day}` };
  if (mode === "range") return { mode, month, day, from, to, fromDate: from <= to ? from : to, toDate: from <= to ? to : from, title: `Payout worksheet · ${from <= to ? from : to} to ${from <= to ? to : from}` };
  const end = new Date(`${month}-01T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  return { mode, month, day, from, to, fromDate: `${month}-01`, toDate: end.toISOString().slice(0, 10), title: `Monthly payout worksheet · ${month}` };
}

async function loadOpenMappingUnlocks(companyId: string, fromDate: string, toDate: string) {
  if (!supabaseAdmin) return {
    unlocks: [] as WorkforcePayoutMappingUnlock[],
    impactedWorkforceIds: new Set<string>(),
    error: null as string | null
  };
  const result = await supabaseAdmin
    .from("workforce_payout_mapping_unlocks")
    .select("id,workforce_id,reason,unlocked_at")
    .eq("company_id", companyId)
    .eq("period_start", fromDate)
    .eq("period_end", toDate)
    .eq("status", "open")
    .order("unlocked_at", { ascending: true })
    .order("id", { ascending: true });
  if (result.error) return {
    unlocks: [] as WorkforcePayoutMappingUnlock[],
    impactedWorkforceIds: new Set<string>(),
    error: result.error.message
  };
  const openRows = (result.data ?? []) as Array<{
    id: string;
    workforce_id: string;
    reason: string;
    unlocked_at: string;
  }>;
  if (!openRows.length) return {
    unlocks: [] as WorkforcePayoutMappingUnlock[],
    impactedWorkforceIds: new Set<string>(),
    error: null as string | null
  };

  const sourceIds = [...new Set(openRows.map((row) => String(row.workforce_id)))];
  const [people, impacted] = await Promise.all([
    supabaseAdmin
      .from("workforce")
      .select("id,dropx_id,full_name")
      .eq("company_id", companyId)
      .in("id", sourceIds),
    supabaseAdmin.rpc("workforce_payout_mapping_unlock_impacted_ids", {
      p_company_id: companyId,
      p_period_start: fromDate,
      p_period_end: toDate,
      p_unlock_ids: openRows.map((row) => row.id)
    })
  ]);
  if (people.error) return {
    unlocks: [] as WorkforcePayoutMappingUnlock[],
    impactedWorkforceIds: new Set<string>(),
    error: people.error.message
  };
  if (impacted.error) return {
    unlocks: [] as WorkforcePayoutMappingUnlock[],
    impactedWorkforceIds: new Set<string>(),
    error: impacted.error.message
  };
  const personById = new Map((people.data ?? []).map((person) => [String(person.id), person]));
  return {
    unlocks: openRows.map((row) => {
      const person = personById.get(String(row.workforce_id));
      return {
        id: String(row.id),
        workforceId: String(row.workforce_id),
        dropxId: String(person?.dropx_id ?? ""),
        name: String(person?.full_name ?? "Workforce member"),
        reason: String(row.reason ?? ""),
        unlockedAt: String(row.unlocked_at ?? "")
      };
    }),
    impactedWorkforceIds: new Set(Array.isArray(impacted.data)
      ? impacted.data.map((id) => String(id))
      : sourceIds),
    error: null as string | null
  };
}

async function withPayoutReviewStatuses(
  companyId: string,
  audience: "workforce" | "helpers",
  fromDate: string,
  toDate: string,
  rows: WorkforcePayoutRow[],
  dependencyHash: string,
  unlockedWorkforceIds: ReadonlySet<string>
) {
  if (!supabaseAdmin) return { rows, error: null as string | null };
  const admin = supabaseAdmin;
  const subjectType = audience === "helpers" ? "helper" : "workforce";
  const ids = [...new Set(rows.flatMap((row) => row.reviewSubjectId ? [row.reviewSubjectId] : []))];
  if (!ids.length) return { rows, error: null as string | null };
  const submissions: Array<{ subject_id: string; location_id: string; status: string }> = [];
  const publications: Array<{ workforce_id: string; station_id: string; notification_status: string; dependency_hash: string | null }> = [];
  const reviewChunks = await mapWithConcurrency(chunkedValues(ids, 100), 4, async (idChunk) => {
    const [result, publicationResult] = await Promise.all([
      readAllRows(admin
        .from("workforce_payout_review_submissions")
        .select("subject_id,location_id,status")
        .eq("company_id", companyId)
        .eq("subject_type", subjectType)
        .eq("period_start", fromDate)
        .eq("period_end", toDate)
        .in("subject_id", idChunk)
        .order("subject_id")
        .order("location_id")),
      audience === "workforce"
        ? readAllRows(admin
          .from("workforce_payout_publications")
          .select("workforce_id,station_id,notification_status,dependency_hash")
          .eq("company_id", companyId)
          .eq("publication_kind", "worksheet")
          .eq("period_start", fromDate)
          .eq("period_end", toDate)
          .in("workforce_id", idChunk)
          .order("workforce_id")
          .order("station_id")
          .order("revision", { ascending: false })
          .order("published_at", { ascending: false })
          .order("id", { ascending: false }))
        : Promise.resolve({ data: [], error: null })
    ]);
    return { result, publicationResult };
  });
  for (const chunk of reviewChunks) {
    if (chunk.result.error) return { rows, error: chunk.result.error.message };
    if (chunk.publicationResult.error) return { rows, error: chunk.publicationResult.error.message };
    submissions.push(...((chunk.result.data ?? []) as Array<{ subject_id: string; location_id: string; status: string }>));
    publications.push(...((chunk.publicationResult.data ?? []) as Array<{ workforce_id: string; station_id: string; notification_status: string; dependency_hash: string | null }>));
  }
  const statusBySubject = new Map(submissions.map((entry) => [`${String(entry.subject_id)}|${String(entry.location_id)}`, String(entry.status)]));
  const publicationBySubject = new Map<string, string>();
  const currentPublicationKeys = new Set<string>();
  const publishedWorkforceIds = new Set<string>();
  publications.forEach((entry) => {
    publishedWorkforceIds.add(String(entry.workforce_id));
    const key = `${String(entry.workforce_id)}|${String(entry.station_id)}`;
    if (!publicationBySubject.has(key)) {
      publicationBySubject.set(key, String(entry.notification_status));
      if (String(entry.dependency_hash ?? "") === dependencyHash) currentPublicationKeys.add(key);
    }
  });
  const publishedStatus = (status: string | undefined) => status === "pending" || status === "sending"
    ? "Notification queued"
    : status === "sent" || status === "superseded" || status === "disabled"
      ? "Payment published"
      : status === "failed"
        ? "Notification failed"
        : status === "uncertain"
          ? "Delivery needs review"
          : null;
  const publishableLocationsBySubject = new Map<string, Array<{ id: string; label: string }>>();
  const paymentRowsBySubject = new Map<string, WorkforcePayoutRow[]>();
  if (audience === "workforce") {
    rows.forEach((row) => {
      const subjectId = String(row.reviewSubjectId ?? "");
      const locationId = String(row.locationId ?? "");
      if (!subjectId || !locationId) return;
      paymentRowsBySubject.set(subjectId, [...(paymentRowsBySubject.get(subjectId) ?? []), row]);
      if (!row.paymentDetailsAvailable || !isWorkforcePayoutCalculationPublishable(row.status)) return;
      const locations = publishableLocationsBySubject.get(subjectId) ?? [];
      if (!locations.some((location) => location.id === locationId)) {
        locations.push({ id: locationId, label: row.location || "Unassigned location" });
      }
      publishableLocationsBySubject.set(subjectId, locations);
    });
  }
  const paymentReadyWorkforceIds = new Set<string>();
  paymentRowsBySubject.forEach((paymentRows, workforceId) => {
    if (paymentRows.length && paymentRows.every((row) => {
      const key = `${workforceId}|${String(row.locationId)}`;
      return currentPublicationKeys.has(key)
        && row.paymentDetailsAvailable
        && isWorkforcePayoutCalculationPublishable(row.status)
        && ["under_review", "approved"].includes(String(statusBySubject.get(key) ?? ""));
    })) paymentReadyWorkforceIds.add(workforceId);
  });
  return {
    rows: rows.map((row) => {
      const subjectKey = row.reviewSubjectId && row.locationId
        ? `${row.reviewSubjectId}|${row.locationId}`
        : null;
      const reviewStatus = subjectKey ? statusBySubject.get(subjectKey) : null;
      const presentation = payoutReviewPresentation(row.status, reviewStatus, subjectType);
      const workforceId = String(row.reviewSubjectId ?? "");
      const mappingUnlocked = audience === "workforce" && unlockedWorkforceIds.has(workforceId);
      const status = mappingUnlocked
        ? "Mapping unlocked"
        : presentation.status === "Under Review" && subjectKey
          ? publishedStatus(publicationBySubject.get(subjectKey)) ?? presentation.status
          : presentation.status;
      const publicationSnapshot = audience === "workforce"
        ? buildWorkforcePayoutPublicationSnapshot(row, fromDate, toDate, dependencyHash)
        : null;
      const publicationLockState: WorkforcePayoutRow["publicationLockState"] = audience !== "workforce"
        ? null
        : mappingUnlocked
          ? "unlocked"
          : publishedWorkforceIds.has(workforceId)
            ? "locked"
            : null;
      const reviewToken = row.reviewSubjectId && row.reviewSubjectType && row.locationId
        && presentation.tokenStatus
        ? createWorkforcePayoutReviewToken({
          companyId,
          subjectType: row.reviewSubjectType,
          subjectId: row.reviewSubjectId,
          locationId: row.locationId,
          periodStart: fromDate,
          periodEnd: toDate,
          status: presentation.tokenStatus,
          dependencyHash,
          calculationHash: audience === "workforce"
            ? workforcePayoutCalculationHash(row, fromDate, toDate)
            : null,
          publicationSnapshotHash: publicationSnapshot
            ? workforcePayoutPublicationSnapshotHash(publicationSnapshot)
            : null,
          locationSetHash: audience === "workforce"
            ? workforcePayoutLocationSetHash((publishableLocationsBySubject.get(String(row.reviewSubjectId)) ?? []).map((location) => location.id))
            : null
        })
        : null;
      return {
        ...row,
        status,
        publicationLockState,
        publicationPaymentReady: audience === "workforce" && paymentReadyWorkforceIds.has(workforceId),
        reviewToken,
        publicationDependencyHash: audience === "workforce" ? dependencyHash : null,
        publicationLocations: audience === "workforce"
          ? publishableLocationsBySubject.get(String(row.reviewSubjectId)) ?? []
          : []
      };
    }),
    error: null as string | null
  };
}

type WorkforcePayoutBank = {
  id: string;
  bankCode: string;
  displayName: string;
  accountNo: string;
  fileType: string;
};

async function withPayoutPaymentSummaries(
  companyId: string,
  fromDate: string,
  toDate: string,
  rows: WorkforcePayoutRow[]
) {
  if (!supabaseAdmin) return { rows, error: null as string | null };
  const admin = supabaseAdmin;
  const payoutRows = [...new Map(rows.flatMap((row) => row.reviewSubjectId && row.locationId
    ? [[`${row.reviewSubjectId.toLowerCase()}|${row.locationId.toLowerCase()}`, {
      workforce_id: row.reviewSubjectId,
      station_id: row.locationId
    }] as const]
    : [])).values()];
  if (!payoutRows.length) return { rows, error: null as string | null };
  type PaymentPreview = {
    workforce_id: string;
    station_id: string;
    current_target_amount: number | string;
    paid_amount: number | string;
    processing_amount: number | string;
    balance_payable: number | string;
    available_to_pay: number | string;
    history_count: number;
    payment_status: WorkforcePayoutPaymentSummary["status"];
    eligible: boolean;
    eligibility_code: string;
    eligibility_message: string;
  };
  const previews: PaymentPreview[] = [];
  const previewResults = await mapWithConcurrency(chunkedValues(payoutRows, 250), 3, async (payoutChunk) => admin.rpc("workforce_preview_payout_payment_rows", {
      p_company_id: companyId,
      p_period_start: fromDate,
      p_period_end: toDate,
      p_rows: payoutChunk
    }));
  for (const result of previewResults) {
    if (result.error) return { rows, error: result.error.message };
    previews.push(...((result.data ?? []) as PaymentPreview[]));
  }
  const previewByPayoutRow = new Map(previews.map((preview) => [
    `${String(preview.workforce_id).toLowerCase()}|${String(preview.station_id).toLowerCase()}`,
    preview
  ]));
  return {
    rows: rows.map((row) => {
      const preview = row.reviewSubjectId && row.locationId
        ? previewByPayoutRow.get(`${row.reviewSubjectId.toLowerCase()}|${row.locationId.toLowerCase()}`)
        : undefined;
      const currentNetAmount = Number(preview?.current_target_amount ?? 0);
      const paidAmount = Number(preview?.paid_amount ?? 0);
      const summary: WorkforcePayoutPaymentSummary | undefined = preview ? {
        currentNetAmount,
        paidAmount,
        processingAmount: Number(preview.processing_amount ?? 0),
        balancePayable: Number(preview.balance_payable ?? 0),
        availableToPay: Number(preview.available_to_pay ?? 0),
        overpaidAmount: Math.max(0, Math.round((paidAmount - currentNetAmount) * 100) / 100),
        historyCount: Number(preview.history_count ?? 0),
        status: preview.payment_status ?? null,
        eligible: preview.eligible === true,
        eligibilityCode: String(preview.eligibility_code ?? "").trim() || null,
        eligibilityMessage: String(preview.eligibility_message ?? "").trim() || null
      } : undefined;
      return {
        ...row,
        publicationPaymentReady: preview?.eligible === true,
        paymentSummary: summary,
        status: summary?.status ?? row.status
      };
    }),
    error: null as string | null
  };
}

async function loadWorkforcePayoutBanks(companyId: string, enabled: boolean) {
  if (!enabled || !supabaseAdmin) return { banks: [] as WorkforcePayoutBank[], error: null as string | null };
  const result = await supabaseAdmin
    .from("payment_banks")
    .select("id,bank_code,display_name,account_no")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("bank_code", "FEDERAL_BANK")
    .order("display_name")
    .order("id");
  if (result.error) return { banks: [] as WorkforcePayoutBank[], error: result.error.message };
  return {
    banks: (result.data ?? []).map((bank) => ({
      id: String(bank.id),
      bankCode: String(bank.bank_code ?? ""),
      displayName: String(bank.display_name ?? "Bank"),
      accountNo: String(bank.account_no ?? ""),
      fileType: String(bank.bank_code ?? "").trim().toUpperCase() === "FEDERAL_BANK" ? "fedone" : ""
    })),
    error: null as string | null
  };
}

export const dynamic = "force-dynamic";

export default async function WorkforcePayoutsPage({ searchParams = {} }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const period = resolvePeriod(searchParams);
  const audience = searchParams.audience === "helpers" ? "helpers" : "workforce";
  const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_payouts" : "workforce_payouts";
  const authorization = await requirePagePermission(pageCode, "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, pageCode, "edit");
  const canProcessPayments = audience === "workforce"
    && period.mode === "monthly"
    && canEdit
    && authorization.hasAllLocationAccess
    && hasPermission(authorization, "payment_process", "edit")
    && !authorization.readOnly;
  const canManageMappingLocks = audience === "workforce"
    && canEdit
    && authorization.hasAllLocationAccess
    && period.mode === "monthly"
    && period.fromDate === `${period.month}-01`;
  const [loaded, mappingLocks, bankResult] = await Promise.all([
    audience === "helpers"
      ? loadHelperPayoutRows(companyId, authorization, period.fromDate, period.toDate)
        .then((result) => ({ ...result, dependencyHash: "" }))
      : loadStablePayoutWorksheet({
        loadRows: () => loadWorkforcePayoutRows(companyId, authorization, period.fromDate, period.toDate),
        loadDependency: () => workforcePayoutDependencyHash(companyId, period.fromDate, period.toDate),
        allowProvisionalOnChurn: true
      }),
    canManageMappingLocks
      ? loadOpenMappingUnlocks(companyId, period.fromDate, period.toDate)
      : Promise.resolve({
        unlocks: [] as WorkforcePayoutMappingUnlock[],
        impactedWorkforceIds: new Set<string>(),
        error: null as string | null
      }),
    loadWorkforcePayoutBanks(companyId, canProcessPayments)
  ]);
  const provisional = audience === "workforce"
    && isProvisionalPayoutDependencyHash(loaded.dependencyHash);
  const loadError = loaded.error || mappingLocks.error || (audience === "workforce" && !loaded.dependencyHash)
    ? loaded.error || mappingLocks.error || "Payout worksheet version is unavailable."
    : null;
  const [reviewed, paymentEnriched] = await Promise.all([
    loadError
      ? Promise.resolve({ rows: loaded.rows, error: loadError })
      : withPayoutReviewStatuses(
        companyId,
        audience,
        period.fromDate,
        period.toDate,
        loaded.rows,
        audience === "workforce" ? loaded.dependencyHash ?? "" : "",
        mappingLocks.impactedWorkforceIds
      ),
    loadError || audience !== "workforce" || !canProcessPayments
      ? Promise.resolve({ rows: loaded.rows, error: loadError })
      : withPayoutPaymentSummaries(companyId, period.fromDate, period.toDate, loaded.rows)
  ]);
  const paymentByRowId = new Map(paymentEnriched.rows.map((row) => [row.id, row]));
  const rows = reviewed.rows.map((row) => {
    const paymentRow = paymentByRowId.get(row.id);
    if (!paymentRow?.paymentSummary) return row;
    return {
      ...row,
      publicationPaymentReady: paymentRow.publicationPaymentReady,
      paymentSummary: paymentRow.paymentSummary,
      status: paymentRow.paymentSummary.status ?? row.status
    };
  });
  const error = reviewed.error || paymentEnriched.error || bankResult.error;
  const advancePageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_advances" : "workforce_advances";
  const canDeductAdvances = audience === "workforce"
    && canEdit
    && hasPermission(authorization, advancePageCode, "edit");
  const audienceHref = (nextAudience: "workforce" | "helpers") => {
    const params = new URLSearchParams({
      audience: nextAudience,
      period: period.mode,
      month: period.month,
      day: period.day,
      from: period.from,
      to: period.to
    });
    return `/payments/workforce-payouts?${params.toString()}`;
  };
  const subjectLabel = audience === "helpers" ? "Helper" : "Workforce";

  return <AppShell active="Workforce Payouts" pageCode={pageCode}>
    <div className="workforce-payout-page">
      <div className="payout-page-titlebar">
        <PageHead title="Workforce Payments" />
        <nav aria-label="Payment population" className="performance-tabs">
          <Link className={audience === "workforce" ? "active" : undefined} href={audienceHref("workforce")}>Workforce</Link>
          <Link className={audience === "helpers" ? "active" : undefined} href={audienceHref("helpers")}>Helpers</Link>
        </nav>
      </div>
      {canEdit && audience === "workforce" ? <WorkforcePayoutBulkUpload fromDate={period.fromDate} toDate={period.toDate} /> : null}
      {provisional && !error
        ? <section className="panel message-panel warn"><div className="panel-body"><strong>Live payout updates are in progress</strong><p className="subtle">The latest worksheet is shown. Every selected payout will be rechecked before its notification is sent.</p></div></section>
        : null}
      {error
        ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load {subjectLabel} payouts</strong><p className="subtle">{error}</p></div></section>
        : <section className="panel"><div className="panel-head payout-period-head"><h2>{period.title}</h2><WorkforcePayoutPeriodFilter audience={audience} mode={period.mode} month={period.month} day={period.day} from={period.from} to={period.to} /></div><WorkforcePayoutTable key={`${audience}-${period.fromDate}-${period.toDate}`} audience={audience} banks={bankResult.banks} canDeductAdvances={canDeductAdvances} canEdit={canEdit} canManageMappingLocks={canManageMappingLocks} canProcessPayments={canProcessPayments} canPublishNotifications={authorization.hasAllLocationAccess} mappingUnlocks={mappingLocks.unlocks} periodStart={period.fromDate} periodEnd={period.toDate} rows={rows} /></section>}
    </div>
  </AppShell>;
}
