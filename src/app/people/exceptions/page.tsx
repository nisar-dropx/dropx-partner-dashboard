import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { requirePagePermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDate } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { updateAndClearPeopleException } from "./actions";

type ProfileRow = Record<string, unknown> & { id: string; full_name: string | null; location_id: string | null; statutory_applicability: string[] | null; updated_at: string | null };
type VerificationRow = { account_id: string; profile_type: string; kind: string; message: string | null; updated_at: string };
type ResolutionRow = { profile_type: string; profile_id: string; rule_code: string; source_updated_at: string };
type ExceptionRow = { profileType: string; profileId: string; table: string; dropxId: string; name: string; designation: string; location: string; category: string; ruleCode: string; issue: string; detail: string; sourceUpdatedAt: string; profile: ProfileRow };

const SOURCES = [
  { table: "employees", profileType: "employee", category: "Employee", employee: true },
  { table: "field_executives", profileType: "field_executive", category: "Delivery Associate", employee: false },
  { table: "contractors", profileType: "contractor", category: "Contractor", employee: false },
  { table: "vendors", profileType: "vendor", category: "Vendor", employee: false },
  { table: "workers", profileType: "worker", category: "Worker", employee: false }
] as const;
const BASE_FIELDS = "id, full_name, location_id, statutory_applicability, pf_uan, esi_no, bank_account_no, pan_number, aadhaar_number, driving_license_no, driving_license_exp_date, vehicle_reg_no, vehicle_reg_exp_date, vehicle_insurance_exp_date, vehicle_pollution_exp_date, updated_at, stations (station_code)";
const PAGE_SIZE = 20;

function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function clean(value: unknown) { return String(value ?? "").trim(); }
function expired(value: unknown, today: string) { const date = clean(value); return Boolean(date && date < today); }
function key(type: string, id: string, rule: string) { return `${type}:${id}:${rule}`; }
function dateValue(value: unknown) { return clean(value) ? formatDashboardDate(clean(value)) : "-"; }

