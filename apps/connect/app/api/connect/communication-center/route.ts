import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  cleanCommunicationText,
  communicationCaseNumber,
  defaultCommunicationSettings,
  validateCommunicationSubmission,
  type CommunicationChannel
} from "@/lib/communication-center";

const evidenceBucket = "communication-evidence";
const allowedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "video/mp4"
]);

function errorMessage(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "");
  return /communication_|schema cache|does not exist/i.test(message)
    ? "Connect is being configured. Please try again shortly."
    : message || "Unable to open Connect.";
}

function extension(name: string) {
  return name.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? "";
}

async function accountFromRequest(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  const profileType = String(body?.profileType ?? url.searchParams.get("profileType") ?? "") as ConnectAccount["profileType"];
  const accountId = String(body?.accountId ?? url.searchParams.get("accountId") ?? "");
  return requireConnectAccount(profileType, accountId);
}

async function loadSettings(companyId: string) {
  const result = await supabaseAdmin!
    .from("communication_channel_settings")
    .select("channel,title,subtitle,guidance,categories,sla_hours,is_active,allow_attachments,reward_enabled")
    .eq("company_id", companyId)
    .order("channel");
  if (result.error) throw result.error;
  const rows = new Map((result.data ?? []).map((row) => [row.channel, row]));
  return (["general", "connect", "integrity"] as CommunicationChannel[]).map((channel) => {
    const row = rows.get(channel);
    const fallback = defaultCommunicationSettings[channel];
    return {
      channel,
      title: row?.title ?? fallback.title,
      subtitle: row?.subtitle ?? fallback.subtitle,
      guidance: row?.guidance ?? fallback.guidance,
      categories: row?.categories ?? fallback.categories,
      slaHours: row?.sla_hours ?? fallback.slaHours,
      active: row?.is_active ?? channel !== "general",
      allowAttachments: row?.allow_attachments ?? true,
      rewardEnabled: row?.reward_enabled ?? fallback.rewardEnabled
    };
  });
}

async function ownsCase(companyId: string, profileType: string, accountId: string, caseId: string) {
  const result = await supabaseAdmin!
    .from("communication_case_reporters")
    .select("case_id")
    .eq("company_id", companyId)
    .eq("reporter_profile_type", profileType)
    .eq("reporter_account_id", accountId)
    .eq("case_id", caseId)
    .maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}

async function announcementInbox(companyId: string, profileType: string, accountId: string) {
  const receiptResult = await supabaseAdmin!
    .from("communication_announcement_recipients")
    .select("announcement_id,delivered_at,read_at")
    .eq("company_id", companyId)
    .eq("recipient_profile_type", profileType)
    .eq("recipient_account_id", accountId);
  if (receiptResult.error) throw receiptResult.error;
  const receipts = receiptResult.data ?? [];
  if (!receipts.length) return [];
  const announcementResult = await supabaseAdmin!
    .from("communication_announcements")
    .select("id,category,title,body,priority,published_at,expires_at")
    .eq("company_id", companyId)
    .eq("status", "published")
    .in("id", receipts.map((item) => item.announcement_id))
    .order("published_at", { ascending: false });
  if (announcementResult.error) throw announcementResult.error;
  const receiptById = new Map(receipts.map((item) => [item.announcement_id, item]));
  const now = Date.now();
  return (announcementResult.data ?? [])
    .filter((item) => !item.expires_at || new Date(item.expires_at).getTime() > now)
    .map((item) => ({
      ...item,
      deliveredAt: receiptById.get(item.id)?.delivered_at ?? null,
      readAt: receiptById.get(item.id)?.read_at ?? null
    }));
}

