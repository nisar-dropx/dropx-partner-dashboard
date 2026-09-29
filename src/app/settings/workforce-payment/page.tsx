import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import {
  DEFAULT_WORKFORCE_PAYMENT_POLICY,
  normalizeWorkforcePaymentPolicy,
  workforcePaymentExample,
  workforcePaymentPolicyForDate,
  type WorkforcePaymentMethod,
  type WorkforcePaymentPolicy
} from "@/lib/workforce-payment-policy";
import { saveWorkforcePaymentSettings } from "./actions";

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

function addMonths(monthValue: string, amount: number) {
  const [year, month] = monthValue.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
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
    return { policies: [] as PolicyRow[], error: "Supabase service role key is not configured." };
  }
  const result = await supabaseAdmin
    .from("workforce_payment_settings")
    .select("id,calculation_method,paid_off_days,work_units_per_paid_off,cap_at_monthly_amount,effective_from,change_reason,created_at,updated_at")
    .eq("company_id", companyId)
    .order("effective_from", { ascending: false });
  if (result.error) return { policies: [] as PolicyRow[], error: result.error.message };
  return {
    policies: (result.data ?? []).map((row) => ({
      ...normalizeWorkforcePaymentPolicy(row),
      id: row.id,
      change_reason: String(row.change_reason ?? ""),
      created_at: row.created_at,
      updated_at: row.updated_at
    })) as PolicyRow[],
    error: null as string | null
  };
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(value);
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
  const firstAllowedMonth = addMonths(currentMonth, 1);
  const nextScheduled = [...data.policies]
    .filter((policy) => policy.effective_from > currentMonthStart)
    .sort((left, right) => left.effective_from.localeCompare(right.effective_from))[0];
  const effectivePolicy = nextScheduled
    ?? workforcePaymentPolicyForDate(data.policies, currentMonthStart)
    ?? DEFAULT_WORKFORCE_PAYMENT_POLICY;
  const formPolicy = normalizeWorkforcePaymentPolicy(effectivePolicy);
  const formMonth = nextScheduled?.effective_from.slice(0, 7) ?? firstAllowedMonth;
  const lastAllowedMonth = addMonths(currentMonth, 24);
  const activePolicy = [...data.policies]
    .filter((policy) => policy.effective_from <= currentMonthStart)
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from))[0];
  const exampleAttendanceUnits = [5, 10, 26, 30];
  const exampleMethods = Object.keys(methodCopy) as WorkforcePaymentMethod[];

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Workforce Payment"
        subtitle="Choose how attendance-based monthly workforce payment heads account for paid weekly offs."
        action={(
          <span className="listing-head-actions">
            <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>
              {isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}
            </span>
            <PendingLink className="button secondary" href="/settings">Back</PendingLink>
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
                <p className="subtle">A full day is 1 unit, a half day is 0.5, and an absence is 0. Policies are scheduled before a month begins and stay locked for that entire month.</p>
              </div>
            </div>
            <form action={saveWorkforcePaymentSettings} className="form-grid two">
              <label className="span-2">Calculation method
                <select className="select" defaultValue={formPolicy.calculation_method} disabled={!canEdit} name="calculation_method" required>
                  {exampleMethods.map((method) => <option key={method} value={method}>{methodCopy[method].label}</option>)}
                </select>
              </label>
              <label>Paid off days per month
                <input className="field" defaultValue={formPolicy.paid_off_days} disabled={!canEdit} max={10} min={0} name="paid_off_days" required step={1} type="number" />
                <span className="subtle">Used by fixed and earned paid-off methods. Default: 4.</span>
              </label>
              <label>Work units per paid off
                <input className="field" defaultValue={formPolicy.work_units_per_paid_off} disabled={!canEdit} max={31} min={0.5} name="work_units_per_paid_off" required step={0.5} type="number" />
                <span className="subtle">Used only by earned paid offs. Default: 6 attendance units.</span>
              </label>
              <label>Effective month
                <input className="field" defaultValue={formMonth} disabled={!canEdit} max={lastAllowedMonth} min={firstAllowedMonth} name="effective_from" required type="month" />
                <span className="subtle">Next month through 24 months ahead. Saving the same future month updates its scheduled policy.</span>
              </label>
              <label>Change reason
                <input className="field" disabled={!canEdit} maxLength={250} minLength={3} name="change_reason" placeholder="Why is this payment rule being changed?" required />
                <span className="subtle">Saved with the policy for payroll review and audit.</span>
              </label>
              <label className="checkbox-row">
                <input defaultChecked={formPolicy.cap_at_monthly_amount} disabled={!canEdit} name="cap_at_monthly_amount" type="checkbox" />
                <span>Cap calculated base pay at the configured monthly amount</span>
              </label>
              <div className="form-actions span-2 align-right">
                <SubmitButton disabled={!canEdit} disabledText="View only">Save workforce payment policy</SubmitButton>
              </div>
            </form>
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
                <h2>₹18,000 example for a 30-day month</h2>
                <p className="subtle">Uses {formPolicy.paid_off_days} paid offs, {formPolicy.work_units_per_paid_off} work units per earned off, and {formPolicy.cap_at_monthly_amount ? "a monthly cap" : "no monthly cap"}.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Method</th>
                    {exampleAttendanceUnits.map((units) => <th key={units}>{units} attendance units</th>)}
                  </tr>
                </thead>
                <tbody>
                  {exampleMethods.map((method) => {
                    const examplePolicy = { ...formPolicy, calculation_method: method };
                    return (
                      <tr key={method}>
                        <td><strong>{methodCopy[method].label}</strong></td>
                        {exampleAttendanceUnits.map((units) => (
                          <td key={units}>{formatMoney(workforcePaymentExample(examplePolicy, units, 18_000, "2026-09-30"))}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
                    return (
                      <tr key={policy.id}>
                        <td><strong>{formatMonth(policy.effective_from)}</strong></td>
                        <td>{methodCopy[policy.calculation_method].label}</td>
                        <td>{policy.paid_off_days}</td>
                        <td>{policy.work_units_per_paid_off}</td>
                        <td>{policy.cap_at_monthly_amount ? "Yes" : "No"}</td>
                        <td>{policy.change_reason}</td>
                        <td><span className={`status-pill ${isScheduled ? "warn" : isActive ? "good" : "neutral"}`}>{isScheduled ? "Scheduled" : isActive ? "Active" : "Superseded"}</span></td>
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
