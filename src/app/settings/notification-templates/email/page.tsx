import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

async function loadBusinessDocumentTemplateStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false };
  const result = await supabaseAdmin
    .from("business_document_notification_templates")
    .select("is_enabled")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  return { isEnabled: Boolean(result.data?.is_enabled) };
}

async function loadFleetDocumentTemplateStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false };
  const result = await supabaseAdmin
    .from("fleet_document_notification_templates")
    .select("is_enabled")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  return { isEnabled: Boolean(result.data?.is_enabled) };
}

async function loadPaymentTemplateStatuses(companyId: string) {
  if (!supabaseAdmin) return new Map<string, boolean>();
  const result = await supabaseAdmin
    .from("payment_notification_templates")
    .select("event_type, is_enabled")
    .eq("company_id", companyId);
  if (result.error) return new Map<string, boolean>();
  return new Map((result.data ?? []).map((row) => [String(row.event_type), Boolean(row.is_enabled)]));
}

export default async function EmailNotificationTemplatesPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const [businessDocumentStatus, fleetDocumentStatus, paymentStatuses] = await Promise.all([
    loadBusinessDocumentTemplateStatus(companyId),
    loadFleetDocumentTemplateStatus(companyId),
    loadPaymentTemplateStatuses(companyId)
  ]);
  const emailItems = [
    {
      href: "/settings/notification-templates/business-documents",
      name: "Business document notifications",
      purpose: "Expiry reminders for business documents",
      schedule: "30, 15, 7, 1 day, expiry day, every 7 days after expiry",
      recipients: "Compliance manager, location email, location manager",
      enabled: businessDocumentStatus.isEnabled
    },
    {
      href: "/settings/notification-templates/fleet-documents",
      name: "Fleet document notifications",
      purpose: "Expiry reminders for fleet documents",
      schedule: "30, 15, 7, 1 day, expiry day, every 7 days after expiry",
      recipients: "Fleet manager, location email, location manager",
      enabled: fleetDocumentStatus.isEnabled
    },
    {
      href: "/settings/notification-templates/payments/request",
      name: "Payment Request",
      purpose: "Email when a payment request is submitted",
      schedule: "On request submission",
      recipients: "Requester, location manager, final approver, payment processor",
      enabled: Boolean(paymentStatuses.get("payment_request"))
    },
    {
      href: "/settings/notification-templates/payments/return",
      name: "Payment Return",
      purpose: "Email when a payment request is returned",
      schedule: "On return",
      recipients: "Requester, location manager, current approver, final approver, payment processor",
      enabled: Boolean(paymentStatuses.get("payment_return"))
    },
    {
      href: "/settings/notification-templates/payments/approve",
      name: "Payment Approve",
      purpose: "Email when a payment request is approved",
      schedule: "On approval",
      recipients: "Requester, location manager, current approver, final approver, payment processor",
      enabled: Boolean(paymentStatuses.get("payment_approve"))
    },
    {
      href: "/settings/notification-templates/payments/reject",
      name: "Payment Reject",
      purpose: "Email when a payment request is rejected",
      schedule: "On reject",
      recipients: "Requester, location manager, current approver, final approver, payment processor",
      enabled: Boolean(paymentStatuses.get("payment_reject"))
    }
  ];
  const enabledCount = emailItems.filter((item) => item.enabled).length;

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Notification Templates"
        title="Email Notifications"
        subtitle="Configure each automated email notification template."
        action={(
          <div className="page-actions">
            {hasPermission(authorization, "mail_health", "view") && <a className="button secondary" href="/notifications/mail-health">Mail Health</a>}
            <a className="button secondary" href="/settings/notification-templates/email/config">Email Config</a>
            <a className="button secondary" href="/settings/notification-templates">Back</a>
          </div>
        )}
      />

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>Email notification templates</h2>
            <p className="subtle">{emailItems.length} template{emailItems.length === 1 ? "" : "s"} configured</p>
          </div>
          <span className="status-pill">{enabledCount} enabled</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Notification</th>
                <th>Trigger</th>
                <th>Recipients</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {emailItems.map((item) => (
                <tr key={item.href}>
                  <td>
                    <strong>{item.name}</strong>
                    <div className="subtle">{item.purpose}</div>
                  </td>
                  <td>{item.schedule}</td>
                  <td>{item.recipients}</td>
                  <td>{item.enabled ? <span className="status-pill good">Enabled</span> : <span className="status-pill warn">Disabled</span>}</td>
                  <td><PendingLink className="button secondary compact" href={item.href}>Manage</PendingLink></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppShell>
  );
}
