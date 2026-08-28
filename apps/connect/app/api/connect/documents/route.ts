import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

function clean(value: unknown) { return String(value ?? "").trim(); }

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor") throw new Error("Documents are available for employees and independent contractors.");
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const [pay, issued, types, requests] = await Promise.all([
      supabaseAdmin.from("hr_pay_documents")
        .select("id,document_type,document_number,period_label,period_start,period_end,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("period_start", { ascending: false }),
      supabaseAdmin.from("hr_worker_documents")
        .select("id,document_type,title,document_date,expires_on,file_name,mime_type,file_size,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("published_at", { ascending: false }),
      supabaseAdmin.from("hr_document_request_types")
        .select("id,code,name,description,instructions,sla_days,issued_document_type")
        .eq("company_id", account.companyId).eq("is_active", true).eq("is_requestable", true)
        .contains("worker_types", [profileType]).order("sort_order").order("name"),
      supabaseAdmin.from("hr_document_requests")
        .select("id,request_number,request_type_id,request_type_name,reason,status,hr_note,requested_at,first_action_at,closed_at,fulfilled_document_id,updated_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .order("requested_at", { ascending: false }).limit(50)
    ]);
    if (pay.error || issued.error || types.error || requests.error) throw new Error(pay.error?.message ?? issued.error?.message ?? types.error?.message ?? requests.error?.message ?? "Unable to load documents.");
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
      }))
    ].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
    return NextResponse.json({
      documents,
      requestTypes: types.data ?? [],
      requests: requests.data ?? [],
      summary: { total: documents.length, pay: pay.data?.length ?? 0, issued: issued.data?.length ?? 0, requests: requests.data?.filter((row) => ["submitted", "in_progress", "returned"].includes(row.status)).length ?? 0 }
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load documents." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
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
    return NextResponse.json({ requestId: result.data, message: "Document request submitted to People & Culture." }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit document request." }, { status: 400 });
  }
}
