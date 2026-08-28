import { requireConnectAccount, type ConnectAccount } from "../../../../../../src/lib/connect-auth";
import { createConnectPayDocument } from "../../../../../../src/lib/connect-pay-document";
import { supabaseAdmin } from "../../../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clean(value: unknown) { return String(value ?? "").trim(); }
function safeDownloadName(value: string) { return value.replace(/[\r\n"]/g, "_") || "document"; }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function settings(snapshot: unknown, companyName: string) {
  const raw = snapshot && typeof snapshot === "object" ? (snapshot as { document_settings?: unknown }).document_settings : null;
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    companyName: typeof row.display_company_name === "string" ? row.display_company_name : companyName,
    address: typeof row.registered_address === "string" ? row.registered_address : "",
    payslipTitle: typeof row.payslip_title === "string" ? row.payslip_title : "Salary Payslip",
    contractorTitle: typeof row.contractor_statement_title === "string" ? row.contractor_statement_title : "Contract Payment Statement",
    footer: typeof row.footer_text === "string" ? row.footer_text : "This is a system-generated document based on the approved and locked payroll snapshot."
  };
}

export async function GET(request: Request, { params }: { params: { kind: string; id: string } }) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    if (!/^[0-9a-f-]{36}$/i.test(params.id) || !["pay", "issued"].includes(params.kind)) return Response.json({ error: "Document is invalid." }, { status: 400 });
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor") return Response.json({ error: "Account is invalid." }, { status: 400 });
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);

    if (params.kind === "issued") {
      const result = await supabaseAdmin.from("hr_worker_documents")
        .select("storage_bucket,storage_path,file_name,mime_type")
        .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
        .eq("id", params.id).is("revoked_at", null).maybeSingle();
      if (result.error) throw new Error(result.error.message);
      if (!result.data) return Response.json({ error: "Document was not found." }, { status: 404 });
      const download = await supabaseAdmin.storage.from(result.data.storage_bucket).download(result.data.storage_path);
      if (download.error) throw new Error(download.error.message);
      return new Response(await download.data.arrayBuffer(), { headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeDownloadName(result.data.file_name)}"`,
        "Content-Type": result.data.mime_type || "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }});
    }

    const result = await supabaseAdmin.from("hr_pay_documents")
      .select("id,document_number,period_label,period_start,period_end,published_at,snapshot,worker_type,hr_payroll_run_people(worker_code,worker_name,location_name,department_name,designation_name,expected_days,present_days,paid_leave_days,absence_days,gross_pay,net_pay,attendance_deductions,hr_payroll_run_items(name,item_type,amount,source,display_order))")
      .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
      .eq("id", params.id).is("revoked_at", null).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return Response.json({ error: "Pay document was not found." }, { status: 404 });
    const person = relation(result.data.hr_payroll_run_people);
    if (!person) throw new Error("The locked payroll snapshot is unavailable.");
    const documentSettings = settings(result.data.snapshot, account.companyName);
    const items = (person.hr_payroll_run_items ?? []).slice().sort((left, right) => left.display_order - right.display_order);
    const deductions = items.filter((item) => item.item_type === "deduction").map((item) => ({ name: item.name, amount: Number(item.amount) }));
    if (Number(person.attendance_deductions) > 0 && !items.some((item) => item.source === "payroll_rules")) deductions.push({ name: "Attendance deduction", amount: Number(person.attendance_deductions) });
    const bytes = await createConnectPayDocument({
      companyName: documentSettings.companyName,
      title: result.data.worker_type === "employee" ? documentSettings.payslipTitle : documentSettings.contractorTitle,
      address: documentSettings.address,
      periodLabel: result.data.period_label,
      periodStart: result.data.period_start,
      periodEnd: result.data.period_end,
      documentNumber: result.data.document_number,
      workerCode: person.worker_code,
      workerName: person.worker_name,
      designationName: person.designation_name,
      departmentName: person.department_name,
      locationName: person.location_name,
      expectedDays: Number(person.expected_days),
      presentDays: Number(person.present_days),
      paidLeaveDays: Number(person.paid_leave_days),
      absenceDays: Number(person.absence_days),
      grossPay: Number(person.gross_pay),
      netPay: Number(person.net_pay),
      earnings: items.filter((item) => item.item_type === "earning").map((item) => ({ name: item.name, amount: Number(item.amount) })),
      deductions,
      footer: documentSettings.footer,
      publishedAt: result.data.published_at
    });
    return new Response(new Uint8Array(bytes), { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeDownloadName(result.data.document_number)}.pdf"`,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff"
    }});
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to download document." }, { status: 400 });
  }
}
