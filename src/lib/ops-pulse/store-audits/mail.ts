import "server-only";
import { sendEmail } from "@/lib/email";
import { resolveStationAuditRecipients } from "../station-audit-recipients";
import { acquireStationAuditThread } from "../station-audit-thread";
import { db, proofs, type context } from "./server";
import { storeAuditPdf } from "./report";
import type { StoreAudit } from "./model";
import { auditCompletionSummary } from "./mail-summary";
/** Called only after a successful completion commit (or a manager's explicit resend). */
export async function notifyStoreAudit(
  c: Awaited<ReturnType<typeof context>>,
  a: StoreAudit,
) {
  if (
    !a.completed_at ||
    ["scheduled", "in_progress", "cancelled"].includes(a.status)
  )
    throw Error("An unfinished audit cannot be emailed to the store.");
  if (!c.master.settings.emailEnabled)
    return "Completion email is disabled in Store Audit Master.";
  const lock = await db()
    .from("ops_store_audits")
    .update({ email_lock_until: new Date(Date.now() + 180000).toISOString() })
    .eq("company_id", c.companyId)
    .eq("id", a.id)
    .or(
      `email_lock_until.is.null,email_lock_until.lt.${new Date().toISOString()}`,
    )
    .select("id")
    .maybeSingle();
  if (lock.error || !lock.data)
    return "Another completion email is in progress. Check delivery status before resending.";
  let thread: Awaited<ReturnType<typeof acquireStationAuditThread>> | undefined;
  try {
    const s = await db()
      .from("stations")
      .select(
        "id,station_code,station_email,station_manager_email,cluster_manager_email,ops_manager_email,finance_manager_email",
      )
      .eq("company_id", c.companyId)
      .eq("id", a.location_id)
      .single();
    if (s.error) throw Error(s.error.message);
    const recipients = await resolveStationAuditRecipients(
      c.companyId,
      s.data,
      ["station_email"],
      c.master.settings.ccRules,
      "store_audits",
    );
    if (!recipients.to.length)
      throw Error("No store email is configured in Location Master.");
    thread = await acquireStationAuditThread(
      c.companyId,
      a.location_id,
      s.data.station_code,
    );
    const url = `https://ops.dropxlogistics.com/store-audits?audit=${a.id}`;
    const summary = auditCompletionSummary(a, url);
    await sendEmail({
      companyId: c.companyId,
      to: recipients.to,
      cc: recipients.cc,
      subject: thread.subject,
      body: summary.text,
      html: summary.html,
      messageId: thread.messageId,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      attachments: [
        {
          filename: `${a.number}.pdf`,
          content: await storeAuditPdf(a, await proofs(c, a.id)),
          contentType: "application/pdf",
        },
      ],
    });
    await thread.finish(thread.messageId);
    await db()
      .from("ops_store_audits")
      .update({
        email_sent_at: new Date().toISOString(),
        email_error: null,
        email_recipients: [...recipients.to, ...recipients.cc],
        email_lock_until: null,
      })
      .eq("company_id", c.companyId)
      .eq("id", a.id);
    return "Report emailed to the store and configured stakeholders in the station audit thread.";
  } catch (e) {
    await thread?.release();
    const message = e instanceof Error ? e.message : "Email could not be sent.";
    await db()
      .from("ops_store_audits")
      .update({ email_error: message, email_lock_until: null })
      .eq("company_id", c.companyId)
      .eq("id", a.id);
    return `Audit saved; email needs attention: ${message}`;
  }
}
