import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import {
  normalizeWorkforceAttendanceCaptureSetting,
  type WorkforceAttendanceCaptureMethod,
  type WorkforceAttendanceCaptureSetting
} from "@/lib/workforce-attendance-capture";
import {
  workforcePaymentMonthIsFinalized,
  type WorkforcePaymentFinalizedPeriod
} from "@/lib/workforce-payment-policy";
import { WorkforceAttendanceCaptureForm } from "./attendance-capture-form";

export const dynamic = "force-dynamic";

type AttendanceCaptureSettingRow = {
  capture_method: WorkforceAttendanceCaptureMethod;
  minimum_daily_deliveries: number | null;
  review_below_deliveries?: number | null;
  effective_from: string;
  change_reason: string;
  updated_at: string | null;
};

type AttendanceCaptureHistoryRow = {
  id: string | number;
  effective_from: string;
  operation: "insert" | "update" | "delete";
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  changed_by: string | null;
  changed_at: string;
};

type HistoryActorRow = {
  id: string;
  full_name: string | null;
  email: string | null;
};

const methodCopy: Record<WorkforceAttendanceCaptureMethod, { label: string; description: string }> = {
  biometric: {
    label: "Biometric attendance",
    description: "Use recorded biometric attendance punches as the daily attendance source."
  },
  shipment_data: {
    label: "Shipment delivery data",
    description: "Qualify daily attendance when completed deliveries reach the configured threshold."
  }
};

function indiaMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? String(date.getUTCFullYear());
  const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function loadFlash() {
  const raw = cookies().get("dropx_workforce_attendance_capture_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadSettings(companyId: string) {
  if (!supabaseAdmin) {
    return {
      settings: [] as AttendanceCaptureSettingRow[],
      history: [] as AttendanceCaptureHistoryRow[],
      historyActors: new Map<string, HistoryActorRow>(),
      lockedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: "Supabase service role key is not configured."
    };
  }
  const [settingsResult, historyResult, payrollResult, reviewResult] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("workforce_attendance_capture_settings")
      .select("capture_method,minimum_daily_deliveries,review_below_deliveries,effective_from,change_reason,updated_at")
      .eq("company_id", companyId)
      .order("effective_from", { ascending: false })),
    readAllRows(supabaseAdmin
      .from("workforce_attendance_capture_setting_history")
      .select("id,effective_from,operation,before_data,after_data,changed_by,changed_at")
      .eq("company_id", companyId)
      .order("changed_at", { ascending: false })),
    readAllRows(supabaseAdmin
      .from("workforce_payroll_runs")
      .select("period_start,period_end")
      .eq("company_id", companyId)
      .or("status.ilike.review,status.ilike.approved,status.ilike.paid")
      .order("period_start", { ascending: true })),
    readAllRows(supabaseAdmin
      .from("workforce_payout_review_submissions")
      .select("period_start,period_end")
      .eq("company_id", companyId)
      .eq("subject_type", "workforce")
      .in("status", ["under_review", "approved"])
      .order("period_start", { ascending: true }))
  ]);
  if (settingsResult.error || historyResult.error || payrollResult.error || reviewResult.error) {
    return {
      settings: [] as AttendanceCaptureSettingRow[],
      history: [] as AttendanceCaptureHistoryRow[],
      historyActors: new Map<string, HistoryActorRow>(),
      lockedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: settingsResult.error?.message ?? historyResult.error?.message ?? payrollResult.error?.message ?? reviewResult.error?.message ?? "Unable to load attendance capture settings."
    };
  }
  const historyRows = (historyResult.data ?? []).map((row) => ({
    id: row.id,
    effective_from: String(row.effective_from),
    operation: row.operation as AttendanceCaptureHistoryRow["operation"],
    before_data: row.before_data as Record<string, unknown> | null,
    after_data: row.after_data as Record<string, unknown> | null,
    changed_by: row.changed_by ? String(row.changed_by) : null,
    changed_at: String(row.changed_at)
  })) as AttendanceCaptureHistoryRow[];
  const actorIds = [...new Set(historyRows.map((row) => row.changed_by).filter((id): id is string => Boolean(id)))];
  const actorsResult = actorIds.length
    ? await supabaseAdmin.from("profiles").select("id,full_name,email").in("id", actorIds)
    : { data: [] as HistoryActorRow[], error: null };
  if (actorsResult.error) {
    return {
      settings: [] as AttendanceCaptureSettingRow[],
      history: [] as AttendanceCaptureHistoryRow[],
      historyActors: new Map<string, HistoryActorRow>(),
      lockedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: actorsResult.error.message
    };
  }
  return {
    settings: (settingsResult.data ?? []).map((row) => ({
      ...normalizeWorkforceAttendanceCaptureSetting(row),
      change_reason: String(row.change_reason ?? ""),
      updated_at: row.updated_at
    })) as AttendanceCaptureSettingRow[],
    history: historyRows,
    historyActors: new Map(((actorsResult.data ?? []) as HistoryActorRow[]).map((actor) => [actor.id, actor])),
    lockedPeriods: [...(payrollResult.data ?? []), ...(reviewResult.data ?? [])].map((row) => ({
      period_start: String(row.period_start),
      period_end: String(row.period_end)
    })),
    error: null as string | null
  };
}

function formatMonth(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  });
}

function formatChangedAt(value: string) {
  return new Date(value).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  });
}

