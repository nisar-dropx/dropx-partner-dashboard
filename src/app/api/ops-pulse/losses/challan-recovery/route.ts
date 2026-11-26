import { randomUUID } from "crypto";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadChallanRecovery, loadChallanAssignOptions } from "@/lib/ops-pulse/challan-recovery";
import { mayActivateRedispute, mayMarkAlreadyRecovered, receivedRecoveryError } from "@/lib/ops-pulse/loss-recovery-controls";
import { uploadOpsProof } from "@/lib/ops-pulse/upload";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return reply({ error: "Login required." }, 401);
    if (!hasPermission(auth, "ops_losses", "access")) return reply({ error: "Loss access denied." }, 403);
    const url = new URL(request.url);
    const station = url.searchParams.get("station");
    if (station) {
      const options = await loadChallanAssignOptions(auth, station);
      return reply(options);
    }
    const attachmentId = url.searchParams.get("attachment");
    const caseId = url.searchParams.get("case");
    if (attachmentId && caseId) {
      if (!supabaseAdmin) return reply({ error: "Database service is unavailable." }, 500);
      const companyId = requireCompanyId(auth);
      const view = await loadChallanRecovery(auth);
      if (!view.cases.some((c) => c.id === caseId)) return reply({ error: "Case is outside your stations." }, 403);
      const file = await supabaseAdmin
        .from("fleet_challan_recovery_attachments")
        .select("storage_bucket,storage_path,file_name,content_type")
        .eq("company_id", companyId)
        .eq("case_id", caseId)
        .eq("id", attachmentId)
        .maybeSingle();
      if (file.error || !file.data) return reply({ error: "Proof file was not found." }, 404);
      const signed = await supabaseAdmin.storage
        .from(file.data.storage_bucket)
        .createSignedUrl(file.data.storage_path, 60 * 10);
      if (signed.error || !signed.data?.signedUrl) return reply({ error: "Proof could not be opened." }, 400);
      return Response.redirect(signed.data.signedUrl, 302);
    }
    const view = await loadChallanRecovery(auth);
    return reply(view);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Challan recovery could not be loaded." }, 400);
  }
}

