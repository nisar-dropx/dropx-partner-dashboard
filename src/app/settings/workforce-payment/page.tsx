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
        title="Workforce & Helper Payment"
        subtitle="Configure shared payout rules, Workforce attendance capture, Helper payment setup, and payout notifications."
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
              <h3>Shared Payout Policy</h3>
              <p className="subtle">Configure attendance-based monthly pay and paid weekly-off rules used by both Workforce and Helpers.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/workforce-payment/attendance-capture">
            <div>
              <h3>Workforce Attendance Capture</h3>
              <p className="subtle">Choose biometric punches or a delivered-shipment threshold for Workforce attendance. Helpers continue to use biometric attendance.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/provider-mapping/direct-pay?audience=helpers&source=payment-settings">
            <div>
              <h3>Helper Payment Setup</h3>
              <p className="subtle">Assign Helpers to locations, designations, and effective-dated payment methods without opening Workforce provider mapping.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/workforce-payment/payout-notification">
            <div>
              <h3>Payout Notifications</h3>
              <p className="subtle">Enable DropX One App alerts and configure the approved WhatsApp template used for Workforce and Helper payouts.</p>
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
