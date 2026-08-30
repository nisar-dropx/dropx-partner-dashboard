"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { sendLocationMail, syncLocationMailbox } from "@/lib/ops-pulse/location-mail";
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

function finish(input: { error?: string; notice?: string; mailboxId?: string; stationAddressId?: string; threadId?: string }): never {
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
  redirect(`/mail${params.size ? `?${params}` : ""}`);
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
      subject: required(formData.get("subject"), "Subject"),
      body: required(formData.get("body"), "Message"),
      threadId,
      inReplyTo: clean(formData.get("in_reply_to")) || null,
      references: clean(formData.get("references")) || null
    });
    revalidatePath("/ops-pulse/mail");
    finish({ mailboxId, stationAddressId, threadId: result.threadId, notice: `Email sent as ${stationAddress.email_address}.` });
  } catch (error) {
    if (isRedirect(error)) throw error;
    finish({ mailboxId, stationAddressId, threadId: threadId ?? undefined, error: error instanceof Error ? error.message : "Email could not be sent." });
  }
}