async function loadExceptions(companyId: string, authorization: AuthorizationContext) {
  if (!supabaseAdmin) return { rows: [] as ExceptionRow[], error: "Database connection is not configured." };
  const profileResults = await Promise.all(SOURCES.map(async (source) => {
    const select = source.employee ? `${BASE_FIELDS}, employee_code, profile_completion_status, ifsc, designations (name)` : `${BASE_FIELDS}, dropx_id, onboarding_status, ifsc_code, designation`;
    let query = supabaseAdmin!.from(source.table).select(select).eq("company_id", companyId).eq(source.employee ? "profile_completion_status" : "onboarding_status", "active");
    if (!authorization.hasAllLocationAccess && !authorization.isMasterOwner) query = query.in("location_id", authorization.locationScopeIds);
    const result = await query;
    return { source, data: (result.data ?? []) as unknown as ProfileRow[], error: result.error?.message ?? null };
  }));
  const profileError = profileResults.find((result) => result.error)?.error;
  if (profileError) return { rows: [] as ExceptionRow[], error: profileError };

  const [verificationResult, resolutionResult] = await Promise.all([
    supabaseAdmin.from("connect_profile_verifications").select("account_id, profile_type, kind, message, updated_at").eq("company_id", companyId).eq("verified", false).neq("kind", "bank"),
    supabaseAdmin.from("people_exception_resolutions").select("profile_type, profile_id, rule_code, source_updated_at").eq("company_id", companyId)
  ]);
  if (verificationResult.error || resolutionResult.error) return { rows: [] as ExceptionRow[], error: verificationResult.error?.message || resolutionResult.error?.message || "Unable to load exceptions." };

  const today = new Date().toISOString().slice(0, 10);
  const rows: ExceptionRow[] = [];
  const profileByKey = new Map<string, { row: ProfileRow; source: typeof SOURCES[number] }>();
  const add = (source: typeof SOURCES[number], profile: ProfileRow, ruleCode: string, issue: string, detail: string, sourceUpdatedAt?: string | null) => {
    const station = first(profile.stations as { station_code?: string } | Array<{ station_code?: string }> | null);
    const designationRelation = first(profile.designations as { name?: string } | Array<{ name?: string }> | null);
    rows.push({ profileType: source.profileType, profileId: profile.id, table: source.table, dropxId: clean(source.employee ? profile.employee_code : profile.dropx_id) || "-", name: clean(profile.full_name) || "Unnamed profile", designation: clean(source.employee ? designationRelation?.name : profile.designation) || "-", location: clean(station?.station_code) || "-", category: source.category, ruleCode, issue, detail, sourceUpdatedAt: sourceUpdatedAt || profile.updated_at || new Date(0).toISOString(), profile });
  };

  for (const result of profileResults) for (const profile of result.data) {
    profileByKey.set(`${result.source.profileType}:${profile.id}`, { row: profile, source: result.source });
    const statutory = profile.statutory_applicability ?? [];
    if (statutory.includes("pf") && !clean(profile.pf_uan)) add(result.source, profile, "pf_missing", "PF details missing", "PF is enabled, but the profile has no PF UAN.");
    if (statutory.includes("esi") && !clean(profile.esi_no)) add(result.source, profile, "esi_missing", "ESI details missing", "ESI is enabled, but the profile has no ESI number.");
    if (expired(profile.driving_license_exp_date, today)) add(result.source, profile, "dl_expired", "Driving licence expired", `Expired on ${dateValue(profile.driving_license_exp_date)}.`);
    if (clean(profile.vehicle_reg_no) && expired(profile.vehicle_reg_exp_date, today)) add(result.source, profile, "vehicle_registration_expired", "Vehicle registration expired", `Expired on ${dateValue(profile.vehicle_reg_exp_date)}.`);
    if (clean(profile.vehicle_reg_no) && expired(profile.vehicle_insurance_exp_date, today)) add(result.source, profile, "vehicle_insurance_expired", "Vehicle insurance expired", `Expired on ${dateValue(profile.vehicle_insurance_exp_date)}.`);
    if (clean(profile.vehicle_reg_no) && expired(profile.vehicle_pollution_exp_date, today)) add(result.source, profile, "vehicle_pollution_expired", "Pollution certificate expired", `Expired on ${dateValue(profile.vehicle_pollution_exp_date)}.`);
  }
  for (const verification of (verificationResult.data ?? []) as VerificationRow[]) {
    if (/partial/i.test(clean(verification.message))) continue;
    const match = profileByKey.get(`${verification.profile_type}:${verification.account_id}`);
    if (!match) continue;
    const label = verification.kind === "pf_uan" ? "PF verification failed" : verification.kind === "bank" ? "Bank verification failed" : `${verification.kind.toUpperCase()} verification failed`;
    add(match.source, match.row, `verification_${verification.kind}`, label, clean(verification.message) || "Submitted verification did not succeed.", verification.updated_at);
  }
  const resolutions = new Map(((resolutionResult.data ?? []) as ResolutionRow[]).map((row) => [key(row.profile_type, row.profile_id, row.rule_code), row.source_updated_at]));
  return { rows: rows.filter((row) => resolutions.get(key(row.profileType, row.profileId, row.ruleCode)) !== row.sourceUpdatedAt).sort((a, b) => a.name.localeCompare(b.name) || a.issue.localeCompare(b.issue)), error: null as string | null };
}

function editFields(row: ExceptionRow) {
  const field = (name: string, label: string, type = "text") => <label key={name}>{label}<input className="field" defaultValue={clean(row.profile[name])} name={name} required type={type} /></label>;
  if (row.ruleCode.includes("pf")) return [field("pf_uan", "PF UAN")];
  if (row.ruleCode.includes("esi")) return [field("esi_no", "ESI Number")];
  if (row.ruleCode.includes("bank")) return [field("bank_account_no", "Bank Account Number"), field(row.profileType === "employee" ? "ifsc" : "ifsc_code", "IFSC")];
  if (row.ruleCode.includes("pan_aadhaar")) return [field("pan_number", "PAN Number"), field("aadhaar_number", "Aadhaar Number")];
  if (row.ruleCode.includes("pan")) return [field("pan_number", "PAN Number")];
  if (row.ruleCode.includes("dl")) return [field("driving_license_no", "Driving Licence Number"), field("driving_license_exp_date", "Driving Licence Expiry", "date")];
  if (row.ruleCode === "vehicle_registration_expired") return [field("vehicle_reg_no", "Vehicle Registration Number"), field("vehicle_reg_exp_date", "Registration Expiry", "date")];
  if (row.ruleCode === "vehicle_insurance_expired") return [field("vehicle_reg_no", "Vehicle Registration Number"), field("vehicle_insurance_exp_date", "Insurance Expiry", "date")];
  if (row.ruleCode === "vehicle_pollution_expired") return [field("vehicle_reg_no", "Vehicle Registration Number"), field("vehicle_pollution_exp_date", "Pollution Expiry", "date")];
  return [field("vehicle_reg_no", "Vehicle Registration Number"), field("vehicle_reg_exp_date", "Registration Expiry", "date"), field("vehicle_insurance_exp_date", "Insurance Expiry", "date"), field("vehicle_pollution_exp_date", "Pollution Expiry", "date")];
}

