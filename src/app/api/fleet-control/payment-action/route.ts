import { NextResponse, type NextRequest } from "next/server";
import { approvePaymentRequest, rejectPaymentRequest, returnPaymentRequest } from "@/app/payments/approvals/actions";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFleetManagerPaymentHead } from "@/lib/fleet-control-payment-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

function text(value: unknown) { return String(value ?? "").trim(); }

export async function POST(request: NextRequest) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Your session has expired. Sign in again." }, { status: 401 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Database service is unavailable." }, { status: 503 });
    const companyId = requireCompanyId(authorization);
    const body = await request.json();
    const action = text(body.action) as "approve" | "return" | "reject";
    const requestId = text(body.requestId);
    if (!requestId || !["approve", "return", "reject"].includes(action)) return NextResponse.json({ error: "A valid payment action is required." }, { status: 400 });

    const payment = await supabaseAdmin.from("payment_requests").select("id,payment_head_id").eq("company_id", companyId).eq("id", requestId).maybeSingle();
    if (payment.error) throw new Error(payment.error.message);
    if (!payment.data?.payment_head_id) return NextResponse.json({ error: "Payment request was not found." }, { status: 404 });
    const head = await supabaseAdmin.from("payment_heads").select("code,name").eq("company_id", companyId).eq("id", payment.data.payment_head_id).maybeSingle();
    if (head.error) throw new Error(head.error.message);
    if (!head.data || !isFleetManagerPaymentHead(head.data)) return NextResponse.json({ error: "This payment is outside Fleet Manager approval. Ad Hoc activity is visibility-only in Fleet." }, { status: 403 });

    const form = new FormData();
    form.set("request_id", requestId);
    form.set("status", text(body.status) || "pending");
    form.set("comments", text(body.comments));
    const runner = action === "approve" ? approvePaymentRequest : action === "return" ? returnPaymentRequest : rejectPaymentRequest;
    const emailReason = await runner(form);
    const success = action === "approve" ? "Vehicle payment approved." : action === "return" ? "Vehicle payment returned for correction." : "Vehicle payment rejected.";
    const current = await supabaseAdmin.from("payment_requests").select("status,approval_status").eq("company_id", companyId).eq("id", requestId).maybeSingle();
    const fallbackStatus = action === "approve" ? "pending" : action === "return" ? "returned" : "rejected";
    const statusValue = text(current.data?.status) || fallbackStatus;
    const statusLabel = action === "approve" ? (text(current.data?.approval_status).replaceAll("_", " ") || "Approved") : action === "return" ? "Returned" : "Rejected";
    return NextResponse.json({ ok: true, action, message: emailReason ? `${success} Notification was not sent: ${emailReason}` : success, status: statusValue, statusLabel });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The payment request could not be updated." }, { status: 400 });
  }
}
