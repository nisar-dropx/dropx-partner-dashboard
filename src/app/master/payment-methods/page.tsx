import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PaymentMethodForm } from "@/components/payment-method-form";
import { PaymentFieldForm } from "@/components/payment-field-form";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createPaymentField, createPaymentMethod, deletePaymentField, deletePaymentMethod, updatePaymentField, updatePaymentMethod } from "./actions";
import { cookies } from "next/headers";
import type { PaymentCalculationSource, PaymentCalculationType } from "@/lib/payment-calculation";

type PaymentComponentRow = {
  id: string;
  payment_field_id: string | null;
  component_code: string;
  component_type: "amount" | "production";
  label: string;
  pay_schedule: "per_hour" | "per_day" | "per_month" | null;
  sort_order: number;
  is_active: boolean;
};

type PaymentFieldRow = {
  id: string;
  code: string;
  field_type: "amount" | "production";
  label: string;
  pay_schedule: "per_hour" | "per_day" | "per_month" | null;
  calculation_type: PaymentCalculationType;
  calculation_source: PaymentCalculationSource | null;
  is_active: boolean;
  usage_count: number;
};

type PaymentMethodRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
  payment_method_components?: PaymentComponentRow[] | null;
  usage_count: number;
};

async function loadPaymentMethods(companyId: string) {
  if (!supabaseAdmin) {
    return {
      methods: [] as PaymentMethodRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const { data, error } = await supabaseAdmin
    .from("payment_methods")
    .select(`
      id,
      code,
      name,
      is_active,
      payment_method_components (
        id,
        payment_field_id,
        component_code,
        component_type,
        label,
        pay_schedule,
        sort_order,
        is_active
      )
    `)
    .eq("company_id", companyId)
    .order("code");

  if (error) return { methods: [] as PaymentMethodRow[], error: error.message };

  const usageResult = await supabaseAdmin
    .from("field_executive_provider_mappings")
    .select("payment_method_id")
    .eq("company_id", companyId);
  if (usageResult.error) return { methods: [] as PaymentMethodRow[], error: usageResult.error.message };

  const usageByMethod = new Map<string, number>();
  (usageResult.data ?? []).forEach((mapping) => {
    if (!mapping.payment_method_id) return;
    usageByMethod.set(mapping.payment_method_id, (usageByMethod.get(mapping.payment_method_id) ?? 0) + 1);
  });

  return {
    methods: ((data ?? []) as Omit<PaymentMethodRow, "usage_count">[]).map((method) => ({
      ...method,
      usage_count: usageByMethod.get(method.id) ?? 0,
      payment_method_components: (method.payment_method_components ?? [])
        .slice()
        .sort((first, second) => first.sort_order - second.sort_order)
    })),
    error: null
  };
}

async function loadPaymentFields(companyId: string) {
  if (!supabaseAdmin) return { fields: [] as PaymentFieldRow[], error: "Supabase service role key is not configured." };
  const fieldsResult = await supabaseAdmin.from("payment_fields")
    .select("id, code, field_type, label, pay_schedule, calculation_type, calculation_source, is_active")
    .eq("company_id", companyId).order("code");
  if (fieldsResult.error) return { fields: [] as PaymentFieldRow[], error: fieldsResult.error.message };
  const usageResult = await supabaseAdmin.from("payment_method_components")
    .select("payment_field_id").eq("company_id", companyId).not("payment_field_id", "is", null);
  if (usageResult.error) return { fields: [] as PaymentFieldRow[], error: usageResult.error.message };
  const usage = new Map<string, number>();
  (usageResult.data ?? []).forEach((row) => usage.set(String(row.payment_field_id), (usage.get(String(row.payment_field_id)) ?? 0) + 1));
  return { fields: ((fieldsResult.data ?? []) as Omit<PaymentFieldRow, "usage_count">[]).map((field) => ({ ...field, usage_count: usage.get(field.id) ?? 0 })), error: null };
}

function loadPaymentMethodFlash() {
  const raw = cookies().get("dropx_payment_method_flash")?.value;
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

export const dynamic = "force-dynamic";

export default async function PaymentMethodsPage({ searchParams }: { searchParams?: { edit?: string; fields?: string } }) {
  const authorization = await requirePagePermission("payment_methods", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.payment_methods;
  const { methods, error } = await loadPaymentMethods(companyId);
  const { fields, error: fieldsError } = await loadPaymentFields(companyId);
  const flash = loadPaymentMethodFlash();
  const editMethod = methods.find((method) => method.id === searchParams?.edit) ?? null;

  return (
    <AppShell active="Payment Methods" pageCode="payment_methods">
      <PageHead
        eyebrow="Master Data"
        title="Payment methods"
        subtitle="Define the payment method and the exact fields managers must fill during Provider ID mapping."
        action={<div className="page-head-actions"><PendingLink className="button secondary" href="/master/payment-methods?fields=1" scroll={false}>Payment Fields</PendingLink><span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span></div>}
      />

      {error || fieldsError ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error ?? fieldsError} Run `scripts/payment_fields_master_v2.sql` in Supabase SQL Editor, then refresh this page.
            </p>
          </div>
        </section>
      ) : null}

      {!error && !fieldsError && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Payment method not deleted" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error && !fieldsError && pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Add payment method</h2>
              <p className="subtle">Example: Per Packet with Production fields named Delivery rate and Pickup rate.</p>
            </div>
          </div>
          <PaymentMethodForm action={createPaymentMethod} availableFields={fields.filter((field) => field.is_active)} />
        </section>
      ) : null}

      {!error && !fieldsError && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Payment method list</h2>
              <p className="subtle">{methods.length} records. Components decide which fields appear in mapping later.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Method ID</th>
                  <th>Name</th>
                  <th>Configured fields</th>
                  <th>Status</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {methods.length ? methods.map((method) => (
                  <tr key={method.id}>
                    <td><strong>{method.code}</strong></td>
                    <td>{method.name}</td>
                    <td>
                      <div className="component-chip-list">
                        {(method.payment_method_components ?? []).length ? method.payment_method_components?.map((component) => (
                          <span className={`component-chip ${component.component_type}`} key={component.id}>
                            {component.label}
                            <small>
                              {component.component_code} | {component.component_type === "amount" ? "Amount" : "Production"}
                              {component.pay_schedule ? ` | ${component.pay_schedule === "per_hour" ? "Per Hour" : component.pay_schedule === "per_day" ? "Per Day" : "Per Month"}` : ""}
                            </small>
                          </span>
                        )) : <span className="subtle">No fields configured</span>}
                      </div>
                    </td>
                    <td><StatusPill status={method.is_active ? "Active" : "Inactive"} /></td>
                    {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/payment-methods?edit=${method.id}`} scroll={false}>Edit</PendingLink></td> : null}
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 5 : 4}>No payment methods added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {editMethod && pagePermission.canEdit ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit payment method">
            <div className="panel-head">
              <div><h2>Edit payment method</h2><p className="subtle">Update the method and its configured payment fields.</p></div>
              <PendingLink className="icon-button" href="/master/payment-methods" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <PaymentMethodForm
              action={updatePaymentMethod}
              availableFields={fields.filter((field) => field.is_active)}
              initialMethod={{
                id: editMethod.id,
                code: editMethod.code,
                name: editMethod.name,
                components: editMethod.payment_method_components ?? []
              }}
              submitLabel="Save changes"
            />
            <form action={deletePaymentMethod} className="danger-form">
              <input type="hidden" name="id" value={editMethod.id} />
              <SubmitButton
                className="button warning"
                confirmationBlocked={editMethod.usage_count > 0}
                confirmMessage={editMethod.usage_count > 0
                  ? `This payment method is used in ${editMethod.usage_count} mapping${editMethod.usage_count === 1 ? "" : "s"} and cannot be deleted.`
                  : "Delete this payment method? This action cannot be undone."}
                pendingText="Deleting"
              >Delete payment method</SubmitButton>
            </form>
          </section>
        </div>
      ) : null}

      {searchParams?.fields === "1" ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide payment-fields-modal" aria-label="Payment fields">
            <div className="panel-head">
              <div><h2>Payment Fields</h2><p className="subtle">Create reusable fields and map each one to a normalized shipment, attendance, or performance source.</p></div>
              <PendingLink className="icon-button" href="/master/payment-methods" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            {pagePermission.canAdd ? <div className="payment-field-create"><div className="payment-field-create-head"><h3>Add payment field</h3><p className="subtle">Create the field once, then reuse it in any payment method.</p></div><PaymentFieldForm action={createPaymentField} submitLabel="Add field" /></div> : null}
            <div className="payment-field-master-list">
              {fields.length ? fields.map((field) => (
                <div className="payment-field-master-row" key={field.id}>
                  {pagePermission.canEdit ? <PaymentFieldForm action={updatePaymentField} initialField={field} submitLabel="Save" /> : <div><strong>{field.label}</strong><small>{field.code}</small></div>}
                  <div className="payment-field-row-footer">
                    <span className="payment-field-usage">Used in {field.usage_count} payment method{field.usage_count === 1 ? "" : "s"}</span>
                    {pagePermission.canEdit ? <form action={deletePaymentField}><input name="field_id" type="hidden" value={field.id} /><SubmitButton className="button warning compact" confirmationBlocked={field.usage_count > 0} confirmMessage={field.usage_count > 0 ? "Remove this field from every payment method before deleting it." : "Delete this payment field?"}>Delete</SubmitButton></form> : null}
                  </div>
                </div>
              )) : <p className="empty-cell">No payment fields created yet.</p>}
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
