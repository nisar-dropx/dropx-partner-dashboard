"use client";

import { useMemo, useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import {
  extractWhatsAppTemplateVariables,
  type WhatsAppTemplateComponent
} from "@/lib/whatsapp-template";
import { WORKFORCE_PAYOUT_WHATSAPP_FIELDS } from "@/lib/workforce-payout-whatsapp";
import {
  saveWorkforcePayoutWhatsAppConfiguration,
  syncWorkforcePayoutWhatsAppTemplates
} from "./actions";

export type PayoutNotificationProfile = {
  id: string;
  profile_name: string;
  is_default: boolean;
  default_country_code: string;
};

export type PayoutNotificationTemplate = {
  template_id: string;
  whatsapp_profile_id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: WhatsAppTemplateComponent[];
  synced_at?: string | null;
};

export type PayoutNotificationConfig = {
  app_notification_enabled: boolean;
  is_enabled: boolean;
  whatsapp_profile_id: string | null;
  template_id: string | null;
  template_name: string | null;
  template_language: string | null;
  variable_mappings: Record<string, string>;
};

function templatePreview(components: WhatsAppTemplateComponent[], mappings: Record<string, string>) {
  const fieldLabels = new Map(WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => [field.value, field.label]));
  return components
    .filter((component) => ["HEADER", "BODY", "FOOTER"].includes(String(component.type ?? "").toUpperCase()) && component.text)
    .map((component) => String(component.text).replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
      const key = `${String(component.type).toLowerCase()}.${position}`;
      return `[${fieldLabels.get(mappings[key] as typeof WORKFORCE_PAYOUT_WHATSAPP_FIELDS[number]["value"]) ?? `variable ${position}`}]`;
    }))
    .join("\n\n");
}

function templateButtonPreviews(components: WhatsAppTemplateComponent[], mappings: Record<string, string>) {
  const fieldLabels = new Map(WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => [field.value, field.label]));
  return components
    .filter((component) => String(component.type ?? "").toUpperCase() === "BUTTONS")
    .flatMap((component) => (component.buttons ?? []).map((button, buttonIndex) => ({ button, buttonIndex })))
    .filter(({ button }) => String(button.type ?? "").toUpperCase() === "URL")
    .map(({ button, buttonIndex }) => ({
      label: button.text || "Open link",
      url: String(button.url ?? "").replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
        const source = mappings[`button.${buttonIndex}.${position}`];
        return `[${fieldLabels.get(source as typeof WORKFORCE_PAYOUT_WHATSAPP_FIELDS[number]["value"]) ?? `variable ${position}`}]`;
      })
    }));
}

