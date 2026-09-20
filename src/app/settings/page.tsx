import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

async function loadWhatsAppStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false, isConfigured: false };
  const settings = await supabaseAdmin
    .from("whatsapp_settings")
    .select("is_enabled")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  const profiles = await supabaseAdmin
    .from("whatsapp_profiles")
    .select("business_account_id, phone_number_id, token_secret_id")
    .eq("company_id", companyId)
    .eq("is_active", true);
  const isConfigured = (profiles.data ?? []).some((profile) => profile.business_account_id && profile.phone_number_id && profile.token_secret_id);
  return {
    isEnabled: Boolean(settings.data?.is_enabled),
    isConfigured
  };
}

async function loadWheelseyeStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false, isConfigured: false };
  const settings = await supabaseAdmin
    .from("wheelseye_settings")
    .select("is_enabled, token_secret_id")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (settings.error) return { isEnabled: false, isConfigured: false };
  return {
    isEnabled: Boolean(settings.data?.is_enabled),
    isConfigured: Boolean(settings.data?.token_secret_id)
  };
}

async function loadMetaMessagingStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false, isConfigured: false };
  const profiles = await supabaseAdmin
    .from("meta_channel_profiles")
    .select("channel, access_token_secret_id, is_active")
    .eq("company_id", companyId)
    .eq("is_active", true);
  if (profiles.error) return { isEnabled: false, isConfigured: false };
  const activeProfiles = profiles.data ?? [];
  return {
    isEnabled: activeProfiles.length > 0,
    isConfigured: activeProfiles.some((profile) => Boolean(profile.access_token_secret_id))
  };
}

async function loadMetaLeadsStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false, isConfigured: false };
  const settings = await supabaseAdmin
    .from("meta_leads_settings")
    .select("is_enabled, meta_app_id, page_id, ad_account_id, access_token_secret_id")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (settings.error) return { isEnabled: false, isConfigured: false };
  return {
    isEnabled: Boolean(settings.data?.is_enabled),
    isConfigured: Boolean(settings.data?.meta_app_id && settings.data?.page_id && settings.data?.ad_account_id && settings.data?.access_token_secret_id)
  };
}

