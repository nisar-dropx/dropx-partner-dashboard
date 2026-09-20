import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { userFacingError } from "@/lib/user-facing-error";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { sendConnectEmail } from "../../../../src/lib/connect-email";

function clean(value: unknown) { return String(value ?? "").trim(); }

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const evidenceBucket = "document-request-evidence";
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

function extension(name: string) {
  return name.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? "";
}

async function ownsRequest(companyId: string, profileType: string, workerId: string, requestId: string) {
  const result = await supabaseAdmin!.from("hr_document_requests")
    .select("id").eq("company_id", companyId).eq("worker_type", profileType).eq("worker_id", workerId).eq("id", requestId).maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return Boolean(result.data);
}

async function peopleTeamRecipients(companyId: string) {
  const pageResult = await supabaseAdmin!.from("hr_permission_pages").select("id").eq("company_id", companyId).eq("code", "document_requests").eq("is_active", true).maybeSingle();
  const recipients = new Set<string>();
  const ownerResult = await supabaseAdmin!.from("profiles").select("id").eq("company_id", companyId).eq("is_active", true).eq("is_master_owner", true);
  for (const row of ownerResult.data ?? []) recipients.add(String(row.id));
  if (pageResult.data?.id) {
    const permissionResult = await supabaseAdmin!.from("hr_role_page_permissions").select("role_id").eq("company_id", companyId).eq("page_id", pageResult.data.id).eq("can_add", true);
    const roleIds = [...new Set((permissionResult.data ?? []).map((row) => String(row.role_id)))];
    if (roleIds.length) {
      const accessResult = await supabaseAdmin!.from("hr_user_access").select("user_id").eq("company_id", companyId).eq("is_active", true).in("role_id", roleIds);
      for (const row of accessResult.data ?? []) recipients.add(String(row.user_id));
    }
  }
  return [...recipients];
}

