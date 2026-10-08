import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { webhookCompanyId } from "@/lib/webhook-company";

type WhatsAppStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ title?: string; message?: string; error_data?: { details?: string } }>;
};

type WhatsAppIncomingMessage = {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  sticker?: { id?: string; mime_type?: string };
};

type WhatsAppContact = {
  profile?: { name?: string };
  wa_id?: string;
};

type WhatsAppWebhookValue = {
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppIncomingMessage[];
  statuses?: WhatsAppStatus[];
};

type WhatsAppWebhookPayload = {
  value?: WhatsAppWebhookValue;
  statuses?: WhatsAppStatus[];
  entry?: Array<{
    changes?: Array<{
      value?: WhatsAppWebhookValue;
    }>;
  }>;
};

type IncomingEnvelope = {
  value: WhatsAppWebhookValue;
  message: WhatsAppIncomingMessage;
};

function extractStatuses(payload: WhatsAppWebhookPayload) {
  const envelopeStatuses = (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .flatMap((change) => change.value?.statuses ?? []);
  return [
    ...envelopeStatuses,
    ...(payload.value?.statuses ?? []),
    ...(payload.statuses ?? [])
  ].filter((status) => status.id && status.status);
}

function extractIncomingMessages(payload: WhatsAppWebhookPayload): IncomingEnvelope[] {
  const values = [
    ...(payload.entry ?? []).flatMap((entry) => entry.changes ?? []).map((change) => change.value),
    payload.value
  ].filter(Boolean) as WhatsAppWebhookValue[];

  return values.flatMap((value) => (value.messages ?? [])
    .filter((message) => message.from)
    .map((message) => ({ value, message })));
}

function timestampToIso(timestamp: string | undefined) {
  if (!timestamp) return new Date().toISOString();
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric)) return new Date().toISOString();
  return new Date(numeric * 1000).toISOString();
}

function errorText(status: WhatsAppStatus) {
  return status.errors?.map((error) => error.message || error.error_data?.details || error.title).filter(Boolean).join("; ") || null;
}

function renderGreeting(template: string, params: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => params[key] ?? "");
}

function incomingMessageText(message: WhatsAppIncomingMessage) {
  if (message.text?.body) return message.text.body;
  if (message.image?.caption) return message.image.caption;
  if (message.document?.caption) return message.document.caption;
  if (message.video?.caption) return message.video.caption;
  return "";
}

function incomingPreview(message: WhatsAppIncomingMessage) {
  const text = incomingMessageText(message);
  if (text) return text;
  if (message.document?.filename) return message.document.filename;
  return `[${message.type ?? "message"}]`;
}

