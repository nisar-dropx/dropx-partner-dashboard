import "server-only";

import { randomUUID } from "node:crypto";
import { sendEmail } from "@/lib/email";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { AuditStation, AuditType, StationAudit } from "@/lib/ops-pulse/station-audits";

type RecipientField = keyof Pick<AuditStation, "station_email" | "station_manager_email" | "cluster_manager_email" | "ops_manager_email" | "finance_manager_email">;
const permittedRecipientFields = new Set<RecipientField>(["station_email", "station_manager_email", "cluster_manager_email", "ops_manager_email", "finance_manager_email"]);

function text(value: unknown) { return String(value ?? "").trim(); }
function escapeHtml(value: unknown) { return text(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;"); }
function recipients(station: AuditStation, configured: string[]) {
  return Array.from(new Set(configured.filter((field): field is RecipientField => permittedRecipientFields.has(field as RecipientField)).map((field) => text(station[field]).toLowerCase()).filter(Boolean)));
}
function interpolation(input: string, audit: StationAudit, station: AuditStation) {
  return input
    .replaceAll("{{station_code}}", station.station_code)
    .replaceAll("{{audit_date}}", audit.scheduled_for.slice(0, 10))
    .replaceAll("{{audit_number}}", audit.audit_number)
    .replaceAll("{{audit_type}}", audit.ops_audit_types?.name ?? "Station audit");
}
function auditHtml(input: { audit: StationAudit; station: AuditStation; type: AuditType; actions: number; url: string }) {
  const type = input.type.name;
  const station = `${input.station.station_code}${input.station.station_name ? ` · ${input.station.station_name}` : ""}`;
  const variance = input.audit.cash_variance_amount == null ? "Not recorded" : `₹${Number(input.audit.cash_variance_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const body = interpolation(input.type.email_body_template || "Audit completed. Review the audit record and required actions in Ops Pulse.", input.audit, input.station);
  return `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#1f2a44"><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f7fb;padding:28px 12px"><tr><td align="center"><table width="640" cellpadding="0" cellspacing="0" role="presentation" style="max-width:640px;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5eaf2"><tr><td style="background:linear-gradient(135deg,#172e52,#275ba7);padding:24px 28px;color:#fff"><div style="font-size:12px;font-weight:700;letter-spacing:1px;opacity:.78">DROPX · OPS PULSE</div><div style="font-size:25px;font-weight:800;margin-top:7px">${escapeHtml(type)}</div><div style="font-size:14px;margin-top:6px;opacity:.9">${escapeHtml(station)}</div></td></tr><tr><td style="padding:25px 28px"><div style="display:inline-block;border-radius:999px;background:#e9f7ee;color:#197744;padding:6px 10px;font-size:12px;font-weight:700">COMPLETED · ${escapeHtml(input.audit.audit_number)}</div><p style="font-size:15px;line-height:1.55;margin:18px 0">${escapeHtml(body)}</p><table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;border-spacing:8px 0"><tr><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Cash variance</div><div style="font-size:17px;font-weight:800;margin-top:5px">${escapeHtml(variance)}</div></td><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Shipment exceptions</div><div style="font-size:17px;font-weight:800;margin-top:5px">${input.audit.shipment_unresolved_count || 0}</div></td><td style="width:33%;background:#f7f9fc;border-radius:10px;padding:13px"><div style="font-size:11px;color:#66758f;font-weight:700;text-transform:uppercase">Open actions</div><div style="font-size:17px;font-weight:800;margin-top:5px">${input.actions}</div></td></tr></table><p style="margin:24px 0 0"><a href="${escapeHtml(input.url)}" style="background:#e62c70;color:#fff;text-decoration:none;border-radius:8px;padding:12px 16px;font-size:14px;font-weight:700;display:inline-block">Open audit record</a></p></td></tr><tr><td style="padding:16px 28px;background:#fbfcfe;border-top:1px solid #edf1f6;color:#6d7b91;font-size:12px">This message stays in the same station and month email chain for traceability.</td></tr></table></td></tr></table></body></html>`;
}

export async function sendStationAuditCompletedEmail(input: { companyId: string; audit: StationAudit; type: AuditType; station: AuditStation; openActions: number }) {
  if (!supabaseAdmin) throw new Error("Database service is unavailable.");
  const to = recipients(input.station, input.type.recipient_rules);
  const cc = recipients(input.station, input.type.cc_rules).filter((email) => !to.includes(email));
  if (!to.length) throw new Error("No audit recipient is configured for this station. Add station email or amend the recipient rules in Audit Master.");
  const auditDate = input.audit.scheduled_for.slice(0, 10);
  const threadMonth = auditDate.slice(0, 7);
  const defaultSubject = `${input.station.station_code} · ${input.type.name} · ${threadMonth}`;
  const found = await supabaseAdmin.from("ops_station_audit_email_threads").select("*").eq("company_id", input.companyId).eq("audit_type_id", input.type.id).eq("location_id", input.station.id).eq("thread_month", threadMonth).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const rootId = found.data?.root_message_id || `<dropx.audit.${randomUUID()}@partner.dropxlogistics.com>`;
  const subject = found.data?.subject || interpolation(input.type.email_subject_template || defaultSubject, input.audit, input.station);
  const messageId = `<dropx.audit.${randomUUID()}@partner.dropxlogistics.com>`;
  const url = `${process.env.NEXT_PUBLIC_APP_URL || "https://ops.dropxlogistics.com"}/ops-pulse/audits?audit=${encodeURIComponent(input.audit.id)}`;
  const html = auditHtml({ audit: input.audit, station: input.station, type: input.type, actions: input.openActions, url });
  const sent = await sendEmail({ companyId: input.companyId, to, cc, subject, body: `Audit ${input.audit.audit_number} completed for ${input.station.station_code}. Open ${url}`, html, messageId, inReplyTo: found.data?.last_message_id || undefined, references: found.data?.last_message_id ? [rootId, found.data.last_message_id] : undefined, timeoutMs: 20_000 });
  const thread = { company_id: input.companyId, audit_type_id: input.type.id, location_id: input.station.id, thread_month: threadMonth, subject, root_message_id: rootId, last_message_id: sent.messageId, updated_at: new Date().toISOString() };
  const stored = found.data ? await supabaseAdmin.from("ops_station_audit_email_threads").update(thread).eq("id", found.data.id) : await supabaseAdmin.from("ops_station_audit_email_threads").insert(thread);
  if (stored.error) throw new Error(stored.error.message);
  return { to, cc, messageId: sent.messageId };
}
