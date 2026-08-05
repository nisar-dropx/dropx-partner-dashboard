import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PaymentHeadForm } from "@/components/payment-head-form";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { normalizePaymentModes, paymentModeLabel, type PaymentMode } from "@/lib/payment-modes";
import { createPaymentHead, updatePaymentHead } from "./actions";

type QuestionRow = {
  id: string;
  question_text: string;
  answer_type: string;
  dropdown_options: string | null;
  field_stage: "expense" | "payment" | null;
  is_required: boolean;
  sort_order: number;
};

type PaymentHeadRow = {
  id: string;
  code: string;
  name: string;
  external_id: string | null;
  initial_approval_role_id: string | null;
  initial_approval_role_ids: string[] | null;
  final_approval_role_id: string | null;
  final_approval_role_ids: string[] | null;
  payment_process_role_ids: string[] | null;
  supported_payment_modes: PaymentMode[] | null;
  requires_supporting_document: boolean;
  request_expense_approval: boolean;
  expense_approval_threshold: number | null;
  is_active: boolean;
  payment_head_questions?: QuestionRow[] | null;
};

type RoleRow = { id: string; code: string; name: string; is_active: boolean };

function questionStage(question: QuestionRow) {
  return question.field_stage === "payment" ? "payment" : "expense";
}

function activeQuestions(questions: QuestionRow[] | null | undefined) {
  return (questions ?? [])
    .filter((question) => Number(question.sort_order ?? 0) > 0)
    .slice()
    .sort((first, second) => first.sort_order - second.sort_order);
}

function configuredRoleIds(roleIds: string[] | null | undefined, legacyRoleId: string | null | undefined) {
  if (Array.isArray(roleIds)) return roleIds;
  return legacyRoleId ? [legacyRoleId] : [];
}

