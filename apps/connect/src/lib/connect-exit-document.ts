// Pure renderer for exit/offboarding documents (relieving letter, experience
// certificate, etc.) downloaded from Connect — mirrors dropx-hrms's
// exit-document-render.ts render step exactly (same template-filling and
// experience-certificate-v2 branch), but has no DB access of its own: the caller
// (the API route) loads everything and passes it in, matching how
// connect-pay-document.ts is structured. See exit-documents.ts for why this is
// hand-duplicated rather than shared.
import { buildExperienceCertificateReference, createExitPdf, createExperienceCertificatePdf, fillExitTemplate } from "./exit-documents";

function formatDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T00:00:00+05:30`)) : "";
}

export type ConnectExitDocumentTemplate = {
  document_type: string;
  title_template: string;
  body_template: string;
  variant?: string | null;
  layout_key?: string | null;
};

export async function renderConnectExitDocumentPdf(input: {
  template: ConnectExitDocumentTemplate;
  companyName: string;
  registeredAddress?: string | null;
  footerText?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  caseNumber: string;
  employeeName: string;
  employeeCode: string;
  designationName: string;
  dateOfJoining: string | null;
  lastWorkingDate: string | null;
  exitReason: string;
  settlementLines: string;
  settlementNet: string;
  settlementStatus: string;
  issueDateIso: string;
  referenceNumber: string | null;
}) {
  const values: Record<string, string> = {
    generated_date: formatDate(input.issueDateIso), company_name: input.companyName,
    employee_name: input.employeeName, employee_code: input.employeeCode, designation: input.designationName,
    date_of_joining: formatDate(input.dateOfJoining), last_working_date: formatDate(input.lastWorkingDate),
    case_number: input.caseNumber, exit_reason: input.exitReason,
    settlement_lines: input.settlementLines, settlement_net: input.settlementNet, settlement_status: input.settlementStatus,
    role_duties: ""
  };
  const isExperience = ["experience", "experience_certificate"].includes(input.template.document_type);
  const layoutKey = String(input.template.layout_key ?? "legacy_body");
  const useExperienceV2 = isExperience && layoutKey === "experience_certificate_v2";
  if (useExperienceV2) {
    const reference = input.referenceNumber ?? buildExperienceCertificateReference(input.issueDateIso, 1);
    return createExperienceCertificatePdf({
      companyName: input.companyName,
      registeredAddress: input.registeredAddress,
      footerText: input.footerText,
      signatoryName: input.signatoryName,
      signatoryTitle: input.signatoryTitle || "Head Human Resources",
      referenceNumber: reference,
      issueDate: formatDate(input.issueDateIso),
      employeeName: values.employee_name,
      employeeCode: values.employee_code,
      designation: values.designation,
      dateOfJoining: values.date_of_joining,
      lastWorkingDate: values.last_working_date,
      variant: (String(input.template.variant ?? "standard") as "standard" | "manager" | "custom"),
      roleDuties: values.role_duties || null,
      bodyOverride: null
    });
  }
  const title = fillExitTemplate(input.template.title_template, values);
  const body = fillExitTemplate(input.template.body_template, values);
  return createExitPdf({ title, body, companyName: input.companyName, registeredAddress: input.registeredAddress, footerText: input.footerText, signatoryName: input.signatoryName, signatoryTitle: input.signatoryTitle });
}
