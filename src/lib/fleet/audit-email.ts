import { normalizeFleetAuditProgrammeConfig, type FleetAuditProgrammeConfig } from "@/lib/fleet/audit-programme-config";

type Finding = { category?: unknown; finding?: unknown; severity?: unknown; actionRequired?: unknown; expectedCompletionDate?: unknown };
type Evidence = { type?: unknown; url?: unknown; caption?: unknown };
type AuditEmailInput = {
  auditId: string;
  auditDate: string;
  auditMode: "video" | "physical";
  stationCode: string;
  vehicleNo: string;
  model: string;
  failed: boolean;
  score: number | null;
  summary: string;
  findings: Finding[];
  evidence: Evidence[];
  config?: FleetAuditProgrammeConfig;
};

const raw = (value: unknown) => String(value ?? "").trim();
const escape = (value: unknown) => raw(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] || character);
const safeUrl = (value: unknown) => /^https?:\/\//i.test(raw(value)) ? raw(value) : "";
const labelDate = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${value}T12:00:00+05:30`));

export function buildFleetAuditEmail(input: AuditEmailInput) {
  const config = normalizeFleetAuditProgrammeConfig(input.config);
  const result = input.failed ? "Attention required" : "Audit passed";
  const resultColor = input.failed ? config.alertColor : "#087f5b";
  const findings = input.findings.length ? input.findings : [{ category: "Audit result", finding: "No material finding was recorded.", severity: "low", actionRequired: "No action required" }];
  const evidence = config.includeEvidence ? input.evidence.filter((item) => safeUrl(item.url)) : [];
  const reportUrl = `https://fleet.dropxlogistics.com/fleet-control?section=audits&auditId=${encodeURIComponent(input.auditId)}`;
  const subject = `${config.emailSubjectPrefix} · ${input.stationCode} · ${input.vehicleNo} · ${labelDate(input.auditDate)}`;
  const text = `${config.emailTitle}\n${input.stationCode} · ${input.vehicleNo} · ${input.model}\n${input.auditMode === "video" ? "Virtual video audit" : "Physical inspection"} · ${labelDate(input.auditDate)}\nResult: ${result}${input.score == null ? "" : ` · Score ${input.score}%`}\n\n${input.summary || result}\n\nMajor findings\n${findings.map((item) => `- ${raw(item.finding)}${raw(item.actionRequired) ? ` | Action: ${raw(item.actionRequired)}` : ""}`).join("\n")}\n\nEvidence\n${evidence.length ? evidence.map((item) => `- ${raw(item.caption) || raw(item.type)}: ${safeUrl(item.url)}`).join("\n") : "- No evidence link included."}`;
  const findingRows = findings.map((item) => `<tr><td style="padding:12px;border-bottom:1px solid #e6eaf0"><b>${escape(item.category || "General")}</b><br><span style="color:${config.alertColor};font-size:12px;text-transform:uppercase">${escape(item.severity || "medium")}</span></td><td style="padding:12px;border-bottom:1px solid #e6eaf0">${escape(item.finding)}</td><td style="padding:12px;border-bottom:1px solid #e6eaf0">${escape(item.actionRequired || "Review and close")}${raw(item.expectedCompletionDate) ? `<br><small>Due ${escape(item.expectedCompletionDate)}</small>` : ""}</td></tr>`).join("");
  const evidenceCards = evidence.map((item, index) => `<a href="${escape(safeUrl(item.url))}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 14px;border-radius:9px;background:#eef7f5;color:#08766b;text-decoration:none;font-weight:700">${escape(item.caption || `${raw(item.type) || "Evidence"} ${index + 1}`)} ↗</a>`).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#eef1f5;font-family:Arial,sans-serif;color:#172033"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px"><table role="presentation" width="720" cellspacing="0" cellpadding="0" style="max-width:720px;width:100%;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 10px 28px rgba(17,26,46,.1)"><tr><td style="padding:26px 30px;background:${config.primaryColor};border-left:7px solid ${config.accentColor};color:#fff"><div style="font-size:12px;letter-spacing:1.5px;color:#ffccda;text-transform:uppercase">Vehicle assurance · ${escape(input.stationCode)}</div><h1 style="margin:8px 0 4px;font-size:26px">${escape(config.emailTitle)}</h1><div style="color:#c9d2e5">${escape(labelDate(input.auditDate))} · ${input.auditMode === "video" ? "Virtual video audit" : "Physical inspection"}</div></td></tr><tr><td style="padding:26px 30px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td><div style="font-size:12px;color:#65718a;text-transform:uppercase">Vehicle</div><div style="font-size:24px;font-weight:800">${escape(input.vehicleNo)}</div><div style="color:#65718a">${escape(input.model)} · ${escape(input.stationCode)}</div></td><td align="right"><span style="display:inline-block;padding:9px 14px;border-radius:999px;background:${resultColor}18;color:${resultColor};font-weight:800">${escape(result)}</span>${input.score == null ? "" : `<div style="margin-top:8px;font-size:24px;font-weight:800">${input.score}%</div>`}</td></tr></table><div style="margin:22px 0;padding:16px 18px;border-radius:12px;background:#f7f8fa;border-left:4px solid ${config.accentColor}"><b>Inspector summary</b><div style="margin-top:6px;color:#4c5870;line-height:1.5">${escape(input.summary || result)}</div></div><h2 style="font-size:18px;margin:24px 0 10px">Major findings and action</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e6eaf0;border-radius:12px;overflow:hidden"><tr style="background:#f0f3f7;text-align:left"><th style="padding:10px 12px">Area</th><th style="padding:10px 12px">Finding</th><th style="padding:10px 12px">Required action</th></tr>${findingRows}</table><h2 style="font-size:18px;margin:24px 0 10px">Evidence and attachments</h2>${evidenceCards || '<div style="color:#7a8498">No evidence link included in this email.</div>'}<div style="margin-top:26px;padding-top:16px;border-top:1px solid #e6eaf0;color:#7a8498;font-size:12px">Audit reference ${escape(input.auditId)} · Generated by DropX Fleet</div></td></tr></table></td></tr></table></body></html>`;
  return { subject, text: `${text}\n\nOpen health report and download PDF: ${reportUrl}`, html: html.replace('<h2 style="font-size:18px;margin:24px 0 10px">Major findings', `<p><a href="${escape(reportUrl)}" style="display:inline-block;padding:12px 18px;background:#08766b;color:white;border-radius:8px;text-decoration:none;font-weight:bold">Open health report &amp; PDF</a></p><h2 style="font-size:18px;margin:24px 0 10px">Major findings`) };
}
