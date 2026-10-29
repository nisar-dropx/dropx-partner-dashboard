import { FleetPaytapSettings } from "@/components/fleet-paytap-settings";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { WebhookSettingsPanel } from "@/components/webhook-settings-panel";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function loadFlash() {
  const raw = cookies().get("dropx_webhook_settings_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadWebhookVerifyToken(companyId: string) {
  if (!supabaseAdmin) return { token: "", error: "Supabase service role key is not configured." };
  const [company, messaging, leads, whatsApp] = await Promise.all([
    supabaseAdmin.from("companies").select("webhook_key").eq("id", companyId).maybeSingle(),
    supabaseAdmin.from("meta_messaging_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin.from("meta_leads_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle(),
    supabaseAdmin.from("whatsapp_settings").select("webhook_verify_token").eq("company_id", companyId).eq("id", true).maybeSingle()
  ]);
  const error = company.error?.message || messaging.error?.message || leads.error?.message || whatsApp.error?.message || null;
  return {
    webhookKey: company.data?.webhook_key ?? "",
    token: messaging.data?.webhook_verify_token ?? leads.data?.webhook_verify_token ?? whatsApp.data?.webhook_verify_token ?? "",
    error
  };
}

export default async function WebhookSettingsPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.app_settings;
  const flash = loadFlash();
  const data = await loadWebhookVerifyToken(companyId);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://dashboard.dropxlogistics.com").replace(/\/$/, "");
  const webhookUrl = data.webhookKey ? `${appUrl}/api/webhooks/${data.webhookKey}` : `${appUrl}/api/webhooks`;

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Configuration"
        title="Webhooks"
        subtitle="Messaging, lead events and PayTap fuel payments."
        action={<a className="button secondary" href="/settings">Back</a>}
      />
      {data.error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Webhook setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{data.error}</p>
          </div>
        </section>
      ) : null}
      {!data.error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}
      {!data.error ? (
        <WebhookSettingsPanel
          canEdit={permission.canEdit || permission.canAdd}
          webhookUrl={webhookUrl}
          webhookVerifyToken={data.token || data.webhookKey}
        />
      ) : null}
      <FleetPaytapSettings surface="dashboard" />
    </AppShell>
  );
}