async function loadWebhookStatus(companyId: string) {
  if (!supabaseAdmin) return { isConfigured: false };
  const [messaging, leads, whatsApp] = await Promise.all([
    supabaseAdmin.from("meta_messaging_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin.from("meta_leads_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin.from("whatsapp_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle()
  ]);
  return {
    isConfigured: Boolean(
      messaging.data?.webhook_verify_token ||
      leads.data?.webhook_verify_token ||
      whatsApp.data?.webhook_verify_token
    )
  };
}

async function loadVerificationApiStatus(companyId: string) {
  if (!supabaseAdmin) return { isConfigured: false };
  const { data, error } = await supabaseAdmin
    .from("verification_api_settings")
    .select("api_id, api_key_secret_id, token_id_secret_id")
    .eq("company_id", companyId)
    .eq("provider_code", "idspay")
    .maybeSingle();
  if (error) return { isConfigured: false };
  return { isConfigured: Boolean(data?.api_id && data?.api_key_secret_id && data?.token_id_secret_id) };
}

async function loadDomainStatus(companyId: string) {
  if (!supabaseAdmin) return { isEnabled: false };
  const { data, error } = await supabaseAdmin
    .from("company_allowed_domains")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .limit(1);
  if (error) return { isEnabled: false };
  return { isEnabled: Boolean(data?.length) };
}

export default async function SettingsPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const canManageAmazonConnectors = isCompanyOwner(authorization);
  const [whatsAppStatus, wheelseyeStatus, metaStatus, metaLeadsStatus, domainStatus, verificationApiStatus] = await Promise.all([
    loadWhatsAppStatus(companyId),
    loadWheelseyeStatus(companyId),
    loadMetaMessagingStatus(companyId),
    loadMetaLeadsStatus(companyId),
    loadDomainStatus(companyId),
    loadVerificationApiStatus(companyId)
  ]);
  const metaMessagingStatus = {
    isEnabled: whatsAppStatus.isEnabled || metaStatus.isEnabled,
    isConfigured: whatsAppStatus.isConfigured || metaStatus.isConfigured
  };

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Configuration"
        title="Settings"
        subtitle="Central place for application-level configurations such as WhatsApp, bank files, notifications, and system defaults."
      />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Configuration areas</h2>
            <p className="subtle">These modules will be enabled one by one as the related workflow is built.</p>
          </div>
        </div>
        <div className="settings-grid">
          <PendingLink className="settings-tile actionable" href="/settings/webhook">
            <div>
              <h3>Webhook</h3>
              <p className="subtle">One callback URL and verify token for external platform events.</p>
            </div>
          </PendingLink>
          <div className="settings-tile">
            <div>
              <h3>Bank File</h3>
              <p className="subtle">Salary export formats, bank file naming, and payout rules.</p>
            </div>
          </div>
          <PendingLink className="settings-tile actionable" href="/settings/domains">
            <div>
              <h3>Login Domains</h3>
              <p className="subtle">Optional email domain allowlist for company login.</p>
            </div>
            {domainStatus.isEnabled ? <span className="status-pill good">Enabled</span> : null}
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/wheelseye">
            <div>
              <h3>Wheelseye Config</h3>
              <p className="subtle">Live GPS provider access token and Fleet tracking switch.</p>
            </div>
            {wheelseyeStatus.isEnabled ? <span className="status-pill good">Enabled</span> : null}
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/messaging">
            <div>
              <h3>Messaging</h3>
              <p className="subtle">Common webhook and messaging platform settings.</p>
            </div>
            {metaMessagingStatus.isEnabled ? <span className="status-pill good">Enabled</span> : null}
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/ads-leads">
            <div>
              <h3>Ads & Leads Config</h3>
              <p className="subtle">Lead webhooks, ad account access, and ad platform settings.</p>
            </div>
            {metaLeadsStatus.isEnabled ? <span className="status-pill good">Enabled</span> : null}
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/notification-templates">
            <div>
              <h3>Notification Templates</h3>
              <p className="subtle">Email templates for business document expiry and future workflow reminders.</p>
            </div>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/app-notifications">
            <div>
              <h3>App Notification</h3>
              <p className="subtle">Choose which automatic events notify DropX One users.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          {canManageAmazonConnectors ? (
            <PendingLink className="settings-tile actionable" href="/settings/amazon">
              <div>
                <h3>Amazon Connector</h3>
                <p className="subtle">Owner-only access for YMS, LSC, and SCC portal automation.</p>
              </div>
            </PendingLink>
          ) : null}
          <PendingLink className="settings-tile actionable" href="/settings/payments">
            <div>
              <h3>Payment Settings</h3>
              <p className="subtle">Approval flow for location expense payment requests.</p>
            </div>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/payment-approvals">
            <div>
              <h3>Payment Approval Steps</h3>
              <p className="subtle">Configure the ordered approval chain per payment head.</p>
            </div>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/dropx-id-generation?type=dropx_id">
            <div>
              <h3>DropX ID Generation</h3>
              <p className="subtle">Configure the Employee ID and Field Executive ID series.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="status-pill good">Enabled</span>
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/dropx-id-generation?type=biometric_id">
            <div>
              <h3>Biometric ID Generation</h3>
              <p className="subtle">Configure the biometric enrolment ID series.</p>
            </div>
            <span className="settings-tile-actions">
              <span className="status-pill good">Enabled</span>
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <PendingLink className="settings-tile actionable" href="/settings/verification-apis">
            <div>
              <h3>Verification APIs</h3>
              <p className="subtle">Provider credentials for identity and document verification services.</p>
            </div>
            <span className="settings-tile-actions">
              {verificationApiStatus.isConfigured ? <span className="status-pill good">Configured</span> : null}
              <span className="button secondary compact">Configure</span>
            </span>
          </PendingLink>
          <div className="settings-tile">
            <div>
              <h3>System Defaults</h3>
              <p className="subtle">Default month close, report import, and operational settings.</p>
            </div>
          </div>
        </div>
      </section>
    </AppShell>
  );
}