async function peopleRecipients(companyId: string) {
  const [pageResult, ownerResult] = await Promise.all([
    supabaseAdmin!.from("hr_permission_pages").select("id").eq("company_id", companyId).eq("code", "announcements").eq("is_active", true).maybeSingle(),
    supabaseAdmin!.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true).eq("is_master_owner", true)
  ]);
  const recipients = new Set((ownerResult.data ?? []).map((row) => String(row.id)));
  if (pageResult.data?.id) {
    const permissionResult = await supabaseAdmin!
      .from("hr_role_page_permissions")
      .select("role_id")
      .eq("company_id", companyId)
      .eq("page_id", pageResult.data.id)
      .eq("can_add", true);
    const roleIds = [...new Set((permissionResult.data ?? []).map((row) => String(row.role_id)))];
    if (roleIds.length) {
      const accessResult = await supabaseAdmin!
        .from("hr_user_access")
        .select("user_id")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("role_id", roleIds);
      for (const row of accessResult.data ?? []) recipients.add(String(row.user_id));
    }
  }
  return [...recipients];
}

async function notifyPeopleTeam(input: {
  companyId: string;
  caseId: string;
  caseNumber: string;
  channel: string;
  subject: string;
  urgency: string;
  event: "submitted" | "reply";
}) {
  try {
    const recipients = await peopleRecipients(input.companyId);
    if (!recipients.length) return;
    const confidential = input.channel === "integrity";
    const title = confidential
      ? `New Speak Up ${input.event === "reply" ? "message" : "case"}`
      : `HR Help ${input.event === "reply" ? "reply" : "request"}`;
    const body = confidential
      ? `${input.caseNumber} · ${input.urgency === "critical" ? "Critical priority" : "Confidential review required"}`
      : `${input.caseNumber} · ${input.subject}`;
    await supabaseAdmin!.from("people_web_notifications").upsert(
      recipients.map((recipient) => ({
        company_id: input.companyId,
        recipient_user_id: recipient,
        event_code: `communication_case_${input.event}`,
        title,
        body,
        href: `/communications?tab=${confidential ? "speak-up" : "hr-help"}&case=${input.caseId}`,
        source_key: `${input.caseId}:${input.event}:${input.event === "reply" ? Date.now() : "initial"}`,
        data: { caseId: input.caseId, caseNumber: input.caseNumber, channel: input.channel }
      })),
      { onConflict: "company_id,event_code,source_key,recipient_user_id", ignoreDuplicates: true }
    );
  } catch {
    // The case remains available in Connect Centre even if a web notification cannot be created.
  }
}

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const account = await accountFromRequest(request);
    const url = new URL(request.url);
    const attachmentId = url.searchParams.get("attachmentId") ?? "";
    if (attachmentId) {
      const attachmentResult = await supabaseAdmin
        .from("communication_case_attachments")
        .select("id,case_id,storage_path")
        .eq("company_id", account.companyId)
        .eq("id", attachmentId)
        .maybeSingle();
      if (attachmentResult.error) throw attachmentResult.error;
      if (!attachmentResult.data || !(await ownsCase(account.companyId, account.profileType, account.id, attachmentResult.data.case_id))) {
        return NextResponse.json({ error: "Evidence is not available for this account." }, { status: 403 });
      }
      const signed = await supabaseAdmin.storage.from(evidenceBucket).createSignedUrl(attachmentResult.data.storage_path, 300);
      if (signed.error) throw signed.error;
      return NextResponse.json({ url: signed.data.signedUrl });
    }

    const reporterResult = await supabaseAdmin
      .from("communication_case_reporters")
      .select("case_id")
      .eq("company_id", account.companyId)
      .eq("reporter_profile_type", account.profileType)
      .eq("reporter_account_id", account.id);
    if (reporterResult.error) throw reporterResult.error;
    const caseIds = (reporterResult.data ?? []).map((row) => row.case_id);
    const announcements = await announcementInbox(account.companyId, account.profileType, account.id);
    if (!caseIds.length) {
      return NextResponse.json({ settings: await loadSettings(account.companyId), cases: [], announcements });
    }

    const [caseResult, messageResult, attachmentResult] = await Promise.all([
      supabaseAdmin.from("communication_cases")
        .select("id,case_number,channel,category,subject,description,urgency,status,identity_protected,reward_status,due_at,last_activity_at,created_at,resolved_at")
        .eq("company_id", account.companyId)
        .in("id", caseIds)
        .order("last_activity_at", { ascending: false }),
      supabaseAdmin.from("communication_case_messages")
        .select("id,case_id,author_kind,body,created_at")
        .eq("company_id", account.companyId)
        .in("case_id", caseIds)
        .eq("visibility", "reporter")
        .order("created_at"),
      supabaseAdmin.from("communication_case_attachments")
        .select("id,case_id,message_id,original_name,mime_type,file_size,created_at")
        .eq("company_id", account.companyId)
        .in("case_id", caseIds)
        .order("created_at")
    ]);
    if (caseResult.error) throw caseResult.error;
    if (messageResult.error) throw messageResult.error;
    if (attachmentResult.error) throw attachmentResult.error;
    const messages = messageResult.data ?? [];
    const attachments = attachmentResult.data ?? [];
    return NextResponse.json({
      settings: await loadSettings(account.companyId),
      announcements,
      cases: (caseResult.data ?? []).map((item) => ({
        ...item,
        messages: messages.filter((message) => message.case_id === item.id),
        attachments: attachments.filter((attachment) => attachment.case_id === item.id)
      }))
    });
  } catch (error) {
    const message = errorMessage(error);
    return NextResponse.json({ error: message }, { status: /login|session/i.test(message) ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  let createdCaseId = "";
  const uploadedPaths: string[] = [];
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const form = await request.formData();
    const account = await accountFromRequest(request, {
      accountId: form.get("accountId"),
      profileType: form.get("profileType")
    });
    const submission = validateCommunicationSubmission({
      channel: form.get("channel"),
      category: form.get("category"),
      subject: form.get("subject"),
      description: form.get("description"),
      urgency: form.get("urgency")
    });
    const channelSettings = (await loadSettings(account.companyId)).find((item) => item.channel === submission.channel);
    if (!channelSettings?.active) throw new Error("This communication channel is currently unavailable.");
    if (!channelSettings.categories.includes(submission.category)) throw new Error("Select a category from the current list.");

    const files = form.getAll("evidence").filter((item): item is File => item instanceof File && item.size > 0);
    if (files.length > 3) throw new Error("Attach no more than three evidence files.");
    if (files.length && !channelSettings.allowAttachments) throw new Error("Attachments are disabled for this channel.");
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024) throw new Error("Each evidence file must be 8 MB or smaller.");
      if (!allowedTypes.has(file.type)) throw new Error("Use JPG, PNG, WebP, PDF, audio or MP4 evidence only.");
    }

    const now = new Date();
    const dueAt = new Date(now.getTime() + channelSettings.slaHours * 3_600_000).toISOString();
    const caseResult = await supabaseAdmin.from("communication_cases").insert({
      company_id: account.companyId,
      case_number: communicationCaseNumber(submission.channel),
      channel: submission.channel,
      category: submission.category,
      subject: submission.subject,
      description: submission.description,
      urgency: submission.channel === "integrity" ? submission.urgency : "normal",
      identity_protected: submission.channel === "integrity",
      reward_status: submission.channel === "integrity" && channelSettings.rewardEnabled ? "under_review" : "not_applicable",
      due_at: dueAt
    }).select("id,case_number,status,created_at").single();
    if (caseResult.error) throw caseResult.error;
    createdCaseId = caseResult.data.id;
    const reporterResult = await supabaseAdmin.from("communication_case_reporters").insert({
      case_id: createdCaseId,
      company_id: account.companyId,
      reporter_profile_type: account.profileType,
      reporter_account_id: account.id
    });
    if (reporterResult.error) throw reporterResult.error;
    const messageResult = await supabaseAdmin.from("communication_case_messages").insert({
      case_id: createdCaseId,
      company_id: account.companyId,
      author_kind: "reporter",
      visibility: "reporter",
      body: submission.description
    }).select("id").single();
    if (messageResult.error) throw messageResult.error;

    for (const file of files) {
      const path = `${account.companyId}/${createdCaseId}/${randomUUID()}${extension(file.name)}`;
      const upload = await supabaseAdmin.storage.from(evidenceBucket).upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: false
      });
      if (upload.error) throw upload.error;
      uploadedPaths.push(path);
      const record = await supabaseAdmin.from("communication_case_attachments").insert({
        case_id: createdCaseId,
        message_id: messageResult.data.id,
        company_id: account.companyId,
        storage_path: path,
        original_name: cleanCommunicationText(file.name, 180),
        mime_type: file.type,
        file_size: file.size,
        created_by_kind: "reporter"
      });
      if (record.error) throw record.error;
    }
    await supabaseAdmin.from("communication_case_events").insert({
      case_id: createdCaseId,
      company_id: account.companyId,
      event_type: "submitted",
      to_status: "submitted",
      note: "Submitted through DropX One."
    });
    await notifyPeopleTeam({
      companyId: account.companyId,
      caseId: createdCaseId,
      caseNumber: caseResult.data.case_number,
      channel: submission.channel,
      subject: submission.subject,
      urgency: submission.urgency,
      event: "submitted"
    });
    return NextResponse.json({
      ok: true,
      caseNumber: caseResult.data.case_number,
      status: caseResult.data.status,
      createdAt: caseResult.data.created_at,
      identityProtected: submission.channel === "integrity"
    });
  } catch (error) {
    if (supabaseAdmin && uploadedPaths.length) await supabaseAdmin.storage.from(evidenceBucket).remove(uploadedPaths);
    if (supabaseAdmin && createdCaseId) await supabaseAdmin.from("communication_cases").delete().eq("id", createdCaseId);
    const message = errorMessage(error);
    return NextResponse.json({ error: message }, { status: /login|session/i.test(message) ? 401 : 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const account = await accountFromRequest(request, body);
    const announcementId = String(body.announcementId ?? "");
    if (announcementId) {
      const result = await supabaseAdmin.from("communication_announcement_recipients")
        .update({ read_at: new Date().toISOString() })
        .eq("company_id", account.companyId)
        .eq("announcement_id", announcementId)
        .eq("recipient_profile_type", account.profileType)
        .eq("recipient_account_id", account.id)
        .is("read_at", null)
        .select("announcement_id");
      if (result.error) throw result.error;
      if (!result.data?.length) {
        const existing = await supabaseAdmin.from("communication_announcement_recipients")
          .select("announcement_id")
          .eq("company_id", account.companyId)
          .eq("announcement_id", announcementId)
          .eq("recipient_profile_type", account.profileType)
          .eq("recipient_account_id", account.id)
          .maybeSingle();
        if (!existing.data) return NextResponse.json({ error: "Announcement access denied." }, { status: 403 });
      }
      return NextResponse.json({ ok: true });
    }

    const caseId = String(body.caseId ?? "");
    const message = cleanCommunicationText(body.message, 3000);
    if (!caseId || message.length < 2) throw new Error("Enter a message.");
    if (!(await ownsCase(account.companyId, account.profileType, account.id, caseId))) {
      return NextResponse.json({ error: "Case access denied." }, { status: 403 });
    }
    const caseResult = await supabaseAdmin.from("communication_cases")
      .select("case_number,channel,subject,urgency,status")
      .eq("company_id", account.companyId)
      .eq("id", caseId)
      .single();
    if (caseResult.error) throw caseResult.error;
    if (["closed", "dismissed"].includes(caseResult.data.status)) {
      throw new Error("This case is closed. Open a new case if further help is required.");
    }
    const result = await supabaseAdmin.from("communication_case_messages").insert({
      case_id: caseId,
      company_id: account.companyId,
      author_kind: "reporter",
      visibility: "reporter",
      body: message
    });
    if (result.error) throw result.error;
    const now = new Date().toISOString();
    await supabaseAdmin.from("communication_cases").update({ last_activity_at: now, updated_at: now }).eq("id", caseId);
    await notifyPeopleTeam({
      companyId: account.companyId,
      caseId,
      caseNumber: caseResult.data.case_number,
      channel: caseResult.data.channel,
      subject: caseResult.data.subject,
      urgency: caseResult.data.urgency,
      event: "reply"
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = errorMessage(error);
    return NextResponse.json({ error: message }, { status: /login|session/i.test(message) ? 401 : 400 });
  }
}
