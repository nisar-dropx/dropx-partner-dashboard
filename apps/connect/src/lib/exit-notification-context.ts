import type { SupabaseClient } from "@supabase/supabase-js";

type Contact = { userId: string | null; name: string; email: string | null };
type Assignment = { id: string; engagement_id: string; location_id: string | null; designation_id: string | null; department_id: string | null; org_unit_id: string | null; position_title: string };
type Grant = { user_id: string; scope_type: string; scope_id: string | null };
export type ExitNoticeContext = {
  values: Record<string, string>;
  groups: Record<string, string[]>;
  managers: Contact[];
  hrContacts: Contact[];
  warnings: string[];
};

const hrRoleCodes = new Set(["HRE", "HRM", "HR", "HR_HEAD", "HR_EXECUTIVE", "HR_MANAGER", "HR_OPERATIONS"]);
export function isExitHrRole(code: string) { return hrRoleCodes.has(code.trim().toUpperCase()); }

export function exitEmails(values: Array<unknown>): string[] {
  return [...new Set(values.map(value => String(value ?? "").trim().toLowerCase())
    .filter(value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !value.endsWith(".internal")))];
}

export function exitGrantCoversWorker(grant: Grant, worker: {
  locationId: string | null; departmentId: string | null; orgUnitIds: string[];
  managerUserIds: string[]; directManagerUserId: string | null;
}) {
  switch (grant.scope_type) {
    case "company": return true;
    case "location": return Boolean(grant.scope_id && grant.scope_id === worker.locationId);
    case "department": return Boolean(grant.scope_id && grant.scope_id === worker.departmentId);
    case "org_unit": return Boolean(grant.scope_id && worker.orgUnitIds.includes(grant.scope_id));
    case "direct_reports": return grant.user_id === worker.directManagerUserId;
    case "reporting_subtree": return worker.managerUserIds.includes(grant.user_id);
    default: return false;
  }
}

