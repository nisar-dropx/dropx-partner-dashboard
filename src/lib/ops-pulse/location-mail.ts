import "server-only";

import { GoogleLocationMailClient, type GoogleMailMessage } from "@/lib/google-workspace-client";
import { supabaseAdmin } from "@/lib/supabase-admin";

type MailboxRow = {
  id: string;
  company_id: string;
  credential_email: string;
  display_name: string;
  status: string;
  sync_enabled: boolean;
  mailbox_mode?: "individual" | "central_routed";
};

type MailboxAddressRow = {
  id: string;
  station_id: string;
  email_address: string;
};

type MimePart = {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: MimePart[];
};

export type MailAttachmentInput = {
  content: Buffer;
  filename: string;
  mimeType: string;
};

export type MailSenderProfile = {
  accent_color: string;
  contact_mobile: string;
  contact_name: string;
  contact_title: string;
  logo_url: string;
  sender_display_name: string;
  signature_enabled: boolean;
  station_label: string;
};

function database() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

function cleanEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function decodeMimeHeader(value: string) {
  return value.replace(/=\?([^?]+)\?([bqBQ])\?([^?]+)\?=/g, (_match, charset: string, encoding: string, data: string) => {
    try {
      if (!/^utf-?8$/i.test(charset) && !/^us-ascii$/i.test(charset)) return data;
      if (encoding.toLowerCase() === "b") return Buffer.from(data, "base64").toString("utf8");
      return Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_value, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "binary").toString("utf8");
    } catch {
      return data;
    }
  }).trim();
}