async function loadPaymentHeads(companyId: string) {
  if (!supabaseAdmin) return { heads: [] as PaymentHeadRow[], roles: [] as RoleRow[], error: "Supabase service role key is not configured." };
  const [headsResult, rolesResult] = await Promise.all([
    supabaseAdmin
      .from("payment_heads")
      .select("id, code, name, external_id, initial_approval_role_id, initial_approval_role_ids, final_approval_role_id, final_approval_role_ids, payment_process_role_ids, supported_payment_modes, requires_supporting_document, request_expense_approval, expense_approval_threshold, is_active, payment_head_questions (id, question_text, answer_type, dropdown_options, field_stage, is_required, sort_order)")
      .eq("company_id", companyId)
      .order("code"),
    supabaseAdmin
      .from("user_roles")
      .select("id, code, name, is_active")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name")
  ]);
  const data = headsResult.data;
  const error = headsResult.error?.message || rolesResult.error?.message || null;
  if (error) return { heads: [] as PaymentHeadRow[], roles: [] as RoleRow[], error };
  return {
    heads: ((data ?? []) as PaymentHeadRow[]).map((head) => ({
      ...head,
      payment_head_questions: activeQuestions(head.payment_head_questions)
    })),
    roles: (rolesResult.data ?? []) as RoleRow[],
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function PaymentHeadsPage({ searchParams }: { searchParams?: { edit?: string; error?: string; saved?: string } }) {
  const authorization = await requirePagePermission("master_payment_heads", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.master_payment_heads;
  const { heads, roles, error } = await loadPaymentHeads(companyId);
  const editHead = pagePermission.canEdit ? heads.find((head) => head.id === searchParams?.edit) ?? null : null;
  const roleOptions = roles.map((role) => ({ value: role.id, label: role.name, helper: role.code }));
  const roleById = new Map(roles.map((role) => [role.id, role]));

  return (
    <AppShell active="Payment Heads" pageCode="master_payment_heads">
      <PageHead
        eyebrow="Master Data"
        title="Payment Heads"
        subtitle="Maintain expense heads and custom request fields."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_requests_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {!editHead && searchParams?.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment head not saved</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{searchParams.error}</p>
          </div>
        </section>
      ) : null}

      {searchParams?.saved ? (
        <section className="panel message-panel success">
          <div className="panel-body">
            <strong>Payment head saved</strong>
          </div>
        </section>
      ) : null}

      {pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Add payment head</h2>
              <p className="subtle">Create reusable expense heads and the fields needed for requests.</p>
            </div>
          </div>
          <PaymentHeadForm action={createPaymentHead} roleOptions={roleOptions} />
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Payment head list</h2>
              <p className="subtle">{heads.length} records</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Payment Head</th>
                  <th>External ID</th>
                  <th>Initial Approver</th>
                  <th>Final Approval</th>
                  <th>Payment Process</th>
                  <th>Payment Methods</th>
                  <th>Expense Approval</th>
                  <th>Fields</th>
                  <th>File Upload</th>
                  <th>Status</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {heads.length ? heads.map((head) => {
                  const expenseFields = (head.payment_head_questions ?? []).filter((question) => questionStage(question) === "expense").length;
                  const paymentFields = (head.payment_head_questions ?? []).filter((question) => questionStage(question) === "payment").length;
                  return (
                    <tr key={head.id}>
                      <td><strong>{head.code}</strong></td>
                      <td>{head.name}</td>
                      <td>{head.external_id || "-"}</td>
                      <td>{configuredRoleIds(head.initial_approval_role_ids, head.initial_approval_role_id).map((roleId) => roleById.get(roleId)?.name).filter(Boolean).join(", ") || "-"}</td>
                      <td>{configuredRoleIds(head.final_approval_role_ids, head.final_approval_role_id).map((roleId) => roleById.get(roleId)?.name).filter(Boolean).join(", ") || "-"}</td>
                      <td>{(head.payment_process_role_ids ?? []).map((roleId) => roleById.get(roleId)?.name).filter(Boolean).join(", ") || "-"}</td>
                      <td>{normalizePaymentModes(head.supported_payment_modes).map(paymentModeLabel).join(", ")}</td>
                      <td>{head.request_expense_approval ? (head.expense_approval_threshold == null ? "All requests" : `Above Rs ${Number(head.expense_approval_threshold).toLocaleString("en-IN")}`) : "-"}</td>
                      <td>{expenseFields} expense / {paymentFields} payment</td>
                      <td>{head.payment_head_questions?.some((question) => question.answer_type === "file") ? "Configured" : "-"}</td>
                      <td><StatusPill status={head.is_active ? "Active" : "Inactive"} /></td>
                      {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/payment-heads?edit=${head.id}`} scroll={false}>Edit</PendingLink></td> : null}
                    </tr>
                  );
                }) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 12 : 11}>No payment heads added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {editHead ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit payment head">
            <div className="panel-head">
              <div>
                <h2>Edit payment head</h2>
                <p className="subtle">Existing requests keep their answers; new requests use the latest fields.</p>
              </div>
              <PendingLink className="icon-button" href="/master/payment-heads" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            {searchParams?.error ? (
              <section className="message-panel error" style={{ margin: "0 20px 16px" }}>
                <strong>Payment head not saved</strong>
                <p className="subtle" style={{ marginTop: 6 }}>{searchParams.error}</p>
              </section>
            ) : null}
            <PaymentHeadForm
              action={updatePaymentHead}
              initialHead={{
                id: editHead.id,
                code: editHead.code,
                name: editHead.name,
                external_id: editHead.external_id,
                initial_approval_role_id: editHead.initial_approval_role_id,
                initial_approval_role_ids: editHead.initial_approval_role_ids,
                final_approval_role_id: editHead.final_approval_role_id,
                final_approval_role_ids: editHead.final_approval_role_ids,
                payment_process_role_ids: editHead.payment_process_role_ids,
                requires_supporting_document: editHead.requires_supporting_document,
                request_expense_approval: editHead.request_expense_approval,
                expense_approval_threshold: editHead.expense_approval_threshold,
                is_active: editHead.is_active,
                questions: editHead.payment_head_questions ?? []
              }}
              roleOptions={roleOptions}
              submitLabel="Save changes"
            />
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
