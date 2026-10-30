import { supabaseAdmin } from "@/lib/supabase-admin";
import { extractWhatsAppTemplateVariables, type WhatsAppTemplateComponent } from "@/lib/whatsapp-template";
import { workforceOnboardingEventCode } from "@/lib/whatsapp-onboarding";
import {
  isDuplicateCampaignCodeError,
  nextOnboardingCampaignCodeFallback
} from "@/lib/whatsapp-onboarding-campaign-code";

type OnboardingMessageData = {
  companyId: string;
  workerId: string;
  workerType: "employee" | "field_executive" | "contractor" | "vendor" | "worker";
  workforceCategoryCode: string;
  fullName: string;
  mobile: string;
  dropxId: string;
  biometricId: string;
  dateOfJoin: string;
  locationCode: string;
  locationName: string;
  providerName: string;
  registrationToken: string;
  triggeredBy?: string | null;
};

type FieldExecutiveOnboardingMessageData = Omit<OnboardingMessageData, "workerId" | "workerType"> & {
  fieldExecutiveId: string;
};

type EmployeeOnboardingMessageData = Omit<OnboardingMessageData, "workerId" | "workerType" | "workforceCategoryCode" | "registrationToken"> & {
  employeeId: string;
  registrationToken?: string;
};

function mappedValue(source: string, data: Record<string, string>) {
  return data[source] ?? "";
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function writeLog(payload: Record<string, unknown>) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("whatsapp_message_logs").insert(payload);
}

function renderTemplateText(components: WhatsAppTemplateComponent[], mappings: Record<string, string>, values: Record<string, string>, fallback: string) {
  const lines = components
    .filter((component) => ["HEADER", "BODY"].includes(String(component.type ?? "").toUpperCase()) && component.text)
    .map((component) => {
      const normalizedType = String(component.type ?? "").toLowerCase();
      return String(component.text ?? "").replace(/\{\{(\d+)\}\}/g, (_, position: string) => mappedValue(mappings[`${normalizedType}.${position}`], values));
    })
    .filter(Boolean);
  return lines.join("\n\n").trim() || `[${fallback}]`;
}

async function nextOnboardingCampaignCode(companyId: string) {
  if (!supabaseAdmin) return `ONBOARD-${Date.now()}`;
  const result = await supabaseAdmin.rpc("next_onboarding_campaign_code");
  if (!result.error && result.data) return String(result.data);
  // Fallback when the sequence RPC is missing: derive max(ONBOARD-N)+1 for this company.
  const existing = await supabaseAdmin
    .from("whatsapp_campaigns")
    .select("campaign_code")
    .eq("company_id", companyId)
    .like("campaign_code", "ONBOARD-%");
  if (existing.error) return `ONBOARD-${Date.now()}`;
  return nextOnboardingCampaignCodeFallback((existing.data ?? []).map((row) => row.campaign_code));
}