async function sendGreeting(envelope: IncomingEnvelope, companyId: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const phoneNumberId = envelope.value.metadata?.phone_number_id;
  if (!phoneNumberId) return { sent: false, reason: "missing_phone_number_id" };

  let profileQuery = supabaseAdmin
    .from("whatsapp_profiles")
    .select("id, company_id, profile_name, phone_number_id, graph_api_version, default_country_code, is_active, greeting_enabled, greeting_message")
    .eq("phone_number_id", phoneNumberId)
    .eq("is_active", true)
    .eq("greeting_enabled", true);
  if (companyId) profileQuery = profileQuery.eq("company_id", companyId);
  const profileResult = await profileQuery.maybeSingle();
  if (profileResult.error) throw new Error(profileResult.error.message);
  const profile = profileResult.data;
  if (!profile?.greeting_message) return { sent: false, reason: "not_enabled" };

  const tokenResult = await supabaseAdmin.rpc("get_whatsapp_profile_access_token", { profile_id: profile.id });
  if (tokenResult.error) throw new Error(tokenResult.error.message);
  if (!tokenResult.data) return { sent: false, reason: "missing_token" };

  const contact = (envelope.value.contacts ?? []).find((item) => item.wa_id === envelope.message.from) ?? envelope.value.contacts?.[0];
  const body = renderGreeting(profile.greeting_message, {
    contact_name: contact?.profile?.name ?? "",
    wa_id: contact?.wa_id ?? envelope.message.from ?? "",
    from: envelope.message.from ?? "",
    message_text: envelope.message.text?.body ?? "",
    profile_name: profile.profile_name ?? "",
    phone_number_id: profile.phone_number_id ?? "",
    display_phone_number: envelope.value.metadata?.display_phone_number ?? ""
  }).trim();
  if (!body) return { sent: false, reason: "blank_message" };

  const response = await fetch(`https://graph.facebook.com/${profile.graph_api_version}/${profile.phone_number_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenResult.data}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: envelope.message.from,
      type: "text",
      text: { preview_url: false, body }
    })
  });
  const payload = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message || "Meta rejected the greeting message.");
  return { sent: true, reason: "sent" };
}

async function saveIncomingMessage(envelope: IncomingEnvelope, companyId: string | null) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const phoneNumberId = envelope.value.metadata?.phone_number_id ?? null;
  let profileQuery = phoneNumberId
    ? supabaseAdmin
      .from("whatsapp_profiles")
      .select("id, company_id, profile_name")
      .eq("phone_number_id", phoneNumberId)
    : null;
  if (profileQuery && companyId) profileQuery = profileQuery.eq("company_id", companyId);
  const profileResult = profileQuery ? await profileQuery.maybeSingle() : { data: null, error: null };
  if (profileResult.error) throw new Error(profileResult.error.message);
  const profile = profileResult.data;
  if (!profile?.company_id) return { saved: false, reason: "profile_not_found" };

  const messageId = envelope.message.id ?? null;
  if (messageId) {
    const existingMessage = await supabaseAdmin
      .from("inbox_messages")
      .select("id")
      .eq("company_id", profile.company_id)
      .eq("provider_message_id", messageId)
      .maybeSingle();
    if (existingMessage.error) throw new Error(existingMessage.error.message);
    if (existingMessage.data) return { saved: false, reason: "duplicate" };
  }

  const contact = (envelope.value.contacts ?? []).find((item) => item.wa_id === envelope.message.from) ?? envelope.value.contacts?.[0];
  const contactExternalId = contact?.wa_id ?? envelope.message.from;
  if (!contactExternalId) return { saved: false, reason: "missing_contact" };
  const messageType = envelope.message.type ?? "unknown";
  const messageText = incomingMessageText(envelope.message);
  const preview = incomingPreview(envelope.message);
  const messageTimestamp = timestampToIso(envelope.message.timestamp);

  const conversationResult = await supabaseAdmin
    .from("inbox_conversations")
    .upsert({
      company_id: profile.company_id,
      channel: "whatsapp",
      whatsapp_profile_id: profile.id,
      whatsapp_profile_name: profile.profile_name ?? null,
      contact_external_id: contactExternalId,
      contact_name: contact?.profile?.name ?? null,
      contact_phone: envelope.message.from ?? contactExternalId,
      status: "open",
      last_message_preview: preview,
      last_message_at: messageTimestamp,
      updated_at: new Date().toISOString()
    }, { onConflict: "channel,whatsapp_profile_id,contact_external_id" })
    .select("id, unread_count")
    .single();
  if (conversationResult.error) throw new Error(conversationResult.error.message);

  const insertResult = await supabaseAdmin.from("inbox_messages").insert({
    company_id: profile.company_id,
    conversation_id: conversationResult.data.id,
    channel: "whatsapp",
    whatsapp_profile_id: profile.id,
    direction: "incoming",
    provider_message_id: messageId,
    message_type: messageType,
    message_text: messageText || null,
    contact_external_id: contactExternalId,
    contact_name: contact?.profile?.name ?? null,
    contact_phone: envelope.message.from ?? contactExternalId,
    payload: envelope.message,
    status: "received",
    message_timestamp: messageTimestamp
  });
  if (insertResult.error) throw new Error(insertResult.error.message);

  await supabaseAdmin
    .from("inbox_conversations")
    .update({
      unread_count: (conversationResult.data.unread_count ?? 0) + 1,
      last_message_preview: preview,
      last_message_at: messageTimestamp,
      updated_at: new Date().toISOString()
    })
    .eq("company_id", profile.company_id)
    .eq("id", conversationResult.data.id);

  return { saved: true, reason: "saved" };
}

async function configuredVerifyToken(companyId: string | null) {
  if (!supabaseAdmin) return null;
  if (!companyId) return null;
  const { data, error } = await supabaseAdmin
    .from("whatsapp_settings")
    .select("webhook_verify_token")
    .eq("company_id", companyId)
    .eq("id", true)
    .maybeSingle();
  if (error) return null;
  return data?.webhook_verify_token ? String(data.webhook_verify_token) : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expectedToken = await configuredVerifyToken(webhookCompanyId(request));

  if (mode === "subscribe" && challenge && expectedToken && token === expectedToken) {
    return new Response(challenge, { status: 200 });
  }

  return new Response("Webhook verification failed", { status: 403 });
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const companyId = webhookCompanyId(request);
    const payload = await request.json() as WhatsAppWebhookPayload;
    const statuses = extractStatuses(payload);
    const incomingMessages = extractIncomingMessages(payload);
    let updated = 0;
    const unmatched: string[] = [];
    let incomingSaved = 0;
    let greetingsSent = 0;
    const greetingSkipped: string[] = [];

    for (const status of statuses) {
      const statusName = String(status.status);
      const happenedAt = timestampToIso(status.timestamp);
      const update: Record<string, unknown> = {
        status: statusName,
        webhook_payload: status,
        updated_at: new Date().toISOString()
      };

      if (statusName === "sent") update.submitted_at = happenedAt;
      if (statusName === "delivered") update.delivered_at = happenedAt;
      if (statusName === "read") update.read_at = happenedAt;
      if (statusName === "failed") {
        update.failed_at = happenedAt;
        update.error_message = errorText(status);
      }

      let recipientUpdate = supabaseAdmin
        .from("whatsapp_campaign_recipients")
        .update(update)
        .eq("provider_message_id", status.id);
      if (companyId) recipientUpdate = recipientUpdate.eq("company_id", companyId);
      const result = await recipientUpdate.select("id");
      const matchedRows = result.data?.length ?? 0;
      updated += matchedRows;
      const logUpdate: Record<string, unknown> = { status: statusName };
      if (statusName === "failed") logUpdate.error_message = errorText(status);
      let payoutLogUpdate = supabaseAdmin
        .from("whatsapp_message_logs")
        .update(logUpdate)
        .eq("provider_message_id", status.id);
      if (companyId) payoutLogUpdate = payoutLogUpdate.eq("company_id", companyId);
      await payoutLogUpdate;
      let inboxUpdate = supabaseAdmin
        .from("inbox_messages")
        .update({
          status: statusName
        })
        .eq("provider_message_id", status.id)
        .eq("direction", "outgoing");
      if (companyId) inboxUpdate = inboxUpdate.eq("company_id", companyId);
      await inboxUpdate;
      if (!matchedRows && status.id) unmatched.push(status.id);
    }

    if (statuses.length) {
      console.info("WhatsApp webhook statuses processed", {
        received: statuses.length,
        updated,
        unmatched
      });
    }

    for (const incomingMessage of incomingMessages) {
      const saveResult = await saveIncomingMessage(incomingMessage, companyId);
      if (saveResult.saved) incomingSaved += 1;
      const result = await sendGreeting(incomingMessage, companyId);
      if (result.sent) {
        greetingsSent += 1;
      } else if (result.reason) {
        greetingSkipped.push(result.reason);
      }
    }

    if (incomingMessages.length) {
      console.info("WhatsApp webhook incoming messages processed", {
        received: incomingMessages.length,
        incomingSaved,
        greetingsSent,
        greetingSkipped
      });
    }

    return NextResponse.json({ received: true, receivedStatuses: statuses.length, receivedMessages: incomingMessages.length, incomingSaved, updated, unmatched, greetingsSent });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to process WhatsApp webhook." }, { status: 500 });
  }
}
