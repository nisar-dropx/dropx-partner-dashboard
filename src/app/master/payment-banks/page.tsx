
import { ReportTable } from "@/components/report-table";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { createPaymentBank, updatePaymentBank } from "./actions";
import { PaymentBankForm } from "./payment-bank-form";

type PaymentBankRow = {
  id: string;
  bank_code: string;
  display_name: string;
  account_no: string;
  ifsc: string;
  is_active: boolean;
};

const bankOptions = [
  { value: "FEDERAL_BANK", label: "Federal Bank" }
];

async function loadPaymentBanks(companyId: string) {
  if (!supabaseAdmin) return { banks: [] as PaymentBankRow[], error: "Supabase service role key is not configured." };
  const { data, error } = await supabaseAdmin
    .from("payment_banks")
    .select("id, bank_code, display_name, account_no, ifsc, is_active")
    .eq("company_id", companyId)
    .order("display_name");
  if (error) return { banks: [] as PaymentBankRow[], error: error.message };
  return { banks: (data ?? []) as PaymentBankRow[], error: null };
}

function bankLabel(code: string) {
  return bankOptions.find((option) => option.value === code)?.label ?? code;
}

export const dynamic = "force-dynamic";

export default async function PaymentBanksPage({ searchParams }: { searchParams?: { edit?: string } }) {
  const authorization = await requirePagePermission("master_payment_banks", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.master_payment_banks;
  const { banks, error } = await loadPaymentBanks(companyId);
  const editBank = pagePermission.canEdit ? banks.find((bank) => bank.id === searchParams?.edit) ?? null : null;

  return (
    <AppShell active="Payment Banks" pageCode="master_payment_banks">
      <PageHead
        eyebrow="Master Data"
        title="Payment Banks"
        subtitle="Configure debit bank accounts for payment processing."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment bank setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_banks_v1.sql` in Supabase SQL Editor, then refresh.</p>
          </div>
        </section>
      ) : null}

      {pagePermission.canAdd ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Add bank</h2>
              <p className="subtle">Create the debit account used for payment upload files.</p>
            </div>
          </div>
          <PaymentBankForm action={createPaymentBank} bankOptions={bankOptions} />
        </section>
      ) : null}

      {!error && pagePermission.canView ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Bank list</h2>
              <p className="subtle">{banks.length} records</p>
            </div>
          </div>
          <div className="table-wrap">
            <ReportTable>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>Display name</th>
                  <th>Bank acc no</th>
                  <th>IFSC</th>
                  <th>Status</th>
                  {pagePermission.canEdit ? <th>Action</th> : null}
                </tr>
              </thead>
              <tbody>
                {banks.length ? banks.map((bank) => (
                  <tr key={bank.id}>
                    <td>{bankLabel(bank.bank_code)}</td>
                    <td><strong>{bank.display_name}</strong></td>
                    <td>{bank.account_no}</td>
                    <td>{bank.ifsc}</td>
                    <td><StatusPill status={bank.is_active ? "Active" : "Inactive"} /></td>
                    {pagePermission.canEdit ? <td><PendingLink className="button secondary compact" href={`/master/payment-banks?edit=${bank.id}`} scroll={false}>Edit</PendingLink></td> : null}
                  </tr>
                )) : (
                  <tr><td className="empty-cell" colSpan={pagePermission.canEdit ? 6 : 5}>No payment banks added yet.</td></tr>
                )}
              </tbody>
            </ReportTable>
          </div>
        </section>
      ) : null}

      {editBank ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit payment bank">
            <div className="panel-head">
              <div>
                <h2>Edit bank</h2>
                <p className="subtle">Update debit account settings.</p>
              </div>
              <PendingLink className="icon-button" href="/master/payment-banks" scroll={false} aria-label="Close">x</PendingLink>
            </div>
            <PaymentBankForm action={updatePaymentBank} bank={editBank} bankOptions={bankOptions} submitLabel="Save changes" />
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
