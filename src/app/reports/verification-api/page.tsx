import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { VerificationApiLogDetails } from "@/components/verification-api-log-details";
import { VerificationApiReportFilters } from "@/components/verification-api-report-filters";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";

type SearchParams = {
  from?: string;
  kind?: string;
  page?: string;
  per_page?: string;
  profile_type?: string;
  result?: string;
  search?: string;
  source?: string;
  to?: string;
};

type AuditRow = {
  id: string;
  account_id: string | null;
  provider_code: string;
  verification_kind: string;
  endpoint: string;
  source: string;
  profile_type: string | null;
  account_code: string | null;
  profile_name: string | null;
  actor_user_id: string | null;
  actor_label: string | null;
  request_data: unknown;
  response_data: unknown;
  http_status: number | null;
  is_success: boolean;
  result_code: string | null;
  result_message: string | null;
  duration_ms: number | null;
  created_at: string;
};

const kindOptions = [
  ["", "All API types"],
  ["pan", "PAN"],
  ["pan_aadhaar", "PAN Aadhaar link"],
  ["dl", "Driving licence"],
  ["vehicle", "Vehicle RC"],
  ["bank", "Bank account"],
  ["upi", "UPI ID"],
  ["pf_uan", "PF UAN"]
];

const sourceOptions = [
  ["", "All sources"],
  ["dashboard", "Dashboard"],
  ["dropx_one_android", "DropX One Android"],
  ["dropx_one_web", "DropX One Web"]
];

const profileOptions = [
  ["", "All categories"],
  ["employee", "Employee"],
  ["field_executive", "Field executive"],
  ["contractor", "Independent contractor"],
  ["vendor", "Vendor"],
  ["worker", "Worker"]
];

function clean(value: string | undefined) {
  return String(value ?? "").trim();
}

function safePage(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function safePageSize(value: string | undefined) {
  const parsed = Number(value);
  return [20, 50, 100].includes(parsed) ? parsed : 20;
}

function selectedValues(value: string | undefined, allowed: string[]) {
  return Array.from(new Set(
    clean(value)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => allowed.includes(item))
  ));
}

function safeDate(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function labelFor(options: string[][], value: string) {
  return options.find(([key]) => key === value)?.[1] ?? value.replaceAll("_", " ");
}

function formatDate(value: string) {
  return formatDashboardDateTime(value);
}

function performerLabel(value: string | null, source: string) {
  const label = clean(value ?? "");
  if (!source.startsWith("dropx_one")) return label || "-";
  if (!/^\d+$/.test(label)) return label || "-";
  let digits = label;
  if (digits.startsWith("9191") && digits.length === 14) digits = digits.slice(2);
  if (digits.startsWith("91") && digits.length === 12) return `+91 ${digits.slice(2)}`;
  if (digits.length === 10) return `+91 ${digits}`;
  return label || "-";
}

function mobileLabel(countryCode: unknown, mobile: unknown) {
  const code = String(countryCode ?? "").replace(/\D/g, "") || "91";
  let number = String(mobile ?? "").replace(/\D/g, "");
  if (!number) return "";
  if (number.startsWith(code) && number.length > 10) number = number.slice(code.length);
  return `+${code} ${number}`;
}

function paginationHref(searchParams: SearchParams, page: number) {
  const params = new URLSearchParams();
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value && key !== "page") params.set(key, value);
  });
  params.set("page", String(page));
  return `/reports/verification-api?${params.toString()}`;
}

function isMissingAuditTable(message: string) {
  const value = message.toLowerCase();
  return value.includes("verification_api_audit_logs") &&
    (value.includes("does not exist") || value.includes("schema cache"));
}

export const dynamic = "force-dynamic";

