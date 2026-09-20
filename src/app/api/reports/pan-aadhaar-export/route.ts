import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { timingSafeEqual } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Person = {
  id: string;
  employee_code?: string | null;
  dropx_id?: string | null;
  full_name: string | null;
  pan_number: string | null;
  aadhaar_number: string | null;
  location_id: string | null;
};

type Station = { id: string; station_code: string | null };
type Verification = { account_id: string; profile_type: string; verified: boolean | null; message: string | null; updated_at: string | null };
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

function hasIntegrationAccess(request: Request) {
  const expected = process.env.PEOPLE_EXPORT_API_KEY?.trim();
  const received = request.headers.get("x-dropx-export-key")?.trim();
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function csv(value: unknown) {
  const text = String(value ?? "");
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  const integrationAccess = hasIntegrationAccess(request);
  if (!integrationAccess && (!authorization || !hasPermission(authorization, "people_review", "access"))) {
    return Response.json({ error: "PAN/Aadhaar export access denied." }, { status: 403 });
  }
  if (!supabaseAdmin) return Response.json({ error: "Database unavailable." }, { status: 500 });

  const db = supabaseAdmin;
  let companyId: string;
  if (integrationAccess) {
    const company = await db.from("companies").select("id").eq("name", "DROPX LOGISTICS").maybeSingle();
    if (company.error || !company.data) return Response.json({ error: "DropX Logistics export company is unavailable." }, { status: 503 });
    companyId = company.data.id;
  } else {
    companyId = requireCompanyId(authorization!);
  }

  const [stations, employees, workforce, contractors, vendors, helpers, verifications] = await Promise.all([
    allRows<Station>((from, to) => db.from("stations").select("id, station_code").eq("company_id", companyId).range(from, to)),
    allRows<Person>((from, to) => db.from("employees").select("id, employee_code, full_name, pan_number, aadhaar_number, location_id").eq("company_id", companyId).range(from, to)),
    allRows<Person>((from, to) => db.from("workforce").select("id, dropx_id, full_name, pan_number, aadhaar_number, location_id").eq("company_id", companyId).range(from, to)),
    allRows<Person>((from, to) => db.from("contractors").select("id, dropx_id, full_name, pan_number, aadhaar_number, location_id").eq("company_id", companyId).range(from, to)),
    allRows<Person>((from, to) => db.from("vendors").select("id, dropx_id, full_name, pan_number, aadhaar_number, location_id").eq("company_id", companyId).range(from, to)),
    allRows<Person>((from, to) => db.from("helpers").select("id, dropx_id, full_name, pan_number, aadhaar_number, location_id").eq("company_id", companyId).range(from, to)),
    allRows<Verification>((from, to) => db.from("connect_profile_verifications").select("account_id, profile_type, verified, message, updated_at").eq("company_id", companyId).eq("kind", "pan_aadhaar").range(from, to))
  ]);
  const failed = [stations, employees, workforce, contractors, vendors, helpers, verifications].find((result) => result.error);
  if (failed?.error) return Response.json({ error: `Unable to prepare PAN/Aadhaar export: ${failed.error.message}` }, { status: 500 });

  const allLocations = integrationAccess || authorization!.hasAllLocationAccess || authorization!.isMasterOwner || authorization!.roleCode === "OWNER";
  const permittedLocationIds = new Set(authorization?.locationScopeIds ?? []);
  const stationCodes = new Map((stations.data ?? []).map((station) => [station.id, station.station_code ?? ""]));
  const verificationMap = new Map((verifications.data ?? []).map((verification) => [`${verification.profile_type}:${verification.account_id}`, verification]));
  const rows = [
    ["employee", employees.data ?? []],
    ["workforce", workforce.data ?? []],
    ["contractor", contractors.data ?? []],
    ["vendor", vendors.data ?? []],
    ["worker", helpers.data ?? []]
  ].flatMap(([profileType, people]) => (people as Person[])
    .filter((person) => allLocations || Boolean(person.location_id && permittedLocationIds.has(person.location_id)))
    .map((person) => {
      const verification = verificationMap.get(`${profileType}:${person.id}`);
      return {
        StaffID: String(person.employee_code ?? person.dropx_id ?? ""),
        FullName: person.full_name ?? "",
        StationCode: person.location_id ? stationCodes.get(person.location_id) ?? "" : "",
        PAN: person.pan_number ?? "",
        AadhaarNo: person.aadhaar_number ?? "",
        PanAadhaarLink: verification?.verified === true,
        Message: verification?.message ?? "Not verified",
        LastUpdated: verification?.updated_at ?? null
      };
    }))
    .sort((a, b) => a.StationCode.localeCompare(b.StationCode) || a.FullName.localeCompare(b.FullName));

  if (new URL(request.url).searchParams.get("format")?.toLowerCase() === "csv") {
    const headers = ["StaffID", "FullName", "StationCode", "PAN", "AadhaarNo", "PanAadhaarLink", "Message", "LastUpdated"] as const;
    return new Response(`\uFEFF${[headers.join(","), ...rows.map((row) => headers.map((header) => csv(row[header])).join(","))].join("\r\n")}`, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="dropx-pan-aadhaar-export.csv"', "Cache-Control": "private, no-store" }
    });
  }
  return Response.json({ exportedAt: new Date().toISOString(), count: rows.length, rows }, { headers: { "Cache-Control": "private, no-store" } });
}
