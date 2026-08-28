import "server-only";

import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function notifyReimbursementPayment(input: { companyId: string; paymentRequestId: string; status: string; remarks?: string | null; actorUserId?: string | null }) {
  if (!supabaseAdmin) return;
  const payment = await supabaseAdmin.from("payment_requests").select("request_no,source_type,source_id,utr_cin,bank_status").eq("company_id", input.companyId).eq("id", input.paymentRequestId).maybeSingle();
  if (payment.error || payment.data?.source_type !== "employee_reimbursement" || !payment.data.source_id) return;
  const claim = await supabaseAdmin.from("hr_expense_claims").select("id,claim_no,claimant_user_id,employee_id,contractor_id").eq("company_id", input.companyId).eq("id", payment.data.source_id).maybeSingle();
  if (claim.error || !claim.data) return;
  const profile = claim.data.claimant_user_id ? await supabaseAdmin.from("profiles").select("id,email").eq("company_id", input.companyId).eq("id", claim.data.claimant_user_id).maybeSingle() : { data: null, error: null };
  const title = input.status === "paid" ? "Reimbursement paid" : input.status === "processing" ? "Reimbursement is processing" : input.status === "returned" ? "Reimbursement payment returned" : "Reimbursement payment rejected";
  const reference = payment.data.utr_cin ? ` UTR/CIN: ${payment.data.utr_cin}.` : "";
  const body = `${claim.data.claim_no} · ${title}.${reference}${input.remarks ? ` ${input.remarks}` : ""}`;
  const actor = input.actorUserId ? await supabaseAdmin.from("profiles").select("full_name,role").eq("company_id", input.companyId).eq("id", input.actorUserId).maybeSingle() : { data: null, error: null };
  if (input.actorUserId) {
    await supabaseAdmin.from("hr_expense_events").insert({
      company_id: input.companyId,
      claim_id: claim.data.id,
      event_type: `finance_${input.status}`,
      actor_user_id: input.actorUserId,
      actor_name: actor.data?.full_name ?? "Finance processor",
      actor_role: actor.data?.role ? String(actor.data.role) : "Payments",
      comments: input.remarks ?? title,
      metadata: { payment_request_id: input.paymentRequestId, utr_cin: payment.data.utr_cin, bank_status: payment.data.bank_status }
    });
  }
  const recipients: Array<{ type: string; id: string }> = [];
  if (claim.data.employee_id) recipients.push({ type: "employee", id: claim.data.employee_id });
  if (claim.data.contractor_id) recipients.push({ type: "contractor", id: claim.data.contractor_id });
  for (const recipient of recipients) {
    await supabaseAdmin.from("mob_app_notifications").upsert({ company_id: input.companyId, event_code: `reimbursement_payment_${input.status}`, source_key: `${claim.data.id}:${input.status}:${payment.data.utr_cin ?? ""}`, recipient_profile_type: recipient.type, recipient_account_id: recipient.id, title, body, route: "reimbursements", data: { claimId: claim.data.id, paymentRequestId: input.paymentRequestId } }, { onConflict: "company_id,event_code,source_key,recipient_account_id", ignoreDuplicates: true });
  }
  if (profile.data?.email) {
    try { await sendEmail({ companyId: input.companyId, to: [profile.data.email], subject: `${title} · ${claim.data.claim_no}`, body }); } catch { /* Payment completion is authoritative even when SMTP is temporarily unavailable. */ }
  }
}
