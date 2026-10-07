import { supabaseAdmin } from "@/lib/supabase-admin";

// A DropX One device binding points at an account in one of several tables,
// depending on its profile type. This is where each type keeps the ID people
// are known by (employee code / DropX ID) and, where it has one, a designation.
const ACCOUNT_SOURCES: Record<string, { table: string; code: string; designation: boolean; label: string }> = {
  employee: { table: "employees", code: "employee_code", designation: false, label: "Employee" },
  contractor: { table: "contractors", code: "dropx_id", designation: true, label: "Contractor" },
  workforce: { table: "workforce", code: "dropx_id", designation: true, label: "Workforce" },
  field_executive: { table: "workforce", code: "dropx_id", designation: true, label: "Workforce" },
  vendor: { table: "vendors", code: "dropx_id", designation: true, label: "Vendor" },
  worker: { table: "helpers", code: "dropx_id", designation: true, label: "Helper" },
  user: { table: "profiles", code: "employee_id", designation: false, label: "Dashboard user" }
};

const CHUNK = 100;

export const deviceGroups = [
  { value: "workforce", label: "Workforce" },
  { value: "contractor", label: "Contractors" },
  { value: "employee", label: "Employees" }
] as const;

export type DeviceGroup = (typeof deviceGroups)[number]["value"];

export type BoundDevicePerson = {
  bindingId: string;
  name: string;
  /** Employee ID / DropX ID of every account this person signs in with. */
  codes: string[];
  /** e.g. "Workforce · Delivery Associate". */
  roles: string[];
  groups: DeviceGroup[];
  mobile: string;
  phone: string;
  boundSince: string;
  lastSignIn: string;
};

type BindingRow = {
  id: string;
  account_id: string;
  profile_type: string;
  display_name: string | null;
  country_code: string | null;
  mobile_number: string | null;
  device_label: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

function groupFor(profileType: string): DeviceGroup {
  if (profileType === "contractor") return "contractor";
  if (profileType === "employee" || profileType === "user") return "employee";
  return "workforce";
}

function displayMobile(countryCode: string | null, mobile: string | null) {
  if (!mobile) return "";
  const local = countryCode && mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
  return countryCode ? `+${countryCode} ${local}` : local;
}

async function loadAccountDetails(rows: BindingRow[]) {
  const details = new Map<string, { code: string; designation: string }>();
  if (!supabaseAdmin) return details;
  const idsByType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!ACCOUNT_SOURCES[row.profile_type] || !row.account_id) continue;
    const ids = idsByType.get(row.profile_type) ?? new Set<string>();
    ids.add(row.account_id);
    idsByType.set(row.profile_type, ids);
  }
  const lookups: Promise<void>[] = [];
  for (const [profileType, idSet] of idsByType) {
    const source = ACCOUNT_SOURCES[profileType];
    const ids = [...idSet];
    for (let index = 0; index < ids.length; index += CHUNK) {
      lookups.push((async () => {
        const result = await supabaseAdmin!.from(source.table)
          .select(`id, ${source.code}${source.designation ? ", designation" : ""}`)
          .in("id", ids.slice(index, index + CHUNK));
        // An account table that cannot be read just leaves those people without an ID.
        if (result.error) return;
        for (const row of (result.data ?? []) as unknown as Record<string, string | null>[]) {
          if (!row.id) continue;
          details.set(`${profileType}:${row.id}`, {
            code: String(row[source.code] ?? "").trim(),
            designation: String(row.designation ?? "").trim()
          });
        }
      })());
    }
  }
  await Promise.all(lookups);
  return details;
}

/**
 * Everyone in the company with a phone bound to DropX One, newest sign-in
 * first. A person with several DropX One accounts has one binding per account,
 * all on the same phone; they are shown once with every ID they hold.
 */
export async function loadBoundDevices(companyId: string): Promise<{ people: BoundDevicePerson[]; error: string | null }> {
  if (!supabaseAdmin) return { people: [], error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin
    .from("connect_account_devices")
    .select("id, account_id, profile_type, display_name, country_code, mobile_number, device_label, first_seen_at, last_seen_at")
    .eq("company_id", companyId)
    .eq("platform", "app")
    .is("reset_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(5000);
  if (result.error) return { people: [], error: result.error.message };

  const rows = (result.data ?? []) as BindingRow[];
  const details = await loadAccountDetails(rows);
  const byPerson = new Map<string, BoundDevicePerson>();
  for (const row of rows) {
    const key = row.mobile_number ? `${row.country_code}:${row.mobile_number}` : row.id;
    const detail = details.get(`${row.profile_type}:${row.account_id}`);
    const label = ACCOUNT_SOURCES[row.profile_type]?.label ?? "DropX One";
    const role = detail?.designation ? `${label} · ${detail.designation}` : label;
    const group = groupFor(row.profile_type);
    const person = byPerson.get(key) ?? {
      bindingId: row.id,
      name: row.display_name || "Unnamed person",
      codes: [],
      roles: [],
      groups: [],
      mobile: displayMobile(row.country_code, row.mobile_number),
      phone: row.device_label || "Android phone",
      boundSince: row.first_seen_at,
      lastSignIn: row.last_seen_at
    };
    if (detail?.code && !person.codes.includes(detail.code)) person.codes.push(detail.code);
    if (!person.roles.includes(role)) person.roles.push(role);
    if (!person.groups.includes(group)) person.groups.push(group);
    byPerson.set(key, person);
  }
  return { people: [...byPerson.values()], error: null };
}
