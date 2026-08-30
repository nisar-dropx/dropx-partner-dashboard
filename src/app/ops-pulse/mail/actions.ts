"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { GoogleLocationMailClient } from "@/lib/google-workspace-client";
import { sendLocationMail, syncLocationMailbox, updateLocationMailMessage } from "@/lib/ops-pulse/location-mail";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function required(value: FormDataEntryValue | null, label: string) {
  const result = clean(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function parseEmails(value: FormDataEntryValue | null) {
  const emails = clean(value).split(/[;,\n]+/).map((email) => email.trim().toLowerCase()).filter(Boolean);
  for (const email of emails) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid email: ${email}`);
  }
  return Array.from(new Set(emails));
}

function isRedirect(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

function finish(input: { compose?: boolean; draftId?: string; error?: string; folder?: string; notice?: string; mailboxId?: string; stationAddressId?: string; threadId?: string }): never {
  cookies().set("dropx_location_mail_flash", JSON.stringify({ error: input.error, notice: input.notice }), {
    httpOnly: true,
    maxAge: 45,
    path: "/",
    sameSite: "lax"
  });
  const params = new URLSearchParams();
  if (input.mailboxId) params.set("mailbox", input.mailboxId);
  if (input.stationAddressId) params.set("station", input.stationAddressId);
  if (input.threadId) params.set("thread", input.threadId);
  if (input.folder) params.set("folder", input.folder);
  if (input.compose) params.set("compose", "1");
  if (input.draftId) params.set("draft", input.draftId);
  redirect(`/mail${params.size ? `?${params}` : ""}`);
}

async function attachments(formData: FormData) {
  const values = formData.getAll("attachments").filter((value): value is File => value instanceof File && value.size > 0);
  if (values.length > 10) throw new Error("Attach a maximum of 10 files.");
  const total = values.reduce((sum, file) => sum + file.size, 0);
  if (total > 20 * 1024 * 1024) throw new Error("Attachments must total 20 MB or less.");
  return Promise.all(values.map(async (file) => ({
    content: Buffer.from(await file.arrayBuffer()),
    filename: file.name || "attachment",
    mimeType: file.type || "application/octet-stream"
  })));
}

async function stationAddressAccess(
  companyId: string,
  mailboxId: string,
  stationAddressId: string,
  authorization: Awaited<ReturnType<typeof requirePagePermission>>
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin.from("ops_location_mailbox_addresses").select("id,station_id,email_address,route_state")
    .eq("company_id", companyId).eq("mailbox_id", mailboxId).eq("id", stationAddressId).eq("is_active", true).maybeSingle();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "The selected station address is unavailable.");
  if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && !authorization.locationScopeIds.includes(result.data.station_id)) {
    throw new Error("You do not have access to this station address.");
  }
  if (!["active", "not_required"].includes(result.data.route_state)) {
    throw new Error(`The selected station route is ${result.data.route_state} and cannot send mail yet.`);
  }
  return result.data;
}

async function assertMailboxAccess(companyId: string, mailboxId: string, authorization: Awaited<ReturnType<typeof requirePagePermission>>) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin.from("ops_location_mailbox_addresses").select("station_id")
    .eq("company_id", companyId).eq("mailbox_id", mailboxId).eq("is_active", true);
  if (result.error) throw new Error(result.error.message);
  const stationIds = (result.data ?? []).map((row) => row.station_id);
  if (!stationIds.length) throw new Error("This mailbox has no active station mapping.");
  if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && !stationIds.some((id) => authorization.locationScopeIds.includes(id))) {
    throw new Error("You do not have access to this station mailbox.");
  }
}

export async function syncLocationMailboxAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "view");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  try {
    if (!mailboxId) throw new Error("Mailbox is required.");
    await assertMailboxAccess(companyId, mailboxId, authorization);
    const result = await syncLocationMailbox(companyId, mailboxId);
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, notice: `${result.messages} recent Google messages synchronized.` });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, error: error instanceof Error ? error.message : "Mailbox sync failed." });
  }
}

export async function sendLocationMailAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "edit");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  const stationAddressId = clean(formData.get("station_address_id"));
  const threadId = clean(formData.get("thread_id")) || null;
  try {
    if (!mailboxId) throw new Error("Mailbox is required.");
    if (!stationAddressId) throw new Error("Station address is required.");
    const stationAddress = await stationAddressAccess(companyId, mailboxId, stationAddressId, authorization);
    const to = parseEmails(formData.get("to"));
    if (!to.length) throw new Error("At least one recipient is required.");
    const result = await sendLocationMail({
      companyId,
      mailboxId,
      fromAddress: stationAddress.email_address,
      to,
      cc: parseEmails(formData.get("cc")),
      bcc: parseEmails(formData.get("bcc")),
      subject: required(formData.get("subject"), "Subject"),
      body: required(formData.get("body"), "Message"),
      attachments: await attachments(formData),
      threadId,
      inReplyTo: clean(formData.get("in_reply_to")) || null,
      references: clean(formData.get("references")) || null
    });
    const draftId = clean(formData.get("draft_id"));
    if (draftId && supabaseAdmin) {
      const removed = await supabaseAdmin.from("ops_mail_drafts").delete()
        .eq("company_id", companyId).eq("id", draftId).eq("mailbox_address_id", stationAddressId);
      if (removed.error) throw new Error(removed.error.message);
    }
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, threadId: result.threadId, notice: `Email sent as ${stationAddress.email_address}.` });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, threadId: threadId ?? undefined, error: error instanceof Error ? error.message : "Email could not be sent." });
  }
}

export async function saveMailDraftAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "edit");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  const stationAddressId = clean(formData.get("station_address_id"));
  const draftId = clean(formData.get("draft_id"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    if (!mailboxId || !stationAddressId) throw new Error("Mailbox and station address are required.");
    const stationAddress = await stationAddressAccess(companyId, mailboxId, stationAddressId, authorization);
    const values = {
      company_id: companyId,
      mailbox_id: mailboxId,
      mailbox_address_id: stationAddressId,
      station_id: stationAddress.station_id,
      google_thread_id: clean(formData.get("thread_id")) || null,
      in_reply_to: clean(formData.get("in_reply_to")) || null,
      reference_ids: clean(formData.get("references")) || null,
      to_emails: parseEmails(formData.get("to")),
      cc_emails: parseEmails(formData.get("cc")),
      bcc_emails: parseEmails(formData.get("bcc")),
      subject: clean(formData.get("subject")),
      body_text: clean(formData.get("body")),
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    };
    const result = draftId
      ? await supabaseAdmin.from("ops_mail_drafts").update(values).eq("company_id", companyId).eq("id", draftId).select("id").single()
      : await supabaseAdmin.from("ops_mail_drafts").insert({ ...values, created_by: authorization.userId }).select("id").single();
    if (result.error) throw new Error(result.error.message);
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, draftId: result.data.id, folder: "drafts", notice: "Draft saved." });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, compose: true, draftId: draftId || undefined, error: error instanceof Error ? error.message : "Draft could not be saved." });
  }
}

export async function deleteMailDraftAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "edit");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  const stationAddressId = clean(formData.get("station_address_id"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    await stationAddressAccess(companyId, mailboxId, stationAddressId, authorization);
    const result = await supabaseAdmin.from("ops_mail_drafts").delete()
      .eq("company_id", companyId).eq("id", required(formData.get("draft_id"), "Draft"))
      .eq("mailbox_address_id", stationAddressId);
    if (result.error) throw new Error(result.error.message);
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, folder: "drafts", notice: "Draft deleted." });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, folder: "drafts", error: error instanceof Error ? error.message : "Draft could not be deleted." });
  }
}

export async function updateMailMessageAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "edit");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  const stationAddressId = clean(formData.get("station_address_id"));
  const folder = clean(formData.get("folder")) || "inbox";
  const action = clean(formData.get("mail_action")) as "archive" | "mark_read" | "mark_unread" | "star" | "trash" | "unstar" | "untrash";
  try {
    const stationAddress = await stationAddressAccess(companyId, mailboxId, stationAddressId, authorization);
    if (!["archive", "mark_read", "mark_unread", "star", "trash", "unstar", "untrash"].includes(action)) throw new Error("Choose a valid mail action.");
    await updateLocationMailMessage({
      action,
      companyId,
      mailboxId,
      messageId: required(formData.get("message_id"), "Message"),
      stationId: stationAddress.station_id
    });
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, folder, notice: "Mail updated." });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, folder, error: error instanceof Error ? error.message : "Mail could not be updated." });
  }
}

export async function saveMailSenderProfileAction(formData: FormData) {
  const authorization = await requirePagePermission("ops_location_mail", "edit");
  const companyId = requireCompanyId(authorization);
  const mailboxId = clean(formData.get("mailbox_id"));
  const stationAddressId = clean(formData.get("station_address_id"));
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const address = await stationAddressAccess(companyId, mailboxId, stationAddressId, authorization);
    const senderDisplayName = required(formData.get("sender_display_name"), "Sender display name");
    const accentColor = clean(formData.get("accent_color"));
    if (!/^#[0-9a-f]{6}$/i.test(accentColor)) throw new Error("Choose a valid signature accent colour.");
    const logoUrl = clean(formData.get("logo_url"));
    if (logoUrl && (!URL.canParse(logoUrl) || new URL(logoUrl).protocol !== "https:")) throw new Error("Logo URL must be a secure HTTPS address.");
    const mailbox = await supabaseAdmin.from("ops_location_mailboxes").select("credential_email")
      .eq("company_id", companyId).eq("id", mailboxId).maybeSingle();
    if (mailbox.error || !mailbox.data) throw new Error(mailbox.error?.message ?? "Mailbox was not found.");
    const gmail = new GoogleLocationMailClient(mailbox.data.credential_email);
    await gmail.updateSendAs({ email: address.email_address, displayName: senderDisplayName });
    const saved = await supabaseAdmin.from("ops_mail_sender_profiles").upsert({
      company_id: companyId,
      mailbox_address_id: stationAddressId,
      sender_display_name: senderDisplayName,
      station_label: required(formData.get("station_label"), "Station name"),
      contact_name: required(formData.get("contact_name"), "TL name"),
      contact_title: required(formData.get("contact_title"), "Contact title"),
      contact_mobile: required(formData.get("contact_mobile"), "TL mobile number"),
      logo_url: logoUrl,
      accent_color: accentColor,
      signature_enabled: formData.get("signature_enabled") === "true",
      updated_by: authorization.userId,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,mailbox_address_id" });
    if (saved.error) throw new Error(saved.error.message);
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, notice: `Sender identity updated to ${senderDisplayName}.` });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, error: error instanceof Error ? error.message : "Sender identity could not be saved." });
  }
}
