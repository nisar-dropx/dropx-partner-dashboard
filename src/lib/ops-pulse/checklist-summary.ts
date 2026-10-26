import type { ReportPack, ReportPackTask } from "./checklist-report-pack";

/** No attachment URLs or hidden identifiers enter the shareable summary. */
export function summaryTask(task: ReportPackTask) {
  const label = (key: string) => task.fieldLabels?.[key] || key.replaceAll("_", " ");
  const values = Object.entries(task.numbers || {}).filter(([, v]) => String(v ?? "").trim());
  const lines = (task.lines || []).map(line => Object.entries(line).filter(([, v]) => String(v ?? "").trim()).map(([k, v]) => `${label(k)}: ${v}`).join(" · ")).filter(Boolean);
  const detail = [task.outcome, ...values.map(([k, v]) => `${label(k)}: ${v}`), task.text, task.informed ? `Informed: ${task.informed}` : "", ...lines].filter(Boolean).join(" · ");
  return { label: task.label, status: task.recordStatus || (detail ? "Recorded" : "Not recorded"), detail: detail || (task.recordStatus?.startsWith("Completed this") ? "Recorded in an earlier submitted store report" : "No answer saved") };
}

export function checklistSummary(pack: ReportPack) {
  const c = pack.checklist;
  const date = c.shift_date || c.work_date || "";
  return {
    title: `${c.store_code} · ${pack.kind === "shift" ? "Shift handover" : "Store day report"}`,
    subtitle: `${c.store_name} · ${date}${c.shift_slot ? ` · ${c.shift_slot} IST` : ""}`,
    owner: `${pack.kind === "shift" ? "Shift in-charge" : "Owner"}: ${c.person_name}${c.incoming_name ? ` → ${c.incoming_name}` : ""}`,
    status: `${c.statusLabel} · ${c.pct}% required answers (${c.answered}/${c.total})`,
    submitted: c.submitted_at ? `Submitted ${ist(c.submitted_at)}` : "Not submitted · saved draft only",
    handover: pack.kind === "shift" ? c.accepted_at ? `Accepted ${ist(c.accepted_at)}` : "Handover acceptance pending" : "",
    sections: pack.sections.map(section => ({ name: section.name, rows: section.tasks.map(task => ({ ...summaryTask(task), proofs: pack.proofs.filter(p => p.task_id === task.id).length })) })),
    notes: c.notes || "",
    filename: `OpsPulse-${c.store_code}-${date}${c.shift_slot ? `-${c.shift_slot.replace(":", "")}` : ""}`.replace(/[^a-zA-Z0-9_-]/g, "-"),
  };
}
function ist(value: string) {
  return new Date(value).toLocaleString("en-IN", {timeZone:"Asia/Kolkata",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) + " IST";
}
