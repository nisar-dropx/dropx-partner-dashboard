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
  body?: { data?: string };
  parts?: MimePart[];
};

function database() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

function cleanEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
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
  const from = cleanEmail(emailsFromHeader(headers.get("from") ?? "")[0] ?? headers.get("from"));
  const to = emailsFromHeader(headers.get("to") ?? "");
  const cc = emailsFromHeader(headers.get("cc") ?? "");
  const deliveredTo = emailsFromHeader(headers.get("delivered-to") ?? "");
  const recipients = new Set([...to, ...cc, ...deliveredTo]);
  const outboundAddress = input.addresses.find((address) => cleanEmail(address.email_address) === from);
  const matchedAddress = outboundAddress ?? input.addresses.find((address) => recipients.has(cleanEmail(address.email_address)));
  const outbound = from === cleanEmail(input.mailbox.credential_email) || Boolean(outboundAddress);
  const bodies = collectBodies(input.message.payload as MimePart | undefined);
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
    to_emails: to,
    cc_emails: cc,
    subject: headers.get("subject") ?? "(no subject)",
    snippet: input.message.snippet ?? "",
    body_text: bodies.text || null,
    body_html: bodies.html || null,
    sent_at: sentAt,
    is_read: !(input.message.labelIds ?? []).includes("UNREAD"),
    metadata: {
      message_id: headers.get("message-id") ?? null,
      in_reply_to: headers.get("in-reply-to") ?? null,
      references: headers.get("references") ?? null,
      delivered_to: headers.get("delivered-to") ?? null,
      station_address: matchedAddress?.email_address ?? null,
      history_id: input.message.historyId ?? null
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
      display_name: "Central Location Mailbox",
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
      display_name: "Central Location Mailbox",
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
    const listed = await client.listMessages({ maxResults: 75, query: "newer_than:45d" });
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

function rawEmail(input: { from: string; to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string | null; references?: string | null }) {
  const headers = [
    `From: ${safeHeader(input.from)}`,
    `To: ${input.to.map(safeHeader).join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.map(safeHeader).join(", ")}`] : []),
    `Subject: ${safeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${safeHeader(input.inReplyTo)}`] : []),
    ...(input.references ? [`References: ${safeHeader(input.references)}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.body}`, "utf8")
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sendLocationMail(input: {
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
  const client = new GoogleLocationMailClient(mailbox.credential_email);
  const sent = await client.sendRaw(rawEmail({
    from: fromAddress,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    body: input.body,
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
