import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { saveApprovalSteps } from "../actions";

type RoleRow = { id: string; code: string; name: string; is_active: boolean };
type StepCandidate = { role_id: string; scope: "station" | "cluster" | "company" };
type StepRow = { id: string; step_order: number; candidates: StepCandidate[]; is_required: boolean };

const MAX_STEPS = 5;
const MAX_CANDIDATES_PER_STEP = 3;
const SCOPE_LABELS: Record<string, string> = { station: "Requester's station", cluster: "Requester's cluster", company: "Anyone in this role" };

async function loadData(companyId: string, paymentHeadId: string) {
  if (!supabaseAdmin) return null;
  const [headResult, rolesResult, stepsResult] = await Promise.all([
    supabaseAdmin.from("payment_heads").select("id, code, name").eq("id", paymentHeadId).eq("company_id", companyId).maybeSingle(),
    supabaseAdmin.from("user_roles").select("id, code, name, is_active").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("payment_head_approval_steps").select("id, step_order, candidates, is_required").eq("company_id", companyId).eq("payment_head_id", paymentHeadId).order("step_order")
  ]);
  if (!headResult.data) return null;
  return {
    head: headResult.data,
    roles: (rolesResult.data ?? []) as RoleRow[],
    steps: (stepsResult.data ?? []) as StepRow[]
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentApprovalStepsPage({ params }: { params: { headId: string } }) {
  const authorization = await requirePagePermission("payment_settings", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_settings;
  const data = await loadData(companyId, params.headId);
  if (!data) notFound();
  const { head, roles, steps } = data;

  const roleOptions = roles.map((role) => ({ value: role.id, label: role.name, helper: role.code }));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const stepSlots = Array.from({ length: MAX_STEPS }, (_, index) => steps[index] ?? null);

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title={`Approval steps · ${head.name}`}
        subtitle={`${head.code} - each step tries its candidate roles in order; leave a step blank to remove it.`}
        action={<PendingLink className="button secondary compact" href="/settings/payment-approvals">Back to payment heads</PendingLink>}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Approval chain</h2>
            <p className="subtle">Step 1 runs first. If a step's candidates are all unavailable and it isn't required, the request skips to the next step.</p>
          </div>
        </div>
        <form action={saveApprovalSteps} className="panel-body payment-approval-steps-form">
          <input type="hidden" name="payment_head_id" value={head.id} />
          <input type="hidden" name="step_count" value={MAX_STEPS} />
          <input type="hidden" name="candidate_count" value={MAX_CANDIDATES_PER_STEP} />

          {stepSlots.map((step, stepIndex) => {
            const candidateSlots = Array.from({ length: MAX_CANDIDATES_PER_STEP }, (_, index) => step?.candidates[index] ?? null);
            return (
              <div key={stepIndex} className="payment-approval-step-block">
                <div className="payment-approval-step-head">
                  <strong>Step {stepIndex + 1}</strong>
                  <label className="payment-approval-step-required">
                    <input
                      defaultChecked={step?.is_required ?? stepIndex === 0}
                      disabled={!pagePermission.canEdit}
                      name={`steps[${stepIndex}][is_required]`}
                      type="checkbox"
                      value="1"
                    />
                    Required (blocks the request here if nobody qualifies, instead of skipping)
                  </label>
                </div>
                <div className="form-grid three">
                  {candidateSlots.map((candidate, candidateIndex) => (
                    <div key={candidateIndex} className="payment-approval-candidate">
                      <label>
                        {candidateIndex === 0 ? "Role" : `Fallback role ${candidateIndex + 1}`}
                        <SearchableSelect
                          disabled={!pagePermission.canEdit}
                          name={`steps[${stepIndex}][candidates][${candidateIndex}][role_id]`}
                          options={roleOptions}
                          defaultValue={candidate?.role_id ?? ""}
                          placeholder="Select role"
                        />
                      </label>
                      <label>
                        Scope
                        <select
                          className="field"
                          defaultValue={candidate?.scope ?? "company"}
                          disabled={!pagePermission.canEdit}
                          name={`steps[${stepIndex}][candidates][${candidateIndex}][scope]`}
                        >
                          {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {pagePermission.canEdit ? (
            <div className="form-actions">
              <SubmitButton>Save approval steps</SubmitButton>
            </div>
          ) : null}
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Current configuration</h2>
            <p className="subtle">{steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"} configured` : "No approval steps configured yet - this payment head falls back to its legacy initial/final approval roles."}</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Candidates (in order)</th>
                <th>Required</th>
              </tr>
            </thead>
            <tbody>
              {steps.length ? steps.map((step) => (
                <tr key={step.id}>
                  <td>{step.step_order}</td>
                  <td>
                    {step.candidates.map((candidate, index) => {
                      const role = roleById.get(candidate.role_id);
                      return (
                        <div key={index}>
                          <strong>{role?.name ?? "Unknown role"}</strong>
                          <span className="subtle"> · {SCOPE_LABELS[candidate.scope] ?? candidate.scope}</span>
                        </div>
                      );
                    })}
                  </td>
                  <td>{step.is_required ? "Yes - blocks if nobody qualifies" : "No - skips if nobody qualifies"}</td>
                </tr>
              )) : (
                <tr><td className="empty-cell" colSpan={3}>No approval steps added yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
