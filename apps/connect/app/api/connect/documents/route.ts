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
    const [pay, issued] = await Promise.all([
      supabaseAdmin.from("hr_pay_documents")
        .select("id,document_type,document_number,period_label,period_start,period_end,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("period_start", { ascending: false }),
      supabaseAdmin.from("hr_worker_documents")
        .select("id,document_type,title,document_date,expires_on,file_name,mime_type,file_size,published_at")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .is("revoked_at", null).order("published_at", { ascending: false })
    ]);
    if (pay.error || issued.error) throw new Error(pay.error?.message ?? issued.error?.message ?? "Unable to load documents.");
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
    return NextResponse.json({ documents, summary: { total: documents.length, pay: pay.data?.length ?? 0, issued: issued.data?.length ?? 0 } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load documents." }, { status: 400 });
  }
}
