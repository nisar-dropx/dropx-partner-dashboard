import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { WorkforcePayoutBulkUpload } from "@/components/workforce-payout-bulk-upload";
import { WorkforcePayoutTable, type WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { WorkforcePayoutPeriodFilter } from "@/components/workforce-payout-period-filter";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadHelperPayoutRows } from "@/lib/helper-payout-loader";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadWorkforcePayoutRows } from "@/lib/workforce-payout-loader";
import { createWorkforcePayoutReviewToken, payoutReviewPresentation } from "@/lib/workforce-payout-review-token";

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

async function withPayoutReviewStatuses(
  companyId: string,
  audience: "workforce" | "helpers",
  fromDate: string,
  toDate: string,
  rows: WorkforcePayoutRow[]
) {
  if (!supabaseAdmin) return { rows, error: null as string | null };
  const subjectType = audience === "helpers" ? "helper" : "workforce";
  const ids = [...new Set(rows.flatMap((row) => row.reviewSubjectId ? [row.reviewSubjectId] : []))];
  if (!ids.length) return { rows, error: null as string | null };
  const submissions: Array<{ subject_id: string; location_id: string; status: string }> = [];
  for (let index = 0; index < ids.length; index += 100) {
    const result = await supabaseAdmin
      .from("workforce_payout_review_submissions")
      .select("subject_id,location_id,status")
      .eq("company_id", companyId)
      .eq("subject_type", subjectType)
      .eq("period_start", fromDate)
      .eq("period_end", toDate)
      .in("subject_id", ids.slice(index, index + 100));
    if (result.error) return { rows, error: result.error.message };
    submissions.push(...((result.data ?? []) as Array<{ subject_id: string; location_id: string; status: string }>));
  }
  const statusBySubject = new Map(submissions.map((entry) => [`${String(entry.subject_id)}|${String(entry.location_id)}`, String(entry.status)]));
  return {
    rows: rows.map((row) => {
      const reviewStatus = row.reviewSubjectId && row.locationId
        ? statusBySubject.get(`${row.reviewSubjectId}|${row.locationId}`)
        : null;
      const presentation = payoutReviewPresentation(row.status, reviewStatus);
      const status = presentation.status;
      const reviewToken = row.reviewSubjectId && row.reviewSubjectType && row.locationId
        && presentation.tokenStatus
        ? createWorkforcePayoutReviewToken({
          companyId,
          subjectType: row.reviewSubjectType,
          subjectId: row.reviewSubjectId,
          locationId: row.locationId,
          periodStart: fromDate,
          periodEnd: toDate,
          status: presentation.tokenStatus
        })
        : null;
      return { ...row, status, reviewToken };
    }),
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
  const loaded = audience === "helpers"
    ? await loadHelperPayoutRows(companyId, authorization, period.fromDate, period.toDate)
    : await loadWorkforcePayoutRows(companyId, authorization, period.fromDate, period.toDate);
  const reviewed = loaded.error
    ? { rows: loaded.rows, error: loaded.error }
    : await withPayoutReviewStatuses(companyId, audience, period.fromDate, period.toDate, loaded.rows);
  const rows = reviewed.rows;
  const error = reviewed.error;
  const canEdit = hasPermission(authorization, pageCode, "edit");
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
      {error
        ? <section className="panel message-panel error"><div className="panel-body"><strong>Unable to load {subjectLabel} payouts</strong><p className="subtle">{error}</p></div></section>
        : <section className="panel"><div className="panel-head payout-period-head"><h2>{period.title}</h2><WorkforcePayoutPeriodFilter audience={audience} mode={period.mode} month={period.month} day={period.day} from={period.from} to={period.to} /></div><WorkforcePayoutTable key={`${audience}-${period.fromDate}-${period.toDate}`} audience={audience} canEdit={canEdit} periodStart={period.fromDate} periodEnd={period.toDate} rows={rows} /></section>}
    </div>
  </AppShell>;
}
