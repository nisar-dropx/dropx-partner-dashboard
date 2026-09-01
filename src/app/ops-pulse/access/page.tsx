import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, locationLabel } from "@/lib/ops-pulse/cod";
import { operatingModeForLocation, operatingModeLabel } from "@/lib/ops-pulse/operating-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort();
}

export default async function OpsAccessPage() {
  const authorization = await requirePagePermission("users", "access");
  const companyId = requireCompanyId(authorization);
  const [{ locations, error: locationError }, memberships] = await Promise.all([
    loadCodLocations(companyId, [], true),
    supabaseAdmin?.from("company_product_memberships")
      .select("user_id,role_id,designation_id,source_system,has_all_location_access,location_scope_ids,is_active")
      .eq("company_id", companyId)
      .eq("product_code", "operations")
      .eq("is_active", true)
  ]);
  const membershipRows = memberships?.data ?? [];
  const userIds = unique(membershipRows.map((membership) => membership.user_id));
  const [profiles, candidates, roles] = await Promise.all([
    userIds.length
      ? supabaseAdmin?.from("profiles").select("id,full_name,email,is_active").eq("company_id", companyId).in("id", userIds).order("full_name")
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? supabaseAdmin?.from("people_portal_access_candidates").select("user_id,designation_id").eq("company_id", companyId).in("user_id", userIds)
      : Promise.resolve({ data: [], error: null }),
    supabaseAdmin?.from("user_roles").select("id,name,code").eq("company_id", companyId).eq("product_code", "operations")
  ]);
  const designationIds = unique([
    ...membershipRows.map((membership) => membership.designation_id),
    ...(candidates?.data ?? []).map((candidate) => candidate.designation_id)
  ]);
  const designations = designationIds.length
    ? await supabaseAdmin?.from("designations").select("id,name,code").eq("company_id", companyId).in("id", designationIds)
    : { data: [], error: null };
  const profileMap = new Map((profiles?.data ?? []).map((profile) => [profile.id, profile]));
  const candidateMap = new Map((candidates?.data ?? []).map((candidate) => [candidate.user_id, candidate]));
  const designationMap = new Map((designations?.data ?? []).map((designation) => [designation.id, designation]));
  const roleMap = new Map((roles?.data ?? []).map((role) => [role.id, role]));
  const rows = membershipRows.map((membership) => {
    const profile = profileMap.get(membership.user_id);
    const role = roleMap.get(membership.role_id ?? "");
    const candidate = candidateMap.get(membership.user_id);
    const designation = designationMap.get(candidate?.designation_id ?? membership.designation_id ?? "");
    const isLocationAccount = membership.source_system === "location_master" || role?.code === "OPERATIONS_LOCATION";
    const scoped = membership.has_all_location_access
      ? locations
      : locations.filter((location) => (membership.location_scope_ids ?? []).includes(location.id));
    const modes = unique(scoped.map((location) => {
      const mode = operatingModeForLocation(location);
      return mode ? operatingModeLabel(mode) : null;
    }));
    return {
      membership,
      profile,
      roleLabel: isLocationAccount ? "Location" : designation?.name || role?.name || "Manual access",
      scoped,
      modes
    };
  });

  return (
    <AppShell active="Users & Access" pageCode="users">
      <div className="ops-command-center">
        <PageHead
          eyebrow="OpsPulse Administration"
          title="Users & Operational Access"
          subtitle="Model, hierarchy and station visibility for OpsPulse. General dashboard permissions are not shown here."
          action={<Link className="button secondary" href="/users?section=roles">Configure designation menus</Link>}
        />
        {locationError || memberships?.error || profiles?.error || candidates?.error || roles?.error || designations?.error ? <section className="panel message-panel error"><div className="panel-body">{locationError ?? memberships?.error?.message ?? profiles?.error?.message ?? candidates?.error?.message ?? roles?.error?.message ?? designations?.error?.message}</div></section> : null}
        <section className="summary-grid">
          <div className="metric-card"><span>Ops users</span><strong>{rows.filter((row) => row.profile?.is_active && (row.membership.has_all_location_access || row.scoped.length)).length}</strong><small>Active People and location identities</small></div>
          <div className="metric-card"><span>All-location access</span><strong>{rows.filter((row) => row.membership.has_all_location_access).length}</strong><small>Company-wide operational scope</small></div>
          <div className="metric-card"><span>Scoped users</span><strong>{rows.filter((row) => !row.membership.has_all_location_access && row.scoped.length).length}</strong><small>People-managed permitted locations</small></div>
          <div className="metric-card"><span>Unassigned</span><strong>{rows.filter((row) => !row.scoped.length).length}</strong><small>Needs OpsPulse location access</small></div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>OpsPulse scope register</h2><p className="subtle">Every model and hierarchy value below is derived from that user’s permitted stations.</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Ops role</th><th>Models</th><th>Region</th><th>AOM</th><th>Cluster Manager</th><th>Cluster</th><th>Locations</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(({ membership, profile, roleLabel, scoped, modes }) => (
                  <tr key={membership.user_id}>
                    <td><strong>{profile?.full_name || profile?.email || "Unlinked identity"}</strong><br /><span className="subtle">{profile?.email || membership.user_id}</span></td>
                    <td>{roleLabel}</td>
                    <td>{modes.join(", ") || "-"}</td>
                    <td>{unique(scoped.map((location) => location.region)).join(", ") || "-"}</td>
                    <td>{unique(scoped.map((location) => location.aom)).join(", ") || "-"}</td>
                    <td>{unique(scoped.map((location) => location.cluster_manager)).join(", ") || "-"}</td>
                    <td>{unique(scoped.map((location) => location.cluster)).join(", ") || "-"}</td>
                    <td title={scoped.map(locationLabel).join(", ")}>{scoped.length} stations</td>
                    <td><span className={`status-pill ${profile?.is_active && (membership.has_all_location_access || scoped.length) ? "good" : "warn"}`}>{profile?.is_active ? membership.has_all_location_access || scoped.length ? "Active" : "Unassigned" : "Inactive"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