async function syncAutoTriggerToInbox({
  companyId,
  profile,
  recipient,
  contactName,
  messageText,
  providerMessageId,
  status,
  requestPayload,
  responsePayload,
  campaignCode,
  triggeredBy
}: {
  companyId: string;
  profile: { id: string; profile_name: string | null };
  recipient: string;
  contactName: string;
  messageText: string;
  providerMessageId: string | null;
  status: "sent" | "failed";
  requestPayload: Record<string, unknown>;
  responsePayload: unknown;
  campaignCode: string;
  triggeredBy?: string | null;
}) {
  if (!supabaseAdmin || !recipient) return;
  const now = new Date().toISOString();
  const existingConversation = await supabaseAdmin
    .from("inbox_conversations")
    .select("id, status")
    .eq("company_id", companyId)
    .eq("channel", "whatsapp")
    .eq("whatsapp_profile_id", profile.id)
    .eq("contact_external_id", recipient)
    .maybeSingle();
  if (existingConversation.error) throw new Error(existingConversation.error.message);

  const conversationPayload = {
      company_id: companyId,
      channel: "whatsapp",
      whatsapp_profile_id: profile.id,
      whatsapp_profile_name: profile.profile_name,
      contact_external_id: recipient,
      contact_name: contactName,
      contact_phone: recipient,
      last_message_preview: messageText,
      last_message_at: now,
      updated_at: now
  };
  const conversationResult = existingConversation.data
    ? await supabaseAdmin
      .from("inbox_conversations")
      .update(conversationPayload)
      .eq("id", existingConversation.data.id)
      .eq("company_id", companyId)
      .select("id")
      .single()
    : await supabaseAdmin
      .from("inbox_conversations")
      .insert({ ...conversationPayload, status: "closed" })
    .select("id")
    .single();
  if (conversationResult.error) throw new Error(conversationResult.error.message);

  const insertResult = await supabaseAdmin.from("inbox_messages").insert({
    company_id: companyId,
    conversation_id: conversationResult.data.id,
    channel: "whatsapp",
    whatsapp_profile_id: profile.id,
    direction: "outgoing",
    provider_message_id: providerMessageId,
    message_type: "template",
    message_text: messageText,
    contact_external_id: recipient,
    contact_name: contactName,
    contact_phone: recipient,
    payload: {
      request: requestPayload,
      response: responsePayload,
      campaign_code: campaignCode,
      auto_trigger: "onboarding",
      sender_name: "System",
      sender_user_id: triggeredBy ?? null
    },
    status,
    message_timestamp: now
  });
  if (insertResult.error && !insertResult.error.message.toLowerCase().includes("duplicate")) {
    throw new Error(insertResult.error.message);
  }
}

