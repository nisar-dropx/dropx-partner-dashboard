import "server-only";
import sharp from "sharp";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { allAuditRows } from "./station-audit-query";
import { loadStationAuditMaster, type StationAudit } from "./station-audits";
import { renderAuditPdf, type AuditReportData } from "./station-audit-report";
export async function buildStationAuditReport(
  companyId: string,
  audit: StationAudit,
) {
  if (!supabaseAdmin) throw new Error("Report service unavailable.");
  const db = supabaseAdmin;
  const [master, checks, shipments, actions, evidence, cashCounts] =
    await Promise.all([
      loadStationAuditMaster(companyId),
      allAuditRows((from, to) =>
        db
          .from("ops_station_audit_check_responses")
          .select(
            "*,ops_audit_checklist_items(label,section_id,ops_audit_checklist_sections(name))",
          )
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .range(from, to),
      ),
      allAuditRows((from, to) =>
        db
          .from("ops_station_audit_shipments")
          .select("*")
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .range(from, to),
      ),
      allAuditRows((from, to) =>
        db
          .from("ops_station_audit_actions")
          .select("*")
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .range(from, to),
      ),
      allAuditRows((from, to) =>
        db
          .from("ops_station_audit_evidence")
          .select("*")
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .range(from, to),
      ),
      allAuditRows((from, to) =>
        db
          .from("ops_station_audit_cash_counts")
          .select("denomination_value,note_count,computed_amount")
          .eq("company_id", companyId)
          .eq("audit_id", audit.id)
          .order("denomination_value", { ascending: false })
          .range(from, to),
      ),
    ]);
  for (const result of [checks, shipments, actions, evidence, cashCounts])
    if (result.error) throw new Error(result.error.message);
  const photos: AuditReportData["photos"] = [];
  const attachPhoto = async (raw: unknown) => {
    const e = raw as any;
    const photo: AuditReportData["photos"][number] = {
      id: e.id,
      label: e.caption || e.file_name || "Audit evidence",
    };
    const match = String(e.media_url).match(/^storage:\/\/([^/]+)\/(.+)$/);
    if (match && String(e.content_type).startsWith("image/")) {
      try {
        const r = await db.storage.from(match[1]).download(match[2]);
        if (r.error || !r.data) throw new Error("Missing proof");
        photo.image = await sharp(Buffer.from(await r.data.arrayBuffer()), {
          limitInputPixels: 40000000,
        })
          .rotate()
          .resize({
            width: 900,
            height: 650,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 65 })
          .toBuffer();
      } catch {
        photo.unavailable = true;
      }
    }
    return photo;
  };
  const evidenceRows = evidence.data || [];
  for (let i = 0; i < evidenceRows.length; i += 4)
    photos.push(
      ...(await Promise.all(evidenceRows.slice(i, i + 4).map(attachPhoto))),
    );
  const data: AuditReportData = {
    number: audit.audit_number,
    station: `${audit.stations?.station_code || ""} - ${audit.stations?.station_name || ""}`,
    type: audit.ops_audit_types?.name || "Station audit",
    auditor: audit.assigned_name || "Not recorded",
    completed: audit.completed_at
      ? new Date(audit.completed_at).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
        })
      : "Not submitted",
    status: audit.status_code.replaceAll("_", " "),
    summary: audit.overall_summary || "",
    stationResponse: audit.station_summary || "",
    expectedCash: audit.system_cash_amount,
    actualCash: audit.physical_cash_amount,
    missing: audit.shipment_missing_count,
    excess: audit.shipment_excess_count,
    cashCounts: (cashCounts.data || []).map((row: any) => ({
      denomination: Number(row.denomination_value),
      count: Number(row.note_count),
      amount: Number(row.computed_amount),
    })),
    snapshot: audit.score_snapshot,
    checks: (checks.data || []).map((raw: any) => {
      const item = master.checklistItems.find(
        (i) => i.id === raw.checklist_item_id,
      );
      const snap = audit.score_snapshot?.sections.find((s) =>
        s.items.some((i) => i.id === raw.checklist_item_id),
      );
      const value = raw.response_value?.value || "";
      return {
        id: raw.checklist_item_id,
        section:
          snap?.name ||
          raw.ops_audit_checklist_items?.ops_audit_checklist_sections?.name ||
          "Other checks",
        label:
          snap?.items.find((i) => i.id === raw.checklist_item_id)?.label ||
          raw.ops_audit_checklist_items?.label ||
          "Checklist item",
        outcome:
          snap?.items.find((i) => i.id === raw.checklist_item_id)?.outcome ||
          item?.response_options.find((o) => o.value === value)?.label ||
          value,
        remarks: raw.remarks || "",
        employees: (raw.response_value?.employees || [])
          .map((e: any) => `${e.employee_code} - ${e.full_name}`)
          .join(", "),
      };
    }),
    shipments: (shipments.data || []).map((s: any) => ({
      tid: s.tracking_id,
      discrepancy: s.discrepancy_code,
      remarks: s.remarks || "",
      response: s.station_response
        ? [
            s.station_response.label || s.station_response.status || "",
            s.station_response.remarks || "",
            s.station_response.employee
              ? `Employee: ${s.station_response.employee.employee_code} - ${s.station_response.employee.full_name}`
              : "",
            s.station_response.responded_name
              ? `Updated by ${s.station_response.responded_name}`
              : "",
            s.station_response.responded_at
              ? new Date(s.station_response.responded_at).toLocaleString(
                  "en-IN",
                  { timeZone: "Asia/Kolkata" },
                )
              : "",
          ]
            .filter(Boolean)
            .join(" | ")
        : "",
    })),
    actions: (actions.data || []).map((a: any) => ({
      title: a.title,
      status: a.status_code,
      action: a.corrective_action || "",
    })),
    photos,
  };
  return { data, pdf: await renderAuditPdf(data) };
}
