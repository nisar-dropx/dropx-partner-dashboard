import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { findPositionApprover } from "@/lib/position-access";
import { approvalEmailCard } from "@/lib/approval-email-card";

const PAYMENT_APPROVALS_URL = "https://ops.dropxlogistics.com/payments/approvals";

function paymentEmailHtml(eventType: PaymentEmailEventType, values: Record<string, string>, reminderNumber?: number) {
  const heading = `${values.request_no} · ${values.requester_name}`;
  const infoValue = `${values.amount} · ${values.location_code}`;
  const isReminder = Boolean(reminderNumber);
  if (eventType === "payment_approve") {
    return approvalEmailCard({
      eyebrow: "PAYMENT APPROVED",
      heading,
      introduction: `This payment request was approved by ${values.action_by}.${values.remarks_note}`,
      infoLabel: values.payment_head,
      infoValue,
      ctaLabel: "Open in Ops",
      ctaUrl: PAYMENT_APPROVALS_URL,
      steps: []
    });
  }
  if (eventType === "payment_return") {
    return approvalEmailCard({
      eyebrow: "PAYMENT RETURNED",
      heading,
      introduction: `This payment request was returned by ${values.action_by} for correction.${values.remarks_note}`,
      infoLabel: values.payment_head,
      infoValue,
      ctaLabel: "Open in Ops",
      ctaUrl: PAYMENT_APPROVALS_URL,
      steps: []
    });
  }
  if (eventType === "payment_reject") {
    return approvalEmailCard({
      eyebrow: "PAYMENT REJECTED",
      heading,
      introduction: `This payment request was rejected by ${values.action_by}.${values.remarks_note}`,
      infoLabel: values.payment_head,
      infoValue,
      ctaLabel: "Open in Ops",
      ctaUrl: PAYMENT_APPROVALS_URL,
      steps: []
    });
  }
  return approvalEmailCard({
    eyebrow: isReminder ? `REMINDER ${reminderNumber}` : "APPROVAL REQUIRED",
    heading,
    introduction: isReminder
      ? `Reminder ${reminderNumber}: this payment request is still waiting for a decision. Please review it and respond.`
      : "This payment request is waiting for a decision.",
    infoLabel: values.payment_head,
    infoValue,
    ctaLabel: "Open in Ops",
    ctaUrl: PAYMENT_APPROVALS_URL,
    steps: [
      `Open Ops: ${PAYMENT_APPROVALS_URL}`,
      "Find the payment request in the approvals list.",
      "Review the amount, payment head and location, then Approve, Return or Reject."
    ],
    footer: isReminder ? "Reminders are sent every 90 minutes until this request is approved, returned or rejected." : undefined
  });
}

export type PaymentEmailEventType = "payment_request" | "payment_approve" | "payment_return" | "payment_reject";

type TemplateRow = {
  body_template: string;
  cc_recipients: string[];
  custom_cc_emails: string[];
  custom_to_emails: string[];
  final_body_template?: string | null;
  final_is_enabled?: boolean | null;
  final_subject_template?: string | null;
  initial_body_template?: string | null;
  initial_is_enabled?: boolean | null;
  initial_subject_template?: string | null;
  is_enabled: boolean;
  subject_template: string;
  to_recipients: string[];
};

export type PaymentEmailResult =
  | { sent: true; cc: string[]; to: string[] }
  | { sent: false; reason: string };

const defaultTemplates: Record<PaymentEmailEventType, Pick<TemplateRow, "subject_template" | "body_template" | "to_recipients" | "cc_recipients">> = {
  payment_request: {
    to_recipients: ["current_approver"],
    cc_recipients: ["requester"],
    subject_template: "Payment approval required · {{request_no}}",
    body_template: "{{requester_name}} requested {{amount}} for {{payment_head}} at {{location_code}}. Open Ops or DropX One to approve or reject."
  },
  payment_approve: {
    to_recipients: ["initial:current_approver", "final:requester"],
    cc_recipients: ["initial:requester", "initial:location_manager", "initial:payment_processor", "final:location_manager", "final:final_approver", "final:payment_processor"],
    subject_template: "Payment approved · {{request_no}}",
    body_template: "{{request_no}} for {{amount}} ({{payment_head}}, {{location_code}}) was approved by {{action_by}}.{{remarks_note}}"
  },
  payment_return: {
    to_recipients: ["requester"],
    cc_recipients: ["location_manager", "current_approver", "final_approver", "payment_processor"],
    subject_template: "Payment returned · {{request_no}}",
    body_template: "{{request_no}} for {{amount}} ({{payment_head}}, {{location_code}}) was returned by {{action_by}} for correction.{{remarks_note}}"
  },
  payment_reject: {
    to_recipients: ["requester"],
    cc_recipients: ["location_manager", "current_approver", "final_approver", "payment_processor"],
    subject_template: "Payment rejected · {{request_no}}",
    body_template: "{{request_no}} for {{amount}} ({{payment_head}}, {{location_code}}) was rejected by {{action_by}}.{{remarks_note}}"
  }
};

