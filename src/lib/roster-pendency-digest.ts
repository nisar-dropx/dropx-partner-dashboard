import type { DigestBuilder, DigestMessage } from "./portal-digest-delivery.ts";
import { rosterPendencyEvents, type RosterPendencyRow, type RosterPendencySnapshot } from "./roster-pendency.ts";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

const stamp = (value: string) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    })
    : "—";

const periodLabel = (start: string, end: string) => {
  const from = new Date(`${start}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const to = new Date(`${end}T12:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  return `${from} – ${to}`;
};

function stationBlocks(rows: RosterPendencyRow[]) {
  const stationIds = [...new Set(rows.map((row) => row.stationId))];
  return stationIds.map((stationId) => {
    const scoped = rows.filter((row) => row.stationId === stationId);
    return {
      code: scoped[0].stationCode,
      name: scoped[0].stationName,
      awaiting: scoped.filter((row) => row.status === "pending_approval").length,
      resubmit: scoped.filter((row) => row.status === "returned").length,
      draft: scoped.filter((row) => row.status === "draft").length,
      total: scoped.length,
      oldest: Math.max(...scoped.map((row) => row.ageDays)),
      rows: scoped
    };
  }).sort((left, right) => left.code.localeCompare(right.code));
}

export function buildRosterPendencyMessages(snapshot: RosterPendencySnapshot, subjectTemplate: string): DigestMessage[] {
  const subject = subjectTemplate
    .replaceAll("{{date}}", snapshot.date)
    .replaceAll("{{month}}", new Date(`${snapshot.date}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "Asia/Kolkata" }))
    .replaceAll("{{year}}", snapshot.date.slice(0, 4));
  if (!subject || /[\r\n]/.test(subject)) throw new Error("Invalid roster reminder subject.");

  return snapshot.recipients.map((recipient) => {
    const rows = snapshot.rows.filter((row) => recipient.planKeys.includes(row.key));
    if (!rows.length) throw new Error("Roster reminder recipient has no pending rows.");
    const stations = stationBlocks(rows);
    const awaiting = rows.filter((row) => row.status === "pending_approval").length;
    const actionNeeded = rows.filter((row) => row.status !== "pending_approval").length;
    const roles = recipient.roles.join(" · ") || "Station operations";
    const stationIds = [...new Set(rows.map((row) => row.stationId))];

    const summaryTable = `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${["Station", "Awaiting approval", "Draft / returned", "Total", "Oldest (days)"].map((header) => `<th align="left" style="padding:10px 8px;background:#18243d;color:#fff">${header}</th>`).join("")}</tr></thead><tbody>${stations.map((station, index) => `<tr style="background:${index % 2 ? "#f2f5fa" : "#fff"}"><td style="padding:11px 8px;border-bottom:1px solid #e3e8f1"><b>${esc(station.code)}</b><br><span style="color:#64748b">${esc(station.name)}</span></td><td style="padding:11px 8px;border-bottom:1px solid #e3e8f1">${station.awaiting}</td><td style="padding:11px 8px;border-bottom:1px solid #e3e8f1">${station.draft + station.resubmit}</td><td style="padding:11px 8px;border-bottom:1px solid #e3e8f1;font-weight:bold;color:#c24131">${station.total}</td><td style="padding:11px 8px;border-bottom:1px solid #e3e8f1">${station.oldest}</td></tr>`).join("")}</tbody></table>`;

    const detailRows = rows.slice(0, 40).map((row) =>
      `<tr><td style="padding:10px 8px;border-bottom:1px solid #eef2f7"><b>${esc(row.stationCode)}</b></td><td style="padding:10px 8px;border-bottom:1px solid #eef2f7">${esc(periodLabel(row.periodStart, row.periodEnd))}<br><span style="color:#64748b">Rev ${row.revisionNo}</span></td><td style="padding:10px 8px;border-bottom:1px solid #eef2f7">${esc(row.statusLabel)}</td><td style="padding:10px 8px;border-bottom:1px solid #eef2f7">${esc(row.waitingOn)}</td><td style="padding:10px 8px;border-bottom:1px solid #eef2f7">${row.ageDays}d</td></tr>`
    ).join("");

    const html = `<!doctype html><html><body style="margin:0;background:#edf1f7;color:#1b2942;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0"><tr><td align="center" style="padding:22px 10px"><table role="presentation" width="680" cellspacing="0" style="width:100%;max-width:680px;background:white;border-radius:16px;overflow:hidden"><tr><td style="padding:26px;background:linear-gradient(120deg,#18243d,#2f5d6e);color:white;border-top:5px solid #f45a2a"><div style="font-size:11px;font-weight:bold;letter-spacing:2px;color:#ffbb9c">DROPX · OPSPULSE ROSTER</div><h1 style="font-size:25px;line-height:1.25;margin:10px 0">Roster pending at your stations</h1><div style="color:#e6e8f2">Morning action list · ${esc(stamp(snapshot.checkedAt))} IST</div></td></tr><tr><td style="padding:24px"><p style="margin-top:0">Hello ${esc(recipient.name)},</p><p style="font-size:14px;line-height:1.6">Please clear roster work waiting at stations in your ${esc(roles.toLowerCase())} scope before the day runs ahead. Drafts need submit, returned plans need a fix and resubmit, and awaiting-approval plans need a decision.</p><table role="presentation" width="100%" cellspacing="0" style="margin:18px 0"><tr>${[[awaiting, "Awaiting approval", "#fff0e7", "#b84317"], [actionNeeded, "Draft / returned", "#f0eaff", "#6d3bb1"], [stations.length, "Stations", "#e4f6f1", "#11745c"]].map(([n, label, bg, color]) => `<td width="33%" style="padding:14px 10px;background:${bg};color:${color};border-right:5px solid white"><b style="font-size:28px">${n}</b><br><span style="font-size:12px">${label}</span></td>`).join("")}</tr></table>${summaryTable}<div style="padding:14px 16px;background:#fff8e9;border-left:4px solid #f59e0b;margin:20px 0"><b>What to do this morning</b><p style="margin:8px 0 0;font-size:13px;line-height:1.6">Approve or return plans waiting on you, and make sure drafts/returned weeks are submitted for stations that still need cover. Open OpsPulse Rostering for the full planner and approval queue.</p></div><h2 style="font-size:16px;margin:22px 0 10px">Plans needing attention</h2><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${["Station", "Week", "Status", "Waiting on", "Age"].map((header) => `<th align="left" style="padding:9px 8px;background:#f4f6fa;color:#475569">${header}</th>`).join("")}</tr></thead><tbody>${detailRows}</tbody></table>${rows.length > 40 ? `<p style="font-size:12px;color:#64748b">${rows.length - 40} more plan(s) are included in your OpsPulse queue.</p>` : ""}<p style="line-height:2.8;margin-top:22px"><a style="background:#ee5427;color:white;padding:11px 16px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13px" href="https://ops.dropxlogistics.com/rostering?view=approvals">Open roster approvals →</a> &nbsp; <a style="background:#38294f;color:white;padding:11px 16px;text-decoration:none;border-radius:6px;font-weight:bold;font-size:13px" href="https://ops.dropxlogistics.com/rostering">Open roster planner →</a></p><p style="font-size:12px;line-height:1.6;color:#64748b">Only stations mapped to you as station manager or cluster manager are included. No email is sent when those stations have no open roster work.</p></td></tr><tr><td style="padding:16px 24px;background:#f4f6fa;color:#64748b;font-size:11px;line-height:1.6">Automatic morning check · Asia/Kolkata. Snapshot time above. Completed or approved plans drop off the next run.</td></tr></table></td></tr></table></body></html>`;

    const text = `DropX roster pending · Morning\nAs of ${stamp(snapshot.checkedAt)} IST\n\nHello ${recipient.name},\nClear roster work at your stations before the day runs ahead.\n\n${awaiting} awaiting approval · ${actionNeeded} draft/returned · ${stations.length} stations\n\nStation | Awaiting | Draft/returned | Total | Oldest\n${stations.map((station) => `${station.code} | ${station.awaiting} | ${station.draft + station.resubmit} | ${station.total} | ${station.oldest}`).join("\n")}\n\nPlans:\n${rows.map((row) => `${row.stationCode} · ${periodLabel(row.periodStart, row.periodEnd)} · ${row.statusLabel} · ${row.waitingOn} · ${row.ageDays}d`).join("\n")}\n\nApprovals: https://ops.dropxlogistics.com/rostering?view=approvals\nPlanner: https://ops.dropxlogistics.com/rostering\n`;

    return {
      email: recipient.email,
      name: recipient.name,
      subject,
      html,
      text,
      scope: {
        planIds: rows.map((row) => row.planId),
        stationIds,
        pending: rows.length,
        reportDate: snapshot.date,
        roles: recipient.roles
      }
    };
  });
}

export const buildRosterPendencyDigest: DigestBuilder = async (db, control, date) => {
  if (!rosterPendencyEvents.includes(control.event_key as typeof rosterPendencyEvents[number])) {
    throw new Error("Invalid roster pendency schedule.");
  }
  if (!control.subject_template) throw new Error("Roster reminder subject is not configured.");
  const { loadRosterPendency } = await import("./roster-pendency-data.ts");
  const snapshot = await loadRosterPendency(db, control.company_id, date, String(control.config.email_domain || ""));
  if (snapshot.unroutedStationIds.length) {
    console.warn("Roster pendency has stations without a routable station/cluster manager email", {
      stations: snapshot.unroutedStationIds.length
    });
  }
  return {
    checkedAt: snapshot.checkedAt,
    messages: buildRosterPendencyMessages(snapshot, control.subject_template)
  };
};