async function notifyPeopleTeam(input: { companyId: string; requestId: string; requestNumber: string; requestTypeName: string; event: "submitted" | "reply" }) {
  try {
    const recipients = await peopleTeamRecipients(input.companyId);
    if (!recipients.length) return;
    await supabaseAdmin!.from("people_web_notifications").upsert(
      recipients.map((recipient) => ({
        company_id: input.companyId,
        recipient_user_id: recipient,
        event_code: `document_request_${input.event}`,
        title: input.event === "reply" ? "Document request reply" : "New document request",
        body: `${input.requestNumber} · ${input.requestTypeName}`,
        href: `/approvals?section=documents&request=${input.requestId}`,
        source_key: `${input.requestId}:${input.event}:${input.event === "reply" ? Date.now() : "initial"}`,
        data: { requestId: input.requestId, requestNumber: input.requestNumber }
      })),
      { onConflict: "company_id,event_code,source_key,recipient_user_id", ignoreDuplicates: true }
    );
  } catch {
    // The request remains visible even if a web notification cannot be created.
  }
}

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (!["employee", "contractor", "workforce"].includes(profileType)) throw new Error("Documents are unavailable for this account.");
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);

    const attachmentId = clean(url.searchParams.get("attachmentId"));
    if (attachmentId) {
      const attachmentResult = await supabaseAdmin.from("hr_document_request_attachments")
        .select("id,request_id,storage_path").eq("company_id", account.companyId).eq("id", attachmentId).maybeSingle();
      if (attachmentResult.error) throw new Error(attachmentResult.error.message);
      if (!attachmentResult.data || !(await ownsRequest(account.companyId, profileType, account.id, attachmentResult.data.request_id))) {
        return NextResponse.json({ error: "Attachment is not available for this account." }, { status: 403 });
      }
      const signed = await supabaseAdmin.storage.from(evidenceBucket).createSignedUrl(attachmentResult.data.storage_path, 300);
      if (signed.error) throw new Error(signed.error.message);
      return NextResponse.json({ url: signed.data.signedUrl });
    }

    const [pay, issued, exit, types, requests] = await Promise.all([
      supabaseAdmin.from("hr_pay_documents")
        .select("id,document_type,document_number,period_label,period_start,period_end,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("period_start", { ascending: false }),
      supabaseAdmin.from("hr_worker_documents")
        .select("id,document_type,title,document_date,expires_on,file_name,mime_type,file_size,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("published_at", { ascending: false }),
      // Relieving letters, experience certificates and other exit documents —
      // generated on demand (see connect-exit-document.ts), never stored.
      profileType === "workforce" ? Promise.resolve({ data: [], error: null }) : supabaseAdmin.from("hr_exit_documents")
        .select("id,document_type,file_name,generated_at,status,hr_exit_cases!inner(worker_type,employee_id,contractor_id)")
        .eq("company_id", account.companyId).neq("status", "void")
        .eq("hr_exit_cases.worker_type", profileType)
        .eq(profileType === "employee" ? "hr_exit_cases.employee_id" : "hr_exit_cases.contractor_id", account.id)
        .order("generated_at", { ascending: false }),
      supabaseAdmin.from("hr_document_request_types")
        .select("id,code,name,description,instructions,sla_days,issued_document_type")
        .eq("company_id", account.companyId).eq("is_active", true).eq("is_requestable", true)
        .contains("worker_types", [profileType]).order("sort_order").order("name"),
      supabaseAdmin.from("hr_document_requests")
        .select("id,request_number,request_type_id,request_type_name,reason,status,hr_note,requested_at,first_action_at,closed_at,fulfilled_document_id,updated_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .order("requested_at", { ascending: false }).limit(50)
    ]);
    if (pay.error || issued.error || exit.error || types.error || requests.error) throw new Error(pay.error?.message ?? issued.error?.message ?? exit.error?.message ?? types.error?.message ?? requests.error?.message ?? "Unable to load documents.");

    const requestIds = (requests.data ?? []).map((row) => row.id);
    const [messagesResult, attachmentsResult] = await Promise.all([
      requestIds.length
        ? supabaseAdmin.from("hr_document_request_messages").select("id,request_id,author_kind,body,created_at").eq("company_id", account.companyId).in("request_id", requestIds).order("created_at")
        : Promise.resolve({ data: [], error: null }),
      requestIds.length
        ? supabaseAdmin.from("hr_document_request_attachments").select("id,request_id,message_id,original_name,mime_type,file_size,created_at").eq("company_id", account.companyId).in("request_id", requestIds).order("created_at")
        : Promise.resolve({ data: [], error: null })
    ]);
    if (messagesResult.error) throw new Error(messagesResult.error.message);
    if (attachmentsResult.error) throw new Error(attachmentsResult.error.message);
    const messages = messagesResult.data ?? [];
    const attachments = attachmentsResult.data ?? [];

    const query = (kind: string, id: string) => `/api/connect/documents/${kind}/${id}?${new URLSearchParams({ accountId: account.id, profileType })}`;
    const documents = [
      ...(pay.data ?? []).map((row) => ({
        id: row.id, kind: "pay", category: row.document_type === "payslip" ? "Salary slip" : "Payment statement",
        title: row.period_label, subtitle: `${row.period_start} to ${row.period_end}`, fileName: `${row.document_number}.pdf`,
        publishedAt: row.published_at, expiresOn: null, downloadUrl: query("pay", row.id)
      })),
      ...(issued.data ?? []).map((row) => ({
        id: row.id, kind: "issued", category: row.document_type.replaceAll("_", " "), title: row.title,
        subtitle: row.document_date ? `Dated ${row.document_date}` : "Issued by People & Culture", fileName: row.file_name,
        publishedAt: row.published_at, expiresOn: row.expires_on, downloadUrl: query("issued", row.id)
      })),
      ...(exit.data ?? []).map((row) => ({
        id: row.id, kind: "exit", category: String(row.document_type).replaceAll("_", " "), title: String(row.document_type).replaceAll("_", " "),
        subtitle: "Offboarding document", fileName: row.file_name,
        publishedAt: row.generated_at, expiresOn: null, downloadUrl: query("exit", row.id)
      }))
    ].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));

    return NextResponse.json({
      documents,
      requestTypes: types.data ?? [],
      requests: (requests.data ?? []).map((row) => ({
        ...row,
        messages: messages.filter((message) => message.request_id === row.id),
        attachments: attachments.filter((attachment) => attachment.request_id === row.id)
      })),
      summary: { total: documents.length, pay: pay.data?.length ?? 0, issued: issued.data?.length ?? 0, requests: requests.data?.filter((row) => ["submitted", "in_progress", "returned"].includes(row.status)).length ?? 0 }
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load documents.") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");

    if (contentType.includes("multipart/form-data")) {
      // Attach an optional file to an existing thread message.
      const form = await request.formData();
      const accountId = clean(form.get("accountId"));
      const profileType = clean(form.get("profileType"));
      const requestId = clean(form.get("requestId"));
      const messageId = clean(form.get("messageId"));
      if (profileType !== "employee" && profileType !== "contractor") throw new Error("Documents are available for employees and independent contractors.");
      const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
      if (!(await ownsRequest(account.companyId, profileType, account.id, requestId))) {
        return NextResponse.json({ error: "Request access denied." }, { status: 403 });
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) throw new Error("Choose a file to attach.");
      if (file.size > 8 * 1024 * 1024) throw new Error("Attachment must be 8 MB or smaller.");
      if (!allowedTypes.has(file.type)) throw new Error("Use JPG, PNG, WebP or PDF only.");
      const path = `${account.companyId}/${requestId}/${randomUUID()}${extension(file.name)}`;
      const upload = await supabaseAdmin.storage.from(evidenceBucket).upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false });
      if (upload.error) throw new Error(upload.error.message);
      const record = await supabaseAdmin.from("hr_document_request_attachments").insert({
        request_id: requestId,
        message_id: messageId || null,
        company_id: account.companyId,
        storage_path: path,
        original_name: file.name.slice(0, 180),
        mime_type: file.type,
        file_size: file.size,
        created_by_kind: "requester"
      });
      if (record.error) { await supabaseAdmin.storage.from(evidenceBucket).remove([path]); throw new Error(record.error.message); }
      return NextResponse.json({ ok: true });
    }

    const body = await request.json();
    const accountId = clean(body.accountId);
    const profileType = clean(body.profileType);
    const requestTypeId = clean(body.requestTypeId);
    const reason = clean(body.reason).slice(0, 500);
    if (profileType !== "employee" && profileType !== "contractor") throw new Error("Documents are available for employees and independent contractors.");
    if (!/^[0-9a-f-]{36}$/i.test(requestTypeId)) throw new Error("Choose a valid document type.");
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const result = await supabaseAdmin.rpc("hr_create_document_request", {
      p_company_id: account.companyId,
      p_worker_type: profileType,
      p_worker_id: account.id,
      p_request_type_id: requestTypeId,
      p_reason: reason || null
    });
    if (result.error) throw new Error(result.error.message);

    const requestType = await supabaseAdmin.from("hr_document_request_types").select("name").eq("company_id", account.companyId).eq("id", requestTypeId).maybeSingle();
    const created = await supabaseAdmin.from("hr_document_requests").select("request_number").eq("company_id", account.companyId).eq("id", result.data).maybeSingle();
    if (created.data) {
      await notifyPeopleTeam({ companyId: account.companyId, requestId: result.data, requestNumber: created.data.request_number, requestTypeName: requestType.data?.name ?? "Document request", event: "submitted" });
    }
    return NextResponse.json({ requestId: result.data, message: "Document request submitted to People & Culture." }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to submit document request.") }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = clean(body.accountId);
    const profileType = clean(body.profileType);
    if (profileType !== "employee" && profileType !== "contractor") throw new Error("Documents are available for employees and independent contractors.");
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);

    const forwardMessageId = clean(body.forwardMessageId);
    if (forwardMessageId) {
      const forwardEmail = clean(body.forwardEmail).toLowerCase();
      if (!emailPattern.test(forwardEmail)) throw new Error("Enter a valid email address.");
      const messageResult = await supabaseAdmin.from("hr_document_request_messages")
        .select("id,request_id,author_kind,body,created_at").eq("company_id", account.companyId).eq("id", forwardMessageId).maybeSingle();
      if (messageResult.error) throw new Error(messageResult.error.message);
      if (!messageResult.data || !(await ownsRequest(account.companyId, profileType, account.id, messageResult.data.request_id))) {
        return NextResponse.json({ error: "Request access denied." }, { status: 403 });
      }
      const requestInfo = await supabaseAdmin.from("hr_document_requests").select("request_number,request_type_name").eq("company_id", account.companyId).eq("id", messageResult.data.request_id).single();
      if (requestInfo.error) throw new Error(requestInfo.error.message);
      const sender = messageResult.data.author_kind === "requester" ? (account.name || "You") : "People & Culture";
      await sendConnectEmail({
        companyId: account.companyId,
        to: [forwardEmail],
        subject: `Forwarded: ${requestInfo.data.request_number} · ${requestInfo.data.request_type_name}`,
        body: `${sender} wrote on ${new Date(messageResult.data.created_at).toLocaleString("en-IN")}:\n\n${messageResult.data.body}\n\n— Forwarded from DropX One Documents by ${account.name || "a team member"}.`
      });
      await supabaseAdmin.from("hr_document_request_events").insert({
        request_id: messageResult.data.request_id,
        company_id: account.companyId,
        event_type: "message_forwarded",
        note: `Message forwarded to ${forwardEmail} by ${account.name || account.reference || "a team member"}.`
      });
      return NextResponse.json({ ok: true });
    }

    const requestId = clean(body.requestId);
    const message = clean(body.message).slice(0, 3000);
    if (!requestId || message.length < 1) throw new Error("Enter a message.");
    if (!(await ownsRequest(account.companyId, profileType, account.id, requestId))) {
      return NextResponse.json({ error: "Request access denied." }, { status: 403 });
    }
    const result = await supabaseAdmin.rpc("hr_send_document_request_message", {
      p_company_id: account.companyId,
      p_request_id: requestId,
      p_author_kind: "requester",
      p_body: message,
      p_actor_user_id: null
    });
    if (result.error) throw new Error(result.error.message);

    const requestInfo = await supabaseAdmin.from("hr_document_requests").select("request_number,request_type_name").eq("company_id", account.companyId).eq("id", requestId).single();
    if (!requestInfo.error) {
      await notifyPeopleTeam({ companyId: account.companyId, requestId, requestNumber: requestInfo.data.request_number, requestTypeName: requestInfo.data.request_type_name, event: "reply" });
    }
    return NextResponse.json({ ok: true, messageId: result.data });
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to send your message.") }, { status: 400 });
  }
}