type AllocInput = {
  ref?: string;
  name?: string;
  utr?: string;
  amount?: number | string;
  salary_month?: string;
  installment_no?: number;
  installment_count?: number;
  remarks?: string;
};

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) return reply({ error: "Database service is unavailable." }, 500);
    const auth = await getAuthorization();
    if (!auth) return reply({ error: "Login required." }, 401);
    if (auth.readOnly) return reply({ error: "Read-only preview cannot assign recovery." }, 403);
    if (!hasPermission(auth, "ops_losses", "edit")) return reply({ error: "Loss edit permission denied." }, 403);
    const companyId = requireCompanyId(auth);

    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      if (!mayMarkAlreadyRecovered(auth))
        return reply({ error: "Only Cluster Manager and above can upload bank deposit proof." }, 403);
      const form = await request.formData();
      const caseId = String(form.get("caseId") || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(caseId)) return reply({ error: "A valid recovery case is required." }, 400);
      const view = await loadChallanRecovery(auth);
      const target = view.cases.find((c) => c.id === caseId);
      if (!target) return reply({ error: "This recovery case is outside your assigned stations." }, 403);
      if (["recovered", "closed", "cancelled"].includes(target.status))
        return reply({ error: "This challan can no longer accept bank deposit proof." }, 409);
      const file = form.get("file");
      const id = randomUUID();
      const attachment = await uploadOpsProof({
        companyId,
        field: "bank-deposit",
        file,
        label: "Bank deposit proof",
        section: "challan-recovery",
        submissionId: id,
      });
      if (!attachment) return reply({ error: "Choose a proof file to upload." }, 400);
      const saved = await supabaseAdmin.from("fleet_challan_recovery_attachments").insert({
        id,
        company_id: companyId,
        case_id: caseId,
        file_name: attachment.file_name,
        storage_bucket: attachment.storage_bucket,
        storage_path: attachment.storage_path,
        content_type: attachment.content_type || "",
        file_size: attachment.file_size || 0,
        created_by: auth.userId,
      });
      if (saved.error) {
        await supabaseAdmin.storage.from(attachment.storage_bucket).remove([attachment.storage_path]);
        return reply({ error: "Proof could not be saved." }, 400);
      }
      return reply({ attachment: { id, file_name: attachment.file_name } });
    }

    if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin)
      return reply({ error: "Invalid request origin." }, 403);

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "assign").trim();
    const caseId = String(body.caseId || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(caseId)) return reply({ error: "A valid recovery case is required." }, 400);

    const view = await loadChallanRecovery(auth);
    const target = view.cases.find((c) => c.id === caseId);
    if (!target) return reply({ error: "This recovery case is outside your assigned stations." }, 403);

    if (action === "bank_deposit") {
      if (!mayMarkAlreadyRecovered(auth))
        return reply({ error: "Only Cluster Manager and above can submit a bank deposit for SLP verification." }, 403);
      const details = body.recovery_details && typeof body.recovery_details === "object" ? body.recovery_details : {};
      const error = receivedRecoveryError(details, Number(target.amount));
      if (error) return reply({ error }, 400);
      const result = await supabaseAdmin.rpc("fleet_challan_recovery_bank_deposit_v1", {
        p_company: companyId,
        p_case: caseId,
        p_user: auth.userId,
        p_name: auth.fullName || auth.email || "Fleet user",
        p_details: details,
        p_remarks: String(body.remarks || "").trim() || null,
      });
      if (result.error) return reply({ error: result.error.message }, 400);
      return reply({ ok: true, view: await loadChallanRecovery(auth) });
    }

    if (action === "bank_review") {
      if (!mayActivateRedispute(auth))
        return reply({ error: "Only SLP Manager, Finance Manager, National Head or Managing Partner can verify bank deposits." }, 403);
      const reviewAction = String(body.reviewAction || "").trim();
      if (!["approve", "return"].includes(reviewAction)) return reply({ error: "Choose approve or return." }, 400);
      if (target.bankDeposit?.proposedBy && target.bankDeposit.proposedBy === auth.userId)
        return reply({ error: "You proposed this bank deposit, so another authorised person must verify it." }, 403);
      const result = await supabaseAdmin.rpc("fleet_challan_recovery_bank_review_v1", {
        p_company: companyId,
        p_case: caseId,
        p_user: auth.userId,
        p_name: auth.fullName || auth.email || "Fleet user",
        p_action: reviewAction,
        p_note: String(body.note || "").trim() || null,
      });
      if (result.error) return reply({ error: result.error.message }, 400);
      return reply({ ok: true, view: await loadChallanRecovery(auth) });
    }

    const splitMode = String(body.splitMode || "custom").trim().toLowerCase();
    const remarks = String(body.remarks || "").trim();
    const allocations = Array.isArray(body.allocations) ? (body.allocations as AllocInput[]) : [];
    if (!allocations.length) return reply({ error: "Add at least one associate to recover from." }, 400);
    if (target.status === "bank_pending")
      return reply({ error: "This challan has a bank deposit awaiting verification. Verify or return it before assigning payroll recovery." }, 409);

    const payload = allocations.map((a) => ({
      ref: String(a.ref || "").trim(),
      name: String(a.name || "").trim(),
      utr: String(a.utr || "").trim(),
      amount: Number(a.amount) || 0,
      salary_month: String(a.salary_month || "").trim(),
      installment_no: Number(a.installment_no) || 1,
      installment_count: Number(a.installment_count) || 1,
      remarks: String(a.remarks || "").trim(),
    }));

    const result = await supabaseAdmin.rpc("fleet_challan_recovery_assign_v1", {
      p_company: companyId,
      p_case: caseId,
      p_user: auth.userId,
      p_name: auth.fullName || auth.email || "Fleet user",
      p_split_mode: splitMode,
      p_allocations: payload,
      p_remarks: remarks || null,
    });
    if (result.error) return reply({ error: result.error.message }, 400);

    const refreshed = await loadChallanRecovery(auth);
    return reply({ ok: true, view: refreshed });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Recovery could not be saved." }, 400);
  }
}
