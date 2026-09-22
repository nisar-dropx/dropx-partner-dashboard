import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFinanceHostName } from "@/lib/finance/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { ReimbursementMaster, type MasterRow } from "./reimbursement-master";
import { PolicyDocument } from "./policy-document";
import "./reimbursements.css";

export const dynamic = "force-dynamic";

export default async function ReimbursementsPage() {
  if (
    !isFinanceHostName(
      headers().get("x-forwarded-host") ?? headers().get("host") ?? "",
    )
  )
    notFound();
  const auth = await requirePagePermission("master_payment_heads", "view");
  const companyId = requireCompanyId(auth);
  if (!supabaseAdmin) throw new Error("Finance database is unavailable.");
  const queries = [
    ["heads", "hr_expense_categories", "*"],
    ["limits", "finance_reimbursement_limits", "*"],
    [
      "documents",
      "finance_reimbursement_documents",
      "id,title,version_label,effective_from,is_current,uploaded_at",
    ],
    ["designations", "designations", "id,code,name,is_active"],
    ["approvers", "profiles", "id,full_name,is_active"],
    [
      "policies",
      "hr_expense_policies",
      "id,name,designation_id,location_id,payment_head_id,updated_at",
    ],
    [
      "paymentHeads",
      "payment_heads",
      "id,code,name,is_active,payment_process_role_ids",
    ],
  ];
  const entries = await Promise.all(
    queries.map(async ([key, table, select]) => {
      const rows: MasterRow[] = [];
      for (let offset = 0; ; offset += 1000) {
        const result = await supabaseAdmin!
          .from(table)
          .select(select)
          .eq("company_id", companyId)
          .order("id")
          .range(offset, offset + 999);
        if (result.error)
          throw new Error(`Unable to load reimbursement ${key}. Please retry.`);
        rows.push(...(result.data as unknown as MasterRow[]));
        if (result.data.length < 1000) break;
      }
      return [key, rows] as const;
    }),
  );
  const data = Object.fromEntries(entries);
  const writable =
    auth.hasAllLocationAccess && !auth.readOnly && !auth.isPreview;
  return (
    <AppShell active="Reimbursements" pageCode="master_payment_heads">
      <PageHead
        eyebrow="Finance · Master"
        title="Reimbursement heads & limits"
        subtitle="One source for DropX One requests, claims and policy exceptions. People supplies the employee designation; Finance controls the expense rules."
      />
      <PolicyDocument
        documents={data.documents ?? []}
        canAdd={writable && hasPermission(auth, "master_payment_heads", "add")}
        canEdit={
          writable && hasPermission(auth, "master_payment_heads", "edit")
        }
      />
      <ReimbursementMaster
        data={data}
        canAdd={writable && hasPermission(auth, "master_payment_heads", "add")}
        canEdit={
          writable && hasPermission(auth, "master_payment_heads", "edit")
        }
      />
    </AppShell>
  );
}
