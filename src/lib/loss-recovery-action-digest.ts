import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { holdApprovers } from "./ops-pulse/salary-hold-policy";
import { loadActiveApprovalCovers } from "./approval-covers";

type ActionRow = {
  station_code: string;
  month: string;
  case_key: string;
  report: string;
  amount: number;
  lifecycle_status: string;
  action_key: string;
  action_label: string;
  owner_role: string;
  age_days: number;
  due_month: string | null;
  blocker: string | null;
  deep_link: string;
};

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const money = (n: number) =>
  `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  const [hierarchy, covers, memberships] = await Promise.all([
    loadPeopleOperationalHierarchy(company, stationIds, { includeStationResponsibilities: true }),
    loadActiveApprovalCovers(company),
    db
      .from("company_product_memberships")
      .select("user_id,location_scope_ids,has_all_location_access,profiles!inner(id,email,full_name,is_active)")
      .eq("company_id", company)
      .eq("product_code", "operations")
      .eq("is_active", true),
  ]);
  if (hierarchy.error) throw new Error("Hierarchy unavailable for loss digest.");
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
  const subjectTemplate =
    control.subject_template || "DropX · Loss recovery actions · {{date}}";
  const subject = subjectTemplate.replaceAll("{{date}}", date);
  if (!subject || /[\r\n]/.test(subject)) throw new Error("Invalid loss recovery email subject.");

  const messages: DigestMessage[] = [];
  for (const recipient of recipients) {
    const table = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${["Station", "Case", "Amount", "Action", "Age", "Due", "Blocker"].map((h) => `<th align="left" style="padding:8px;background:#18243d;color:#fff">${h}</th>`).join("")}</tr></thead><tbody>${recipient.rows
      .map(
        (r, i) =>
          `<tr style="background:${i % 2 ? "#f2f5fa" : "#fff"}"><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.station_code)}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1"><a href="https://ops.dropxlogistics.com${esc(r.deep_link)}">${esc(r.case_key)}</a></td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(money(r.amount))}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.action_label)}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.age_days)}d</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.due_month || "—")}</td><td style="padding:8px;border-bottom:1px solid #e3e8f1">${esc(r.blocker || "—")}</td></tr>`,
      )
      .join("")}</tbody></table>`;
    const html = `<!doctype html><html><body style="margin:0;background:#edf1f7;font-family:Arial,sans-serif;color:#1b2942"><table role="presentation" width="100%"><tr><td align="center" style="padding:22px 10px"><table role="presentation" width="720" style="width:100%;max-width:720px;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="padding:22px;background:#18243d;color:#fff"><div style="font-size:11px;letter-spacing:1px">DROPX · OPS PULSE</div><h1 style="margin:8px 0 0;font-size:22px">Loss recovery actions</h1><div style="opacity:.85;margin-top:6px">${esc(date)} · ${recipient.rows.length} open</div></td></tr><tr><td style="padding:22px"><p>Hello ${esc(recipient.name)},</p><p style="font-size:14px;line-height:1.5">These are unresolved NL/SLP loss actions in your scope. Empty days do not send mail.</p>${table}<p style="margin-top:18px"><a href="https://ops.dropxlogistics.com/team-ops/losses/nl" style="background:#ee5427;color:#fff;padding:10px 14px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13px">Open Losses →</a></p></td></tr></table></td></tr></table></body></html>`;
    const text = `DropX loss recovery actions · ${date}\n\nHello ${recipient.name},\n${recipient.rows.length} open actions.\n\n${recipient.rows
      .map(
        (r) =>
          `${r.station_code} | ${r.case_key} | ${money(r.amount)} | ${r.action_label} | age ${r.age_days}d | due ${r.due_month || "—"} | ${r.blocker || "—"} | https://ops.dropxlogistics.com${r.deep_link}`,
      )
      .join("\n")}\n\nOpen Losses: https://ops.dropxlogistics.com/team-ops/losses/nl`;
    messages.push({
      email: recipient.email,
      name: recipient.name,
      subject,
      html,
      text,
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
