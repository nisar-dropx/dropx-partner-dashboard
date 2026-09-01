import type { AllPeopleRow } from "@/components/all-people-register";
import { allPeopleExportColumns, type AllPeopleExportValues } from "@/lib/all-people-export";
import { supabaseAdmin } from "@/lib/supabase-admin";

function first<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function dateText(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date).replace(",", "");
}

function exportValues(row: Record<string, unknown>, location: string, status: string, designation: string): AllPeopleExportValues {
  const values = Object.fromEntries(allPeopleExportColumns.map(({ key }) => [key, ""])) as AllPeopleExportValues;
  values.dropxId = String(row.dropx_id ?? "");
  values.fullName = String(row.full_name ?? "");
  values.category = "Workforce";
  values.dateOfJoin = dateText(row.date_of_join);
  values.location = location;
  values.designation = designation;
  values.status = status;
  values.active = row.is_active === false || row.deleted_at ? "No" : "Yes";
  values.createdAt = dateText(row.created_at);
  values.updatedAt = dateText(row.updated_at);
  return values;
}

export async function loadCanonicalWorkforcePeople(
  companyId: string,
  locationScopeIds: string[],
  hasAllLocationAccess: boolean
): Promise<{ rows: AllPeopleRow[]; error: string | null }> {
  if (!supabaseAdmin) return { rows: [], error: "Supabase service role key is not configured." };

  const result = await supabaseAdmin
    .from("workforce")
    .select("id, source_profile_type, source_profile_id, full_name, date_of_join, location_id, designation_id, dropx_id, biometric_id, mobile, email, onboarding_status, is_active, deleted_at, created_at, updated_at, stations (station_code), designations (code, name)")
    .eq("company_id", companyId)
    .order("full_name");
  if (result.error) return { rows: [], error: result.error.message };

  const seen = new Set<string>();
  const rows = ((result.data ?? []) as unknown as Record<string, unknown>[])
    .filter((row) => hasAllLocationAccess || locationScopeIds.includes(String(row.location_id ?? "")))
    .filter((row) => {
      const key = String(row.id ?? "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => {
      const station = first(row.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
      const designationRecord = first(row.designations as { code?: string; name?: string } | Array<{ code?: string; name?: string }> | null);
      const location = String(station?.station_code ?? "-");
      const designation = String(designationRecord?.name ?? designationRecord?.code ?? "-").trim() || "-";
      const active = row.is_active !== false && !row.deleted_at;
      const onboardingStatus = String(row.onboarding_status ?? "").trim().replaceAll("_", " ");
      const status = active
        ? onboardingStatus
          ? onboardingStatus.replace(/\b\w/g, (letter) => letter.toUpperCase())
          : "Active"
        : "Inactive";
      return {
        id: String(row.id),
        category: "Workforce",
        categoryCode: "workforce",
        code: String(row.dropx_id ?? "-"),
        biometricId: String(row.biometric_id ?? "-") || "-",
        fullName: String(row.full_name ?? "-"),
        mobile: String(row.mobile ?? "-") || "-",
        email: String(row.email ?? "-") || "-",
        location,
        designation,
        status,
        canEdit: false,
        exportValues: exportValues(row, location, status, designation)
      } satisfies AllPeopleRow;
    });

  return { rows, error: null };
}