export function WorkforcePayoutNotificationForm({
  canEdit,
  globalWhatsAppEnabled,
  profiles,
  templates: initialTemplates,
  config
}: {
  canEdit: boolean;
  globalWhatsAppEnabled: boolean;
  profiles: PayoutNotificationProfile[];
  templates: PayoutNotificationTemplate[];
  config: PayoutNotificationConfig;
}) {
  const defaultProfileId = config.whatsapp_profile_id || profiles.find((profile) => profile.is_default)?.id || profiles[0]?.id || "";
  const [appNotificationEnabled, setAppNotificationEnabled] = useState(config.app_notification_enabled);
  const [enabled, setEnabled] = useState(config.is_enabled);
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [templateId, setTemplateId] = useState(config.template_id ?? "");
  const [mappings, setMappings] = useState<Record<string, string>>(config.variable_mappings ?? {});
  const [templates, setTemplates] = useState(initialTemplates);
  const [syncMessage, setSyncMessage] = useState<{ error?: string; notice?: string }>({});
  const [syncing, setSyncing] = useState(false);

  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: `${profile.profile_name}${profile.is_default ? " · Default" : ""}`,
    helper: `Country code +${profile.default_country_code}`
  }));
  const selectedProfileTemplates = useMemo(
    () => templates.filter((template) => template.whatsapp_profile_id === profileId && template.status === "APPROVED"),
    [profileId, templates]
  );
  const templateOptions = selectedProfileTemplates.map((template) => ({
    value: template.template_id,
    label: `${template.name} · ${template.language}`,
    helper: template.category ?? "Approved template"
  }));
  const selectedTemplate = selectedProfileTemplates.find((template) => template.template_id === templateId) ?? null;
  const variables = selectedTemplate ? extractWhatsAppTemplateVariables(selectedTemplate.components) : [];
  const preview = selectedTemplate ? templatePreview(selectedTemplate.components, mappings) : "";
  const previewButtons = selectedTemplate ? templateButtonPreviews(selectedTemplate.components, mappings) : [];

  async function syncTemplates() {
    if (!profileId) {
      setSyncMessage({ error: "Select a WhatsApp sender before syncing templates." });
      return;
    }
    if (syncing) return;
    setSyncMessage({});
    setSyncing(true);
    try {
      const result = await syncWorkforcePayoutWhatsAppTemplates(profileId);
      if (result.error) {
        setSyncMessage({ error: result.error });
        return;
      }
      const refreshed = (result.templates ?? []) as PayoutNotificationTemplate[];
      setTemplates((current) => [...current.filter((template) => template.whatsapp_profile_id !== profileId), ...refreshed]);
      if (templateId && !refreshed.some((template) => template.template_id === templateId)) {
        setTemplateId("");
        setMappings({});
      }
      setSyncMessage({ notice: result.notice });
    } catch (error) {
      setSyncMessage({ error: error instanceof Error ? error.message : "Unable to sync WhatsApp templates." });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <form action={saveWorkforcePayoutWhatsAppConfiguration} className="whatsapp-notification-form">
      <div className="panel-body">
        {!globalWhatsAppEnabled ? (
          <div className="inline-error" role="alert">
            <strong>WhatsApp messaging is disabled</strong>
            <span>Enable it in Meta settings before turning on the WhatsApp channel. The DropX One App notification can still be enabled independently.</span>
          </div>
        ) : null}
        {syncMessage.error || syncMessage.notice ? (
          <div className={syncMessage.error ? "inline-error" : "message-panel success"} role={syncMessage.error ? "alert" : "status"}>
            <strong>{syncMessage.error ? "Sync failed" : "Templates updated"}</strong>
            <span>{syncMessage.error ?? syncMessage.notice}</span>
          </div>
        ) : null}

        <label className="toggle-field">
          <input
            checked={appNotificationEnabled}
            disabled={!canEdit}
            name="app_notification_enabled"
            onChange={(event) => setAppNotificationEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Send a DropX One App notification when a workforce payout is published for review</span>
        </label>

        <label className="toggle-field">
          <input
            checked={enabled}
            disabled={!canEdit || !globalWhatsAppEnabled}
            name="is_enabled"
            onChange={(event) => setEnabled(event.target.checked)}
            type="checkbox"
          />
          <span>Send a WhatsApp notification when a workforce payout is published for review</span>
        </label>

        {appNotificationEnabled ? (
          <div className="message-panel success" role="status">
            <strong>DropX One App preview</strong>
            <span>Payment details available — opens the published month directly in the Payouts tab. A device push is also attempted when the associate has an active app token.</span>
          </div>
        ) : null}

        <div className="whatsapp-config-layout">
          <div className="whatsapp-config-fields">
            <label>Send from profile
              <SearchableSelect
                disabled={!canEdit || !enabled}
                name="whatsapp_profile_id"
                onValueChange={(value) => {
                  setProfileId(value);
                  setTemplateId("");
                  setMappings({});
                  setSyncMessage({});
                }}
                options={profileOptions}
                placeholder={profiles.length ? "Select active WhatsApp sender" : "No active WhatsApp senders"}
                required={enabled}
                value={profileId}
              />
            </label>
            <div className="form-actions" style={{ justifyContent: "flex-start", marginTop: 0 }}>
              <button className="button secondary" disabled={!canEdit || !enabled || !profileId || syncing} onClick={() => void syncTemplates()} type="button">
                {syncing ? "Syncing with Meta…" : "Sync templates now"}
              </button>
            </div>
            <label>Approved WhatsApp template
              <SearchableSelect
                disabled={!canEdit || !enabled || !profileId}
                name="template_id"
                onValueChange={(value) => {
                  setTemplateId(value);
                  setMappings({});
                }}
                options={templateOptions}
                placeholder={!profileId ? "Select sender first" : templateOptions.length ? "Search approved templates" : "Sync approved templates from Meta"}
                required={enabled}
                value={templateId}
              />
            </label>

            {selectedTemplate ? (
              <div className="whatsapp-variable-list">
                <div className="whatsapp-template-meta">
                  <strong>{selectedTemplate.name}</strong>
                  <span>{selectedTemplate.language}</span>
                  <span className="status-pill good">APPROVED</span>
                </div>
                {variables.length ? variables.map((variable) => (
                  <label key={variable.key}>{variable.label}
                    <SearchableSelect
                      disabled={!canEdit || !enabled}
                      name={`mapping_${variable.key.replaceAll(".", "_")}`}
                      onValueChange={(value) => setMappings((current) => ({ ...current, [variable.key]: value }))}
                      options={WORKFORCE_PAYOUT_WHATSAPP_FIELDS.map((field) => ({ value: field.value, label: field.label }))}
                      placeholder="Map to payout data"
                      required={enabled}
                      value={mappings[variable.key] ?? ""}
                    />
                  </label>
                )) : <p className="subtle">This approved template has no variables.</p>}
              </div>
            ) : null}
          </div>

          <aside className="whatsapp-preview">
            <h3>Notification preview</h3>
            {selectedTemplate ? (
              <>
                <p style={{ whiteSpace: "pre-wrap" }}>{preview || "This template has no text preview."}</p>
                {previewButtons.map((button, index) => (
                  <div key={`${button.label}:${index}`}>
                    <span>URL button</span>
                    <p><strong>{button.label}</strong><br />{button.url}</p>
                  </div>
                ))}
              </>
            ) : (
              <p className="subtle">Select an approved template to preview its mapped payout data.</p>
            )}
            <p className="subtle" style={{ marginTop: 12 }}>
              Template ID and language are saved exactly. They are rechecked against the active sender and Meta-approved cache immediately before every send.
            </p>
          </aside>
        </div>

        <input name="variable_mappings_json" type="hidden" value={JSON.stringify(mappings)} />
        {canEdit ? (
          <div className="form-actions">
            <SubmitButton disabled={enabled && (!profileId || !templateId || variables.some((variable) => !mappings[variable.key]))}>
              Save notification settings
            </SubmitButton>
          </div>
        ) : <p className="subtle">You have view-only access to Workforce Payment settings.</p>}
      </div>
    </form>
  );
}
