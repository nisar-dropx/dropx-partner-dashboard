import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { allAuditRows } from "./station-audit-query";

export type AuditNotificationUser = {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
  owner: boolean;
  allLocations: boolean;
  stationIds: string[];
};
export const auditRecipientFields = [
  "station_email",
  "station_manager_email",
  "cluster_manager_email",
  "ops_manager_email",
  "finance_manager_email",
] as const;
export function validAuditRecipientRule(rule: unknown) {
  return (
    typeof rule === "string" &&
    ((auditRecipientFields as readonly string[]).includes(rule) ||
      ["people_reporting_chain", "company_owners"].includes(rule) ||
      /^(user|role):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        rule,
      ))
  );
}

/** The recipient picker uses active Operations accounts with Audit access. */
export async function loadAuditNotificationUsers(
  companyId: string,
): Promise<AuditNotificationUser[]> {
  if (!supabaseAdmin) throw new Error("Database service unavailable.");
  const db = supabaseAdmin;
  const [profiles, memberships, roles, pages] = await Promise.all([
    allAuditRows((from, to) =>
      db
        .from("profiles")
        .select("id,full_name,email,is_master_owner")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("id")
        .range(from, to),
    ),
    allAuditRows((from, to) =>
      db
        .from("company_product_memberships")
        .select("user_id,role_id,location_scope_ids,has_all_location_access")
        .eq("company_id", companyId)
        .eq("product_code", "operations")
        .eq("is_active", true)
        .order("user_id")
        .order("role_id")
        .range(from, to),
    ),
    allAuditRows((from, to) =>
      db
        .from("user_roles")
        .select("id,code,location_access_mode")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("id")
        .range(from, to),
    ),
    db
      .from("app_pages")
      .select("id")
      .eq("company_id", companyId)
      .eq("code", "station_audits")
      .eq("is_active", true),
  ]);
  for (const r of [profiles, memberships, roles, pages])
    if (r.error) throw new Error(r.error.message);
  const pageIds = (pages.data || []).map((p) => p.id);
  const grants = pageIds.length
    ? await allAuditRows((from, to) =>
        db
          .from("role_page_permissions")
          .select("role_id,can_view,can_edit")
          .eq("company_id", companyId)
          .in("page_id", pageIds)
          .order("role_id")
          .order("page_id")
          .range(from, to),
      )
    : { data: [], error: null };
  if (grants.error) throw new Error(grants.error.message);
  const auditRoles = new Set(
    (grants.data || [])
      .filter((g) => g.can_view || g.can_edit)
      .map((g) => g.role_id),
  );
  return (profiles.data || [])
    .flatMap((p) => {
      const member = (memberships.data || []).filter(
        (m) =>
          m.user_id === p.id &&
          (roles.data || []).some((r) => r.id === m.role_id),
      );
      const effective = (roles.data || []).filter((r) =>
        member.some((m) => m.role_id === r.id),
      );
      const owner = Boolean(p.is_master_owner);
      if (!p.email || (!owner && !effective.some((r) => auditRoles.has(r.id))))
        return [];
      return [
        {
          id: p.id,
          name: p.full_name || p.email,
          email: p.email.trim().toLowerCase(),
          roleIds: effective.map((r) => r.id),
          owner,
          allLocations:
            owner ||
            member.some((m) => m.has_all_location_access) ||
            effective.some((r) => r.location_access_mode === "all_locations"),
          stationIds: [
            ...new Set<string>(
              member.flatMap((m) => m.location_scope_ids || []),
            ),
          ],
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveStationAuditRecipients(
  companyId: string,
  station: { id: string } & Partial<
    Record<(typeof auditRecipientFields)[number], string | null>
  >,
  toRules: string[],
  ccRules: string[],
) {
  if (!supabaseAdmin) throw new Error("Database service unavailable.");
  const rules = [...toRules, ...ccRules];
  const users = await loadAuditNotificationUsers(companyId);
  const scoped = users.filter(
    (u) => u.allLocations || u.stationIds.includes(station.id),
  );
  const dynamic = new Map<string, string[]>();
  if (
    rules.some((r) =>
      [
        "people_reporting_chain",
        "cluster_manager_email",
        "ops_manager_email",
      ].includes(r),
    )
  ) {
    const hierarchy = await loadPeopleOperationalHierarchy(
      companyId,
      [station.id],
      { includeStationResponsibilities: true },
    );
    if (hierarchy.error)
      throw new Error(
        `Audit recipients could not be verified in People: ${hierarchy.error}`,
      );
    const h = hierarchy.byLocation.get(station.id);
    const groups = {
      people_reporting_chain: [
        ...(h?.primaryReportingChain || []),
        ...(h?.managerReportingChain || []),
        ...(h?.reportingAuthorities || []),
        ...(h?.clusterManagers || []),
        ...(h?.areaOperationsManagers || []),
      ],
      cluster_manager_email: h?.clusterManagers || [],
      ops_manager_email: h?.areaOperationsManagers || [],
    };
    const personIds = [
      ...new Set(
        Object.values(groups)
          .flat()
          .map((p) => p.personId),
      ),
    ];
    const links = personIds.length
      ? await allAuditRows((from, to) =>
          supabaseAdmin!
            .from("hr_user_person_links")
            .select("person_id,user_id")
            .eq("company_id", companyId)
            .eq("status", "active")
            .in("person_id", personIds)
            .order("person_id")
            .order("user_id")
            .range(from, to),
        )
      : { data: [], error: null };
    if (links.error) throw new Error(links.error.message);
    for (const [key, people] of Object.entries(groups)) {
      const ids = new Set(
        (links.data || [])
          .filter((l) => people.some((p) => p.personId === l.person_id))
          .map((l) => l.user_id),
      );
      dynamic.set(
        key,
        scoped.filter((u) => ids.has(u.id)).map((u) => u.email),
      );
    }
  }
  const resolve = (configured: string[]) => [
    ...new Set(
      configured.flatMap((rule) => {
        if (dynamic.has(rule)) return dynamic.get(rule)!;
        if (rule === "company_owners")
          return scoped.filter((u) => u.owner).map((u) => u.email);
        if (rule.startsWith("user:"))
          return scoped
            .filter((u) => u.id === rule.slice(5))
            .map((u) => u.email);
        if (rule.startsWith("role:"))
          return scoped
            .filter((u) => u.roleIds.includes(rule.slice(5)))
            .map((u) => u.email);
        if ((auditRecipientFields as readonly string[]).includes(rule))
          return String(
            station[rule as (typeof auditRecipientFields)[number]] || "",
          )
            .split(/[,;]/)
            .map((v) => v.trim().toLowerCase())
            .filter((email) => Boolean(email) && (rule === "station_email" || scoped.some((u) => u.email === email)));
        return [];
      }),
    ),
  ];
  const to = resolve(toRules),
    cc = resolve(ccRules).filter((email) => !to.includes(email));
  return { to, cc };
}
