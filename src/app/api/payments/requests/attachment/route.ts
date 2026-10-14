import { NextResponse, type NextRequest } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canAccessPaymentLocation } from "@/lib/payment-approval-scope";
import { paymentRequestAttachments } from "@/lib/payment-request-attachments";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PaymentRequestAnswerFile = {
  id: string;
  file_name: string | null;
  file_path: string | null;
  file_size: number | null;
  attachments?: unknown;
  payment_requests?: { location_id: string | null; requested_by: string | null } | { location_id: string | null; requested_by: string | null }[] | null;
};

function sanitizeFilename(value: string) {
  return value.replace(/[\r\n"]/g, "").trim() || "payment-request-attachment";
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (
      !hasPermission(authorization, "expense_requests", "access") &&
      !hasPermission(authorization, "payment_requests", "access") &&
      !hasPermission(authorization, "payment_approvals", "access")
    ) {
      return NextResponse.json({ error: "Document access denied." }, { status: 403 });
    }
    const companyId = requireCompanyId(authorization);
    const answerId = request.nextUrl.searchParams.get("answer_id");
    const requestedAttachmentIndex = request.nextUrl.searchParams.get("attachment_index");
    if (!answerId) return NextResponse.json({ error: "Attachment is required." }, { status: 400 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const { data, error } = await supabaseAdmin
      .from("payment_request_answers")
      .select("id, file_name, file_path, file_size, attachments, payment_requests ( location_id, requested_by )")
      .eq("company_id", companyId)
      .eq("id", answerId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const answer = data as PaymentRequestAnswerFile | null;
    const paymentRequest = Array.isArray(answer?.payment_requests)
      ? answer.payment_requests[0]
      : answer?.payment_requests;
    if (!answer || (
      !canAccessPaymentLocation(authorization, paymentRequest?.location_id) &&
      paymentRequest?.requested_by !== authorization.userId
    )) {
      return NextResponse.json({ error: "Document access denied." }, { status: 403 });
    }
    const attachmentIndex = requestedAttachmentIndex == null ? 0 : Number(requestedAttachmentIndex);
    const attachment = Number.isInteger(attachmentIndex) && attachmentIndex >= 0
      ? paymentRequestAttachments(answer)[attachmentIndex]
      : null;
    if (!attachment) {
      return NextResponse.json({ error: "Attachment file is not available." }, { status: 404 });
    }

    const file = await supabaseAdmin.storage.from("payment-request-documents").download(attachment.path);
    if (file.error) throw new Error(file.error.message);

    const filename = sanitizeFilename(attachment.name);
    return new NextResponse(file.data, {
      headers: {
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Type": file.data.type || "application/octet-stream",
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to open attachment." }, { status: 500 });
  }
}
