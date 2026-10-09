import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireConnectAccount, type ConnectAccount } from "../../../../../../src/lib/connect-auth";
import { userFacingError } from "@/lib/user-facing-error";
import { renderConnectExitDocumentPdf } from "../../../../../../src/lib/connect-exit-document";
import { buildPayDocumentInput, payDocumentSettingsFromSnapshot, type PayDocumentSettings } from "../../../../../../src/lib/hrms-pay-document-input";
import { createPayDocumentPdf } from "../../../../../../src/lib/hrms-pay-document-pdf";
import { supabaseAdmin } from "../../../../../../src/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clean(value: unknown) { return String(value ?? "").trim(); }
function safeDownloadName(value: string) { return value.replace(/[\r\n"]/g, "_") || "document"; }
function relation<T>(value: T | T[] | null | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
async function payDocumentLogo() {
  const candidates = [path.join(process.cwd(), "public", "dropx-logo.png"), path.join(process.cwd(), "apps", "connect", "public", "dropx-logo.png")];
  for (const file of candidates) {
    try { return new Uint8Array(await readFile(file)); } catch { /* try the next location */ }
  }
  return null;
}
async function livePayDocumentSettings(companyId: string, companyName: string): Promise<PayDocumentSettings> {
  const fallback: PayDocumentSettings = {
    displayCompanyName: companyName,
    registeredAddress: "",
    footerText: "This is a system-generated document based on the approved and locked payroll snapshot. No signature is required.",
    authorisedSignatory: "People & Culture",
    showAttendance: true
  };
  const result = await supabaseAdmin!.from("hr_pay_document_settings")
    .select("display_company_name,registered_address,footer_text,authorised_signatory,show_attendance")
    .eq("company_id", companyId).maybeSingle();
  if (result.error || !result.data) return fallback;
  return {
    displayCompanyName: result.data.display_company_name || companyName,
    registeredAddress: result.data.registered_address || "",
    footerText: result.data.footer_text || fallback.footerText,
    authorisedSignatory: result.data.authorised_signatory || fallback.authorisedSignatory,
    showAttendance: result.data.show_attendance !== false
  };
}

export async function GET(request: Request, { params }: { params: { kind: string; id: string } }) {
  try {
    if (!supabaseAdmin) throw new Error("Database configuration is unavailable.");
    if (!/^[0-9a-f-]{36}$/i.test(params.id) || !["pay", "issued", "exit"].includes(params.kind)) return Response.json({ error: "Document is invalid." }, { status: 400 });
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor" && profileType !== "workforce") return Response.json({ error: "Account is invalid." }, { status: 400 });
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    if (profileType === "workforce" && params.kind !== "issued") return Response.json({ error: "This document is not available for the Workforce account." }, { status: 404 });

    if (params.kind === "exit") {
      const document = await supabaseAdmin.from("hr_exit_documents")
        .select("id, case_id, document_type, file_name, template_id, template_version, issue_date, reference_number, status, hr_exit_cases!inner(id, case_number, worker_type, employee_id, contractor_id, reason_id, approved_last_working_date, effective_date, settlement_status)")
        .eq("company_id", account.companyId).eq("id", params.id).neq("status", "void")
        .eq("hr_exit_cases.worker_type", profileType)
        .eq(profileType === "employee" ? "hr_exit_cases.employee_id" : "hr_exit_cases.contractor_id", account.id)
        .maybeSingle();
      if (document.error) throw new Error(document.error.message);
      if (!document.data?.template_id) return Response.json({ error: "This document is no longer available." }, { status: 404 });
      const exitCase = relation(document.data.hr_exit_cases);
      if (!exitCase) return Response.json({ error: "This document is no longer available." }, { status: 404 });
      const [template, worker, policy, items, reason] = await Promise.all([
        supabaseAdmin.from("hr_exit_document_templates").select("document_type, title_template, body_template, variant, layout_key").eq("id", document.data.template_id).maybeSingle(),
        profileType === "contractor"
          ? supabaseAdmin.from("contractors").select("full_name, dropx_id, designation, date_of_join").eq("company_id", account.companyId).eq("id", account.id).maybeSingle()
          : supabaseAdmin.from("employees").select("full_name, employee_code, date_of_join, designations(name)").eq("company_id", account.companyId).eq("id", account.id).maybeSingle(),
        supabaseAdmin.from("hr_exit_policies").select("registered_address, footer_text, signatory_name, signatory_title").eq("company_id", account.companyId).maybeSingle(),
        supabaseAdmin.from("hr_exit_settlement_items").select("label, item_type, amount").eq("case_id", exitCase.id).order("created_at"),
        exitCase.reason_id ? supabaseAdmin.from("hr_exit_reasons").select("name").eq("id", exitCase.reason_id).maybeSingle() : Promise.resolve({ data: null })
      ]);
      if (template.error || !template.data) return Response.json({ error: "This document's template is no longer available." }, { status: 404 });
      if (worker.error || !worker.data) return Response.json({ error: "Worker record is unavailable." }, { status: 404 });
      const designationRelation = profileType === "employee" ? relation((worker.data as { designations?: unknown }).designations) as { name?: string } | null : null;
      const designationName = profileType === "contractor"
        ? String((worker.data as { designation?: string | null }).designation ?? "Independent contractor")
        : designationRelation?.name ?? "Employee";
      const earnings = (items.data ?? []).filter((item) => item.item_type === "earning").reduce((sum, item) => sum + Number(item.amount), 0);
      const deductions = (items.data ?? []).filter((item) => item.item_type === "deduction").reduce((sum, item) => sum + Number(item.amount), 0);
      const bytes = await renderConnectExitDocumentPdf({
        template: template.data,
        companyName: account.companyName,
        registeredAddress: policy.data?.registered_address,
        footerText: policy.data?.footer_text,
        signatoryName: policy.data?.signatory_name,
        signatoryTitle: policy.data?.signatory_title,
        caseNumber: exitCase.case_number,
        employeeName: worker.data.full_name,
        employeeCode: profileType === "contractor" ? (worker.data as { dropx_id?: string | null }).dropx_id ?? "" : (worker.data as { employee_code?: string | null }).employee_code ?? "",
        designationName,
        dateOfJoining: (worker.data as { date_of_join?: string | null }).date_of_join ?? null,
        lastWorkingDate: exitCase.approved_last_working_date ?? exitCase.effective_date,
        exitReason: reason.data?.name ?? "As recorded in the exit case",
        settlementLines: (items.data ?? []).map((item) => `${item.label}: ${item.item_type === "deduction" ? "-" : "+"} INR ${Number(item.amount).toFixed(2)}`).join("\n") || "No settlement line items.",
        settlementNet: `INR ${(earnings - deductions).toFixed(2)}`,
        settlementStatus: String(exitCase.settlement_status ?? "").replaceAll("_", " "),
        issueDateIso: document.data.issue_date ?? new Date().toISOString().slice(0, 10),
        referenceNumber: document.data.reference_number ?? null
      });
      return new Response(new Uint8Array(bytes), { headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${safeDownloadName(document.data.file_name)}"`,
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff"
      }});
    }

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
      .select("id,run_id,document_number,period_label,period_start,period_end,published_at,snapshot,worker_type,hr_payroll_run_people(worker_type,worker_id,worker_code,worker_name,location_name,department_name,designation_name,payment_basis,expected_days,present_days,paid_leave_days,absence_days,half_days,payable_days,weekoff_days,wfh_days,gross_pay,statutory_deductions,attendance_deductions,other_deductions,employer_contributions,net_pay,adjusted_net_pay,calculation_snapshot,hr_payroll_run_items(code,name,item_type,amount,source,display_order,metadata))")
      .eq("company_id", account.companyId).eq("worker_type", profileType).eq("worker_id", account.id)
      .eq("id", params.id).is("revoked_at", null).maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) return Response.json({ error: "Pay document was not found." }, { status: 404 });
    const person = relation(result.data.hr_payroll_run_people);
    if (!person) throw new Error("The payroll snapshot is unavailable.");
    const workerQuery = profileType === "employee"
      ? supabaseAdmin.from("employees").select("date_of_join,pan_number,pf_uan,pf_account_no,esi_no,bank_account_no,ifsc,tax_regime,pran").eq("company_id", account.companyId).eq("id", account.id).maybeSingle()
      : supabaseAdmin.from("contractors").select("date_of_join,pan_number,pf_uan,pf_account_no,esi_no,bank_account_no,ifsc:ifsc_code,tax_regime,pran").eq("company_id", account.companyId).eq("id", account.id).maybeSingle();
    const [worker, settings, logo] = await Promise.all([
      workerQuery,
      livePayDocumentSettings(account.companyId, account.companyName),
      payDocumentLogo()
    ]);
    if (worker.error) throw new Error(worker.error.message);
    const bytes = await createPayDocumentPdf(buildPayDocumentInput({
      settings: payDocumentSettingsFromSnapshot(result.data.snapshot) ?? settings,
      periodLabel: result.data.period_label,
      periodStart: result.data.period_start,
      periodEnd: result.data.period_end,
      documentNumber: result.data.document_number,
      publishedAt: result.data.published_at,
      person: { ...person, worker_type: result.data.worker_type },
      items: person.hr_payroll_run_items ?? [],
      worker: worker.data,
      addAttendanceDeductionFallback: true,
      logoPng: logo
    }));
    return new Response(new Uint8Array(bytes), { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeDownloadName(result.data.document_number)}.pdf"`,
      "Content-Type": "application/pdf",
      "X-Content-Type-Options": "nosniff"
    }});
  } catch (error) {
    return Response.json({ error: userFacingError(error, "Unable to download document.") }, { status: 400 });
  }
}
