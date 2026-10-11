import * as XLSX from "xlsx";

export const importTemplateKinds = [
  "employee",
  "contractor",
  "field_executive",
  "helper",
  "employee_salary",
  "contractor_remuneration"
] as const;

export type ImportTemplateKind = (typeof importTemplateKinds)[number];

type TemplateDefinition = {
  fileName: string;
  headers: string[];
  title: string;
  notes: string[];
};

const peopleHeaders = [
  "DropX ID",
  "Biometric ID",
  "Full name",
  "Mob country code",
  "Mob no",
  "Email",
  "Date of join (DD/MM/YYYY)",
  "Location",
  "Designation code"
];

const definitions: Record<ImportTemplateKind, TemplateDefinition> = {
  employee: {
    fileName: "DropX_Employee_Bulk_Upload_Template.xlsx",
    title: "Employee bulk upload",
    headers: [...peopleHeaders, "Statutory applicability"],
    notes: [
      "Use one row per employee.",
      "Date of join must use DD/MM/YYYY.",
      "Statutory applicability accepts PF, ESI, PF/ESI, or Not Applicable.",
      "Location and designation must use their existing Dashboard codes."
    ]
  },
  contractor: {
    fileName: "DropX_Independent_Contractor_Bulk_Upload_Template.xlsx",
    title: "Independent contractor bulk upload",
    headers: peopleHeaders,
    notes: [
      "Use one row per independent contractor.",
      "Date of join must use DD/MM/YYYY.",
      "Location and designation must use their existing Dashboard codes."
    ]
  },
  field_executive: {
    fileName: "DropX_People_Bulk_Upload_Template.xlsx",
    title: "People bulk upload",
    headers: peopleHeaders,
    notes: [
      "Use one row per person.",
      "Date of join must use DD/MM/YYYY.",
      "Location and designation must use their existing Dashboard codes."
    ]
  },
  helper: {
    fileName: "DropX_Helper_Bulk_Upload_Template.xlsx",
    title: "Helper bulk upload",
    headers: [...peopleHeaders, "Bank account number", "IFSC"],
    notes: [
      "Use one row per Helper who is not already registered in Dashboard.",
      "Date of join must use DD/MM/YYYY.",
      "Location and designation must use their existing Dashboard codes.",
      "DropX ID and Biometric ID may be left blank only when the selected Helper designation has an ID generation series configured.",
      "Imported Helpers are activated immediately without a review step.",
      "Bank account number and IFSC are optional, but enter both together when supplied. Format Bank account number cells as Text so Excel preserves every digit. Both fields are needed before the Helper can be included in a bank payment file.",
      "PAN is not required for Helper import or Helper payout.",
      "Existing Helper records are rejected; this upload never overwrites a saved profile."
    ]
  },
  employee_salary: {
    fileName: "DropX_Employee_Salary_Upload_Template.xlsx",
    title: "Employee salary upload",
    headers: [
      "EmpCode",
      "BASIC",
      "HRA",
      "Conveyance/LTA",
      "Special",
      "Food",
      "Communication",
      "Other",
      "Total",
      "PF",
      "ESI",
      "CTC",
      "CTC/YR"
    ],
    notes: [
      "EmpCode is matched to the saved DropX employee ID. Name, designation, and location are not used.",
      "Total must equal BASIC + HRA + Conveyance/LTA + Special + Food + Communication + Other.",
      "CTC must equal Total + PF + ESI. CTC/YR must equal CTC x 12.",
      "Use non-negative numeric amounts and one row per EmpCode."
    ]
  },
  contractor_remuneration: {
    fileName: "DropX_IC_Remuneration_Upload_Template.xlsx",
    title: "Independent contractor remuneration upload",
    headers: ["DropX ID", "Remuneration"],
    notes: [
      "DropX ID is matched to the saved independent contractor record.",
      "Remuneration is the positive monthly amount.",
      "Use one row per DropX ID. Name, designation, and location are not required."
    ]
  }
};

export function isImportTemplateKind(value: string): value is ImportTemplateKind {
  return importTemplateKinds.includes(value as ImportTemplateKind);
}

export function buildImportTemplate(kind: ImportTemplateKind) {
  const definition = definitions[kind];
  const workbook = XLSX.utils.book_new();
  const uploadSheet = XLSX.utils.aoa_to_sheet([definition.headers]);
  uploadSheet["!cols"] = definition.headers.map((header) => ({ wch: Math.min(Math.max(header.length + 4, 14), 34) }));
  uploadSheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(definition.headers.length - 1)}1` };

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    [definition.title],
    [],
    ["Instructions"],
    ...definition.notes.map((note) => [note]),
    [],
    ["Do not rename or remove columns in the Upload sheet."]
  ]);
  instructionsSheet["!cols"] = [{ wch: 110 }];

  XLSX.utils.book_append_sheet(workbook, uploadSheet, "Upload");
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "Instructions");
  return {
    bytes: XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true }) as Buffer,
    fileName: definition.fileName
  };
}

