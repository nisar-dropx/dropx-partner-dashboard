import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendPaymentApprovalReminder } from "@/lib/payment-email-notifications";
import { sendPaymentAdvanceReminder } from "@/lib/payment-advance-email-notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Fires the 90-minute reminder for any payment (advance) request still
 * awaiting a decision, threaded onto the same email conversation as the
 * initial email - never a fresh, separate message. Each request's own
 * email_next_reminder_at column (set by sendPaymentNotification /
 * sendPaymentAdvanceRequestNotification after every send) is the schedule;
 * this cron only polls for rows whose time has passed.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const [paymentDue, advanceDue] = await Promise.all([
    supabaseAdmin.from("payment_requests").select("id, company_id").not("email_next_reminder_at", "is", null).lte("email_next_reminder_at", new Date().toISOString()).limit(50),
    supabaseAdmin.from("payment_advance_requests").select("id, company_id").not("email_next_reminder_at", "is", null).lte("email_next_reminder_at", new Date().toISOString()).limit(50)
  ]);
  if (paymentDue.error || advanceDue.error) {
    return NextResponse.json({ error: paymentDue.error?.message ?? advanceDue.error?.message }, { status: 500 });
  }

  let sent = 0;
  let skipped = 0;
  for (const row of paymentDue.data ?? []) {
    const result = await sendPaymentApprovalReminder(row.company_id, row.id);
    if (result.sent) sent += 1; else skipped += 1;
  }
  for (const row of advanceDue.data ?? []) {
    const result = await sendPaymentAdvanceReminder(row.company_id, row.id);
    if (result.sent) sent += 1; else skipped += 1;
  }

  return NextResponse.json({ sent, skipped, total: (paymentDue.data?.length ?? 0) + (advanceDue.data?.length ?? 0) });
}
