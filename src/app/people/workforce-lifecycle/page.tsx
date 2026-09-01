import { BadgeCheck, BriefcaseBusiness, ClipboardCheck, LogOut, ShieldCheck, UserCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { completeWorkforceSettlement, reviewWorkforceExit, reviewWorkforceOnboarding, startWorkforceExit } from "./actions";

export const dynamic = "force-dynamic";

type Applicant = {
  id: string; full_name: string; dropx_id: string | null; biometric_id: string | null;
  mobile_country_code: string | null; mobile: string; email: string | null; designation: string | null;
  location_id: string | null; date_of_join: string | null; onboarding_status: string; lifecycle_status: string;
  onboarding_application_source: string | null; onboarding_submitted_at: string | null; provider_id_status: string | null;
  provider_employee_id: string | null; onboarding_review_remarks: string | null; updated_at: string;
  stations: { station_code: string | null; station_name: string | null } | Array<{ station_code: string | null; station_name: string | null }> | null;
};

type ChecklistItem = { id: string; code: string; label: string; description: string | null; is_required: boolean; applicable_designation_codes: string[]; sort_order: number };
type ChecklistResult = { field_executive_id: string; checklist_item_id: string; status: string; remarks: string | null };
type ExitCase = { id: string; field_executive_id: string; case_type: string; status: string; requested_effective_date: string; approved_effective_date: string | null; reason_code: string; reason_details: string | null; review_remarks: string | null; created_at: string };

function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function title(value: string | null | undefined) { return String(value ?? "-").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function when(value: string | null | undefined) { if (!value) return "-"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date); }

export default async function WorkforceLifecyclePage({ searchParams }: { searchParams?: { tab?: string; error?: string; notice?: string } }) {
  const authorization = await requirePagePermission("people_review", "access");
  const companyId = requireCompanyId(authorization);
  const canEdit = authorization.permissions.people_review?.canEdit ?? false;
  const tab = ["onboarding", "active", "exits"].includes(searchParams?.tab ?? "") ? searchParams!.tab! : "onboarding";
  let error = "";
  let applicants: Applicant[] = [];
  let checklist: ChecklistItem[] = [];
  let checklistResults: ChecklistResult[] = [];
  let acceptedIds = new Set<string>();
  let exits: ExitCase[] = [];
  let exitChecklist: Array<{ id: string; label: string; description: string | null; is_required: boolean }> = [];
  let designationCodes = new Map<string, string>();
  if (!supabaseAdmin) {
    error = "Supabase service role key is not configured.";
  } else {
    let applicantQuery = supabaseAdmin.from("workforce")
      .select("id, full_name, dropx_id, biometric_id, mobile_country_code, mobile, email, designation, location_id, date_of_join, onboarding_status, lifecycle_status, onboarding_application_source, onboarding_submitted_at, provider_id_status, provider_employee_id, onboarding_review_remarks, updated_at, stations(station_code, station_name)")
      .eq("company_id", companyId).order("updated_at", { ascending: false });
    if (!authorization.hasAllLocationAccess) applicantQuery = applicantQuery.in("location_id", authorization.locationScopeIds.length ? authorization.locationScopeIds : ["00000000-0000-0000-0000-000000000000"]);
    const [applicantResult, checklistResult, resultResult, acceptanceResult, exitResult, exitMasterResult, designationResult] = await Promise.all([
      applicantQuery,
      supabaseAdmin.from("workforce_onboarding_checklist_master").select("id, code, label, description, is_required, applicable_designation_codes, sort_order").eq("company_id", companyId).eq("is_active", true).order("sort_order"),
      supabaseAdmin.from("workforce_onboarding_checklist_results").select("field_executive_id, checklist_item_id, status, remarks").eq("company_id", companyId),
      supabaseAdmin.from("workforce_agreement_acceptances").select("field_executive_id").eq("company_id", companyId),
      supabaseAdmin.from("workforce_lifecycle_cases").select("id, field_executive_id, case_type, status, requested_effective_date, approved_effective_date, reason_code, reason_details, review_remarks, created_at").eq("company_id", companyId).order("created_at", { ascending: false }),
      supabaseAdmin.from("workforce_exit_checklist_master").select("id, label, description, is_required").eq("company_id", companyId).eq("is_active", true).order("sort_order"),
      supabaseAdmin.from("designations").select("name, code").eq("company_id", companyId).eq("is_active", true)
    ]);
    const firstError = [applicantResult, checklistResult, resultResult, acceptanceResult, exitResult, exitMasterResult, designationResult].find((result) => result.error)?.error;
    if (firstError) error = firstError.message;
    else {
      applicants = (applicantResult.data ?? []) as Applicant[];
      checklist = (checklistResult.data ?? []) as ChecklistItem[];
      checklistResults = (resultResult.data ?? []) as ChecklistResult[];
      acceptedIds = new Set((acceptanceResult.data ?? []).map((row) => String(row.field_executive_id)));
      exits = (exitResult.data ?? []) as ExitCase[];
      exitChecklist = (exitMasterResult.data ?? []) as typeof exitChecklist;
      designationCodes = new Map((designationResult.data ?? []).map((row) => [String(row.name).toLowerCase(), String(row.code).toUpperCase()]));
    }
  }
  const pending = applicants.filter((item) => !["active", "cancelled"].includes(item.onboarding_status));
  const active = applicants.filter((item) => item.lifecycle_status === "active");
  const openExits = exits.filter((item) => !["rejected", "settled", "cancelled"].includes(item.status));
  const resultMap = new Map(checklistResults.map((item) => [`${item.field_executive_id}:${item.checklist_item_id}`, item]));
  const applicantMap = new Map(applicants.map((item) => [item.id, item]));

  return <AppShell active="Workforce Lifecycle" pageCode="people_review">
    <PageHead eyebrow="HO Workforce Control" title="Workforce Lifecycle" subtitle="Approve and activate workforce requests from Recruit and Ops, then manage resignation, termination and final settlement without mixing HR profiles." />
    {searchParams?.notice ? <div className="notice">{searchParams.notice}</div> : null}
    {searchParams?.error || error ? <div className="error-box"><strong>Action required</strong><p>{searchParams?.error || error}</p></div> : null}
    <section className="workforce-lifecycle-summary">
      <article><ClipboardCheck /><span>Awaiting HO</span><strong>{pending.filter((item) => item.onboarding_status === "under_review").length}</strong></article>
      <article><UserCheck /><span>Active workforce</span><strong>{active.length}</strong></article>
      <article><LogOut /><span>Open exits</span><strong>{openExits.length}</strong></article>
      <article><ShieldCheck /><span>Agreements accepted</span><strong>{acceptedIds.size}</strong></article>
    </section>
    <nav className="workforce-lifecycle-tabs" aria-label="Workforce lifecycle sections">
      <PendingLink className={tab === "onboarding" ? "active" : ""} href="/people/workforce-lifecycle?tab=onboarding">Onboarding approvals</PendingLink>
      <PendingLink className={tab === "active" ? "active" : ""} href="/people/workforce-lifecycle?tab=active">Active workforce</PendingLink>
      <PendingLink className={tab === "exits" ? "active" : ""} href="/people/workforce-lifecycle?tab=exits">Exit & settlement</PendingLink>
    </nav>

    {tab === "onboarding" ? <section className="workforce-lifecycle-grid">
      {pending.length ? pending.map((item) => {
        const station = first(item.stations);
        const applicantDesignationCode = designationCodes.get(String(item.designation ?? "").toLowerCase()) ?? "";
        const applicable = checklist.filter((check) => !check.applicable_designation_codes?.length || check.applicable_designation_codes.map((code) => code.toUpperCase()).includes(applicantDesignationCode));
        return <article className="card workforce-lifecycle-card" key={item.id}>
          <header><div><small>{title(item.onboarding_application_source)} request</small><h2>{item.full_name}</h2><p>{item.dropx_id || "ID reserved"} · {station?.station_code || "No station"} · {item.designation || "No designation"}</p></div><span className={`status ${item.onboarding_status}`}>{title(item.onboarding_status)}</span></header>
          <div className="workforce-lifecycle-facts"><span>Mobile<strong>+{item.mobile_country_code || "91"} {item.mobile}</strong></span><span>Submitted<strong>{when(item.onboarding_submitted_at || item.updated_at)}</strong></span><span>Agreement<strong>{acceptedIds.has(item.id) ? "Accepted" : "Pending"}</strong></span><span>Provider ID<strong>{item.provider_employee_id || title(item.provider_id_status)}</strong></span></div>
          {canEdit && ["under_review", "returned"].includes(item.onboarding_status) ? <form action={reviewWorkforceOnboarding} className="workforce-review-form">
            <input name="id" type="hidden" value={item.id} />
            <h3>HO activation checklist</h3>
            {applicable.map((check) => {
              const existing = resultMap.get(`${item.id}:${check.id}`);
              return <label key={check.id}><input defaultChecked={["completed", "not_required"].includes(existing?.status ?? "")} name={`checklist_${check.id}`} type="checkbox" value="true" /><span><strong>{check.label}{check.is_required ? " *" : ""}</strong><small>{check.description}</small></span></label>;
            })}
            <div className="workforce-provider-row"><label>Amazon / provider ID<input defaultValue={item.provider_employee_id || ""} name="provider_employee_id" placeholder="Enter ID after creation" /></label><label className="compact-check"><input name="provider_not_required" type="checkbox" value="true" />Not required for this designation</label></div>
            <label>Review remarks<textarea name="remarks" placeholder="Verification, return or rejection note" /></label>
            <div className="form-actions"><button className="button secondary" name="review_action" type="submit" value="return">Return</button><button className="button danger" name="review_action" type="submit" value="reject">Reject</button><button className="button" name="review_action" type="submit" value="approve">Approve & activate</button></div>
          </form> : <p className="subtle">{item.onboarding_review_remarks || "Waiting for the applicant or HO action."}</p>}
        </article>;
      }) : <div className="card workforce-empty"><BadgeCheck /><h2>No onboarding requests pending</h2><p>New workforce requests from Recruit and Ops will appear here after the applicant submits the profile.</p></div>}
    </section> : null}

    {tab === "active" ? <section className="workforce-lifecycle-grid">
      {active.length ? active.map((item) => { const station = first(item.stations); return <article className="card workforce-lifecycle-card" key={item.id}>
        <header><div><small>Active workforce</small><h2>{item.full_name}</h2><p>{item.dropx_id || "-"} · {station?.station_code || "-"} · {item.designation || "-"}</p></div><span className="status active">Active</span></header>
        <div className="workforce-lifecycle-facts"><span>Biometric<strong>{item.biometric_id || "-"}</strong></span><span>Provider ID<strong>{item.provider_employee_id || "Not required"}</strong></span><span>Date of join<strong>{item.date_of_join || "-"}</strong></span><span>Mobile<strong>+{item.mobile_country_code || "91"} {item.mobile}</strong></span></div>
        {canEdit ? <form action={startWorkforceExit} className="workforce-exit-start"><input name="id" type="hidden" value={item.id} /><label>Exit type<select name="case_type" required><option value="">Select</option><option value="resignation">Resignation</option><option value="termination">Termination</option></select></label><label>Effective date<input name="effective_date" required type="date" /></label><label>Reason<select name="reason_code" required><option value="">Select</option><option value="voluntary">Voluntary resignation</option><option value="attendance">Attendance / abandonment</option><option value="performance">Performance</option><option value="conduct">Conduct / compliance</option><option value="business">Business requirement</option><option value="other">Other</option></select></label><label>Details<textarea name="reason_details" /></label><SubmitButton confirmMessage="This creates a formal workforce exit case and starts the settlement workflow." confirmTitle="Start exit process?">Start exit process</SubmitButton></form> : null}
      </article>; }) : <div className="card workforce-empty"><BriefcaseBusiness /><h2>No active workforce in scope</h2></div>}
    </section> : null}

    {tab === "exits" ? <section className="workforce-lifecycle-grid">
      {exits.length ? exits.map((item) => { const person = applicantMap.get(item.field_executive_id); return <article className="card workforce-lifecycle-card" key={item.id}>
        <header><div><small>{title(item.case_type)}</small><h2>{person?.full_name || "Workforce profile"}</h2><p>Requested last day {item.requested_effective_date} · {title(item.reason_code)}</p></div><span className={`status ${item.status}`}>{title(item.status)}</span></header>
        {item.reason_details ? <p>{item.reason_details}</p> : null}
        {canEdit && ["submitted", "under_review"].includes(item.status) ? <form action={reviewWorkforceExit} className="workforce-decision-form"><input name="case_id" type="hidden" value={item.id} /><label>Decision remarks<textarea name="remarks" required /></label><div className="form-actions"><button className="button danger" name="review_action" type="submit" value="reject">Reject exit</button><button className="button" name="review_action" type="submit" value="approve">Approve for settlement</button></div></form> : null}
        {canEdit && item.status === "settlement_pending" ? <form action={completeWorkforceSettlement} className="workforce-review-form"><input name="case_id" type="hidden" value={item.id} /><h3>Exit checklist and final settlement</h3>{exitChecklist.map((check) => <label key={check.id}><input name={`exit_checklist_${check.id}`} type="checkbox" value="true" /><span><strong>{check.label}{check.is_required ? " *" : ""}</strong><small>{check.description}</small></span></label>)}<div className="workforce-settlement-values"><label>Gross amount<input min="0" name="gross_amount" step="0.01" type="number" /></label><label>Deductions<input min="0" name="deduction_amount" step="0.01" type="number" /></label><label>Settlement<select name="settlement_status" required><option value="">Select</option><option value="paid">Paid</option><option value="waived">Waived</option></select></label><label>Payment date<input name="payment_date" type="date" /></label><label>UTR / reference<input name="payment_reference" /></label></div><SubmitButton confirmMessage="This records final settlement and permanently deactivates the workforce and biometric access." confirmTitle="Complete settlement?">Complete & deactivate</SubmitButton></form> : null}
        {item.review_remarks ? <p className="subtle">Review: {item.review_remarks}</p> : null}
      </article>; }) : <div className="card workforce-empty"><BadgeCheck /><h2>No exit cases</h2><p>Resignation and termination cases will be tracked here through settlement and deactivation.</p></div>}
    </section> : null}
  </AppShell>;
}
