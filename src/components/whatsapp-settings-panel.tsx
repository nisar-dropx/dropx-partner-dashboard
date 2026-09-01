"use client";

import { useMemo, useState } from "react";
import { Copy, Settings } from "lucide-react";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { extractWhatsAppTemplateVariables, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";
import { deleteWhatsAppProfile, saveWhatsAppGeneralSettings, saveWhatsAppNotificationConfig, saveWhatsAppProfile, saveWhatsAppProfileGreeting, syncWhatsAppTemplates } from "@/app/settings/whatsapp-actions";

export type GeneralSettings = {
  is_enabled: boolean;
  webhook_verify_token: string | null;
};

export type WhatsAppProfile = {
  id: string;
  profile_name: string;
  business_account_id: string | null;
  phone_number_id: string;
  graph_api_version: string;
  default_country_code: string;
  chat_enabled: boolean;
  greeting_enabled: boolean;
  greeting_message: string | null;
  is_active: boolean;
  is_default: boolean;
  token_configured: boolean;
  token_mask: string;
  usage_count: number;
};

export type Template = {
  template_id: string;
  whatsapp_profile_id: string | null;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: WhatsAppTemplateComponent[];
};

export type NotificationConfig = {
  is_enabled: boolean;
  template_id: string | null;
  whatsapp_profile_id: string | null;
  variable_mappings: Record<string, string>;
};

export type WhatsAppOnboardingTarget = {
  categoryCode: string;
  code: string;
  label: string;
  config: NotificationConfig;
};

const emptyNotificationConfig: NotificationConfig = {
  is_enabled: false,
  template_id: null,
  whatsapp_profile_id: null,
  variable_mappings: {}
};

const dataOptions = [
  { value: "full_name", label: "Full name" },
  { value: "mobile", label: "Mobile number" },
  { value: "dropx_id", label: "DropX ID" },
  { value: "biometric_id", label: "Biometric ID" },
  { value: "date_of_join", label: "Date of join" },
  { value: "location_code", label: "Location code" },
  { value: "location_name", label: "Location name" },
  { value: "provider_name", label: "Provider name" },
  { value: "registration_link", label: "Registration link" },
  { value: "otp_code", label: "OTP code" },
  { value: "expiry_minutes", label: "OTP expiry minutes" },
  { value: "app_name", label: "App name" }
];

export function WhatsAppSettingsPanel({
  canEdit,
  onboardingTargets,
  otpConfig = emptyNotificationConfig,
  flash,
  general,
  profiles,
  templates,
  webhookUrl,
  commonWebhookMode = false,
  detailMode = false
}: {
  canEdit: boolean;
  onboardingTargets: WhatsAppOnboardingTarget[];
  otpConfig?: NotificationConfig;
  flash: { error: string | null; notice: string | null };
  general: GeneralSettings;
  profiles: WhatsAppProfile[];
  templates: Template[];
  webhookUrl: string;
  commonWebhookMode?: boolean;
  detailMode?: boolean;
}) {
  const defaultOnboardingTarget = onboardingTargets.find((target) => target.categoryCode === "workforce") ?? onboardingTargets[0];
  const defaultOnboardingConfig = defaultOnboardingTarget?.config ?? emptyNotificationConfig;
  const flashTarget = flash.error && (
    flash.error.includes("template") ||
    flash.error.includes("variable") ||
    flash.error.includes("onboarding") ||
    flash.error.includes("approved")
  ) ? "field_executive_onboarding" : flash.error ? "whatsapp_general" : null;
  const [whatsAppEnabled, setWhatsAppEnabled] = useState(general.is_enabled);
  const [onboardingEnabled, setOnboardingEnabled] = useState(defaultOnboardingConfig.is_enabled);
  const [configuring, setConfiguring] = useState<string | null>(flashTarget);
  const [onboardingTarget, setOnboardingTarget] = useState(defaultOnboardingTarget?.code ?? "");
  const [editingProfile, setEditingProfile] = useState<WhatsAppProfile | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [settingsProfile, setSettingsProfile] = useState<WhatsAppProfile | null>(null);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [greetingEnabled, setGreetingEnabled] = useState(false);
  const [templateId, setTemplateId] = useState(defaultOnboardingConfig.template_id ?? "");
  const [notificationProfileId, setNotificationProfileId] = useState(defaultOnboardingConfig.whatsapp_profile_id ?? profiles.find((profile) => profile.is_default)?.id ?? "");
  const [mappings, setMappings] = useState<Record<string, string>>(defaultOnboardingConfig.variable_mappings ?? {});
  const [otpExpiryMinutes, setOtpExpiryMinutes] = useState(defaultOnboardingConfig.variable_mappings?.__otp_expiry_minutes ?? "10");
  const [profileTokenInput, setProfileTokenInput] = useState("");
  const [copiedWebhook, setCopiedWebhook] = useState(false);
  const selectedTemplate = templates.find((template) => template.template_id === templateId && template.whatsapp_profile_id === notificationProfileId) ?? null;
  const variables = useMemo(() => extractWhatsAppTemplateVariables(selectedTemplate?.components ?? []), [selectedTemplate]);
  const dataLabelByValue = Object.fromEntries(dataOptions.map((option) => [option.value, option.label]));
  const canConfigureWhatsApp = canEdit && whatsAppEnabled;
  const canUseWhatsApp = !detailMode || whatsAppEnabled;
  const previewSections = useMemo(() => {
    if (!selectedTemplate) return [];
    return (selectedTemplate.components ?? []).flatMap((component) => {
      const type = component.type?.toUpperCase();
      if ((type === "HEADER" || type === "BODY") && component.text) {
        const label = type === "HEADER" ? "Header" : "Body";
        const text = component.text.replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
          const source = mappings[`${type.toLowerCase()}.${position}`];
          return `[${source ? dataLabelByValue[source] ?? source : `${label} variable ${position}`}]`;
        });
        return [{ label, text }];
      }
      if (type === "BUTTONS") {
        return (component.buttons ?? []).map((button, buttonIndex) => ({
          label: button.text || `Button ${buttonIndex + 1}`,
          text: (button.url || "").replace(/\{\{(\d+)\}\}/g, (_, position: string) => {
            const source = mappings[`button.${buttonIndex}.${position}`];
            return `[${source ? dataLabelByValue[source] ?? source : `Button variable ${position}`}]`;
          })
        })).filter((section) => section.text);
      }
      return [];
    });
  }, [dataLabelByValue, mappings, selectedTemplate]);
  const templateOptions = templates.filter((template) => template.whatsapp_profile_id === notificationProfileId).map((template) => ({
    value: template.template_id,
    label: `${template.name} (${template.language})`,
    helper: `${template.status} - ${template.category ?? "Uncategorised"}`
  }));
  const profileOptions = profiles.filter((profile) => profile.is_active).map((profile) => ({
    value: profile.id,
    label: profile.profile_name,
    helper: `${profile.phone_number_id} - ${profile.default_country_code}`
  }));
  const notificationConfigByCode: Record<string, NotificationConfig> = {
    ...Object.fromEntries(onboardingTargets.map((target) => [target.code, target.config])),
    onboarding_otp_verification: otpConfig
  };
  const templateLabel = (notificationConfig: NotificationConfig) => {
    const template = templates.find((item) =>
      item.template_id === notificationConfig.template_id &&
      item.whatsapp_profile_id === notificationConfig.whatsapp_profile_id
    );
    return template ? `${template.name} (${template.language})` : "No template selected";
  };
  const openNotificationConfig = (code: string) => {
    const nextConfig = notificationConfigByCode[code] ?? emptyNotificationConfig;
    if (onboardingTargets.some((target) => target.code === code)) {
      setOnboardingTarget(code);
    }
    setOnboardingEnabled(nextConfig.is_enabled);
    setNotificationProfileId(nextConfig.whatsapp_profile_id ?? profiles.find((profile) => profile.is_default)?.id ?? "");
    setTemplateId(nextConfig.template_id ?? "");
    setMappings(nextConfig.variable_mappings ?? {});
    setOtpExpiryMinutes(nextConfig.variable_mappings?.__otp_expiry_minutes ?? "10");
    setConfiguring(code);
  };
  const openOnboardingGroup = () => {
    const firstConfigured = onboardingTargets.find((target) => target.config.is_enabled)?.code;
    openNotificationConfig(firstConfigured ?? defaultOnboardingTarget?.code ?? "");
    setConfiguring("onboarding_group");
  };
  const switchOnboardingTarget = (code: string) => {
    const nextConfig = notificationConfigByCode[code] ?? emptyNotificationConfig;
    setOnboardingTarget(code);
    setOnboardingEnabled(nextConfig.is_enabled);
    setNotificationProfileId(nextConfig.whatsapp_profile_id ?? profiles.find((profile) => profile.is_default)?.id ?? "");
    setTemplateId(nextConfig.template_id ?? "");
    setMappings(nextConfig.variable_mappings ?? {});
    setOtpExpiryMinutes(nextConfig.variable_mappings?.__otp_expiry_minutes ?? "10");
  };
  const onboardingEnabledCount = onboardingTargets.filter((target) => target.config.is_enabled).length;
  const notificationRows = [
    {
      code: "onboarding_group",
      title: "Onboarding message",
      description: "Configure onboarding messages separately for employees, field executives, vendors, and other worker types.",
      enabled: onboardingEnabledCount > 0,
      template: `${onboardingEnabledCount} enabled`,
      configurable: true
    },
    {
      code: "onboarding_otp_verification",
      title: "Onboarding OTP Verification",
      description: "Send OTP verification message for DropX Connect onboarding login.",
      enabled: otpConfig.is_enabled,
      template: templateLabel(otpConfig),
      configurable: true
    },
    {
      code: "advance_request",
      title: "Advance request message",
      description: "Notify users and approvers during advance request workflow.",
      enabled: false,
      template: "Not configured",
      configurable: false
    },
    {
      code: "payroll_summary",
      title: "Payroll summary message",
      description: "Share payout summary once payroll is reviewed.",
      enabled: false,
      template: "Not configured",
      configurable: false
    },
    {
      code: "document_reminder",
      title: "Document reminder message",
      description: "Remind Field Executives to complete pending onboarding documents.",
      enabled: false,
      template: "Not configured",
      configurable: false
    }
  ];

  return (
    <div className="whatsapp-settings-stack">
      {detailMode ? (
        <section className="panel">
          <form action={saveWhatsAppGeneralSettings} className="panel-head whatsapp-enable-head">
            <div>
              <h2>WhatsApp</h2>
              <p className="subtle">Enable WhatsApp before maintaining profiles, templates, and notification rules.</p>
            </div>
            <div className="panel-head-actions">
              <label className="toggle-field compact-toggle">
                <input checked={whatsAppEnabled} disabled={!canEdit} name="is_enabled" onChange={(event) => setWhatsAppEnabled(event.target.checked)} type="checkbox" />
                <span>Enable WhatsApp</span>
              </label>
              {canEdit ? <SubmitButton className="button compact">Save</SubmitButton> : null}
            </div>
          </form>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <div><h2>{commonWebhookMode ? "WhatsApp" : "WhatsApp Cloud API"}</h2><p className="subtle">{commonWebhookMode ? "Sender profiles, templates, and WhatsApp notification rules." : "Enable WhatsApp and maintain shared webhook settings."}</p></div>
            <div className="panel-head-actions">
              {general.is_enabled ? <span className="status-pill good">Enabled</span> : null}
              <button className="button secondary compact" disabled={!canEdit} onClick={() => setConfiguring("whatsapp_general")} type="button">Configure</button>
            </div>
          </div>
        </section>
      )}

      {configuring === "whatsapp_general" ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfiguring(null);
          }}
        >
          <section className="modal-panel wide" aria-label="Configure WhatsApp Cloud API">
            <div className="panel-head">
              <div>
                <h2>{commonWebhookMode ? "WhatsApp" : "WhatsApp Cloud API"}</h2>
                <p className="subtle">{commonWebhookMode ? "Enable WhatsApp notifications. Webhook settings are handled in Common Webhook." : "Enable WhatsApp and maintain webhook settings."}</p>
              </div>
              <button className="icon-button" onClick={() => setConfiguring(null)} type="button">x</button>
            </div>
            <form action={saveWhatsAppGeneralSettings} className="whatsapp-general-form">
              <label className="toggle-field">
                <input checked={whatsAppEnabled} disabled={!canEdit} name="is_enabled" onChange={(event) => setWhatsAppEnabled(event.target.checked)} type="checkbox" />
                <span>Enable WhatsApp notifications</span>
              </label>
              {!commonWebhookMode ? (
                <div className={`form-grid two ${!whatsAppEnabled ? "disabled-form-area" : ""}`}>
                  <label>Webhook URL
                    <span className="copy-field">
                      <input className="field mono" readOnly value={webhookUrl} />
                      <button
                        className="icon-button"
                        disabled={!webhookUrl}
                        onClick={async () => {
                          await navigator.clipboard.writeText(webhookUrl);
                          setCopiedWebhook(true);
                          window.setTimeout(() => setCopiedWebhook(false), 1500);
                        }}
                        title="Copy webhook URL"
                        type="button"
                      >
                        <Copy size={15} />
                      </button>
                    </span>
                    {copiedWebhook ? <small className="field-hint success">Copied</small> : null}
                  </label>
                  <label>Webhook verify token
                    <input
                      className="field"
                      defaultValue={general.webhook_verify_token ?? ""}
                      disabled={!canConfigureWhatsApp}
                      name="webhook_verify_token"
                      placeholder="Enter verify token used in Meta"
                    />
                  </label>
                </div>
              ) : null}
              {canEdit ? <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setConfiguring(null)} type="button">Cancel</button><SubmitButton>Save general settings</SubmitButton></div> : null}
            </form>
          </section>
        </div>
      ) : null}

      <section className={`panel ${canUseWhatsApp ? "" : "disabled-form-area"}`}>
        <div className="panel-head">
          <div><h2>WhatsApp profiles</h2><p className="subtle">Create sender profiles and choose which profile sends each workflow or manual campaign.</p></div>
          <button
            className="button compact"
            disabled={!canEdit || !canUseWhatsApp}
            onClick={() => {
              setEditingProfile(null);
              setProfileTokenInput("");
              setProfileModalOpen(true);
            }}
            type="button"
          >
            Add profile
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profile</th>
                <th>Business Account ID</th>
                <th>Phone Number ID</th>
                <th>Graph API</th>
                <th>Country</th>
                <th>Token</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {profiles.length ? profiles.map((profile) => (
                <tr key={profile.id}>
                  <td><strong>{profile.profile_name}</strong>{profile.is_default ? <><br /><span className="subtle">Default profile</span></> : null}</td>
                  <td>{profile.business_account_id || "-"}</td>
                  <td>{profile.phone_number_id}</td>
                  <td>{profile.graph_api_version}</td>
                  <td>{profile.default_country_code}</td>
                  <td>{profile.token_configured ? "Configured" : "Missing"}</td>
                  <td><span className={`status-pill ${profile.is_active ? "good" : "warn"}`}>{profile.is_active ? "Active" : "Inactive"}</span></td>
                  <td>
                    <div className="whatsapp-profile-actions">
                        <button
                        className="button secondary compact"
                        disabled={!canEdit || !canUseWhatsApp}
                        onClick={() => {
                          setEditingProfile(profile);
                          setProfileTokenInput(profile.token_configured ? profile.token_mask : "");
                          setProfileModalOpen(true);
                        }}
                        type="button"
                      >
                        Edit
                      </button>
                      <form action={deleteWhatsAppProfile}>
                        <input name="profile_id" type="hidden" value={profile.id} />
                        <SubmitButton
                          className="button danger compact"
                          disabled={!canEdit || !canUseWhatsApp || profile.usage_count > 0}
                        >
                          Delete
                        </SubmitButton>
                      </form>
                      <button
                        aria-label={`Open settings for ${profile.profile_name}`}
                        className="icon-button"
                        disabled={!canEdit || !canUseWhatsApp}
                        onClick={() => {
                          setChatEnabled(profile.chat_enabled);
                          setGreetingEnabled(profile.greeting_enabled);
                          setSettingsProfile(profile);
                        }}
                        title="Profile settings"
                        type="button"
                      >
                        <Settings size={16} />
                      </button>
                      {profile.usage_count > 0 ? <span className="subtle tiny-note">{profile.usage_count} used</span> : null}
                    </div>
                  </td>
                </tr>
              )) : <tr><td className="empty-cell" colSpan={8}>No WhatsApp profiles added yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {settingsProfile ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsProfile(null);
          }}
        >
          <section className="modal-panel wide" aria-label="Configure WhatsApp profile settings">
            <div className="panel-head">
              <div>
                <h2>{settingsProfile.profile_name} settings</h2>
                <p className="subtle">Profile-level rules for incoming WhatsApp messages.</p>
              </div>
              <button className="icon-button" onClick={() => setSettingsProfile(null)} type="button">x</button>
            </div>
            <form action={saveWhatsAppProfileGreeting} className="whatsapp-general-form">
              <input name="profile_id" type="hidden" value={settingsProfile.id} />
              <label className="toggle-field">
                <input
                  checked={chatEnabled}
                  disabled={!canEdit || !settingsProfile.is_active}
                  name="chat_enabled"
                  onChange={(event) => setChatEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>Enable chat</span>
              </label>
              <label className="toggle-field">
                <input
                  checked={greetingEnabled}
                  disabled={!canEdit || !settingsProfile.is_active}
                  name="greeting_enabled"
                  onChange={(event) => setGreetingEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>Enable greeting auto-reply</span>
              </label>
              <label className="stacked-field greeting-message-field">
                <span>Greeting message</span>
                <textarea
                  className="field bulk-textarea"
                  defaultValue={settingsProfile.greeting_message ?? ""}
                  disabled={!canEdit || !settingsProfile.is_active || !greetingEnabled}
                  name="greeting_message"
                  placeholder="Hi {{contact_name}}, thanks for messaging {{profile_name}}."
                  rows={4}
                />
              </label>
              <p className="subtle">
                Available variables: {"{{contact_name}}"}, {"{{wa_id}}"}, {"{{from}}"}, {"{{message_text}}"}, {"{{profile_name}}"}, {"{{phone_number_id}}"}, {"{{display_phone_number}}"}.
              </p>
              {!settingsProfile.is_active ? <p className="inline-error"><strong>Profile inactive</strong><span>Greeting will send only from active WhatsApp profiles.</span></p> : null}
              {canEdit ? <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setSettingsProfile(null)} type="button">Cancel</button><SubmitButton>Save settings</SubmitButton></div> : null}
            </form>
          </section>
        </div>
      ) : null}

      {profileModalOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setProfileModalOpen(false);
          }}
        >
          <section className="modal-panel wide" aria-label="Configure WhatsApp profile">
            <div className="panel-head">
              <div>
                <h2>{editingProfile ? "Edit WhatsApp profile" : "Add WhatsApp profile"}</h2>
                <p className="subtle">Sender credentials for one WhatsApp phone number.</p>
              </div>
              <button className="icon-button" onClick={() => setProfileModalOpen(false)} type="button">x</button>
            </div>
            <form action={saveWhatsAppProfile} className="whatsapp-general-form">
              <input name="profile_id" type="hidden" value={editingProfile?.id ?? ""} />
              <div className="form-grid three">
                <label>WhatsApp profile name<input className="field" defaultValue={editingProfile?.profile_name ?? ""} name="profile_name" required /></label>
                <label>WhatsApp Business Account ID<input className="field" defaultValue={editingProfile?.business_account_id ?? ""} name="business_account_id" required /></label>
                <label>Phone Number ID<input className="field" defaultValue={editingProfile?.phone_number_id ?? ""} name="phone_number_id" required /></label>
                <label>Graph API version<input className="field mono" defaultValue={editingProfile?.graph_api_version ?? "v25.0"} name="graph_api_version" placeholder="v25.0" required /></label>
                <label>Default country code<input className="field" defaultValue={editingProfile?.default_country_code ?? "91"} inputMode="numeric" name="default_country_code" required /></label>
                <label className="span-2">Permanent access token
                  <input
                    className="field"
                    name="access_token"
                    onChange={(event) => setProfileTokenInput(event.target.value)}
                    placeholder={editingProfile?.token_configured ? "Token configured" : "Enter Meta permanent access token"}
                    type="password"
                    value={profileTokenInput}
                  />
                </label>
              </div>
              <div className="inline-toggle-row">
                <label className="toggle-field compact-toggle"><input defaultChecked={editingProfile?.is_active ?? true} name="is_active" type="checkbox" /><span>Active</span></label>
                <label className="toggle-field compact-toggle"><input defaultChecked={editingProfile?.is_default ?? profiles.length === 0} name="is_default" type="checkbox" /><span>Default profile</span></label>
              </div>
              <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setProfileModalOpen(false)} type="button">Cancel</button><SubmitButton>{editingProfile ? "Save profile" : "Create profile"}</SubmitButton></div>
            </form>
          </section>
        </div>
      ) : null}

      <section className={`panel ${canUseWhatsApp ? "" : "disabled-form-area"}`}>
        <div className="panel-head">
          <div><h2>Message templates</h2><p className="subtle">Fetch template names, languages, status, and variables directly from Meta.</p></div>
          {canEdit ? <form action={syncWhatsAppTemplates}><SubmitButton className="button secondary" disabled={!canUseWhatsApp || !profiles.some((profile) => profile.is_default && profile.is_active)} pendingText="Syncing">Sync templates</SubmitButton></form> : null}
        </div>
        <div className="panel-body whatsapp-template-summary">
          <strong>{templates.length} templates synced</strong>
          <span className="subtle">{templates.filter((template) => template.status === "APPROVED").length} approved</span>
        </div>
      </section>

      <section className={`panel ${canUseWhatsApp ? "" : "disabled-form-area"}`}>
        <div className="panel-head">
          <div><h2>Notification messages</h2><p className="subtle">Configure each WhatsApp workflow with its own approved template and variable mapping.</p></div>
        </div>
        <div className={`whatsapp-notification-list ${!canUseWhatsApp ? "disabled-form-area" : ""}`}>
          {notificationRows.map((row) => (
            <div className="whatsapp-notification-row" key={row.code}>
              <div>
                <h3>{row.title}</h3>
                <p className="subtle">{row.description}</p>
              </div>
              <div className="whatsapp-notification-meta">
                {row.enabled ? <span className="status-pill good">Enabled</span> : null}
                <span className="subtle">{row.template}</span>
              </div>
              <button
                className="button secondary compact"
                disabled={!canEdit || !canUseWhatsApp || !row.configurable}
                onClick={() => row.code === "onboarding_group" ? openOnboardingGroup() : openNotificationConfig(row.code)}
                type="button"
              >
                Configure
              </button>
            </div>
          ))}
        </div>
      </section>

      {configuring === "onboarding_group" || configuring === "onboarding_otp_verification" ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfiguring(null);
          }}
        >
          <section className="modal-panel wide" aria-label="Configure WhatsApp notification message">
            <div className="panel-head">
              <div>
                <h2>{configuring === "onboarding_otp_verification" ? "Onboarding OTP Verification" : "Onboarding message"}</h2>
                <p className="subtle">Select the approved WhatsApp template and map each variable to dashboard data.</p>
              </div>
              <button className="icon-button" onClick={() => setConfiguring(null)} type="button">x</button>
            </div>
            <form action={saveWhatsAppNotificationConfig} className={`whatsapp-notification-form ${!canUseWhatsApp ? "disabled-form-area" : ""}`}>
              <input name="event_code" type="hidden" value={configuring === "onboarding_group" ? onboardingTarget : configuring} />
              {flash.error ? (
                <div className="inline-error"><strong>Action required</strong><span>{flash.error}</span></div>
              ) : null}
              {configuring === "onboarding_group" ? (
                <div className="segmented-control" aria-label="Onboarding worker type">
                  {onboardingTargets.map((target) => (
                    <button
                      className={onboardingTarget === target.code ? "active" : ""}
                      key={target.code}
                      onClick={() => switchOnboardingTarget(target.code)}
                      type="button"
                    >
                      {target.label}
                      {target.config.is_enabled ? <span className="status-dot" /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="toggle-field">
                <input checked={onboardingEnabled} disabled={!canEdit || !canUseWhatsApp} name="is_enabled" onChange={(event) => setOnboardingEnabled(event.target.checked)} type="checkbox" />
                <span>Enable {configuring === "onboarding_otp_verification" ? "onboarding OTP verification" : onboardingTargets.find((target) => target.code === onboardingTarget)?.label.toLowerCase() ?? "onboarding"} message</span>
              </label>
              <div className="whatsapp-config-layout">
                <div className="whatsapp-config-fields">
                  <label>Send from profile
                    <SearchableSelect
                      disabled={!canEdit || !canUseWhatsApp || !onboardingEnabled}
                      name="whatsapp_profile_id"
                      onValueChange={(value) => {
                        setNotificationProfileId(value);
                        setTemplateId("");
                        setMappings({});
                      }}
                      options={profileOptions}
                      placeholder={profiles.length ? "Select WhatsApp profile" : "Add profile first"}
                      required={onboardingEnabled}
                      value={notificationProfileId}
                    />
                  </label>
                  <label>WhatsApp template
                    <SearchableSelect
                      disabled={!canEdit || !canUseWhatsApp || !onboardingEnabled || !notificationProfileId}
                      name="template_id"
                      onValueChange={(value) => { setTemplateId(value); setMappings({}); }}
                      options={templateOptions}
                      placeholder={!notificationProfileId ? "Select profile first" : templateOptions.length ? "Search synced template" : "No templates for selected profile"}
                      required={onboardingEnabled}
                      value={templateId}
                    />
                  </label>
                  {configuring === "onboarding_otp_verification" ? (
                    <label>Expiry time in minutes
                      <input
                        className="field"
                        disabled={!canEdit || !canUseWhatsApp || !onboardingEnabled}
                        max={30}
                        min={1}
                        name="otp_expiry_minutes"
                        onChange={(event) => setOtpExpiryMinutes(event.target.value)}
                        required={onboardingEnabled}
                        type="number"
                        value={otpExpiryMinutes}
                      />
                    </label>
                  ) : null}

                  {selectedTemplate && canUseWhatsApp ? (
                    <div className="whatsapp-variable-list">
                      <div className="whatsapp-template-meta">
                        <strong>{selectedTemplate.name}</strong>
                        <span>{selectedTemplate.language}</span>
                        <span className={`status-pill ${selectedTemplate.status === "APPROVED" ? "good" : "warn"}`}>{selectedTemplate.status}</span>
                      </div>
                      {variables.length ? variables.map((variable) => (
                        <label key={variable.key}>{variable.label}
                          <SearchableSelect
                            disabled={!canEdit || !onboardingEnabled}
                            key={`${onboardingTarget || configuring}-${variable.key}`}
                            name={`mapping_${variable.key.replaceAll(".", "_")}`}
                            onValueChange={(value) => setMappings((current) => ({ ...current, [variable.key]: value }))}
                            options={dataOptions}
                            placeholder="Map to message data"
                            required
                            value={mappings[variable.key] ?? ""}
                          />
                        </label>
                      )) : <p className="subtle">This template has no variables.</p>}
                    </div>
                  ) : null}
                </div>
                <aside className="whatsapp-preview">
                  <h3>Preview</h3>
                  {selectedTemplate ? (
                    previewSections.length ? previewSections.map((section, index) => (
                      <div key={`${section.label}-${index}`}>
                        <span>{section.label}</span>
                        <p>{section.text}</p>
                      </div>
                    )) : <p className="subtle">This template has no message text to preview.</p>
                  ) : <p className="subtle">Select a synced template to preview the message.</p>}
                </aside>
              </div>
              <input name="variable_mappings_json" type="hidden" value={JSON.stringify(mappings)} />
              {canEdit ? <div className="form-actions modal-actions"><button className="button secondary" onClick={() => setConfiguring(null)} type="button">Cancel</button><SubmitButton>Save configuration</SubmitButton></div> : null}
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