function historyPolicySummary(value: Record<string, unknown> | null) {
  if (!value) return "—";
  const policy = normalizeWorkforceAttendanceCaptureSetting(value);
  const parts = [methodCopy[policy.capture_method].label];
  if (policy.capture_method === "shipment_data") parts.push(`minimum ${policy.minimum_daily_deliveries} deliveries`);
  if (policy.review_below_deliveries) parts.push(`review below ${policy.review_below_deliveries}`);
  const reason = String(value.change_reason ?? "").trim();
  if (reason) parts.push(reason);
  return parts.join(" · ");
}

export default async function WorkforceAttendanceCaptureSettingsPage() {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, "payment_settings", "edit");
  const data = await loadSettings(companyId);
  const flash = loadFlash();
  const currentMonth = indiaMonth();
  const currentMonthStart = `${currentMonth}-01`;
  const activeSetting = data.settings.find((setting) => setting.effective_from <= currentMonthStart);
  const formRevision = data.settings
    .map((setting) => `${setting.effective_from}:${setting.updated_at ?? setting.capture_method}`)
    .join("|") || "default";

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Workforce Attendance Capture"
        subtitle="Choose the source that qualifies daily Workforce attendance. Helpers always use biometric attendance."
        action={(
          <span className="listing-head-actions">
            <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>
              {isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}
            </span>
            <PendingLink className="button secondary" href="/settings/workforce-payment">Back</PendingLink>
          </span>
        )}
      />

      {data.error ? (
        <section aria-live="assertive" className="panel message-panel error" role="alert">
          <div className="panel-body">
            <strong>Attendance capture settings are unavailable</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error}</p>
          </div>
        </section>
      ) : null}

      {!data.error && (flash.error || flash.notice) ? (
        <section aria-live={flash.error ? "assertive" : "polite"} className={`panel message-panel ${flash.error ? "error" : "success"}`} role={flash.error ? "alert" : "status"}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!data.error ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Workforce daily attendance source</h2>
                <p className="subtle">Changes are effective-dated so Workforce payout review can preserve which source qualified each day. This setting does not change Helper attendance.</p>
              </div>
            </div>
            <WorkforceAttendanceCaptureForm
              canEdit={canEdit}
              currentMonth={currentMonth}
              lockedPeriods={data.lockedPeriods}
              key={formRevision}
              settings={data.settings.map((setting): WorkforceAttendanceCaptureSetting => ({
                capture_method: setting.capture_method,
                minimum_daily_deliveries: setting.minimum_daily_deliveries,
                review_below_deliveries: setting.review_below_deliveries,
                effective_from: setting.effective_from
              }))}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>How each source works</h2>
                <p className="subtle">Only the Workforce shipment source uses a minimum daily delivery threshold. Helper payouts continue to use biometric workdays.</p>
                <p className="subtle">The effective-dated setting applies to every Workforce payment path. When shipment data is selected, a person without matched delivery data is absent unless an explicit payout attendance upload covers the period.</p>
              </div>
            </div>
            <div className="settings-grid">
              {(Object.keys(methodCopy) as WorkforceAttendanceCaptureMethod[]).map((method) => (
                <article className="settings-tile" key={method}>
                  <div>
                    <h3>{methodCopy[method].label}</h3>
                    <p className="subtle">{methodCopy[method].description}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Effective policies</h2>
                <p className="subtle">This timeline shows the attendance source that applies to each period.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Effective month</th>
                    <th>Capture method</th>
                    <th>Minimum deliveries</th>
                    <th>Review below</th><th>Change reason</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.settings.length ? data.settings.map((setting) => {
                    const isScheduled = setting.effective_from > currentMonthStart;
                    const isActive = activeSetting === setting;
                    const isLocked = workforcePaymentMonthIsFinalized(setting.effective_from, data.lockedPeriods);
                    return (
                      <tr key={setting.effective_from}>
                        <td><strong>{formatMonth(setting.effective_from)}</strong></td>
                        <td>{methodCopy[setting.capture_method].label}</td>
                        <td>{setting.capture_method === "shipment_data" ? setting.minimum_daily_deliveries : "-"}</td>
                        <td>{setting.review_below_deliveries ?? "—"} deliveries</td><td>{setting.change_reason}</td>
                        <td><span className={`status-pill ${isLocked || isScheduled ? "warn" : isActive ? "good" : "neutral"}`}>{isLocked ? "Locked" : isScheduled ? "Scheduled" : isActive ? "Active" : "Superseded"}</span></td>
                      </tr>
                    );
                  }) : (
                    <tr>
                      <td className="empty-cell" colSpan={6}>No saved policy yet. Biometric attendance remains the default.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Change history</h2>
                <p className="subtle">Every saved revision is retained with its previous and new values.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Changed at</th>
                    <th>Changed by</th>
                    <th>Effective month</th>
                    <th>Action</th>
                    <th>Previous value</th>
                    <th>New value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.length ? data.history.map((entry) => {
                    const actor = entry.changed_by ? data.historyActors.get(entry.changed_by) : null;
                    return <tr key={entry.id}>
                      <td>{formatChangedAt(entry.changed_at)}</td>
                      <td><strong>{actor?.full_name || "System"}</strong>{actor?.email ? <><br /><span className="subtle">{actor.email}</span></> : null}</td>
                      <td><strong>{formatMonth(entry.effective_from)}</strong></td>
                      <td>{entry.operation === "insert" ? "Created" : entry.operation === "update" ? "Updated" : "Deleted"}</td>
                      <td>{historyPolicySummary(entry.before_data)}</td>
                      <td>{historyPolicySummary(entry.after_data)}</td>
                    </tr>;
                  }) : (
                    <tr><td className="empty-cell" colSpan={6}>No attendance-setting changes have been recorded yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
