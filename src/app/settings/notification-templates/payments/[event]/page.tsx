import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmailRecipientInput, type EmailRecipientOption } from "@/components/email-recipient-input";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { paymentEmailDefaultTemplates, type PaymentEmailEventType } from "@/lib/payment-email-notifications";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { savePaymentNotificationTemplate, sendMissedPaymentReminders } from "./actions";
import { defaultPaymentWorkHours, type PaymentWorkHours } from "@/lib/payment-reminder-policy";

type TemplateRow = {
  reminder_interval_minutes?: number;
  reminder_work_hours?: PaymentWorkHours;
  thread_by_station_month?: boolean;
  reminders_enabled?: boolean;
  body_template: string;
  cc_recipients: string[];
  custom_cc_emails: string[];
  custom_to_emails: string[];
  final_body_template: string | null;
  final_is_enabled: boolean;
  final_subject_template: string | null;
  initial_body_template: string | null;
  initial_is_enabled: boolean;
  initial_subject_template: string | null;
  is_enabled: boolean;
  subject_template: string;
  to_recipients: string[];
};

type ApprovalPhase = "initial" | "final";

const eventMap: Record<string, { eventType: PaymentEmailEventType; title: string; subtitle: string }> = {
  request: {
    eventType: "payment_request",
    title: "Payment request email",
    subtitle: "Sent when a payment request is submitted."
  },
  approve: {
    eventType: "payment_approve",
    title: "Payment approve email",
    subtitle: "Sent when a payment request is approved."
  },
  return: {
    eventType: "payment_return",
    title: "Payment return email",
    subtitle: "Sent when a payment request is returned."
  },
  reject: {
    eventType: "payment_reject",
    title: "Payment reject email",
    subtitle: "Sent when a payment request is rejected."
  }
};

const requestRecipientOptions = [
  { label: "Requester", value: "requester" },
  { label: "Current approver (assigned stage)", value: "current_approver" },
  { label: "Reporting Manager", value: "location_manager" },
  { label: "Final approver", value: "final_approver" },
  { label: "Payment processor", value: "payment_processor" }
];

const actionRecipientOptions = [
  { label: "Requester", value: "requester" },
  { label: "Reporting Manager", value: "location_manager" },
  { label: "Current approver", value: "current_approver" },
  { label: "Final approver", value: "final_approver" },
  { label: "Payment processor", value: "payment_processor" }
];

const recipientOptionsByEvent: Record<PaymentEmailEventType, typeof requestRecipientOptions> = {
  payment_request: requestRecipientOptions,
  payment_approve: actionRecipientOptions,
  payment_return: actionRecipientOptions,
  payment_reject: actionRecipientOptions
};

function defaultTemplate(eventType: PaymentEmailEventType): TemplateRow {
  return {
    is_enabled: false,
    final_body_template: null,
    final_is_enabled: false,
    final_subject_template: null,
    initial_body_template: null,
    initial_is_enabled: false,
    initial_subject_template: null,
    custom_cc_emails: [],
    custom_to_emails: [],
    ...paymentEmailDefaultTemplates[eventType]
  };
}