const allowedRecipientsByEvent: Record<PaymentEmailEventType, string[]> = {
  payment_request: ["requester", "current_approver", "location_manager", "final_approver", "payment_processor"],
  payment_approve: [
    "requester",
    "location_manager",
    "current_approver",
    "final_approver",
    "payment_processor",
    "initial:requester",
    "initial:location_manager",
    "initial:current_approver",
    "initial:final_approver",
    "initial:payment_processor",
    "final:requester",
    "final:location_manager",
    "final:current_approver",
    "final:final_approver",
    "final:payment_processor"
  ],
  payment_return: ["requester", "location_manager", "current_approver", "final_approver", "payment_processor"],
  payment_reject: ["requester", "location_manager", "current_approver", "final_approver", "payment_processor"]
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function uniqueEmails(values: string[]) {
  return Array.from(new Set(values.map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@"))));
}

function normalizeEmail(value?: string | null) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.includes("@") ? email : null;
}

function render(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

function allowedRecipients(eventType: PaymentEmailEventType, values: string[] | null | undefined) {
  const allowed = new Set(allowedRecipientsByEvent[eventType]);
  return (values ?? []).filter((value) => allowed.has(value));
}

function hasApprovalPhase(values: string[] | null | undefined) {
  return (values ?? []).some((value) => value.startsWith("initial:") || value.startsWith("final:"));
}

function recipientsForApprovalPhase(values: string[] | null | undefined, phase: "initial" | "final") {
  const currentValues = values ?? [];
  if (!hasApprovalPhase(currentValues)) return currentValues;
  return currentValues
    .filter((value) => value.startsWith(`${phase}:`))
    .map((value) => value.slice(phase.length + 1));
}

function emailsForApprovalPhase(values: string[] | null | undefined, phase: "initial" | "final") {
  const currentValues = values ?? [];
  if (!hasApprovalPhase(currentValues)) return currentValues;
  return currentValues
    .filter((value) => value.startsWith(`${phase}:`))
    .map((value) => value.slice(phase.length + 1));
}

async function loadTemplate(companyId: string, eventType: PaymentEmailEventType): Promise<TemplateRow | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("payment_notification_templates")
    .select("is_enabled, initial_is_enabled, final_is_enabled, to_recipients, cc_recipients, custom_to_emails, custom_cc_emails, subject_template, body_template, initial_subject_template, initial_body_template, final_subject_template, final_body_template")
    .eq("company_id", companyId)
    .eq("event_type", eventType)
    .maybeSingle();
  if (error) {
    console.error("Payment email template load failed", error.message);
    return null;
  }
  const defaults = defaultTemplates[eventType];
  const template = {
    is_enabled: false,
    initial_is_enabled: false,
    final_is_enabled: false,
    custom_cc_emails: [],
    custom_to_emails: [],
    ...defaults,
    ...(data ?? {})
  } as TemplateRow;
  return {
    ...template,
    cc_recipients: allowedRecipients(eventType, template.cc_recipients),
    to_recipients: allowedRecipients(eventType, template.to_recipients)
  };
}

function skipped(reason: string): PaymentEmailResult {
  return { sent: false, reason };
}

async function profileById(companyId: string, userId?: string | null) {
  if (!supabaseAdmin || !userId) return null;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, email, role_id, reports_to_user_id")
    .eq("company_id", companyId)
    .eq("id", userId)
    .maybeSingle();
  return data ?? null;
}

async function profileByEmail(companyId: string, email?: string | null) {
  const normalizedEmail = normalizeEmail(email);
  if (!supabaseAdmin || !normalizedEmail) return null;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, full_name, email, role_id, reports_to_user_id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .ilike("email", normalizedEmail)
    .maybeSingle();
  return data ?? null;
}

type PaymentRecipientProfile = {
  email?: string | null;
  id: string;
  reports_to_user_id?: string | null;
  role_id?: string | null;
};

async function profilesForProductRoles(companyId: string, roleIds: string[], locationId?: string | null) {
  if (!supabaseAdmin || !roleIds.length) return [] as PaymentRecipientProfile[];

  const membershipResult = await supabaseAdmin
    .from("company_product_memberships")
    .select("user_id,has_all_location_access,location_scope_ids")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("role_id", roleIds);
  if (membershipResult.error) throw new Error(membershipResult.error.message);

  const scopedUserIds = [...new Set((membershipResult.data ?? [])
    .filter((membership) => (
      !locationId ||
      membership.has_all_location_access ||
      (membership.location_scope_ids ?? []).includes(locationId)
    ))
    .map((membership) => membership.user_id))];

  const [membershipProfiles, legacyProfiles] = await Promise.all([
    scopedUserIds.length
      ? supabaseAdmin.from("profiles")
        .select("id,email,role_id,reports_to_user_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("id", scopedUserIds)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin.from("profiles")
      .select("id,email,role_id,reports_to_user_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("role_id", roleIds)
  ]);
  if (membershipProfiles.error || legacyProfiles.error) {
    throw new Error(membershipProfiles.error?.message ?? legacyProfiles.error?.message ?? "Payment recipients could not be resolved.");
  }

  const profiles = new Map<string, PaymentRecipientProfile>();
  for (const profile of [...(membershipProfiles.data ?? []), ...(legacyProfiles.data ?? [])]) profiles.set(profile.id, profile);
  return [...profiles.values()];
}

async function resolveHierarchyFinalApprovers({
  actorUserId,
  companyId,
  currentApproverUserId,
  finalRoleIds,
  locationId,
  locationManagerEmail,
  requesterUserId
}: {
  actorUserId?: string | null;
  companyId: string;
  currentApproverUserId?: string | null;
  finalRoleIds: string[];
  locationId?: string | null;
  locationManagerEmail?: string | null;
  requesterUserId?: string | null;
}) {
  if (!supabaseAdmin || !finalRoleIds.length) return [];
  const finalRoles = new Set(finalRoleIds);
  const designationApprovers = await profilesForProductRoles(companyId, finalRoleIds, locationId);
  const designationApproverIds = new Set(designationApprovers.map((profile) => profile.id));
  const positionApprover = await findPositionApprover(companyId, finalRoleIds, locationId);
  const startProfiles = [
    await profileById(companyId, positionApprover?.userId),
    await profileById(companyId, currentApproverUserId),
    await profileById(companyId, actorUserId),
    await profileByEmail(companyId, locationManagerEmail),
    await profileById(companyId, requesterUserId)
  ].filter(Boolean) as PaymentRecipientProfile[];

  const checked = new Set<string>();
  for (const startProfile of startProfiles) {
    let profile: typeof startProfile | null = startProfile;
    for (let depth = 0; profile && depth < 20; depth += 1) {
      if (checked.has(profile.id)) break;
      checked.add(profile.id);
      if (designationApproverIds.has(profile.id) || (profile.role_id && finalRoles.has(profile.role_id))) {
        return profile.email ? [profile] : [];
      }
      profile = await profileById(companyId, profile.reports_to_user_id) as typeof startProfile | null;
    }
  }

  // A designation may intentionally have no reporting-line relationship to
  // the requester (for example Finance). The central membership and station
  // scope are still authoritative, so notify the scoped configured owners.
  return designationApprovers.filter((profile) => profile.email);
}

async function resolveRecipientEmails({
  actor,
  currentApprover,
  finalApprovers,
  location,
  paymentProcessors,
  requester,
  selected
}: {
  actor: { email?: string | null } | null;
  currentApprover: { email?: string | null } | null;
  finalApprovers: { email?: string | null }[];
  location: { station_email?: string | null; station_manager_email?: string | null } | null;
  paymentProcessors: { email?: string | null }[];
  requester: { email?: string | null } | null;
  selected: string[];
}) {
  const emails: string[] = [];
  selected.forEach((recipient) => {
    if (recipient === "requester" && requester?.email) emails.push(requester.email);
    if (recipient === "current_approver" && currentApprover?.email) emails.push(currentApprover.email);
    if (recipient === "approver" && actor?.email) emails.push(actor.email);
    if (recipient === "final_approver") finalApprovers.forEach((user) => user.email ? emails.push(user.email) : null);
    if (recipient === "payment_processor") paymentProcessors.forEach((user) => user.email ? emails.push(user.email) : null);
    if (recipient === "location_email" && location?.station_email) emails.push(location.station_email);
    if (recipient === "location_manager" && location?.station_manager_email) emails.push(location.station_manager_email);
  });
  return uniqueEmails(emails);
}

export async function sendPaymentNotification({
  actorUserId,
  companyId,
  eventType,
  remarks,
  requestId
}: {
  actorUserId?: string | null;
  companyId: string;
  eventType: PaymentEmailEventType;
  remarks?: string | null;
  requestId: string;
}): Promise<PaymentEmailResult> {
  try {
    if (!supabaseAdmin) return skipped("Supabase service role key is not configured.");
    const template = await loadTemplate(companyId, eventType);
    if (!template) return skipped("Payment email template is not configured.");

    const { data: request, error: requestError } = await supabaseAdmin
      .from("payment_requests")
      .select(`
        id,
        request_no,
        location_id,
        location_code,
        payment_head_id,
        amount,
        status,
        approval_status,
        requested_by,
        current_approver_user_id,
        final_approval_role_id,
        final_approval_role_ids,
        payment_process_role_ids,
        email_root_message_id,
        email_last_message_id,
        email_send_count,
        payment_heads ( name, code )
      `)
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle();
    if (requestError || !request) throw new Error(requestError?.message ?? "Payment request not found.");

    const finalRoleIds = (request.final_approval_role_ids?.length ? request.final_approval_role_ids : request.final_approval_role_id ? [request.final_approval_role_id] : []) as string[];
    const paymentProcessRoleIds = (request.payment_process_role_ids ?? []) as string[];
    const [requester, actor, currentApprover, locationResult, companyResult, paymentProcessors] = await Promise.all([
      profileById(companyId, request.requested_by),
      profileById(companyId, actorUserId),
      profileById(companyId, request.current_approver_user_id),
      request.location_id
        ? supabaseAdmin.from("stations").select("station_code, station_email, station_manager_email").eq("company_id", companyId).eq("id", request.location_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabaseAdmin.from("companies").select("name").eq("id", companyId).maybeSingle(),
      profilesForProductRoles(companyId, paymentProcessRoleIds, request.location_id)
    ]);
    const finalApprovers = await resolveHierarchyFinalApprovers({
      actorUserId,
      companyId,
      currentApproverUserId: request.current_approver_user_id,
      finalRoleIds,
      locationId: request.location_id,
      locationManagerEmail: locationResult.data?.station_manager_email,
      requesterUserId: request.requested_by
    });

    const paymentHead = firstRelation(request.payment_heads);
    const values = {
      action_by: clean(actor?.full_name || actor?.email || "-"),
      amount: request.amount == null ? "-" : `Rs ${Number(request.amount).toLocaleString("en-IN")}`,
      company_name: clean(companyResult.data?.name || "DropX"),
      location_code: clean(request.location_code || locationResult.data?.station_code || "-"),
      payment_head: clean(paymentHead?.name || paymentHead?.code || "-"),
      remarks: clean(remarks || "-"),
      remarks_note: clean(remarks) ? ` Remarks: ${clean(remarks)}` : "",
      request_no: clean(request.request_no || "-"),
      requester_name: clean(requester?.full_name || requester?.email || "-"),
      status: clean(request.approval_status || request.status || "-")
    };

    const approvalPhase = eventType === "payment_approve" && request.current_approver_user_id ? "initial" : "final";
    const isTemplateEnabled = eventType === "payment_approve"
      ? approvalPhase === "initial"
        ? Boolean(template.initial_is_enabled)
        : Boolean(template.final_is_enabled)
      : template.is_enabled;
    if (!isTemplateEnabled) return skipped("Payment email template is disabled.");
    const selectedToRecipients = eventType === "payment_approve"
      ? recipientsForApprovalPhase(template.to_recipients, approvalPhase)
      : template.to_recipients ?? [];
    const selectedCcRecipients = eventType === "payment_approve"
      ? recipientsForApprovalPhase(template.cc_recipients, approvalPhase)
      : template.cc_recipients ?? [];
    const selectedCustomToEmails = eventType === "payment_approve"
      ? emailsForApprovalPhase(template.custom_to_emails, approvalPhase)
      : template.custom_to_emails ?? [];
    const selectedCustomCcEmails = eventType === "payment_approve"
      ? emailsForApprovalPhase(template.custom_cc_emails, approvalPhase)
      : template.custom_cc_emails ?? [];
    const actorEmail = normalizeEmail(actor?.email);
    const to = uniqueEmails([
      ...(await resolveRecipientEmails({ actor, currentApprover, finalApprovers, location: locationResult.data, paymentProcessors, requester, selected: selectedToRecipients })),
      ...selectedCustomToEmails
    ]).filter((email) => email !== actorEmail);
    const cc = uniqueEmails([
      ...(await resolveRecipientEmails({ actor, currentApprover, finalApprovers, location: locationResult.data, paymentProcessors, requester, selected: selectedCcRecipients })),
      ...selectedCustomCcEmails
    ]).filter((email) => email !== actorEmail && !to.includes(email));

    if (!to.length) return skipped("No To recipients were resolved for this payment email.");
    const subjectTemplate = eventType === "payment_approve"
      ? approvalPhase === "initial"
        ? template.initial_subject_template || template.subject_template
        : template.final_subject_template || template.subject_template
      : template.subject_template;
    const bodyTemplate = eventType === "payment_approve"
      ? approvalPhase === "initial"
        ? template.initial_body_template || template.body_template
        : template.final_body_template || template.body_template
      : template.body_template;
    const messageId = `<dropx.payment.${request.id}.${(request.email_send_count ?? 0) + 1}@partner.dropxlogistics.com>`;
    const lastMessageId = request.email_last_message_id ?? null;
    const rootMessageId = request.email_root_message_id ?? null;
    const result = await sendEmail({
      body: render(bodyTemplate, values),
      html: paymentEmailHtml(eventType, values),
      cc,
      companyId,
      subject: render(subjectTemplate, values),
      to,
      messageId,
      inReplyTo: lastMessageId ?? undefined,
      references: lastMessageId ? [...new Set([rootMessageId, lastMessageId].filter((id): id is string => Boolean(id)))] : undefined
    });
    await supabaseAdmin.from("payment_requests").update({
      email_root_message_id: rootMessageId ?? result.messageId ?? messageId,
      email_last_message_id: result.messageId ?? messageId,
      email_send_count: (request.email_send_count ?? 0) + 1,
      // A decision (approve/reject/return) closes the thread; only a still-pending
      // request should get another reminder scheduled.
      email_next_reminder_at: eventType === "payment_request" && request.current_approver_user_id ? new Date(Date.now() + 90 * 60_000).toISOString() : null
    }).eq("company_id", companyId).eq("id", request.id);
    return { sent: true, cc, to };
  } catch (error) {
    console.error("Payment email notification failed", error);
    return skipped(error instanceof Error ? error.message : "Payment email notification failed.");
  }
}

/**
 * A 90-minute reminder for a payment request still awaiting its current
 * approver. Reuses the same recipient resolution as the initial
 * payment_request email (the request hasn't moved, so the same people are
 * still waiting), but always threads onto the existing conversation - never
 * a fresh email - and is skipped once the request is no longer pending.
 */
export async function sendPaymentApprovalReminder(companyId: string, requestId: string): Promise<PaymentEmailResult> {
  try {
    if (!supabaseAdmin) return skipped("Supabase service role key is not configured.");
    const template = await loadTemplate(companyId, "payment_request");
    if (!template?.is_enabled) return skipped("Payment email template is disabled.");

    const { data: request, error: requestError } = await supabaseAdmin
      .from("payment_requests")
      .select(`
        id, request_no, location_id, location_code, payment_head_id, amount, status, approval_status,
        requested_by, current_approver_user_id, payment_process_role_ids, final_approval_role_id, final_approval_role_ids,
        email_root_message_id, email_last_message_id, email_send_count,
        payment_heads ( name, code )
      `)
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle();
    if (requestError || !request) throw new Error(requestError?.message ?? "Payment request not found.");
    if (!["pending", "resubmitted"].includes(String(request.status)) || !request.current_approver_user_id) {
      await supabaseAdmin.from("payment_requests").update({ email_next_reminder_at: null }).eq("company_id", companyId).eq("id", request.id);
      return skipped("This payment request is no longer awaiting approval.");
    }

    const finalRoleIds = (request.final_approval_role_ids?.length ? request.final_approval_role_ids : request.final_approval_role_id ? [request.final_approval_role_id] : []) as string[];
    const paymentProcessRoleIds = (request.payment_process_role_ids ?? []) as string[];
    const [requester, currentApprover, locationResult, companyResult, paymentProcessors] = await Promise.all([
      profileById(companyId, request.requested_by),
      profileById(companyId, request.current_approver_user_id),
      request.location_id
        ? supabaseAdmin.from("stations").select("station_code, station_email, station_manager_email").eq("company_id", companyId).eq("id", request.location_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabaseAdmin.from("companies").select("name").eq("id", companyId).maybeSingle(),
      profilesForProductRoles(companyId, paymentProcessRoleIds, request.location_id)
    ]);
    const finalApprovers = await resolveHierarchyFinalApprovers({
      companyId, currentApproverUserId: request.current_approver_user_id, finalRoleIds,
      locationId: request.location_id, locationManagerEmail: locationResult.data?.station_manager_email, requesterUserId: request.requested_by
    });

    const paymentHead = firstRelation(request.payment_heads);
    const values = {
      action_by: "-",
      amount: request.amount == null ? "-" : `Rs ${Number(request.amount).toLocaleString("en-IN")}`,
      company_name: clean(companyResult.data?.name || "DropX"),
      location_code: clean(request.location_code || locationResult.data?.station_code || "-"),
      payment_head: clean(paymentHead?.name || paymentHead?.code || "-"),
      remarks: "-",
      request_no: clean(request.request_no || "-"),
      requester_name: clean(requester?.full_name || requester?.email || "-"),
      status: clean(request.approval_status || request.status || "-")
    };

    const to = uniqueEmails(await resolveRecipientEmails({
      actor: null, currentApprover, finalApprovers, location: locationResult.data, paymentProcessors, requester,
      selected: template.to_recipients ?? []
    }));
    if (!to.length) return skipped("No To recipients were resolved for this payment reminder.");
    const cc = uniqueEmails(await resolveRecipientEmails({
      actor: null, currentApprover, finalApprovers, location: locationResult.data, paymentProcessors, requester,
      selected: template.cc_recipients ?? []
    })).filter((email) => !to.includes(email));

    const reminderNumber = request.email_send_count ?? 1;
    const subject = `Reminder ${reminderNumber}: ${render(template.subject_template, values)}`;
    const body = `This request is still waiting for a decision. Please review it and respond.\n\n${render(template.body_template, values)}`;
    const messageId = `<dropx.payment.${request.id}.${(request.email_send_count ?? 0) + 1}@partner.dropxlogistics.com>`;
    const lastMessageId = request.email_last_message_id ?? null;
    const rootMessageId = request.email_root_message_id ?? null;
    const result = await sendEmail({
      body, cc, companyId, subject, to,
      html: paymentEmailHtml("payment_request", values, reminderNumber),
      messageId,
      inReplyTo: lastMessageId ?? undefined,
      references: lastMessageId ? [...new Set([rootMessageId, lastMessageId].filter((id): id is string => Boolean(id)))] : undefined
    });
    await supabaseAdmin.from("payment_requests").update({
      email_root_message_id: rootMessageId ?? result.messageId ?? messageId,
      email_last_message_id: result.messageId ?? messageId,
      email_send_count: (request.email_send_count ?? 0) + 1,
      email_next_reminder_at: new Date(Date.now() + 90 * 60_000).toISOString()
    }).eq("company_id", companyId).eq("id", request.id);
    return { sent: true, cc, to };
  } catch (error) {
    console.error("Payment reminder email failed", error);
    return skipped(error instanceof Error ? error.message : "Payment reminder email failed.");
  }
}

export { defaultTemplates as paymentEmailDefaultTemplates };
