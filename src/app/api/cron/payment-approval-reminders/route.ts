import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { sendPaymentApprovalReminder } from "@/lib/payment-email-notifications";
import { sendPaymentAdvanceReminder } from "@/lib/payment-advance-email-notifications";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";
import { isPendingPaymentApproval } from "@/lib/payment-stage-policy";

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
  return processReminders(request, false);
}

// Explicit authenticated one-off catch-up, never part of the regular cron URL.
export async function POST(request: Request) {
  return processReminders(request, true);
}

async function processReminders(request: Request, catchUp: boolean) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return unauthorized();
  if (secret) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return unauthorized();
  }
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "Payment reminders run on OpsPulse only" });
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const [paymentDue, advanceDue] = await Promise.all([
    supabaseAdmin.from("payment_requests").select("id, company_id, status, approval_status")
      .not("current_approver_user_id", "is", null)
      .not("status", "in", "(approved,processed,processing,returned,rejected,cancelled)")
      .or(`email_next_reminder_at.is.null,email_next_reminder_at.lte.${new Date().toISOString()}`)
      .order("email_next_reminder_at", { ascending: true, nullsFirst: true }).limit(200),
    supabaseAdmin.from("payment_advance_requests").select("id, company_id").not("email_next_reminder_at", "is", null).lte("email_next_reminder_at", new Date().toISOString()).limit(20)
  ]);
  if (paymentDue.error || advanceDue.error) {
    return NextResponse.json({ error: paymentDue.error?.message ?? advanceDue.error?.message }, { status: 500 });
  }

  // Interleave the two tables (rather than draining payment_requests before
  // ever starting payment_advance_requests) so a large batch on one table
  // can never starve the other within this function's time budget - if the
  // budget runs out, both tables have made partial progress, not just one.
  const queue: Array<{ kind: "payment" | "advance"; companyId: string; requestId: string }> = [];
  const payments = (paymentDue.data ?? []).filter(row => isPendingPaymentApproval(row.status, row.approval_status));
  const advances = catchUp ? [] : advanceDue.data ?? [];
  const maxLength = Math.max(payments.length, advances.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (payments[index]) queue.push({ kind: "payment", companyId: payments[index].company_id, requestId: payments[index].id });
    if (advances[index]) queue.push({ kind: "advance", companyId: advances[index].company_id, requestId: advances[index].id });
  }

  let sent = 0;
  let skipped = 0;
  const results: { requestId: string; sent: boolean; reason?: string }[] = [];
  const deadline = Date.now() + 45_000; // Leave headroom under maxDuration for the response itself.
  for (const item of queue) {
    if (Date.now() > deadline) break;
    const result = item.kind === "payment"
      ? await sendPaymentApprovalReminder(item.companyId, item.requestId, { catchUp })
      : await sendPaymentAdvanceReminder(item.companyId, item.requestId);
    if (result.sent) sent += 1; else skipped += 1;
    results.push({ requestId: item.requestId, sent: result.sent, ...(!result.sent ? { reason: result.reason } : {}) });
  }

  console.info("Payment reminders completed", JSON.stringify({ sent, skipped, queued: queue.length, catchUp, results }));
  return NextResponse.json({ sent, skipped, queued: queue.length, total: payments.length + advances.length, results });
}