export const dynamic = "force-dynamic";

export default async function PeopleExceptionsPage({ searchParams }: { searchParams?: { error?: string; notice?: string; page?: string; edit?: string } }) {
  const authorization = await requirePagePermission("people_exceptions", "access");
  const { rows, error } = await loadExceptions(requireCompanyId(authorization), authorization);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pageCount, Math.max(1, Number(searchParams?.page) || 1));
  const visibleRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const selected = searchParams?.edit ? rows.find((row) => key(row.profileType, row.profileId, row.ruleCode) === searchParams.edit) ?? null : null;
  return <AppShell active="Exception" pageCode="people_exceptions">
    <PageHead eyebrow="People" title="Exceptions" subtitle="Active-profile statutory, verification, and expired-document exceptions." action={<StatusPill status={`${rows.length} open`} />} />
    {(error || searchParams?.error || searchParams?.notice) ? <section className={`panel message-panel ${error || searchParams?.error ? "error" : "success"}`}><div className="panel-body"><strong>{error || searchParams?.error ? "Exceptions need attention" : "Updated"}</strong><p className="subtle">{error || searchParams?.error || searchParams?.notice}</p></div></section> : null}
    <section className="panel"><div className="panel-head"><div><h2>Open exceptions</h2><p className="subtle">Active profiles only. Partial matches remain in Under Review.</p></div></div><div className="table-wrap"><table><thead><tr><th>DropX ID</th><th>Person</th><th>Category</th><th>Designation</th><th>Location</th><th>Exception</th><th>Details</th><th>Action</th></tr></thead><tbody>
      {visibleRows.length ? visibleRows.map((row) => <tr key={key(row.profileType, row.profileId, row.ruleCode)}><td><strong>{row.dropxId}</strong></td><td><strong>{row.name}</strong></td><td>{row.category}</td><td>{row.designation}</td><td>{row.location}</td><td><StatusPill status={row.issue} /></td><td>{row.detail}</td><td><PendingLink className="button secondary compact" href={`/people/exceptions?page=${page}&edit=${encodeURIComponent(key(row.profileType, row.profileId, row.ruleCode))}`} scroll={false}>Clear</PendingLink></td></tr>) : <tr><td className="empty-cell" colSpan={8}>No open people exceptions.</td></tr>}
    </tbody></table></div><div className="panel-body" style={{ display: "flex", justifyContent: "space-between" }}><span className="subtle">Page {page} of {pageCount} · {rows.length} records</span><div className="form-actions">{page > 1 ? <PendingLink className="button secondary compact" href={`/people/exceptions?page=${page - 1}`}>Previous</PendingLink> : null}{page < pageCount ? <PendingLink className="button secondary compact" href={`/people/exceptions?page=${page + 1}`}>Next</PendingLink> : null}</div></div></section>
    {selected ? <div className="modal-backdrop"><section className="modal-panel" role="dialog" aria-modal="true"><div className="panel-head"><div><h2>Correct exception</h2><p className="subtle">{selected.name} · {selected.issue}</p></div><PendingLink className="modal-close" href={`/people/exceptions?page=${page}`} scroll={false}>x</PendingLink></div><form action={updateAndClearPeopleException} className="panel-body"><input name="profile_type" type="hidden" value={selected.profileType} /><input name="profile_id" type="hidden" value={selected.profileId} /><input name="rule_code" type="hidden" value={selected.ruleCode} /><input name="source_updated_at" type="hidden" value={selected.sourceUpdatedAt} /><div className="form-grid two">{editFields(selected)}</div><div className="form-actions modal-actions"><PendingLink className="button secondary" href={`/people/exceptions?page=${page}`} scroll={false}>Cancel</PendingLink><button className="button" type="submit">Save and clear</button></div></form></section></div> : null}
  </AppShell>;
}
