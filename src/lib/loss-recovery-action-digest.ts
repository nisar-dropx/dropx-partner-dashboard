import { mayViewLossApprovals } from "./ops-pulse/loss-recovery-controls";
import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { holdApprovers } from "./ops-pulse/salary-hold-policy";
import { loadActiveApprovalCovers } from "./approval-covers";
import {
  lossRecoveryDigestSubject,
  renderLossRecoveryDigestEmail,
  type LossRecoveryDigestRow,
} from "./loss-recovery-action-digest-render";

type ActionRow = LossRecoveryDigestRow;

async function resolveOwners(
  db: Parameters<DigestBuilder>[0],
  company: string,
  rows: ActionRow[],
  emailDomain: string,
) {
  const codes = [...new Set(rows.map((r) => r.station_code))];
  const stations = await db
    .from("stations")
    .select("id,station_code")
    .eq("company_id", company)
    .in("station_code", codes.length ? codes : ["__none__"]);
  if (stations.error) throw new Error(stations.error.message);
  const byCode = new Map((stations.data ?? []).map((s) => [s.station_code, s.id as string]));
  const stationIds = [...byCode.values()];
  const [hierarchy, covers, memberships, roles] = await Promise.all([
    loadPeopleOperationalHierarchy(company, stationIds, { includeStationResponsibilities: true }),
    loadActiveApprovalCovers(company),
    db
      .from("company_product_memberships")
      .select("user_id,role_id,location_scope_ids,has_all_location_access,profiles!inner(id,email,full_name,is_active)")
      .eq("company_id", company)
      .eq("product_code", "operations")
      .eq("is_active", true),
    db.from("user_roles").select("id,code").eq("company_id",company).eq("is_active",true),
  ]);
  if (hierarchy.error) throw new Error("Hierarchy unavailable for loss digest.");
  if (roles.error) throw new Error("Loss approval roles unavailable.");
  const roleById = new Map((roles.data || []).map((r:any)=>[r.id,r.code]));
  if (memberships.error) throw new Error(memberships.error.message);

  type Recipient = { email: string; name: string; stationIds: string[]; rows: ActionRow[] };
  const bag = new Map<string, Recipient>();

  const add = (email: string, name: string, stationId: string, row: ActionRow) => {
    const key = email.toLowerCase();
    if (!key.includes("@")) return;
    if (emailDomain && !key.endsWith("@" + emailDomain.toLowerCase())) return;
    const current = bag.get(key) ?? { email: key, name, stationIds: [], rows: [] };
    if (!current.stationIds.includes(stationId)) current.stationIds.push(stationId);
    current.rows.push(row);
    bag.set(key, current);
  };

  const slpUsers = (memberships.data ?? []).filter((m: any) => {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
    return profile?.is_active && profile?.email;
  });

  for (const row of rows) {
    const stationId = byCode.get(row.station_code);
    if (!stationId) continue;
    if (row.owner_role === "station") {
      // Station Ops: people with the station in location scope (not all-locations masters).
      for (const m of slpUsers as any[]) {
        const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
        const scope: string[] = m.location_scope_ids ?? [];
        if (!m.has_all_location_access && scope.includes(stationId)) {
          add(profile.email, profile.full_name || profile.email, stationId, row);
        }
      }
      continue;
    }
    if (row.owner_role === "cluster" || row.owner_role === "recovery_owner") {
      const approvers = holdApprovers(hierarchy.byLocation.get(stationId), new Set(), covers);
      for (const personId of approvers.personIds) {
        const link = await db
          .from("hr_user_person_links")
          .select("user_id,profiles!inner(email,full_name,is_active)")
          .eq("company_id", company)
          .eq("person_id", personId)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();
        const profile = link.data
          ? (Array.isArray((link.data as any).profiles)
              ? (link.data as any).profiles[0]
              : (link.data as any).profiles)
          : null;
        if (profile?.is_active && profile.email) {
          add(profile.email, profile.full_name || profile.email, stationId, row);
        }
      }
      continue;
    }
    if (row.owner_role === "slp") {
      for (const m of slpUsers as any[]) {
        const roleCode=String(roleById.get(m.role_id)||"");
        if(!mayViewLossApprovals({isMasterOwner:roleCode==="OWNER",roleCode})) continue;
        const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
        const scope: string[] = m.location_scope_ids ?? [];
        if (m.has_all_location_access || scope.includes(stationId)) {
          add(profile.email, profile.full_name || profile.email, stationId, row);
        }
      }
    }
  }
  return [...bag.values()].filter((r) => r.rows.length);
}

export const buildLossRecoveryActionDigest: DigestBuilder = async (db, control, date) => {
  const checkedAt = new Date().toISOString();
  const items = await db.rpc("nl_loss_recovery_action_items", { p_company: control.company_id });
  if (items.error) {
    if (/does not exist|schema cache/i.test(items.error.message)) {
      return { checkedAt, messages: [] };
    }
    throw new Error(items.error.message);
  }
  const rows = (items.data ?? []) as ActionRow[];
  if (!rows.length) return { checkedAt, messages: [] };

  const recipients = await resolveOwners(
    db,
    control.company_id,
    rows,
    String(control.config.email_domain || ""),
  );
  const subject = lossRecoveryDigestSubject(
    control.subject_template || "DropX · Loss recovery actions · {{date}}",
    date,
  );

  const messages: DigestMessage[] = [];
  for (const recipient of recipients) {
    const rendered = renderLossRecoveryDigestEmail({
      date,
      recipientName: recipient.name,
      rows: recipient.rows,
    });
    messages.push({
      email: recipient.email,
      name: recipient.name,
      subject,
      html: rendered.html,
      text: rendered.text,
      scope: {
        stationIds: recipient.stationIds,
        caseKeys: recipient.rows.map((r) => r.case_key),
        reportDate: date,
        count: recipient.rows.length,
      },
    });
  }
  return { checkedAt, messages };
};
