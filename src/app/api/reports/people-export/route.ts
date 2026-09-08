import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Station = {
  id: string;
  station_code: string | null;
  providers: { name: string | null } | { name: string | null }[] | null;
};

type PersonRecord = {
  id: string;
  employee_code?: string | null;
  dropx_id?: string | null;
  full_name: string | null;
  bank_account_no: string | null;
  ifsc?: string | null;
  ifsc_code?: string | null;
  email: string | null;
  profile_completion_status?: string | null;
  onboarding_status?: string | null;
  lifecycle_status?: string | null;
  is_active: boolean | null;
  location_id: string | null;
};

type ExportRow = {
  personType: string;
  dropxId: string;
  fullName: string;
  bankAccountNo: string;
  ifsc: string;
  email: string;
  staffStatus: string;
  stationCode: string;
  stationProvider: string;
};

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

async function allRows<T>(page: (from: number, to: number) => PromiseLike<QueryResult<T>>, cap = 100000) {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let from = 0; from < cap; from += pageSize) {
    const result = await page(from, from + pageSize - 1);
    if (result.error) return { data: rows, error: result.error };
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { data: rows, error: null };
  }
  return { data: [], error: { message: `This export exceeds ${cap.toLocaleString("en-IN")} rows.` } };
}

function relationValue<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function statusOf(person: PersonRecord) {
  return String(person.lifecycle_status ?? person.onboarding_status ?? person.profile_completion_status ?? "").trim()
    || (person.is_active ? "Active" : "Inactive");
}

function spreadsheetValue(value: unknown) {
  const text = value == null ? "" : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csv(value: unknown) {
  return `"${spreadsheetValue(value).replace(/"/g, '""')}"`;
}

function hasIntegrationAccess(request: Request) {
  const expected = process.env.PEOPLE_EXPORT_API_KEY?.trim();
  const received = request.headers.get("x-dropx-export-key")?.trim();
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function csvResponse(rows: ExportRow[]) {
  const headers: Array<keyof ExportRow> = [
    "personType", "dropxId", "fullName", "bankAccountNo", "ifsc", "email", "staffStatus", "stationCode", "stationProvider"
  ];
  const body = [
    headers.map((key) => csv(key)).join(","),
    ...rows.map((row) => headers.map((key) => csv(row[key])).join(","))
  ].join("\r\n");
  return new Response(`\uFEFF${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="dropx-people-export.csv"',
      "Cache-Control": "private, no-store"
    }
  });
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  const integrationAccess = hasIntegrationAccess(request);
  if (!integrationAccess && (!authorization || !hasPermission(authorization, "people_review", "access"))) {
    return Response.json({ error: "People export access denied." }, { status: 403 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });

  const db = supabaseAdmin;
  let companyId: string;
  if (integrationAccess) {
    const company = await db
      .from("companies")
      .select("id")
      .eq("name", "DROPX LOGISTICS")
      .maybeSingle();
    if (company.error || !company.data) {
      return Response.json({ error: "DropX Logistics export company is unavailable." }, { status: 503 });
    }
    companyId = company.data.id;
  } else {
    companyId = requireCompanyId(authorization!);
  }
  const [stations, employees, workforce, contractors, vendors, helpers] = await Promise.all([
    allRows((from, to) => db.from("stations").select("id, station_code, providers(name)").eq("company_id", companyId).order("station_code").range(from, to)),
    allRows<PersonRecord>((from, to) => db.from("employees").select("id, employee_code, full_name, bank_account_no, ifsc, email, profile_completion_status, is_active, location_id").eq("company_id", companyId).order("full_name").range(from, to)),
    allRows<PersonRecord>((from, to) => db.from("workforce").select("id, dropx_id, full_name, bank_account_no, ifsc_code, email, onboarding_status, lifecycle_status, is_active, location_id").eq("company_id", companyId).order("full_name").range(from, to)),
    allRows<PersonRecord>((from, to) => db.from("contractors").select("id, dropx_id, full_name, bank_account_no, ifsc_code, email, onboarding_status, lifecycle_status, is_active, location_id").eq("company_id", companyId).order("full_name").range(from, to)),
    allRows<PersonRecord>((from, to) => db.from("vendors").select("id, dropx_id, full_name, bank_account_no, ifsc_code, email, onboarding_status, lifecycle_status, is_active, location_id").eq("company_id", companyId).order("full_name").range(from, to)),
    allRows<PersonRecord>((from, to) => db.from("helpers").select("id, dropx_id, full_name, bank_account_no, ifsc_code, email, onboarding_status, lifecycle_status, is_active, location_id").eq("company_id", companyId).order("full_name").range(from, to))
  ]);

  const failed = [stations, employees, workforce, contractors, vendors, helpers].find((result) => result.error);
  if (failed?.error) return Response.json({ error: `Unable to prepare people export: ${failed.error.message}` }, { status: 500 });

  const allLocations = integrationAccess || authorization!.hasAllLocationAccess || authorization!.isMasterOwner || authorization!.roleCode === "OWNER";
  const permittedLocationIds = new Set(authorization?.locationScopeIds ?? []);
  const stationMap = new Map((stations.data as Station[]).map((station) => {
    const provider = relationValue(station.providers);
    return [station.id, { code: station.station_code ?? "", provider: provider?.name ?? "" }];
  }));

  const buildRows = (personType: string, people: PersonRecord[]) => people
    .filter((person) => allLocations || Boolean(person.location_id && permittedLocationIds.has(person.location_id)))
    .map((person): ExportRow => {
      const station = person.location_id ? stationMap.get(person.location_id) : undefined;
      return {
        personType,
        dropxId: String(person.employee_code ?? person.dropx_id ?? ""),
        fullName: person.full_name ?? "",
        bankAccountNo: person.bank_account_no ?? "",
        ifsc: person.ifsc ?? person.ifsc_code ?? "",
        email: person.email ?? "",
        staffStatus: statusOf(person),
        stationCode: station?.code ?? "",
        stationProvider: station?.provider ?? ""
      };
    });

  const rows = [
    ...buildRows("Employee", employees.data),
    ...buildRows("Workforce", workforce.data),
    ...buildRows("Contractor", contractors.data),
    ...buildRows("Vendor", vendors.data),
    ...buildRows("Helper", helpers.data)
  ].sort((a, b) => a.personType.localeCompare(b.personType) || a.fullName.localeCompare(b.fullName));

  const format = new URL(request.url).searchParams.get("format")?.toLowerCase();
  if (format === "json") {
    return Response.json({ exportedAt: new Date().toISOString(), count: rows.length, rows }, {
      headers: { "Cache-Control": "private, no-store" }
    });
  }
  return csvResponse(rows);
}
