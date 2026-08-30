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
};

type MailboxAddressRow = {
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
  const recipients = new Set([...to, ...cc]);
  const matchedAddress = input.addresses.find((address) => recipients.has(cleanEmail(address.email_address)));
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
    direction: from === cleanEmail(input.mailbox.credential_email) ? "outbound" : "inbound",
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
      history_id: input.message.historyId ?? null
    },
    updated_at: new Date().toISOString()
  };
}

async function loadMailbox(companyId: string, mailboxId: string) {
  const [mailboxResult, addressesResult] = await Promise.all([
    database().from("ops_location_mailboxes").select("id,company_id,credential_email,display_name,status,sync_enabled")
      .eq("company_id", companyId).eq("id", mailboxId).maybeSingle(),
    database().from("ops_location_mailbox_addresses").select("station_id,email_address")
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
    is_active: Boolean(locationResult.data.is_active),
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,station_id,email_address" });
  if (addressResult.error) throw new Error(addressResult.error.message);
  return mailboxResult.data.id as string;
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
  subject: string;
  threadId?: string | null;
  to: string[];
  inReplyTo?: string | null;
  references?: string | null;
}) {
  const { mailbox, addresses } = await loadMailbox(input.companyId, input.mailboxId);
  if (mailbox.status === "inactive") throw new Error("Location mailbox is inactive.");
  const client = new GoogleLocationMailClient(mailbox.credential_email);
  const sent = await client.sendRaw(rawEmail({
    from: mailbox.credential_email,
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
