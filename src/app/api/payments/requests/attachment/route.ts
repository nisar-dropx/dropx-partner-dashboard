import { NextResponse, type NextRequest } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { hasActiveFleetMembership } from "@/lib/fleet-control";
import { isFleetManagerPaymentHead } from "@/lib/fleet-control-payment-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PaymentRequestAnswerFile = {
  id: string;
  file_name: string | null;
  file_path: string | null;
  file_size: number | null;
  payment_request_id: string;
};

function sanitizeFilename(value: string) {
  return value.replace(/[\r\n"]/g, "").trim() || "payment-request-attachment";
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const companyId = requireCompanyId(authorization);
    const hasPaymentAccess = hasPermission(authorization, "payment_requests", "access") || hasPermission(authorization, "payment_approvals", "access");
    const hasFleetMembership = !hasPaymentAccess && await hasActiveFleetMembership(companyId, authorization.userId);
    if (!hasPaymentAccess && !hasFleetMembership) {
      return NextResponse.json({ error: "Document access denied." }, { status: 403 });
    }
    const answerId = request.nextUrl.searchParams.get("answer_id");
    if (!answerId) return NextResponse.json({ error: "Attachment is required." }, { status: 400 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const { data, error } = await supabaseAdmin
      .from("payment_request_answers")
      .select("id, file_name, file_path, file_size, payment_request_id")
      .eq("company_id", companyId)
      .eq("id", answerId)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const answer = data as PaymentRequestAnswerFile | null;
    if (!answer?.file_path) {
      return NextResponse.json({ error: "Attachment file is not available." }, { status: 404 });
    }

    const paymentResult = await supabaseAdmin
      .from("payment_requests")
      .select("id,location_id,payment_head_id")
      .eq("company_id", companyId)
      .eq("id", answer.payment_request_id)
      .maybeSingle();
    if (paymentResult.error) throw new Error(paymentResult.error.message);
    const payment = paymentResult.data;
    if (!payment || (!authorization.hasAllLocationAccess && !authorization.isMasterOwner && (!payment.location_id || !authorization.locationScopeIds.includes(payment.location_id)))) {
      return NextResponse.json({ error: "Document access denied for this vehicle placement." }, { status: 403 });
    }
    if (!hasPaymentAccess) {
      const headResult = await supabaseAdmin.from("payment_heads").select("id,code,name").eq("company_id", companyId).eq("id", payment.payment_head_id).maybeSingle();
      if (headResult.error) throw new Error(headResult.error.message);
      if (!headResult.data || !isFleetManagerPaymentHead(headResult.data)) return NextResponse.json({ error: "Document access denied." }, { status: 403 });
    }

    const file = await supabaseAdmin.storage.from("payment-request-documents").download(answer.file_path);
    if (file.error) throw new Error(file.error.message);

    const filename = sanitizeFilename(answer.file_name ?? "payment-request-attachment");
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
