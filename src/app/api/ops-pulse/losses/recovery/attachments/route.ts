import { randomUUID } from "crypto";
import { recoveryContext } from "@/lib/ops-pulse/nl-recovery-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";
import { disputeContext } from "@/lib/ops-pulse/nl-live";
export const dynamic = "force-dynamic";

/** Evidence belongs either to a recovery plan (re-dispute) or to a live-month dispute request. */
async function attachmentScope(
  purpose: string,
  month: string,
  key: string,
  edit: boolean,
  outcomeCode = "",
) {
  if (purpose === "dispute") {
    const ctx = await disputeContext(month, key, edit ? "station" : "view");
    if (edit && !ctx.gate.open)
      throw Error(ctx.gate.reason || "The dispute window is closed.");
    if (edit && !ctx.policy) throw Error("Attachment rules are not configured in Loss Recovery Master.");
    return { userId: ctx.auth.userId, company: ctx.company, caseKey: ctx.caseKey, policy: ctx.policy!, label: "Dispute evidence", field: "dispute" };
  }
  const { auth, scope, settings, caseKey } = await recoveryContext(month, key, edit);
  if (edit) {
    const outcome = await supabaseAdmin!
      .from("nl_recovery_outcomes")
      .select("attachments_enabled")
      .eq("company_id", scope.company)
      .eq("code", outcomeCode)
      .eq("is_active", true)
      .maybeSingle();
    if (!outcome.data?.attachments_enabled)
      throw Error("Attachments are not enabled for this recovery action.");
  }
  return { userId: auth.userId, company: scope.company, caseKey, policy: settings!.recovery_policy, label: "Re-dispute evidence", field: "re-dispute" };
}
export async function POST(request: Request) {
  try {
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      throw Error("Invalid request origin.");
    const form = await request.formData();
    const month = String(form.get("month") || "");
    const { userId, company, caseKey, policy, label, field } =
      await attachmentScope(
        String(form.get("purpose") || ""),
        month,
        String(form.get("case") || ""),
        true,
        String(form.get("outcome") || ""),
      );
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > policy.attachment_max_mb * 1024 * 1024
    )
      throw Error(`Choose a file up to ${policy.attachment_max_mb} MB.`);
    if (!policy.attachment_types.includes(file.type))
      throw Error("This file type is not enabled in Loss Recovery Master.");
    const id = randomUUID();
    const attachment = await uploadOpsProof({
      companyId: company,
      field,
      file,
      label,
      section: "nl-recovery",
      submissionId: id,
    });
    if (!attachment) throw Error("File could not be uploaded.");
    const saved = await supabaseAdmin!
      .from("nl_recovery_attachments")
      .insert({
        id,
        company_id: company,
        month,
        case_key: caseKey,
        file_name: attachment.file_name,
        storage_bucket: attachment.storage_bucket,
        storage_path: attachment.storage_path,
        content_type: attachment.content_type,
        file_size: attachment.file_size,
        created_by: userId,
      });
    if (saved.error) {
      await supabaseAdmin!.storage
        .from(attachment.storage_bucket)
        .remove([attachment.storage_path]);
      throw Error("Attachment could not be saved.");
    }
    return Response.json(
      { attachment: { id, file_name: attachment.file_name } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : "Unable to upload attachment.",
      },
      { status: 400 },
    );
  }
}
export async function GET(request: Request) {
  try {
    const url = new URL(request.url),
      month = url.searchParams.get("month") || "";
    const { company, caseKey } = await attachmentScope(
      url.searchParams.get("purpose") || "",
      month,
      url.searchParams.get("case") || "",
      false,
    );
    const row = await supabaseAdmin!
      .from("nl_recovery_attachments")
      .select("file_name,storage_bucket,storage_path")
      .eq("company_id", company)
      .eq("month", month)
      .eq("case_key", caseKey)
      .eq("id", url.searchParams.get("id") || "")
      .maybeSingle();
    if (row.error || !row.data)
      throw Error("Attachment is not available in your station scope.");
    const file = await supabaseAdmin!.storage
      .from(row.data.storage_bucket)
      .download(row.data.storage_path);
    if (file.error || !file.data) throw Error("Attachment is unavailable.");
    return new Response(await file.data.arrayBuffer(), {
      headers: {
        "Content-Type": file.data.type || "application/octet-stream",
        "Content-Disposition": `attachment; filename="${row.data.file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Unable to open attachment." },
      { status: 403 },
    );
  }
}