export default async function VerificationApiReportPage({
  searchParams = {}
}: {
  searchParams?: SearchParams;
}) {
  const authorization = await requirePagePermission("verification_api_reports", "access");
  const companyId = requireCompanyId(authorization);
  const page = safePage(searchParams.page);
  const pageSize = safePageSize(searchParams.per_page);
  const from = safeDate(searchParams.from);
  const to = safeDate(searchParams.to);
  const kinds = selectedValues(searchParams.kind, kindOptions.map(([value]) => value).filter(Boolean));
  const sources = selectedValues(searchParams.source, sourceOptions.map(([value]) => value).filter(Boolean));
  const profileTypes = selectedValues(searchParams.profile_type, profileOptions.map(([value]) => value).filter(Boolean));
  const results = selectedValues(searchParams.result, ["success", "failed"]);
  const search = clean(searchParams.search).replace(/[,%()]/g, " ");

  let rows: AuditRow[] = [];
  let actorEmails = new Map<string, string>();
  let appActorMobiles = new Map<string, string>();
  let total = 0;
  let error: string | null = null;

  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    let query = supabaseAdmin
      .from("verification_api_audit_logs")
      .select(
        "id, account_id, provider_code, verification_kind, endpoint, source, profile_type, account_code, profile_name, actor_user_id, actor_label, request_data, response_data, http_status, is_success, result_code, result_message, duration_ms, created_at",
        { count: "exact" }
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false });

    if (from) query = query.gte("created_at", `${from}T00:00:00+05:30`);
    if (to) query = query.lte("created_at", `${to}T23:59:59.999+05:30`);
    if (kinds.length) query = query.in("verification_kind", kinds);
    if (sources.length) query = query.in("source", sources);
    if (profileTypes.length) query = query.in("profile_type", profileTypes);
    if (results.length === 1) query = query.eq("is_success", results[0] === "success");
    if (search) {
      query = query.or(
        `account_code.ilike.%${search}%,profile_name.ilike.%${search}%,actor_label.ilike.%${search}%,result_message.ilike.%${search}%`
      );
    }

    const response = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (response.error) {
      error = response.error.message;
    } else {
      rows = (response.data ?? []) as AuditRow[];
      total = response.count ?? rows.length;
      const actorUserIds = Array.from(new Set(rows.map((row) => row.actor_user_id).filter(Boolean))) as string[];
      if (actorUserIds.length) {
        const actors = await supabaseAdmin
          .from("profiles")
          .select("id, email")
          .eq("company_id", companyId)
          .in("id", actorUserIds);
        if (!actors.error) {
          actorEmails = new Map(
            (actors.data ?? [])
              .filter((actor) => actor.email)
              .map((actor) => [actor.id as string, actor.email as string])
          );
        }
      }
      const appProfileTables = [
        ["employee", "employees"],
        ["field_executive", "field_executives"],
        ["contractor", "contractors"],
        ["vendor", "vendors"],
        ["worker", "workers"]
      ] as const;
      const appActorResults = await Promise.all(appProfileTables.map(async ([profileType, table]) => {
        const ids = Array.from(new Set(
          rows
            .filter((row) => row.source.startsWith("dropx_one") && row.profile_type === profileType)
            .map((row) => row.account_id)
            .filter(Boolean)
        )) as string[];
        if (!ids.length) return [] as Array<[string, string]>;
        const profiles = await supabaseAdmin!
          .from(table)
          .select("id, mobile, mobile_country_code")
          .eq("company_id", companyId)
          .in("id", ids);
        if (profiles.error) return [] as Array<[string, string]>;
        return (profiles.data ?? []).map((profile) => [
          `${profileType}:${profile.id}`,
          mobileLabel(profile.mobile_country_code, profile.mobile)
        ] as [string, string]);
      }));
      appActorMobiles = new Map(appActorResults.flat());
    }
  }

  const successCount = rows.filter((row) => row.is_success).length;
  const failedCount = rows.length - successCount;
  const averageDuration = rows.length
    ? Math.round(rows.reduce((sum, row) => sum + (row.duration_ms ?? 0), 0) / rows.length)
    : 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <AppShell active="Verification API" pageCode="verification_api_reports">
      <PageHead
        eyebrow="Reports"
        title="Verification API"
        subtitle="Review every verification request from Dashboard and DropX One, including the account, API payload, provider response, and outcome."
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>{isMissingAuditTable(error) ? "Database setup needed" : "Unable to load report"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error}
              {isMissingAuditTable(error)
                ? " Run scripts/verification_api_audit_logs_v1.sql in Supabase SQL Editor, then refresh."
                : ""}
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <VerificationApiReportFilters
          kindOptions={kindOptions.filter(([value]) => value).map(([value, label]) => ({ value, label }))}
          profileOptions={profileOptions.filter(([value]) => value).map(([value, label]) => ({ value, label }))}
          resultOptions={[{ value: "success", label: "Success" }, { value: "failed", label: "Failed" }]}
          sourceOptions={sourceOptions.filter(([value]) => value).map(([value, label]) => ({ value, label }))}
        />
      </section>

      <section className="grid metrics verification-api-metrics">
        <div className="metric-card"><span>Filtered calls</span><strong>{total}</strong><small>Across all matching pages</small></div>
        <div className="metric-card"><span>Visible success</span><strong>{successCount}</strong><small>On this page</small></div>
        <div className="metric-card"><span>Visible failed</span><strong>{failedCount}</strong><small>On this page</small></div>
        <div className="metric-card"><span>Average response</span><strong>{averageDuration} ms</strong><small>On this page</small></div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>API trigger history</h2>
            <p className="subtle">
              {total
                ? `Showing ${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total} matching records.`
                : "0 matching records."} Newest calls are shown first.
            </p>
          </div>
        </div>
        <div className="table-wrap verification-api-report-table">
          <table>
            <thead>
              <tr>
                <th>Date and time</th>
                <th>API</th>
                <th>Verification subject</th>
                <th>Performed by</th>
                <th>Platform</th>
                <th>Result</th>
                <th>Response</th>
                <th>Time</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatDate(row.created_at)}</td>
                  <td>
                    <strong>{labelFor(kindOptions, row.verification_kind)}</strong>
                    <small>{row.provider_code.toUpperCase()}</small>
                  </td>
                  <td>
                    <strong>{row.profile_name || "-"}</strong>
                    <small>
                      {[row.account_code, labelFor(profileOptions, row.profile_type ?? "")]
                        .filter(Boolean)
                        .join(" · ") || "-"}
                    </small>
                  </td>
                  <td>
                    {(() => {
                      const performer = performerLabel(row.actor_label, row.source);
                      const mobile = row.source.startsWith("dropx_one") && row.account_id && row.profile_type
                        ? appActorMobiles.get(`${row.profile_type}:${row.account_id}`) ?? ""
                        : "";
                      return (
                        <>
                          <strong>{performer}</strong>
                          {mobile && mobile !== performer ? <small>{mobile}</small> : null}
                        </>
                      );
                    })()}
                    {row.source === "dashboard" && row.actor_user_id && actorEmails.get(row.actor_user_id)
                      ? <small>{actorEmails.get(row.actor_user_id)}</small>
                      : null}
                  </td>
                  <td>{labelFor(sourceOptions, row.source)}</td>
                  <td>
                    <StatusPill status={row.is_success ? "Success" : "Failed"} />
                    <small>HTTP {row.http_status ?? "-"}</small>
                  </td>
                  <td>
                    <span>{row.result_message || "-"}</span>
                    {row.result_code ? <small>Code: {row.result_code}</small> : null}
                  </td>
                  <td>{row.duration_ms == null ? "-" : `${row.duration_ms} ms`}</td>
                  <td>
                    <VerificationApiLogDetails details={{
                      endpoint: row.endpoint,
                      requestData: row.request_data,
                      responseData: row.response_data
                    }} />
                  </td>
                </tr>
              ))}
              {!rows.length && !error ? (
                <tr><td className="empty-cell" colSpan={9}>No verification API calls match these filters.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {total > 0 ? (
          <nav className="verification-api-pagination" aria-label="Verification API report pages">
            {page > 1
              ? <Link className="button secondary compact" href={paginationHref(searchParams, page - 1)}>Previous</Link>
              : <span className="button secondary compact disabled">Previous</span>}
            <span>Page {page} of {totalPages}</span>
            {page < totalPages
              ? <Link className="button secondary compact" href={paginationHref(searchParams, page + 1)}>Next</Link>
              : <span className="button secondary compact disabled">Next</span>}
          </nav>
        ) : null}
      </section>
    </AppShell>
  );
}