function senderFromHeader(value: string) {
  const decoded = decodeMimeHeader(value);
  const bracketed = decoded.match(/^(.*?)\s*<([^>]+)>/);
  const email = cleanEmail(bracketed?.[2] ?? emailsFromHeader(decoded)[0] ?? decoded);
  const rawName = (bracketed?.[1] ?? "").trim().replace(/^['"]|['"]$/g, "").trim();
  const name = rawName && cleanEmail(rawName) !== email ? rawName : "";
  return { email, name };
}

function emailsFromHeader(value: string) {
  return value.split(",").map((entry) => {
    const bracketed = entry.match(/<([^>]+)>/);
    return cleanEmail(bracketed?.[1] ?? entry.replace(/^.*?\s/, ""));
  }).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function decodeGmailBody(data: string | undefined) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectBodies(part: MimePart | undefined, result = { text: "", html: "" }) {
  if (!part) return result;
  if (part.mimeType === "text/plain" && part.body?.data) result.text ||= decodeGmailBody(part.body.data);
  if (part.mimeType === "text/html" && part.body?.data) result.html ||= decodeGmailBody(part.body.data);
  for (const child of part.parts ?? []) collectBodies(child, result);
  return result;
}

function collectAttachments(part: MimePart | undefined, result: Array<{ attachmentId: string; filename: string; mimeType: string; size: number }> = []) {
  if (!part) return result;
  if (part.filename && part.body?.attachmentId) {
    result.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || "application/octet-stream",
      size: Number(part.body.size ?? 0)
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, result);
  return result;
}

function headersFor(message: GoogleMailMessage) {
  return new Map((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
}

function messageRecord(input: {
  addresses: MailboxAddressRow[];
  companyId: string;
  mailbox: MailboxRow;
  message: GoogleMailMessage;
}) {
  const headers = headersFor(input.message);
  const sender = senderFromHeader(headers.get("from") ?? "");
  const from = sender.email;
  const to = emailsFromHeader(headers.get("to") ?? "");
  const cc = emailsFromHeader(headers.get("cc") ?? "");
  const bcc = emailsFromHeader(headers.get("bcc") ?? "");
  const deliveredTo = emailsFromHeader(headers.get("delivered-to") ?? "");
  const recipients = new Set([...to, ...cc, ...deliveredTo]);
  const outboundAddress = input.addresses.find((address) => cleanEmail(address.email_address) === from);
  const matchedAddress = outboundAddress ?? input.addresses.find((address) => recipients.has(cleanEmail(address.email_address)));
  const outbound = from === cleanEmail(input.mailbox.credential_email) || Boolean(outboundAddress);
  const bodies = collectBodies(input.message.payload as MimePart | undefined);
  const attachments = collectAttachments(input.message.payload as MimePart | undefined);
  const sentAt = input.message.internalDate && /^\d+$/.test(input.message.internalDate)
    ? new Date(Number(input.message.internalDate)).toISOString()
    : new Date(headers.get("date") ?? Date.now()).toISOString();
  return {
    company_id: input.companyId,
    mailbox_id: input.mailbox.id,
    station_id: matchedAddress?.station_id ?? input.addresses[0]?.station_id ?? null,
    google_message_id: input.message.id,
    google_thread_id: input.message.threadId,
    direction: outbound ? "outbound" : "inbound",
    from_email: from || "unknown",
    from_name: sender.name,
    to_emails: to,
    cc_emails: cc,
    bcc_emails: bcc,
    subject: headers.get("subject") ?? "(no subject)",
    snippet: input.message.snippet ?? "",
    body_text: bodies.text || null,
    body_html: bodies.html || null,
    sent_at: sentAt,
    is_read: !(input.message.labelIds ?? []).includes("UNREAD"),
    label_ids: input.message.labelIds ?? [],
    metadata: {
      message_id: headers.get("message-id") ?? null,
      in_reply_to: headers.get("in-reply-to") ?? null,
      references: headers.get("references") ?? null,
      delivered_to: headers.get("delivered-to") ?? null,
      from_header: headers.get("from") ?? null,
      station_address: matchedAddress?.email_address ?? null,
      history_id: input.message.historyId ?? null,
      attachments
    },
    updated_at: new Date().toISOString()
  };
}

async function loadMailbox(companyId: string, mailboxId: string) {
  const [mailboxResult, addressesResult] = await Promise.all([
    database().from("ops_location_mailboxes").select("id,company_id,credential_email,display_name,status,sync_enabled,mailbox_mode")
      .eq("company_id", companyId).eq("id", mailboxId).maybeSingle(),
    database().from("ops_location_mailbox_addresses").select("id,station_id,email_address")
      .eq("company_id", companyId).eq("mailbox_id", mailboxId).eq("is_active", true)
  ]);
  if (mailboxResult.error || !mailboxResult.data) throw new Error(mailboxResult.error?.message ?? "Location mailbox was not found.");
  if (addressesResult.error) throw new Error(addressesResult.error.message);
  return { mailbox: mailboxResult.data as MailboxRow, addresses: (addressesResult.data ?? []) as MailboxAddressRow[] };
}

export async function ensureLocationMailboxMapping(input: {
  actorId: string;
  companyId: string;
  locationId: string;
  workspaceAccountId: string;
}) {
  const [accountResult, locationResult] = await Promise.all([
    database().from("google_workspace_accounts").select("id,primary_email,full_name,suspended,account_state")
      .eq("company_id", input.companyId).eq("id", input.workspaceAccountId).maybeSingle(),
    database().from("stations").select("id,station_code,station_name,station_email,is_active")
      .eq("company_id", input.companyId).eq("id", input.locationId).maybeSingle()
  ]);
  if (accountResult.error || !accountResult.data) throw new Error(accountResult.error?.message ?? "Workspace account was not found.");
  if (locationResult.error || !locationResult.data) throw new Error(locationResult.error?.message ?? "Location was not found.");
  if (accountResult.data.suspended || accountResult.data.account_state === "deleted") throw new Error("A suspended or deleted Google account cannot be enabled as an Ops mailbox.");
  const email = cleanEmail(accountResult.data.primary_email);
  const locationEmail = cleanEmail(locationResult.data.station_email) || email;
  if (locationEmail !== email) {
    throw new Error(`Station mail ${locationEmail} must match the mapped Google mailbox ${email} for the first live test.`);
  }

  const mailboxResult = await database().from("ops_location_mailboxes").upsert({
    company_id: input.companyId,
    workspace_account_id: input.workspaceAccountId,
    credential_email: email,
    display_name: `${locationResult.data.station_code} · ${locationResult.data.station_name ?? accountResult.data.full_name}`,
    status: locationResult.data.is_active ? "active" : "inactive",
    sync_enabled: Boolean(locationResult.data.is_active),
    mailbox_mode: "individual",
    created_by: input.actorId,
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,credential_email" }).select("id").single();
  if (mailboxResult.error) throw new Error(mailboxResult.error.message);

  const addressResult = await database().from("ops_location_mailbox_addresses").upsert({
    company_id: input.companyId,
    mailbox_id: mailboxResult.data.id,
    station_id: input.locationId,
    email_address: locationEmail,
    address_type: "primary",
    route_state: "not_required",
    route_error: null,
    is_active: Boolean(locationResult.data.is_active),
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,station_id,email_address" });
  if (addressResult.error) throw new Error(addressResult.error.message);
  return mailboxResult.data.id as string;
}

export function locationAddressForStation(stationCode: string, domain: string) {
  const localPart = stationCode.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  if (!localPart) throw new Error(`Station code ${stationCode} cannot be converted to a Google mail address.`);
  return `${localPart}@${domain}`;
}

export async function configureCentralLocationMailboxPilotMapping(input: {
  actorId: string;
  companyId: string;
  routeResult: { email: string; error?: string | null; state: "active" | "conflict" | "error" | "pending" };
  stationId: string;
  workspaceAccountId: string;
}) {
  const [accountResult, stationResult, existingCentralResult] = await Promise.all([
    database().from("google_workspace_accounts").select("id,primary_email,full_name,suspended,account_state,metadata")
      .eq("company_id", input.companyId).eq("id", input.workspaceAccountId).maybeSingle(),
    database().from("stations").select("id,station_code,station_name,is_active")
      .eq("company_id", input.companyId).eq("id", input.stationId).maybeSingle(),
    database().from("ops_location_mailboxes").select("id")
      .eq("company_id", input.companyId).eq("mailbox_mode", "central_routed").neq("status", "inactive").maybeSingle()
  ]);
  if (accountResult.error || !accountResult.data) throw new Error(accountResult.error?.message ?? "Central Workspace account was not found.");
  if (stationResult.error || !stationResult.data?.is_active) throw new Error(stationResult.error?.message ?? "Choose an active pilot station.");
  if (existingCentralResult.error) throw new Error(existingCentralResult.error.message);
  if (accountResult.data.suspended || accountResult.data.account_state === "deleted") throw new Error("A suspended or deleted Google account cannot be the central location inbox.");

  const now = new Date().toISOString();
  const credentialEmail = cleanEmail(accountResult.data.primary_email);
  let mailboxId = existingCentralResult.data?.id ?? null;
  if (mailboxId) {
    const updated = await database().from("ops_location_mailboxes").update({
      workspace_account_id: input.workspaceAccountId,
      credential_email: credentialEmail,
      display_name: "Central Ops Mailbox · Pilot",
      status: "active",
      sync_enabled: true,
      mailbox_mode: "central_routed",
      last_sync_error: null,
      updated_at: now
    }).eq("company_id", input.companyId).eq("id", mailboxId).select("id").single();
    if (updated.error) throw new Error(updated.error.message);
  } else {
    const inserted = await database().from("ops_location_mailboxes").insert({
      company_id: input.companyId,
      workspace_account_id: input.workspaceAccountId,
      credential_email: credentialEmail,
      display_name: "Central Ops Mailbox · Pilot",
      status: "active",
      sync_enabled: true,
      mailbox_mode: "central_routed",
      created_by: input.actorId,
      updated_at: now
    }).select("id").single();
    if (inserted.error) throw new Error(inserted.error.message);
    mailboxId = inserted.data.id;
  }

  const disabled = await database().from("ops_location_mailbox_addresses").update({
    is_active: false,
    updated_at: now
  }).eq("company_id", input.companyId).eq("mailbox_id", mailboxId);
  if (disabled.error) throw new Error(disabled.error.message);

  const address = await database().from("ops_location_mailbox_addresses").upsert({
    company_id: input.companyId,
    mailbox_id: mailboxId,
    station_id: input.stationId,
    email_address: cleanEmail(input.routeResult.email),
    address_type: "group",
    route_state: input.routeResult.state,
    route_error: input.routeResult.error ?? null,
    last_provisioned_at: now,
    is_active: true,
    updated_at: now
  }, { onConflict: "company_id,station_id,email_address" });
  if (address.error) throw new Error(address.error.message);

  const oldMetadata = accountResult.data.metadata && typeof accountResult.data.metadata === "object"
    ? accountResult.data.metadata as Record<string, unknown>
    : {};
  const accountSaved = await database().from("google_workspace_accounts").update({
    account_type: "service",
    source_type: null,
    source_record_id: null,
    location_id: null,
    metadata: {
      ...oldMetadata,
      central_location_mailbox: true,
      rollout_mode: "pilot",
      pilot_station_id: input.stationId,
      configured_at: now,
      configured_by: input.actorId
    },
    updated_at: now
  }).eq("company_id", input.companyId).eq("id", input.workspaceAccountId);
  if (accountSaved.error) throw new Error(accountSaved.error.message);

  return { mailboxId, credentialEmail };
}

export async function configureCentralLocationMailboxMapping(input: {
  actorId: string;
  routeResults?: Array<{ email: string; error?: string | null; state: "active" | "conflict" | "error" | "pending" }>;
  companyId: string;
  workspaceAccountId: string;
}) {
  const [accountResult, settingsResult, stationsResult, existingCentralResult] = await Promise.all([
    database().from("google_workspace_accounts").select("id,primary_email,full_name,suspended,account_state,metadata")
      .eq("company_id", input.companyId).eq("id", input.workspaceAccountId).maybeSingle(),
    database().from("google_workspace_settings").select("primary_domain")
      .eq("company_id", input.companyId).maybeSingle(),
    database().from("stations").select("id,station_code,station_name,is_active")
      .eq("company_id", input.companyId).eq("is_active", true).order("station_code"),
    database().from("ops_location_mailboxes").select("id,credential_email")
      .eq("company_id", input.companyId).eq("mailbox_mode", "central_routed").neq("status", "inactive").maybeSingle()
  ]);
  if (accountResult.error || !accountResult.data) throw new Error(accountResult.error?.message ?? "Central Workspace account was not found.");
  if (settingsResult.error || !settingsResult.data?.primary_domain) throw new Error(settingsResult.error?.message ?? "Workspace primary domain is not configured.");
  if (stationsResult.error) throw new Error(stationsResult.error.message);
  if (existingCentralResult.error) throw new Error(existingCentralResult.error.message);
  if (accountResult.data.suspended || accountResult.data.account_state === "deleted") throw new Error("A suspended or deleted Google account cannot be the central location inbox.");

  const credentialEmail = cleanEmail(accountResult.data.primary_email);
  const domain = cleanEmail(settingsResult.data.primary_domain).replace(/^@/, "");
  const stations = stationsResult.data ?? [];
  const routes = stations.map((station) => ({
    ...station,
    email: locationAddressForStation(station.station_code, domain)
  }));
  const routeResultByEmail = new Map((input.routeResults ?? []).map((result) => [cleanEmail(result.email), result]));
  const now = new Date().toISOString();

  let mailboxId = existingCentralResult.data?.id ?? null;
  if (mailboxId) {
    const updated = await database().from("ops_location_mailboxes").update({
      workspace_account_id: input.workspaceAccountId,
      credential_email: credentialEmail,
      display_name: "Central Ops Mailbox",
      status: "active",
      sync_enabled: true,
      mailbox_mode: "central_routed",
      last_sync_error: null,
      updated_at: now
    }).eq("company_id", input.companyId).eq("id", mailboxId).select("id").single();
    if (updated.error) throw new Error(updated.error.message);
  } else {
    const inserted = await database().from("ops_location_mailboxes").insert({
      company_id: input.companyId,
      workspace_account_id: input.workspaceAccountId,
      credential_email: credentialEmail,
      display_name: "Central Ops Mailbox",
      status: "active",
      sync_enabled: true,
      mailbox_mode: "central_routed",
      created_by: input.actorId,
      updated_at: now
    }).select("id").single();
    if (inserted.error) throw new Error(inserted.error.message);
    mailboxId = inserted.data.id;
  }

  const paused = await database().from("ops_location_mailboxes").update({
    status: "paused",
    sync_enabled: false,
    updated_at: now
  }).eq("company_id", input.companyId).neq("id", mailboxId);
  if (paused.error) throw new Error(paused.error.message);

  const deactivated = await database().from("ops_location_mailbox_addresses").update({
    is_active: false,
    updated_at: now
  }).eq("company_id", input.companyId).eq("mailbox_id", mailboxId);
  if (deactivated.error) throw new Error(deactivated.error.message);

  if (routes.length) {
    const rows = routes.map((route) => {
      const result = routeResultByEmail.get(route.email);
      return {
        company_id: input.companyId,
        mailbox_id: mailboxId,
        station_id: route.id,
        email_address: route.email,
        address_type: route.email === credentialEmail ? "primary" : "group",
        route_state: route.email === credentialEmail ? "not_required" : result?.state ?? "pending",
        route_error: result?.error ?? null,
        last_provisioned_at: result ? now : null,
        is_active: true,
        updated_at: now
      };
    });
    const saved = await database().from("ops_location_mailbox_addresses").upsert(rows, {
      onConflict: "company_id,station_id,email_address"
    });
    if (saved.error) throw new Error(saved.error.message);
    const migratedStationIds = routes
      .filter((route) => !["conflict", "error"].includes(routeResultByEmail.get(route.email)?.state ?? "pending"))
      .map((route) => route.id);
    if (migratedStationIds.length) {
      const oldMappings = await database().from("ops_location_mailbox_addresses").update({
        is_active: false,
        updated_at: now
      }).eq("company_id", input.companyId).in("station_id", migratedStationIds).neq("mailbox_id", mailboxId);
      if (oldMappings.error) throw new Error(oldMappings.error.message);
    }
  }

  const retainedLegacyResult = await database().from("ops_location_mailbox_addresses").select("mailbox_id")
    .eq("company_id", input.companyId).eq("is_active", true).neq("mailbox_id", mailboxId);
  if (retainedLegacyResult.error) throw new Error(retainedLegacyResult.error.message);
  const retainedLegacyMailboxIds = Array.from(new Set((retainedLegacyResult.data ?? []).map((row) => row.mailbox_id)));
  if (retainedLegacyMailboxIds.length) {
    const retained = await database().from("ops_location_mailboxes").update({
      status: "active",
      sync_enabled: true,
      updated_at: now
    }).eq("company_id", input.companyId).in("id", retainedLegacyMailboxIds);
    if (retained.error) throw new Error(retained.error.message);
  }

  const accountMetadata = accountResult.data.metadata && typeof accountResult.data.metadata === "object"
    ? accountResult.data.metadata as Record<string, unknown>
    : {};
  const accountSaved = await database().from("google_workspace_accounts").update({
    account_type: "service",
    source_type: null,
    source_record_id: null,
    location_id: null,
    metadata: {
      ...accountMetadata,
      central_location_mailbox: true,
      station_route_count: routes.length,
      configured_at: now,
      configured_by: input.actorId
    },
    updated_at: now
  }).eq("company_id", input.companyId).eq("id", input.workspaceAccountId);
  if (accountSaved.error) throw new Error(accountSaved.error.message);

  return { routes, mailboxId, credentialEmail };
}

export async function syncLocationMailbox(companyId: string, mailboxId: string) {
  const { mailbox, addresses } = await loadMailbox(companyId, mailboxId);
  if (!mailbox.sync_enabled || mailbox.status === "inactive") throw new Error("Location mailbox sync is disabled.");
  const client = new GoogleLocationMailClient(mailbox.credential_email);
  try {
    const listed = await client.listMessages({ maxResults: 100, query: "in:anywhere newer_than:90d" });
    const records = [];
    for (let index = 0; index < (listed.messages ?? []).length; index += 10) {
      const batch = (listed.messages ?? []).slice(index, index + 10);
      const messages = await Promise.all(batch.map((entry) => client.getMessage(entry.id)));
      records.push(...messages.map((message) => messageRecord({ addresses, companyId, mailbox, message })));
    }
    if (records.length) {
      const saved = await database().from("ops_location_mail_messages").upsert(records, {
        onConflict: "company_id,mailbox_id,google_message_id"
      });
      if (saved.error) throw new Error(saved.error.message);
    }
    const updated = await database().from("ops_location_mailboxes").update({
      last_synced_at: new Date().toISOString(),
      last_sync_error: null,
      status: "active",
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", mailboxId);
    if (updated.error) throw new Error(updated.error.message);
    return { messages: records.length };
  } catch (error) {
    await database().from("ops_location_mailboxes").update({
      last_sync_error: error instanceof Error ? error.message : "Gmail sync failed.",
      status: "error",
      updated_at: new Date().toISOString()
    }).eq("company_id", companyId).eq("id", mailboxId);
    throw error;
  }
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function quoteHeader(value: string) {
  return `"${safeHeader(value).replace(/["\\]/g, "\\$&")}"`;
}

function htmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function safeLogoUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function renderMailSignature(profile: MailSenderProfile) {
  if (!profile.signature_enabled) return { html: "", text: "" };
  const logoUrl = safeLogoUrl(profile.logo_url);
  const accent = /^#[0-9a-f]{6}$/i.test(profile.accent_color) ? profile.accent_color : "#ef6c00";
  const contactLines = [profile.contact_name, profile.contact_title, profile.contact_mobile].map((entry) => entry.trim()).filter(Boolean);
  const text = ["Regards,", profile.station_label, ...contactLines, "DropX Logistics"].filter(Boolean).join("\n");
  const contactHtml = contactLines.map((entry, index) => index === 0
    ? `<strong style="font-size:16px;color:#172033">${htmlEscape(entry)}</strong>`
    : `<span style="font-size:13px;line-height:1.6;color:${index === 1 ? accent : "#344054"}">${htmlEscape(entry)}</span>`).join("");
  const html = [
    '<div style="margin-top:24px;font-family:Arial,sans-serif;color:#172033">',
    '<div style="margin-bottom:12px;font-size:13px">Regards,</div>',
    `<div style="display:inline-flex;align-items:stretch;gap:22px;min-width:470px;border-top:3px solid ${accent};padding-top:12px">`,
    '<div style="display:flex;min-width:250px;flex-direction:column;gap:2px">',
    `<strong style="font-size:15px;color:#172033">${htmlEscape(profile.station_label)}</strong>`,
    contactHtml,
    '</div>',
    `<div style="border-left:2px dotted ${accent};padding-left:22px;display:flex;align-items:center">`,
    logoUrl ? `<img src="${htmlEscape(logoUrl)}" alt="DropX Logistics" style="display:block;width:132px;height:auto;max-height:52px;object-fit:contain" />` : '<strong style="color:#f15a24;font-size:22px">DropX Logistics</strong>',
    '</div></div></div>'
  ].join("");
  return { html, text };
}

function base64Lines(value: Buffer) {
  return value.toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function rawEmail(input: {
  attachments: MailAttachmentInput[];
  bcc: string[];
  body: string;
  cc: string[];
  from: string;
  inReplyTo?: string | null;
  references?: string | null;
  senderName: string;
  signature: { html: string; text: string };
  subject: string;
  to: string[];
}) {
  const mixedBoundary = `dropx-mixed-${crypto.randomUUID()}`;
  const alternativeBoundary = `dropx-alt-${crypto.randomUUID()}`;
  const plainBody = `${input.body.trim()}${input.signature.text ? `\n\n${input.signature.text}` : ""}`;
  const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#172033">${htmlEscape(input.body.trim()).replace(/\n/g, "<br>")}</div>${input.signature.html}`;
  const headers = [
    `From: ${quoteHeader(input.senderName)} <${safeHeader(input.from)}>`,
    `To: ${input.to.map(safeHeader).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(safeHeader).join(", ")}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.map(safeHeader).join(", ")}`] : []),
    `Subject: ${safeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${safeHeader(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${safeHeader(input.references)}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`
  ];
  const parts = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    `--${alternativeBoundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainBody,
    `--${alternativeBoundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlBody,
    `--${alternativeBoundary}--`
  ];
  for (const attachment of input.attachments) {
    const filename = safeHeader(attachment.filename).replace(/"/g, "'") || "attachment";
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${safeHeader(attachment.mimeType || "application/octet-stream")}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(attachment.content)
    );
  }
  parts.push(`--${mixedBoundary}--`);
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sendLocationMail(input: {
  attachments?: MailAttachmentInput[];
  bcc: string[];
  body: string;
  cc: string[];
  companyId: string;
  mailboxId: string;
  fromAddress: string;
  subject: string;
  threadId?: string | null;
  to: string[];
  inReplyTo?: string | null;
  references?: string | null;
}) {
  const { mailbox, addresses } = await loadMailbox(input.companyId, input.mailboxId);
  if (mailbox.status === "inactive") throw new Error("Location mailbox is inactive.");
  const fromAddress = cleanEmail(input.fromAddress);
  if (!addresses.some((address) => cleanEmail(address.email_address) === fromAddress)) {
    throw new Error("The selected station address is not assigned to this central mailbox.");
  }
  const profileResult = await database().from("ops_mail_sender_profiles")
    .select("sender_display_name,station_label,contact_name,contact_title,contact_mobile,logo_url,accent_color,signature_enabled")
    .eq("company_id", input.companyId)
    .eq("mailbox_address_id", addresses.find((address) => cleanEmail(address.email_address) === fromAddress)?.id ?? "")
    .maybeSingle();
  if (profileResult.error) throw new Error(profileResult.error.message);
  if (!profileResult.data) throw new Error("Configure the station sender identity and signature before sending mail.");
  const profile = profileResult.data as MailSenderProfile;
  const client = new GoogleLocationMailClient(mailbox.credential_email);
  const sent = await client.sendRaw(rawEmail({
    attachments: input.attachments ?? [],
    bcc: input.bcc,
    from: fromAddress,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
    senderName: profile.sender_display_name,
    signature: renderMailSignature(profile),
    inReplyTo: input.inReplyTo,
    references: input.references
  }), input.threadId ?? undefined);
  const full = await client.getMessage(sent.id);
  const record = messageRecord({ addresses, companyId: input.companyId, mailbox, message: full });
  const saved = await database().from("ops_location_mail_messages").upsert(record, {
    onConflict: "company_id,mailbox_id,google_message_id"
  });
  if (saved.error) throw new Error(saved.error.message);
  return sent;
}

type ScheduledMailRow = {
  id: string;
  company_id: string;
  mailbox_id: string;
  mailbox_address_id: string;
  google_thread_id: string | null;
  in_reply_to: string | null;
  reference_ids: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  body_text: string;
  ops_location_mailbox_addresses: { email_address: string } | Array<{ email_address: string }> | null;
};

export async function processScheduledLocationMail(limit = 20) {
  const due = await database().from("ops_mail_scheduled_messages")
    .select("id,company_id,mailbox_id,mailbox_address_id,google_thread_id,in_reply_to,reference_ids,to_emails,cc_emails,bcc_emails,subject,body_text,ops_location_mailbox_addresses(email_address)")
    .eq("status", "scheduled").lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true }).limit(limit);
  if (due.error) throw new Error(due.error.message);
  const summary = { sent: 0, failed: 0, errors: [] as string[] };
  for (const row of (due.data ?? []) as unknown as ScheduledMailRow[]) {
    const claimed = await database().from("ops_mail_scheduled_messages").update({
      status: "sending",
      last_error: null,
      updated_at: new Date().toISOString()
    }).eq("id", row.id).eq("status", "scheduled").select("id").maybeSingle();
    if (claimed.error || !claimed.data) continue;
    try {
      const address = Array.isArray(row.ops_location_mailbox_addresses)
        ? row.ops_location_mailbox_addresses[0]
        : row.ops_location_mailbox_addresses;
      if (!address?.email_address) throw new Error("Scheduled sender address is unavailable.");
      const sent = await sendLocationMail({
        companyId: row.company_id,
        mailboxId: row.mailbox_id,
        fromAddress: address.email_address,
        to: row.to_emails,
        cc: row.cc_emails,
        bcc: row.bcc_emails,
        subject: row.subject,
        body: row.body_text,
        threadId: row.google_thread_id,
        inReplyTo: row.in_reply_to,
        references: row.reference_ids
      });
      const completed = await database().from("ops_mail_scheduled_messages").update({
        status: "sent",
        google_message_id: sent.id,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq("id", row.id);
      if (completed.error) throw new Error(completed.error.message);
      summary.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Scheduled email failed.";
      await database().from("ops_mail_scheduled_messages").update({
        status: "failed",
        last_error: message,
        updated_at: new Date().toISOString()
      }).eq("id", row.id);
      summary.failed += 1;
      summary.errors.push(`${row.id}: ${message}`);
    }
  }
  return summary;
}

export async function updateLocationMailMessage(input: {
  action: "archive" | "mark_read" | "mark_unread" | "snooze" | "star" | "trash" | "unsnooze" | "unstar" | "untrash";
  companyId: string;
  mailboxId: string;
  messageId: string;
  snoozedUntil?: string | null;
  stationId: string;
}) {
  const { mailbox } = await loadMailbox(input.companyId, input.mailboxId);
  const result = await database().from("ops_location_mail_messages")
    .select("id,google_message_id,google_thread_id,label_ids,is_read")
    .eq("company_id", input.companyId).eq("mailbox_id", input.mailboxId)
    .eq("station_id", input.stationId).eq("id", input.messageId).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Mail message was not found.");
  if (input.action === "snooze" || input.action === "unsnooze") {
    const snoozedUntil = input.action === "snooze" ? input.snoozedUntil : null;
    if (input.action === "snooze" && (!snoozedUntil || new Date(snoozedUntil).getTime() <= Date.now())) {
      throw new Error("Choose a future snooze time.");
    }
    const snoozed = await database().from("ops_location_mail_messages").update({
      snoozed_until: snoozedUntil,
      updated_at: new Date().toISOString()
    }).eq("company_id", input.companyId).eq("mailbox_id", input.mailboxId)
      .eq("station_id", input.stationId).eq("google_thread_id", result.data.google_thread_id);
    if (snoozed.error) throw new Error(snoozed.error.message);
    return;
  }
  const client = new GoogleLocationMailClient(mailbox.credential_email);
  const current = new Set<string>((result.data.label_ids as string[] | null) ?? []);
  if (input.action === "trash") {
    await client.trashMessage(result.data.google_message_id);
    current.add("TRASH");
    current.delete("INBOX");
  } else if (input.action === "untrash") {
    await client.untrashMessage(result.data.google_message_id);
    current.delete("TRASH");
  } else {
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];
    if (input.action === "archive") removeLabelIds.push("INBOX");
    if (input.action === "mark_read") removeLabelIds.push("UNREAD");
    if (input.action === "mark_unread") addLabelIds.push("UNREAD");
    if (input.action === "star") addLabelIds.push("STARRED");
    if (input.action === "unstar") removeLabelIds.push("STARRED");
    await client.modifyMessage(result.data.google_message_id, { addLabelIds, removeLabelIds });
    for (const label of addLabelIds) current.add(label);
    for (const label of removeLabelIds) current.delete(label);
  }
  const saved = await database().from("ops_location_mail_messages").update({
    is_read: !current.has("UNREAD"),
    label_ids: Array.from(current),
    updated_at: new Date().toISOString()
  }).eq("company_id", input.companyId).eq("id", input.messageId);
  if (saved.error) throw new Error(saved.error.message);
}

export async function locationMailAttachment(input: { companyId: string; mailboxId: string; messageId: string }) {
  const { mailbox } = await loadMailbox(input.companyId, input.mailboxId);
  const result = await database().from("ops_location_mail_messages")
    .select("google_message_id,metadata,station_id")
    .eq("company_id", input.companyId).eq("mailbox_id", input.mailboxId).eq("id", input.messageId).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Mail attachment was not found.");
  return { client: new GoogleLocationMailClient(mailbox.credential_email), message: result.data };
}