async function sendOnboardingWhatsApp(data: OnboardingMessageData) {
  if (!supabaseAdmin) return;
  const eventCode = workforceOnboardingEventCode(data.workforceCategoryCode);
  let recipient = data.mobile;
  let templateName: string | null = null;
  let campaignId: string | null = null;
  let campaignCode: string | null = null;
  let campaignProfile: { id: string; profile_name: string | null; default_country_code: string } | null = null;
  let requestPayloadForFailure: Record<string, unknown> | null = null;
  let responsePayloadForFailure: unknown = null;
  let campaignFinalized = false;
  try {
    const [settings, config] = await Promise.all([
      supabaseAdmin.from("whatsapp_settings").select("is_enabled").eq("company_id", data.companyId).eq("id", true).maybeSingle(),
      supabaseAdmin
        .from("whatsapp_notification_configs")
        .select("is_enabled, whatsapp_profile_id, template_id, template_name, template_language, variable_mappings")
        .eq("company_id", data.companyId)
        .eq("event_code", eventCode)
        .maybeSingle()
    ]);
    if (settings.error) throw new Error(settings.error.message);
    if (config.error) throw new Error(config.error.message);
    if (!settings.data?.is_enabled || !config.data?.is_enabled) {
      await writeLog({ event_code: eventCode, field_executive_id: data.workerType === "field_executive" ? data.workerId : null, recipient, template_name: config.data?.template_name, status: "skipped", error_message: "WhatsApp or onboarding notification is disabled." });
      return;
    }
    if (!config.data.whatsapp_profile_id || !config.data.template_id || !config.data.template_name || !config.data.template_language) throw new Error("WhatsApp onboarding configuration is incomplete.");
    const [profileResult, profileTokenResult] = await Promise.all([
      supabaseAdmin.from("whatsapp_profiles").select("id, profile_name, phone_number_id, graph_api_version, default_country_code, is_active").eq("company_id", data.companyId).eq("id", config.data.whatsapp_profile_id).single(),
      supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: config.data.whatsapp_profile_id })
    ]);
    if (profileResult.error) throw new Error(profileResult.error.message);
    if (profileTokenResult.error) throw new Error(profileTokenResult.error.message);
    const profile = profileResult.data;
    if (!profile?.is_active || !profile.phone_number_id || !profile.graph_api_version || !profileTokenResult.data) throw new Error("Selected WhatsApp profile is incomplete or inactive.");
    templateName = config.data.template_name;

    const template = await supabaseAdmin
      .from("whatsapp_template_cache")
      .select("components")
      .eq("company_id", data.companyId)
      .eq("template_id", config.data.template_id)
      .eq("whatsapp_profile_id", profile.id)
      .single();
    if (template.error) throw new Error(template.error.message);
    const components = (template.data.components ?? []) as WhatsAppTemplateComponent[];
    const variables = extractWhatsAppTemplateVariables(components);
    const mappings = (config.data.variable_mappings ?? {}) as Record<string, string>;
    const registrationLink = data.registrationToken
      ? `https://dashboard.dropxlogistics.com/register/${encodeURIComponent(data.registrationToken)}`
      : (process.env.NEXT_PUBLIC_CONNECT_WEB_URL || "https://team.dropxlogistics.com/account/register");
    const values: Record<string, string> = {
      full_name: data.fullName,
      mobile: data.mobile,
      dropx_id: data.dropxId,
      biometric_id: data.biometricId,
      date_of_join: data.dateOfJoin,
      location_code: data.locationCode,
      location_name: data.locationName,
      provider_name: data.providerName,
      registration_link: registrationLink
    };

    const messageComponents: Array<Record<string, unknown>> = [];
    (["header", "body"] as const).forEach((componentType) => {
      const componentVariables = variables.filter((variable) => variable.component === componentType).sort((a, b) => a.position - b.position);
      if (!componentVariables.length) return;
      messageComponents.push({
        type: componentType,
        parameters: componentVariables.map((variable) => ({ type: "text", text: mappedValue(mappings[variable.key], values) }))
      });
    });
    variables.filter((variable) => variable.component === "button").forEach((variable) => {
      messageComponents.push({
        type: "button",
        sub_type: "url",
        index: String(variable.buttonIndex ?? 0),
        parameters: [{ type: "text", text: mappedValue(mappings[variable.key], values) }]
      });
    });

    const countryCode = profile.default_country_code.replace(/\D/g, "");
    recipient = data.mobile.startsWith(countryCode) && data.mobile.length > 10 ? data.mobile : `${countryCode}${data.mobile}`;
    const requestPayload = {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: { name: templateName, language: { code: config.data.template_language }, components: messageComponents }
    };
    requestPayloadForFailure = requestPayload;
    campaignProfile = { id: profile.id, profile_name: profile.profile_name, default_country_code: profile.default_country_code };
    campaignCode = await nextOnboardingCampaignCode(data.companyId);
    const campaignRow = {
      company_id: data.companyId,
      campaign_code: campaignCode,
      source_mode: "auto_onboarding",
      whatsapp_profile_id: profile.id,
      whatsapp_profile_name: profile.profile_name,
      template_id: config.data.template_id,
      template_name: templateName,
      template_language: config.data.template_language,
      variable_mappings: config.data.variable_mappings ?? {},
      total_count: 1,
      sent_count: 0,
      failed_count: 0,
      pending_count: 1,
      status: "processing",
      created_by: data.triggeredBy ?? null,
      started_at: new Date().toISOString()
    };
    let campaignResult = await supabaseAdmin.from("whatsapp_campaigns").insert(campaignRow).select("id").single();
    // Concurrent invites can still race the fallback allocator; one unique retry
    // keeps DropX ID / biometric WhatsApp from dying on campaign_code alone.
    if (campaignResult.error && isDuplicateCampaignCodeError(campaignResult.error.message)) {
      campaignCode = `ONBOARD-${Date.now()}`;
      campaignResult = await supabaseAdmin.from("whatsapp_campaigns")
        .insert({ ...campaignRow, campaign_code: campaignCode })
        .select("id").single();
    }
    if (campaignResult.error) throw new Error(campaignResult.error.message);
    campaignId = campaignResult.data.id;

    const response = await fetch(`https://graph.facebook.com/${profile.graph_api_version}/${profile.phone_number_id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${profileTokenResult.data}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload)
    });
    const responsePayload = await response.json() as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    responsePayloadForFailure = responsePayload;
    if (!response.ok) throw new Error(responsePayload.error?.message || "Meta rejected the WhatsApp message.");
    const providerMessageId = responsePayload.messages?.[0]?.id ?? null;
    const now = new Date().toISOString();

    const recipientResult = await supabaseAdmin.from("whatsapp_campaign_recipients").insert({
      company_id: data.companyId,
      campaign_id: campaignId,
      row_no: 1,
      recipient_name: data.fullName,
      recipient_mobile: data.mobile,
      country_code: profile.default_country_code,
      source: data.workerType,
      source_id: data.workerId,
      recipient_payload: {
        worker_id: data.workerId,
        worker_type: data.workerType,
        full_name: data.fullName,
        dropx_id: data.dropxId,
        location_code: data.locationCode,
        location_name: data.locationName,
        provider_name: data.providerName
      },
      status: "sent",
      provider_message_id: providerMessageId,
      request_payload: requestPayload,
      response_payload: responsePayload,
      sent_at: now,
      submitted_at: now,
      updated_at: now
    });
    if (recipientResult.error) throw new Error(recipientResult.error.message);

    await supabaseAdmin.from("whatsapp_campaigns").update({
      sent_count: 1,
      failed_count: 0,
      pending_count: 0,
      status: "completed",
      completed_at: now,
      updated_at: now
    }).eq("id", campaignId);
    campaignFinalized = true;

    await syncAutoTriggerToInbox({
      companyId: data.companyId,
      profile,
      recipient,
      contactName: data.fullName,
      messageText: renderTemplateText(components, mappings, values, templateName ?? "WhatsApp template"),
      providerMessageId,
      status: "sent",
      requestPayload,
      responsePayload,
      campaignCode: campaignCode ?? "",
      triggeredBy: data.triggeredBy
    });

    await writeLog({
      event_code: eventCode,
      field_executive_id: data.workerType === "field_executive" ? data.workerId : null,
      whatsapp_profile_id: profile.id,
      whatsapp_profile_name: profile.profile_name,
      recipient,
      template_name: templateName,
      status: "sent",
      provider_message_id: providerMessageId,
      request_payload: { template: templateName, campaign_code: campaignCode, mapped_variables: Object.keys(mappings) },
      response_payload: responsePayload
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unable to send WhatsApp message.";
    if (campaignId && !campaignFinalized) {
      const now = new Date().toISOString();
      await supabaseAdmin.from("whatsapp_campaign_recipients").insert({
        company_id: data.companyId,
        campaign_id: campaignId,
        row_no: 1,
        recipient_name: data.fullName,
        recipient_mobile: data.mobile,
        country_code: campaignProfile?.default_country_code ?? null,
        source: data.workerType,
        source_id: data.workerId,
        recipient_payload: {
          worker_id: data.workerId,
          worker_type: data.workerType,
          full_name: data.fullName,
          dropx_id: data.dropxId,
          location_code: data.locationCode,
          location_name: data.locationName,
          provider_name: data.providerName
        },
        status: "failed",
        error_message: errorMessage,
        request_payload: requestPayloadForFailure ?? {},
        response_payload: responsePayloadForFailure,
        failed_at: now,
        updated_at: now
      });
      await supabaseAdmin.from("whatsapp_campaigns").update({
        sent_count: 0,
        failed_count: 1,
        pending_count: 0,
        status: "failed",
        completed_at: now,
        updated_at: now
      }).eq("id", campaignId);
    }
    await writeLog({
      event_code: eventCode,
      field_executive_id: data.workerType === "field_executive" ? data.workerId : null,
      whatsapp_profile_id: campaignProfile?.id,
      whatsapp_profile_name: campaignProfile?.profile_name,
      recipient,
      template_name: templateName,
      status: "failed",
      error_message: errorMessage,
      request_payload: { campaign_code: campaignCode, request: requestPayloadForFailure },
      response_payload: responsePayloadForFailure
    });
  }
}

export async function sendFieldExecutiveOnboardingWhatsApp(data: FieldExecutiveOnboardingMessageData) {
  await sendOnboardingWhatsApp({
    ...data,
    workerId: data.fieldExecutiveId,
    workerType: data.workforceCategoryCode === "contractors" ? "contractor"
      : data.workforceCategoryCode === "vendors" ? "vendor"
        : data.workforceCategoryCode === "workers" ? "worker"
          : "field_executive"
  });
}

export async function sendEmployeeOnboardingWhatsApp(data: EmployeeOnboardingMessageData) {
  await sendOnboardingWhatsApp({
    ...data,
    registrationToken: data.registrationToken ?? "",
    workerId: data.employeeId,
    workerType: "employee",
    workforceCategoryCode: "employees"
  });
}