function loadFlash(eventType: PaymentEmailEventType) {
  const raw = cookies().get(`dropx_payment_notification_${eventType}_flash`)?.value;
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

async function loadTemplate(companyId: string, eventType: PaymentEmailEventType) {
  if (!supabaseAdmin) return { template: defaultTemplate(eventType), error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin
    .from("payment_notification_templates")
    .select("is_enabled, initial_is_enabled, final_is_enabled, to_recipients, cc_recipients, custom_to_emails, custom_cc_emails, subject_template, body_template, initial_subject_template, initial_body_template, final_subject_template, final_body_template, reminder_interval_minutes, reminder_work_hours, thread_by_station_month")
    .eq("company_id", companyId)
    .eq("event_type", eventType)
    .maybeSingle();
  if (result.error) return { template: defaultTemplate(eventType), error: result.error.message };
  const reminder = await supabaseAdmin.from("payment_notification_templates").select("is_enabled").eq("company_id", companyId).eq("event_type", "payment_reminder").maybeSingle();
  if (reminder.error) return { template: defaultTemplate(eventType), error: reminder.error.message };
  return { template: { ...defaultTemplate(eventType), ...(result.data ?? {}), reminders_enabled: reminder.data?.is_enabled ?? false } as TemplateRow, error: null as string | null };
}

async function loadUserOptions(companyId: string): Promise<EmailRecipientOption[]> {
  if (!supabaseAdmin) return [];
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("employee_id, full_name, email, role")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .not("email", "is", null)
    .order("full_name");
  return (data ?? []).map((user) => ({
    email: String(user.email ?? "").trim().toLowerCase(),
    label: user.full_name || user.email || "User",
    helper: [user.employee_id, user.role].filter(Boolean).join(" | ")
  })).filter((user) => user.email.includes("@"));
}

function RecipientCheckboxes({
  disabled,
  name,
  options,
  selected
}: {
  disabled: boolean;
  name: string;
  options: { label: string; value: string }[];
  selected: string[];
}) {
  return (
    <div className="notification-recipient-options">
      {options.map((option) => (
        <label className="check-row business-expiry-check" key={`${name}-${option.value}`}>
          <input defaultChecked={selected.includes(option.value)} disabled={disabled} name={name} type="checkbox" value={option.value} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function phaseEmails(phase: ApprovalPhase, values: string[]) {
  return values
    .filter((value) => value.startsWith(`${phase}:`))
    .map((value) => value.slice(phase.length + 1));
}

function phaseRecipients(phase: ApprovalPhase, values: string[]) {
  return values
    .filter((value) => value.startsWith(`${phase}:`))
    .map((value) => value.slice(phase.length + 1));
}

function hasPhaseRecipients(values: string[]) {
  return values.some((value) => value.startsWith("initial:") || value.startsWith("final:"));
}

function ApprovalRecipientSection({
  customEmails,
  disabled,
  isEnabled,
  bodyTemplate,
  phase,
  selectedCc,
  selectedTo,
  subjectTemplate,
  title,
  userOptions
}: {
  bodyTemplate: string;
  customEmails: { cc: string[]; to: string[] };
  disabled: boolean;
  isEnabled: boolean;
  phase: ApprovalPhase;
  selectedCc: string[];
  selectedTo: string[];
  subjectTemplate: string;
  title: string;
  userOptions: EmailRecipientOption[];
}) {
  return (
    <div className="settings-subpanel">
      <h3>{title}</h3>
      <label className="toggle-field">
        <input defaultChecked={isEnabled} disabled={disabled} name={`${phase}_is_enabled`} type="checkbox" />
        <span>Enable {title.toLowerCase()}</span>
      </label>
      <div className="form-grid">
        <div>
          <label>To</label>
          <RecipientCheckboxes
            disabled={disabled}
            name={`${phase}_to_recipients`}
            options={actionRecipientOptions}
            selected={selectedTo}
          />
          <label className="email-recipient-input-title">Additional To emails</label>
          <EmailRecipientInput
            defaultValue={customEmails.to}
            disabled={disabled}
            name={`${phase}_custom_to_emails`}
            options={userOptions}
            placeholder="Search user or enter email"
          />
        </div>
        <div>
          <label>CC</label>
          <RecipientCheckboxes
            disabled={disabled}
            name={`${phase}_cc_recipients`}
            options={actionRecipientOptions}
            selected={selectedCc}
          />
          <label className="email-recipient-input-title">Additional CC emails</label>
          <EmailRecipientInput
            defaultValue={customEmails.cc}
            disabled={disabled}
            name={`${phase}_custom_cc_emails`}
            options={userOptions}
            placeholder="Search user or enter email"
          />
        </div>
      </div>
      <label className="approval-template-field">
        Subject
        <input className="field" defaultValue={subjectTemplate} disabled={disabled} name={`${phase}_subject_template`} required />
      </label>
      <label className="approval-template-field approval-template-body-field">
        Body
        <textarea className="field notification-template-body" defaultValue={bodyTemplate} disabled={disabled} name={`${phase}_body_template`} required />
      </label>
    </div>
  );
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function PaymentNotificationTemplatePage({
  params
}: {
  params: { event: string };
}) {
  const eventConfig = eventMap[params.event];
  if (!eventConfig) notFound();
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.app_settings;
  const flash = loadFlash(eventConfig.eventType);
  const ccRecipientOptions = recipientOptionsByEvent[eventConfig.eventType];
  const [{ template, error }, userOptions] = await Promise.all([
    loadTemplate(companyId, eventConfig.eventType),
    loadUserOptions(companyId)
  ]);
  const approveHasPhaseRecipients = hasPhaseRecipients([...(template.to_recipients ?? []), ...(template.cc_recipients ?? [])]);
  const initialToRecipients = eventConfig.eventType === "payment_approve" && approveHasPhaseRecipients
    ? phaseRecipients("initial", template.to_recipients ?? [])
    : template.to_recipients ?? [];
  const initialCcRecipients = eventConfig.eventType === "payment_approve" && approveHasPhaseRecipients
    ? phaseRecipients("initial", template.cc_recipients ?? [])
    : template.cc_recipients ?? [];
  const finalToRecipients = eventConfig.eventType === "payment_approve" && approveHasPhaseRecipients
    ? phaseRecipients("final", template.to_recipients ?? [])
    : template.to_recipients ?? [];
  const finalCcRecipients = eventConfig.eventType === "payment_approve" && approveHasPhaseRecipients
    ? phaseRecipients("final", template.cc_recipients ?? [])
    : template.cc_recipients ?? [];
  const initialSubjectTemplate = template.initial_subject_template || template.subject_template;
  const initialBodyTemplate = template.initial_body_template || template.body_template;
  const finalSubjectTemplate = template.final_subject_template || template.subject_template;
  const finalBodyTemplate = template.final_body_template || template.body_template;
  const workHours = template.reminder_work_hours ?? defaultPaymentWorkHours;

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Email Notifications"
        title={eventConfig.title}
        subtitle={eventConfig.subtitle}
        action={<a className="button secondary" href="/settings/notification-templates/email">Back</a>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Payment email setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{error} Run `scripts/payment_email_notifications_v1.sql` in Supabase SQL Editor.</p>
          </div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{eventConfig.title}</h2>
              <p className="subtle">{eventConfig.subtitle}</p>
            </div>
            {template.is_enabled ? <span className="status-pill good">Enabled</span> : null}
          </div>
          <form action={savePaymentNotificationTemplate} className="notification-template-form">
            <input name="event_type" type="hidden" value={eventConfig.eventType} />
            {eventConfig.eventType === "payment_request" ? <fieldset className="settings-subpanel" disabled={!permission.canEdit}>
              <h3>Approval reminders — all locations and current approvers</h3>
              <label className="check-row"><input type="checkbox" name="reminders_enabled" defaultChecked={template.reminders_enabled} /> Enable recurring reminders</label>
              <label className="check-row"><input type="checkbox" name="thread_by_station_month" defaultChecked={template.thread_by_station_month !== false} /> One station/month thread for requests, decisions and reminders</label>
              <p className="subtle">Only the current approver is reminded. Stops on final approval, return or rejection. Subject: QLDA Payment Request September 2026. Monthly threading overrides the subject below.</p>
              <div className="form-grid">
                <label>Interval (minutes)<input className="field" type="number" min="15" max="1440" name="reminder_interval_minutes" defaultValue={template.reminder_interval_minutes ?? 90} required /></label>
                <label>Timezone<input className="field" name="reminder_timezone" defaultValue={workHours.timezone} required /></label>
                <label>Work hours start<input className="field" type="time" name="reminder_start" defaultValue={workHours.start} required /></label>
                <label>Work hours end<input className="field" type="time" name="reminder_end" defaultValue={workHours.end} required /></label>
              </div>
              <div className="notification-recipient-options">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day,index) =>
                <label className="check-row" key={day}><input type="checkbox" name="reminder_days" value={index} defaultChecked={workHours.days.includes(index)} />{day}</label>)}</div>
              <p className="subtle">Reminders due after closing are deferred to the next opening time. Pending requests with a missing schedule are recovered automatically.</p>
            </fieldset> : null}
            {eventConfig.eventType !== "payment_approve" ? (
              <label className="toggle-field">
                <input defaultChecked={template.is_enabled} disabled={!permission.canEdit} name="is_enabled" type="checkbox" />
                <span>Enable {eventConfig.title.toLowerCase()}</span>
              </label>
            ) : null}
            {eventConfig.eventType === "payment_approve" ? (
              <>
                <ApprovalRecipientSection
                  bodyTemplate={initialBodyTemplate}
                  customEmails={{ cc: phaseEmails("initial", template.custom_cc_emails ?? []), to: phaseEmails("initial", template.custom_to_emails ?? []) }}
                  disabled={!permission.canEdit}
                  isEnabled={template.initial_is_enabled}
                  phase="initial"
                  selectedCc={initialCcRecipients}
                  selectedTo={initialToRecipients}
                  subjectTemplate={initialSubjectTemplate}
                  title="Initial Approval email"
                  userOptions={userOptions}
                />
                <ApprovalRecipientSection
                  bodyTemplate={finalBodyTemplate}
                  customEmails={{ cc: phaseEmails("final", template.custom_cc_emails ?? []), to: phaseEmails("final", template.custom_to_emails ?? []) }}
                  disabled={!permission.canEdit}
                  isEnabled={template.final_is_enabled}
                  phase="final"
                  selectedCc={finalCcRecipients}
                  selectedTo={finalToRecipients}
                  subjectTemplate={finalSubjectTemplate}
                  title="Final Approval email"
                  userOptions={userOptions}
                />
              </>
            ) : (
              <div className="settings-subpanel">
                <h3>Recipients</h3>
                <div className="form-grid">
                  <div>
                    <label>To</label>
                    <RecipientCheckboxes disabled={!permission.canEdit} name="to_recipients" options={ccRecipientOptions} selected={template.to_recipients ?? []} />
                    <label className="email-recipient-input-title">Additional To emails</label>
                    <EmailRecipientInput
                      defaultValue={template.custom_to_emails ?? []}
                      disabled={!permission.canEdit}
                      name="custom_to_emails"
                      options={userOptions}
                      placeholder="Search user or enter email"
                    />
                  </div>
                  <div>
                    <label>CC</label>
                    <RecipientCheckboxes disabled={!permission.canEdit} name="cc_recipients" options={ccRecipientOptions} selected={template.cc_recipients ?? []} />
                    <label className="email-recipient-input-title">Additional CC emails</label>
                    <EmailRecipientInput
                      defaultValue={template.custom_cc_emails ?? []}
                      disabled={!permission.canEdit}
                      name="custom_cc_emails"
                      options={userOptions}
                      placeholder="Search user or enter email"
                    />
                  </div>
                </div>
              </div>
            )}
            {eventConfig.eventType !== "payment_approve" ? (
              <>
                <label>
                  Subject
                  <input className="field" defaultValue={template.subject_template} disabled={!permission.canEdit} name="subject_template" required />
                </label>
                <label>
                  Body
                  <textarea className="field notification-template-body" defaultValue={template.body_template} disabled={!permission.canEdit} name="body_template" required />
                </label>
              </>
            ) : null}
            <div className="settings-subpanel">
              <h3>Available variables</h3>
              <p className="subtle">{"{{request_no}}, {{location_code}}, {{payment_head}}, {{amount}}, {{requester_name}}, {{action_by}}, {{status}}, {{remarks}}, {{company_name}}"}</p>
            </div>
            {permission.canEdit ? (
              <div className="form-actions">
                <SubmitButton>Save template</SubmitButton>
              </div>
            ) : null}
          </form>
          {eventConfig.eventType === "payment_request" && permission.canEdit ? <form action={sendMissedPaymentReminders} className="panel-body">
            <p className="subtle">One-off catch-up for all currently assigned approvers in this company. Sends missing/overdue reminders now, including outside work hours. Already scheduled, not-yet-due requests are not resent.</p>
            <SubmitButton>Send missed reminders now</SubmitButton>
          </form> : null}
        </section>
      ) : null}
    </AppShell>
  );
}