async function checked<T>(query: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const result = await query;
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

function dateLabel(value: string | null | undefined, fallback = "Not recorded") {
  if (!value) return fallback;
  const date = new Date(value.length === 10 ? value + "T00:00:00+05:30" : value);
  return Number.isNaN(date.getTime()) ? fallback : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(date);
}

/** Read-only: never provisions identities or modifies the exit approval sequence.
 * Kept identical in People and One, with parity tests at release.
 */
export async function loadExitNoticeContext(db: SupabaseClient, companyId: string, caseId: string, options: { today?: string; taskOwnerId?: string } = {}): Promise<ExitNoticeContext> {
  const today = options.today ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const exitCase = await checked(db.from("hr_exit_cases")
    .select("id,case_number,worker_type,employee_id,contractor_id,personal_email,personal_mobile,hr_owner_user_id,requested_last_working_date,approved_last_working_date,submitted_at,status,scenario,notice_days")
    .eq("company_id", companyId).eq("id", caseId).maybeSingle());
  if (!exitCase) throw new Error("Exit case is unavailable.");
  const contractor = exitCase.worker_type === "contractor";
  const worker = await checked(db.from(contractor ? "contractors" : "employees")
    .select(contractor ? "id,dropx_id,full_name,email,mobile,location_id,designation_id" : "id,employee_code,full_name,email,mobile,location_id,designation_id")
    .eq("company_id", companyId).eq("id", contractor ? exitCase.contractor_id : exitCase.employee_id).maybeSingle());
  if (!worker) throw new Error("Exit worker is unavailable.");
  const workerCode = String(("dropx_id" in worker ? worker.dropx_id : worker.employee_code) ?? "");
  const engagement = await checked(db.from("hr_engagements").select("id,person_id,status")
    .eq("company_id", companyId).eq(contractor ? "contractor_id" : "employee_id", worker.id)
    .lte("start_date", today).order("start_date", { ascending: false }).limit(1).maybeSingle());
  const assignmentColumns = "id,engagement_id,location_id,designation_id,department_id,org_unit_id,position_title";
  const assignment: Assignment | null = engagement ? await checked(db.from("hr_work_assignments").select(assignmentColumns)
    .eq("company_id", companyId).eq("engagement_id", engagement.id).eq("is_primary", true)
    .lte("effective_from", today).or("effective_to.is.null,effective_to.gte." + today)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle()) : null;
  const locationId = assignment?.location_id ?? worker.location_id;
  const designationId = assignment?.designation_id ?? worker.designation_id;
  const [station, designation] = await Promise.all([
    locationId ? checked(db.from("stations").select("station_code,station_name").eq("company_id", companyId).eq("id", locationId).maybeSingle()) : null,
    designationId ? checked(db.from("designations").select("name").eq("company_id", companyId).eq("id", designationId).maybeSingle()) : null
  ]);

  async function profileContact(userId: string): Promise<Contact | null> {
    const profile = await checked(db.from("profiles").select("id,full_name,email").eq("company_id", companyId).eq("id", userId).eq("is_active", true).maybeSingle());
    return profile ? { userId: profile.id, name: profile.full_name ?? "Team member", email: exitEmails([profile.email])[0] ?? null } : null;
  }
  async function personContact(personId: string, engagementId: string): Promise<Contact> {
    const [person, links, record] = await Promise.all([
      checked(db.from("hr_people").select("display_name").eq("company_id", companyId).eq("id", personId).maybeSingle()),
      checked(db.from("hr_user_person_links").select("user_id").eq("company_id", companyId).eq("person_id", personId).eq("status", "active")),
      checked(db.from("hr_engagements").select("employee_id,contractor_id").eq("company_id", companyId).eq("id", engagementId).maybeSingle())
    ]);
    const profiles = await Promise.all((links ?? []).map(link => profileContact(link.user_id)));
    const profile = profiles.find(row => row?.email) ?? profiles.find(Boolean);
    let email = profile?.email ?? null;
    if (!email && record) {
      const contact = await checked(db.from(record.employee_id ? "employees" : "contractors").select("email")
        .eq("company_id", companyId).eq("id", record.employee_id ?? record.contractor_id).eq("is_active", true).maybeSingle());
      email = exitEmails([contact?.email])[0] ?? null;
    }
    return { userId: profile?.userId ?? null, name: person?.display_name ?? profile?.name ?? "Manager", email };
  }

  const managers: Contact[] = [];
  const allManagerUserIds: string[] = [];
  const seenPeople = new Set<string>(engagement?.person_id ? [engagement.person_id] : []);
  const seenAssignments = new Set<string>();
  let current = assignment?.id ?? null;
  // Walk ancestors for scoped-HR checks, but only the first two people receive manager email.
  for (let depth = 0; current && depth < 16; depth++) {
    if (seenAssignments.has(current)) break;
    seenAssignments.add(current);
    const relation = await checked(db.from("hr_reporting_relationships").select("manager_assignment_id")
      .eq("company_id", companyId).eq("subject_assignment_id", current).eq("relationship_type", "solid_line").eq("is_primary", true)
      .lte("effective_from", today).or("effective_to.is.null,effective_to.gte." + today)
      .order("effective_from", { ascending: false }).limit(1).maybeSingle());
    if (!relation?.manager_assignment_id || seenAssignments.has(relation.manager_assignment_id)) break;
    const managerAssignment = await checked(db.from("hr_work_assignments").select("id,engagement_id")
      .eq("company_id", companyId).eq("id", relation.manager_assignment_id)
      .lte("effective_from", today).or("effective_to.is.null,effective_to.gte." + today).maybeSingle());
    if (!managerAssignment) break;
    current = managerAssignment.id;
    const managerEngagement = await checked(db.from("hr_engagements").select("id,person_id")
      .eq("company_id", companyId).eq("id", managerAssignment.engagement_id).eq("status", "active").maybeSingle());
    if (!managerEngagement || seenPeople.has(managerEngagement.person_id)) break;
    seenPeople.add(managerEngagement.person_id);
    const contact = await personContact(managerEngagement.person_id, managerEngagement.id);
    if (contact.userId) allManagerUserIds.push(contact.userId);
    if (managers.length < 2) managers.push(contact);
  }
  // Legacy records only: never let a stale profile override a configured People assignment.
  if (!assignment && !engagement && workerCode) {
    const profile = await checked(db.from("profiles").select("id,reports_to_user_id").eq("company_id", companyId).eq("employee_id", workerCode).eq("is_active", true).limit(1).maybeSingle());
    const seen = new Set<string>(profile ? [profile.id] : []);
    let managerId = profile?.reports_to_user_id;
    for (let level = 0; managerId && level < 2 && !seen.has(managerId); level++) {
      seen.add(managerId);
      const manager = await checked(db.from("profiles").select("id,full_name,email,reports_to_user_id").eq("company_id", companyId).eq("id", managerId).eq("is_active", true).maybeSingle());
      if (!manager) break;
      managers.push({ userId: manager.id, name: manager.full_name ?? "Manager", email: exitEmails([manager.email])[0] ?? null });
      allManagerUserIds.push(manager.id);
      managerId = manager.reports_to_user_id;
    }
  }

  const orgUnitIds: string[] = [];
  let orgId = assignment?.org_unit_id;
  for (let depth = 0; orgId && depth < 16 && !orgUnitIds.includes(orgId); depth++) {
    orgUnitIds.push(orgId);
    const org = await checked(db.from("hr_org_units").select("parent_org_unit_id").eq("company_id", companyId).eq("id", orgId).maybeSingle());
    orgId = org?.parent_org_unit_id;
  }
  const roles = await checked(db.from("hr_roles").select("id,code").eq("company_id", companyId).eq("is_active", true));
  const hrRoleIds = (roles ?? []).filter(role => isExitHrRole(role.code)).map(role => role.id);
  const page = await checked(db.from("hr_permission_pages").select("id").eq("company_id", companyId).eq("code", "exits").eq("is_active", true).maybeSingle());
  const permissions = hrRoleIds.length && page ? await checked(db.from("hr_role_page_permissions").select("role_id")
    .eq("company_id", companyId).eq("page_id", page.id).eq("can_view", true).in("role_id", hrRoleIds)) : [];
  const allowedRoleIds = (permissions ?? []).map(row => row.role_id);
  const grants = allowedRoleIds.length ? await checked(db.from("hr_access_grants").select("user_id,scope_type,scope_id")
    .eq("company_id", companyId).in("role_id", allowedRoleIds).eq("is_active", true)
    .lte("effective_from", today).or("effective_to.is.null,effective_to.gte." + today)) : [];
  const hrUserIds = [...new Set((grants ?? []).filter(grant => exitGrantCoversWorker(grant, {
    locationId, departmentId: assignment?.department_id ?? null, orgUnitIds,
    managerUserIds: allManagerUserIds, directManagerUserId: managers[0]?.userId ?? null
  })).map(grant => grant.user_id))];
  const hrContacts = (await Promise.all(hrUserIds.map(profileContact))).filter((contact): contact is Contact => Boolean(contact));
  const owner = exitCase.hr_owner_user_id ? await profileContact(exitCase.hr_owner_user_id) : null;
  const taskOwner = options.taskOwnerId ? await profileContact(options.taskOwnerId) : null;
  const warnings = [
    ...managers.map((manager, index) => !manager.email ? "Reporting manager " + (index + 1) + " has no deliverable email." : "").filter(Boolean),
    !managers.length ? "No current reporting manager is configured." : "",
    !hrContacts.some(contact => contact.email) && !owner?.email ? "No responsible HR email resolved; check Exit access roles and scope." : ""
  ].filter(Boolean);
  const describe = (contact: Contact | undefined) => contact ? contact.name + (contact.email ? " · " + contact.email : " · Email unavailable") : "Not configured";
  return {
    managers, hrContacts, warnings,
    groups: {
      EMPLOYEE: exitEmails([exitCase.personal_email, worker.email]),
      REPORTING_MANAGER: exitEmails(managers.map(manager => manager.email)),
      HR_TEAM: exitEmails([...hrContacts.map(contact => contact.email), owner?.email]),
      HR_OWNER: exitEmails([owner?.email]), TASK_OWNER: exitEmails([taskOwner?.email])
    },
    values: {
      case_number: exitCase.case_number, employee_name: worker.full_name, employee_code: workerCode,
      designation: designation?.name ?? assignment?.position_title ?? "Not recorded",
      location: station ? [station.station_code, station.station_name].filter(Boolean).join(" · ") : "Not recorded",
      employee_email: exitEmails([exitCase.personal_email, worker.email])[0] ?? "Not recorded",
      employee_mobile: exitCase.personal_mobile ?? worker.mobile ?? "Not recorded",
      reporting_manager: describe(managers[0]), second_reporting_manager: describe(managers[1]),
      hr_contacts: hrContacts.map(contact => contact.name).join(", ") || owner?.name || "Not configured",
      submitted_date: dateLabel(exitCase.submitted_at), requested_last_working_date: dateLabel(exitCase.requested_last_working_date),
      approved_last_working_date: dateLabel(exitCase.approved_last_working_date, "Not approved yet"),
      last_working_date: dateLabel(exitCase.approved_last_working_date ?? exitCase.requested_last_working_date),
      notice_days: String(exitCase.notice_days ?? 0), exit_status: String(exitCase.status).replaceAll("_", " "),
      exit_type: String(exitCase.scenario).replaceAll("_", " "),
      review_url: "https://one.dropxlogistics.com/approvals?section=exits",
      people_review_url: "https://people.dropxlogistics.com/exits/" + encodeURIComponent(caseId)
    }
  };
}

export function resolveExitNoticeRecipients(template: {
  to_recipients?: string[]; cc_recipients?: string[]; custom_to_emails?: string[]; custom_cc_emails?: string[];
}, groups: Record<string, string[]>) {
  const resolve = (keys: string[] = [], custom: string[] = []) => exitEmails([...keys.flatMap(key => groups[key] ?? []), ...custom]);
  const to = resolve(template.to_recipients, template.custom_to_emails);
  return { to, cc: resolve(template.cc_recipients, template.custom_cc_emails).filter(email => !to.includes(email)) };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

export function renderExitNotice(body: string, context: ExitNoticeContext) {
  const v = context.values;
  const rows = [
    ["Team member", v.employee_name + " · " + v.employee_code],
    ["Designation", v.designation], ["Location / store", v.location],
    ["Contact", v.employee_email + " · " + v.employee_mobile],
    ["Reporting manager · L1", v.reporting_manager], ["Reporting manager · L2", v.second_reporting_manager],
    ["Responsible HR", v.hr_contacts], ["Submitted", v.submitted_date],
    ["Requested last working day", v.requested_last_working_date],
    ["Approved last working day", v.approved_last_working_date],
    ["Notice period", v.notice_days + " days"], ["Status", v.exit_status]
  ];
  const notes = context.warnings.join(" ");
  const text = body + "\n\n" + rows.map(([label, value]) => label + ": " + value).join("\n")
    + (notes ? "\n\nRouting check: " + notes : "")
    + "\n\nManagers — review in DropX One: " + v.review_url + "\nHR — open People: " + v.people_review_url;
  const html = '<!doctype html><html><body style="margin:0;background:#f4f5f8;font-family:Arial,sans-serif;color:#1b2940">'
    + '<table role="presentation" style="max-width:640px;width:100%;margin:24px auto;background:white;border:1px solid #e5e7eb;border-radius:14px"><tr><td style="padding:22px;background:#1b2940;color:white"><strong style="color:#ffb26b">DropX · People &amp; Culture</strong><h2 style="margin:10px 0 0;font-size:21px">' + escapeHtml(v.case_number) + '</h2></td></tr>'
    + '<tr><td style="padding:22px"><p style="line-height:1.6;margin:0 0 18px;white-space:pre-line">' + escapeHtml(body) + '</p><table style="width:100%;border-collapse:collapse;font-size:14px">'
    + rows.map(([label, value]) => '<tr><th scope="row" style="padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid #eee;color:#637086;width:42%">' + escapeHtml(label) + '</th><td style="padding:9px;border-bottom:1px solid #eee;overflow-wrap:anywhere">' + escapeHtml(value ?? "Not recorded") + '</td></tr>').join("")
    + '</table>' + (notes ? '<p style="padding:12px;background:#fff7e6;font-size:13px">' + escapeHtml(notes) + '</p>' : "")
    + '<p style="line-height:1.9"><a style="color:#c4471e;font-weight:bold" href="' + escapeHtml(v.review_url) + '">Review in DropX One</a> · <a style="color:#c4471e" href="' + escapeHtml(v.people_review_url) + '">Open in People (HR)</a></p>'
    + '<p style="font-size:12px;color:#637086">The requested last working day is not confirmed until approved. Receiving this email does not change approval ownership.</p></td></tr></table></body></html>';
  return { body: text, html };
}

