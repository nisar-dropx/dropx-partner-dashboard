import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import {
  normalizeWorkforcePaymentPolicy,
  workforcePaymentMonthIsFinalized,
  type WorkforcePaymentFinalizedPeriod,
  type WorkforcePaymentMethod,
  type WorkforcePaymentPolicy
} from "@/lib/workforce-payment-policy";
import { WorkforcePaymentPolicyForm } from "./policy-form";

export const dynamic = "force-dynamic";

type PolicyRow = WorkforcePaymentPolicy & {
  id: string | number;
  change_reason: string;
  created_at: string | null;
  updated_at: string | null;
};

const methodCopy: Record<WorkforcePaymentMethod, { label: string; description: string; formula: string }> = {
  calendar_days: {
    label: "Calendar-day attendance",
    description: "Preserves the existing calculation. Only recorded attendance units are paid.",
    formula: "Monthly amount ÷ calendar days × attendance units"
  },
  fixed_paid_offs: {
    label: "Fixed paid offs",
    description: "Treats the configured monthly off allowance as paid by reducing the expected workdays.",
    formula: "Monthly amount ÷ (calendar days − paid off days) × attendance units"
  },
  earned_paid_offs: {
    label: "Earned paid offs",
    description: "Credits one paid off after each configured block of attendance units, up to the monthly allowance.",
    formula: "Monthly amount ÷ calendar days × (attendance units + earned paid offs)"
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
  const raw = cookies().get("dropx_workforce_payment_settings_flash")?.value;
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

async function loadPolicies(companyId: string) {
  if (!supabaseAdmin) {
    return {
      policies: [] as PolicyRow[],
      finalizedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: "Supabase service role key is not configured."
    };
  }
  const [settingsResult, payrollResult] = await Promise.all([
    readAllRows(supabaseAdmin
      .from("workforce_payment_settings")
      .select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from,change_reason,created_at,updated_at")
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
      policies: [] as PolicyRow[],
      finalizedPeriods: [] as WorkforcePaymentFinalizedPeriod[],
      error: settingsResult.error?.message ?? payrollResult.error?.message ?? "Unable to load workforce payment settings."
    };
  }
  return {
    policies: (settingsResult.data ?? []).map((row) => ({
      ...normalizeWorkforcePaymentPolicy(row),
      id: row.id,
      change_reason: String(row.change_reason ?? ""),
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as PolicyRow[],
    finalizedPeriods: (payrollResult.data ?? []).map((row) => ({
      period_start: String(row.period_start),
      period_end: String(row.period_end)
    })),
    error: null as string | null
  };
}

function formatMonth(value: string) {
  return new Date(`${value}T12:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  });
}

function formatUpdated(value: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata"
  });
}

export default async function WorkforcePaymentSettingsPage() {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = hasPermission(authorization, "payment_settings", "edit");
  const data = await loadPolicies(companyId);
  const flash = loadFlash();
  const currentMonth = indiaMonth();
  const currentMonthStart = `${currentMonth}-01`;
  const activePolicy = [...data.policies]
    .filter((policy) => policy.effective_from <= currentMonthStart)
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0];
  const exampleMethods = Object.keys(methodCopy) as WorkforcePaymentMethod[];
  const formRevision = data.policies
    .map((policy) => `${policy.id}:${policy.updated_at ?? policy.created_at ?? policy.effective_from}`)
    .join("|") || "default";

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Payout Method"
        subtitle="Choose how attendance-based monthly workforce payment heads account for paid weekly offs."
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
            <strong>Workforce payment settings are unavailable</strong>
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
                <h2>Monthly attendance policy</h2>
                <p className="subtle">A full day is 1 unit, a half day is 0.5, and an absence is 0. Each month remains editable until that month&apos;s payroll is finalized.</p>
              </div>
            </div>
            <WorkforcePaymentPolicyForm
              canEdit={canEdit}
              currentMonth={currentMonth}
              finalizedPeriods={data.finalizedPeriods}
              key={formRevision}
              policies={data.policies.map((policy) => ({
                calculation_method: policy.calculation_method,
                paid_off_days: policy.paid_off_days,
                work_units_per_paid_off: policy.work_units_per_paid_off,
                cap_at_monthly_amount: policy.cap_at_monthly_amount,
                effective_from: policy.effective_from
              }))}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>How each method works</h2>
                <p className="subtle">The cap is applied after the formula when enabled.</p>
              </div>
            </div>
            <div className="settings-grid">
              {exampleMethods.map((method) => (
                <article className="settings-tile" key={method}>
                  <div>
                    <h3>{methodCopy[method].label}</h3>
                    <p className="subtle">{methodCopy[method].description}</p>
                    <p style={{ marginTop: 8 }}><strong>{methodCopy[method].formula}</strong></p>
                    {method === "earned_paid_offs" ? (
                      <p className="subtle" style={{ marginTop: 6 }}>Earned paid offs = minimum of paid off days and floor(attendance units ÷ work units per paid off).</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Policy history</h2>
                <p className="subtle">Effective-dated records preserve which rule applies to each workforce payment month.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Effective month</th>
                    <th>Method</th>
                    <th>Paid offs</th>
                    <th>Units per off</th>
                    <th>Monthly cap</th>
                    <th>Change reason</th>
                    <th>Status</th>
                    <th>Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policies.length ? data.policies.map((policy) => {
                    const isScheduled = policy.effective_from > currentMonthStart;
                    const isActive = activePolicy?.id === policy.id;
                    const isLocked = workforcePaymentMonthIsFinalized(policy.effective_from, data.finalizedPeriods);
                    return (
                      <tr key={policy.id}>
                        <td><strong>{formatMonth(policy.effective_from)}</strong></td>
                        <td>{methodCopy[policy.calculation_method].label}</td>
                        <td>{policy.calculation_method === "calendar_days" ? "-" : policy.paid_off_days}</td>
                        <td>{policy.calculation_method === "earned_paid_offs" ? policy.work_units_per_paid_off : "-"}</td>
                        <td>{policy.cap_at_monthly_amount ? "Yes" : "No"}</td>
                        <td>{policy.change_reason}</td>
                        <td><span className={`status-pill ${isLocked || isScheduled ? "warn" : isActive ? "good" : "neutral"}`}>{isLocked ? "Locked" : isScheduled ? "Scheduled" : isActive ? "Active" : "Superseded"}</span></td>
                        <td>{formatUpdated(policy.updated_at ?? policy.created_at)}</td>
                      </tr>
                    );
                  }) : (
                    <tr>
                      <td className="empty-cell" colSpan={8}>No saved policy yet. Calendar-day attendance remains the default.</td>
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
