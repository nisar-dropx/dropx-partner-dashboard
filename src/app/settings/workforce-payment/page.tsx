import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { requirePagePermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

export default async function WorkforcePaymentSettingsHubPage() {
  await requirePagePermission("payment_settings", "access");

  return (
    <AppShell active="Settings" pageCode="payment_settings">
      <PageHead
        eyebrow="Configuration"
        title="Workforce Payment"
        subtitle="Choose how attendance is captured and how monthly workforce payouts account for paid weekly offs."
        action={<PendingLink className="button secondary" href="/settings">Back</PendingLink>}
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Configuration areas</h2>
            <p className="subtle">Open a setting to review its effective-dated policy and make permitted changes.</p>
          </div>
        </div>
        <div className="settings-grid">
          <PendingLink className="settings-tile actionable" href="/settings/workforce-payment/payout-method">
            <div>
              <h3>Payout Method</h3>
              <p className="subtle">Configure attendance-based monthly pay and paid weekly-off rules.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/workforce-payment/attendance-capture">
            <div>
              <h3>Attendance Capture</h3>
              <p className="subtle">Choose biometric punches or a minimum delivered-shipment threshold for daily attendance.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/workforce-payment/payout-notification">
            <div>
              <h3>Payout WhatsApp Notification</h3>
              <p className="subtle">Select an approved template, map its payout variables, and sync templates directly from Meta.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
        </div>
      </section>
    </AppShell>
  );
}
