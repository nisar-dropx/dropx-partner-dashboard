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
  effective_from: string;
  change_reason: string;
  updated_at: string | null;
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
      finalizedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: "Supabase service role key is not configured."
    };
  }
  const [settingsResult, payrollResult] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("workforce_attendance_capture_settings")
      .select("capture_method,minimum_daily_deliveries,effective_from,change_reason,updated_at")
      .eq("company_id", companyId)
      .order("effective_from", { ascending: false })),
    readAllRows(supabaseAdmin
      .from("workforce_payroll_runs")
      .select("period_start,period_end")
      .eq("company_id", companyId)
      .or("status.ilike.approved,status.ilike.paid")
      .order("period_start", { ascending: true }))
  ]);
  if (settingsResult.error || payrollResult.error) {
    return {
      settings: [] as AttendanceCaptureSettingRow[],
      finalizedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: settingsResult.error?.message ?? payrollResult.error?.message ?? "Unable to load attendance capture settings."
    };
  }
  return {
    settings: (settingsResult.data ?? []).map((row) => ({
      ...normalizeWorkforceAttendanceCaptureSetting(row),
      change_reason: String(row.change_reason ?? ""),
      updated_at: row.updated_at
    })) as AttendanceCaptureSettingRow[],
    finalizedPeriods: (payrollResult.data ?? []).map((row) => ({
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
        title="Attendance Capture"
        subtitle="Choose the source that qualifies daily attendance for attendance-based workforce payment."
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
                <h2>Daily attendance source</h2>
                <p className="subtle">Changes are effective-dated so payroll review can preserve which source qualified each day.</p>
              </div>
            </div>
            <WorkforceAttendanceCaptureForm
              canEdit={canEdit}
              currentMonth={currentMonth}
              finalizedPeriods={data.finalizedPeriods}
              key={formRevision}
              settings={data.settings.map((setting): WorkforceAttendanceCaptureSetting => ({
                capture_method: setting.capture_method,
                minimum_daily_deliveries: setting.minimum_daily_deliveries,
                effective_from: setting.effective_from
              }))}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>How each source works</h2>
                <p className="subtle">Only the shipment source uses a minimum daily delivery threshold.</p>
                <p className="subtle">Shipment data can identify only workforce with an active provider-member mapping. Providerless direct-pay workforce must use biometric attendance.</p>
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
                <h2>Policy history</h2>
                <p className="subtle">Effective-dated records preserve the attendance source used for each period.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Effective month</th>
                    <th>Capture method</th>
                    <th>Minimum deliveries</th>
                    <th>Change reason</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.settings.length ? data.settings.map((setting) => {
                    const isScheduled = setting.effective_from > currentMonthStart;
                    const isActive = activeSetting === setting;
                    const isLocked = workforcePaymentMonthIsFinalized(setting.effective_from, data.finalizedPeriods);
                    return (
                      <tr key={setting.effective_from}>
                        <td><strong>{formatMonth(setting.effective_from)}</strong></td>
                        <td>{methodCopy[setting.capture_method].label}</td>
                        <td>{setting.capture_method === "shipment_data" ? setting.minimum_daily_deliveries : "-"}</td>
                        <td>{setting.change_reason}</td>
                        <td><span className={`status-pill ${isLocked || isScheduled ? "warn" : isActive ? "good" : "neutral"}`}>{isLocked ? "Locked" : isScheduled ? "Scheduled" : isActive ? "Active" : "Superseded"}</span></td>
                      </tr>
                    );
                  }) : (
                    <tr>
                      <td className="empty-cell" colSpan={5}>No saved policy yet. Biometric attendance remains the default.</td>
                    </tr>
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
