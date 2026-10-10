import "server-only";
import { buildStationAuditReport } from "./station-audit-report-data";
import type { AuditReportData } from "./station-audit-report";
import { resolveStationAuditRecipients } from "./station-audit-recipients";
import { auditDay } from "./station-audit-planning";

import { acquireStationAuditThread } from "./station-audit-thread";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type {
  AuditStation,
  AuditType,
  StationAudit,
} from "@/lib/ops-pulse/station-audits";

function text(value: unknown) {
  return String(value ?? "").trim();
}
function escapeHtml(value: unknown) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function interpolation(
  input: string,
  audit: StationAudit,
  station: AuditStation,
) {
  return input
    .replaceAll("{{station_code}}", station.station_code)
    .replaceAll("{{audit_date}}", auditDay(audit.scheduled_for))
    .replaceAll("{{audit_number}}", audit.audit_number)
    .replaceAll(
      "{{audit_type}}",
      audit.ops_audit_types?.name ?? "Station audit",
    );
}
function displayDate(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not set"
    : `${date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })} IST`;
}
export function auditUpdateDetails(
  audit: StationAudit,
  report?: AuditReportData,
) {
  const facts = [
    [
      "Audit",
      `${audit.ops_audit_types?.name || report?.type || "Station audit"} · ${audit.audit_number}`,
    ],
    ["Scheduled", displayDate(audit.scheduled_for)],
    ["Submitted", displayDate(audit.completed_at)],
    ["Auditor", report?.auditor || audit.assigned_name || "Not recorded"],
    [
      "Audit status",
      text(audit.status_code).replaceAll("_", " ") || "Submitted",
    ],
    [
      "Station response",
      text(audit.station_response_status).replaceAll("_", " ") ||
        "Not requested",
    ],
    [
      "Response due",
      audit.station_response_status === "requested"
        ? displayDate(audit.response_due_at)
        : "No response outstanding",
    ],
  ];
  const findings = (report?.checks || []).filter((c) => c.nonCompliant);
  const actions = report?.actions || [];
  const summary =
    report?.summary || audit.overall_summary || "No auditor summary recorded.";
  const line = (a: (typeof actions)[number]) =>
    `${a.title} — ${a.action || "Action not recorded"} | Owner: ${a.owner || "Unassigned"} | Due / ETA: ${displayDate(a.dueAt)} | Status: ${a.status.replaceAll("_", " ")}${a.dueAt && new Date(a.dueAt).getTime() < Date.now() && !["completed", "closed", "cancelled"].includes(a.status) ? " · OVERDUE" : ""}${a.completionNote ? ` | Update: ${a.completionNote}` : ""}`;
  const plain = [
    ...facts.map(([k, v]) => `${k}: ${v}`),
    `Major findings / auditor summary: ${summary}`,
    ...findings.map(
      (c) => `${c.section}: ${c.label} — ${c.outcome}. ${c.remarks}`,
    ),
    `Shipment differences: ${report?.missing ?? audit.shipment_missing_count ?? 0} missing; ${report?.excess ?? audit.shipment_excess_count ?? 0} excess.`,
    `Cash variance: ${audit.cash_variance_amount == null ? "Not recorded" : audit.cash_variance_amount}`,
    actions.length
      ? "Actions, owners and ETA:"
      : "No corrective actions recorded.",
    ...actions.map(line),
    report?.stationResponse ? `Station update: ${report.stationResponse}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<h2 style="font-size:18px;margin:22px 0 10px">Latest audit update</h2><table width="100%" style="font-size:13px;border-collapse:collapse">${facts.map(([k, v]) => `<tr><td style="padding:6px 0;color:#66758f;width:30%">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join("")}</table>
    <h3 style="font-size:16px;margin:20px 0 8px">Major findings</h3><p style="line-height:1.5;white-space:pre-line">${escapeHtml(summary)}</p>
    ${
      findings.length
        ? `<ul style="padding-left:20px;line-height:1.5">${findings
            .slice(0, 8)
            .map(
              (c) =>
                `<li><strong>${escapeHtml(c.section)} · ${escapeHtml(c.label)}</strong><br/>${escapeHtml(c.outcome)}${c.remarks ? ` — ${escapeHtml(c.remarks)}` : ""}</li>`,
            )
            .join(
              "",
            )}</ul>${findings.length > 8 ? `<p>${findings.length - 8} more findings are in the attached report.</p>` : ""}`
        : '<p style="font-size:13px;color:#66758f">No non-compliant checklist outcomes recorded. Review the summary, scores and reconciliation below.</p>'
    }
    <h3 style="font-size:16px;margin:20px 0 8px">Actions · owners · due dates</h3>${
      actions.length
        ? actions
            .slice(0, 10)
            .map(
              (a) =>
                `<div style="border:1px solid #e2e8f0;border-left:3px solid #e89128;border-radius:8px;padding:12px;margin:8px 0;font-size:13px;line-height:1.5"><b>${escapeHtml(a.title)}</b><br/>${escapeHtml(a.action || "Action not recorded")}<br/><b>Owner:</b> ${escapeHtml(a.owner || "Unassigned")} · <b>Due / ETA:</b> ${escapeHtml(displayDate(a.dueAt))}<br/><b>Status:</b> ${escapeHtml(a.status.replaceAll("_", " "))}${a.completionNote ? `<br/>${escapeHtml(a.completionNote)}` : ""}</div>`,
            )
            .join("") +
          (actions.length > 10
            ? `<p>${actions.length - 10} further actions are in OpsPulse.</p>`
            : "")
        : "<p>No corrective actions recorded.</p>"
    }
    ${report?.stationResponse ? `<p><b>Station update:</b> ${escapeHtml(report.stationResponse)}</p>` : ""}`;
  return { html, plain };
}
function auditHtml(input: {
  audit: StationAudit;
  station: AuditStation;
  type: AuditType;
  actions: number;
  url: string;
  report?: AuditReportData;
}) {
  const type = input.type.name;
  const station = `${input.station.station_code}${input.station.station_name ? ` · ${input.station.station_name}` : ""}`;
  const variance =
    input.audit.cash_variance_amount == null
      ? "Not recorded"
      : `₹${Number(input.audit.cash_variance_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const body = interpolation(
    input.type.email_body_template ||
      "Audit completed. Review the audit record and required actions in Ops Pulse.",
    input.audit,
    input.station,
  );
  const update = auditUpdateDetails(input.audit, input.report);
  const score = input.audit.score_snapshot;
  const scoreHtml = score
    ? `<div style="padding:18px;background:#edf8f5;border-radius:12px;margin:18px 0"><div style="font-size:30px;font-weight:800;color:#0c756c">${score.percentage ?? "—"}% · ${escapeHtml(score.rating)}</div><p>${score.provisional ? "Provisional: responsibility / scoring review pending. Not a final R&amp;R score." : "Assessed result. Review open findings separately."}</p><table width="100%" style="font-size:13px;border-collapse:collapse"><tr><th align="left">Area</th><th>Weight</th><th>Score</th></tr>${score.sections.map((s) => `<tr><td style="padding:8px 0;border-top:1px solid #cfe8e2">${escapeHtml(s.name)}</td><td align="center">${s.weight}%</td><td align="center"><b>${s.percentage == null ? "N/A" : `${s.percentage}%`}</b></td></tr>`).join("")}</table></div>`
    : "";
  const gallery = (input.report?.photos || [])
    .filter((p) => p.image)
    .slice(0, 3)
    .map(
      (p) =>
        `<div style="margin:14px 0"><p style="font-size:12px;font-weight:bold">${escapeHtml(p.label)}</p><img src="cid:audit-${p.id}" alt="${escapeHtml(p.label)}" width="280" style="max-width:100%;border-radius:8px" /></div>`,
    )
    .join("");
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#1f2a44"><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f7fb;padding:28px 12px"><tr><td align="center"><table width="640" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5eaf2"><tr><td style="background:linear-gradient(135deg,#172e52,#275ba7);padding:24px 28px;color:#fff"><div style="font-size:12px;font-weight:700;letter-spacing:1px;opacity:.78">DROPX · OPS PULSE</div><div style="font-size:25px;font-weight:800;margin-top:7px">${escapeHtml(type)}</div><div style="font-size:14px;margin-top:6px;opacity:.9">${escapeHtml(station)}</div></td></tr><tr><td style="padding:25px 28px"><div style="display:inline-block;border-radius:999px;background:#e9f7ee;color:#197744;padding:6px 10px;font-size:12px;font-weight:700">SUBMITTED · ${escapeHtml(input.audit.audit_number)}</div><p style="font-size:15px;line-height:1.55;margin:18px 0">${escapeHtml(body)}</p>${update.html}${scoreHtml}<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;border-spacing:8px 0"><tr><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Cash variance</div><div style="font-size:17px;font-weight:800;margin-top:5px">${escapeHtml(variance)}</div></td><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Shipment exceptions</div><div style="font-size:17px;font-weight:800;margin-top:5px">${input.audit.shipment_unresolved_count || 0}</div></td><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Open actions</div><div style="font-size:17px;font-weight:800;margin-top:5px">${input.actions}</div></td></tr></table><p style="font-size:14px;line-height:1.5">${input.audit.station_response_status === "requested" ? `Station response required${input.audit.response_due_at ? ` by ${escapeHtml(new Date(input.audit.response_due_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))} IST` : ""}. Open OpsPulse, review the findings and submit your response with supporting evidence.` : "Review the saved report and evidence in OpsPulse."} Please record responses in OpsPulse so the tracker stays up to date.</p><p style="font-size:13px">The illustrated PDF report is attached, including section scores, observations, responsibility decisions and evidence.</p>${gallery}<p style="margin:24px 0 0"><a href="${escapeHtml(input.url)}" style="background:#e62c70;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-size:14px;font-weight:700;display:inline-block">${input.audit.station_response_status === "requested" ? "Open OpsPulse &amp; respond" : "View audit report"}</a></p></td></tr><tr><td style="padding:16px 28px;background:#fbfcfe;border-top:1px solid #edf1f6;color:#6d7b91;font-size:12px">One ongoing audit conversation for this station, across COD and physical audits and all months. Dates and findings are shown in each update. Reply to findings in OpsPulse so ownership, ETA and completion remain tracked.</td></tr></table></td></tr></table></body></html>`;
}

export async function sendStationAuditCompletedEmail(input: {
  companyId: string;
  audit: StationAudit;
  type: AuditType;
  station: AuditStation;
  openActions: number;
}) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const { to, cc } = await resolveStationAuditRecipients(
    input.companyId,
    input.station,
    input.type.recipient_rules,
    input.type.cc_rules,
  );
  if (!to.length)
    throw new Error(
      "No audit recipient is configured for this station. Add station email or amend the recipient rules in Audit Master.",
    );
  const url = `https://ops.dropxlogistics.com/audits?audit=${encodeURIComponent(input.audit.id)}`;
  const report = await buildStationAuditReport(input.companyId, input.audit);
  const html = auditHtml({
    report: report.data,
    audit: input.audit,
    station: input.station,
    type: input.type,
    actions: input.openActions,
    url,
  });
  const thread = await acquireStationAuditThread(
    input.companyId,
    input.station.id,
    input.station.station_code,
  );
  try {
    const sent = await sendEmail({
      companyId: input.companyId,
      to,
      cc,
      subject: thread.subject,
      body: `${auditUpdateDetails(input.audit, report.data).plain}\n\nOpen OpsPulse to review the report and respond: ${url}`,
      html,
      attachments: [
        {
          filename: `${input.audit.audit_number}.pdf`,
          content: report.pdf,
          contentType: "application/pdf",
        },
        ...report.data.photos
          .filter((p) => p.image)
          .slice(0, 3)
          .map((p) => ({
            filename: `${p.id}.jpg`,
            content: Buffer.from(p.image!),
            contentType: "image/jpeg",
            cid: `audit-${p.id}`,
          })),
      ],
      messageId: thread.messageId,
      inReplyTo: thread.inReplyTo,
      references: thread.references,
      timeoutMs: 20_000,
    });
    await thread.finish(sent.messageId);
    return { to, cc, messageId: sent.messageId };
  } finally {
    await thread.release();
  }
}
