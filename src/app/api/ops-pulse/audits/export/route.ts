import { allAuditRows } from "@/lib/ops-pulse/station-audit-query";
import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canManageStationAudits,
  loadAuditStations,
  loadStationAuditMaster,
} from "@/lib/ops-pulse/station-audits";
import {
  auditDuration,
  auditStatusLabel,
  auditTone,
  isFastAudit,
  validAuditDate,
} from "@/lib/ops-pulse/station-audit-planning";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function workbookSheet(rows: Record<string, unknown>[]) {
  const sheet = XLSX.utils.json_to_sheet(
    rows.length ? rows : [{ "No records": "No records for this selection" }],
  );
  const keys = Object.keys(rows[0] ?? { "No records": "" });
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: Math.max(rows.length, 1), c: Math.max(keys.length - 1, 0) },
    }),
  };
  sheet["!freeze"] = { ySplit: 1 };
  sheet["!cols"] = keys.map((key) => ({
    wch: Math.min(42, Math.max(12, key.length + 3)),
  }));
  return sheet;
}

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (
    !authorization ||
    !hasPermission(authorization, "station_audits", "access")
  )
    return Response.json({ error: "Audit access denied." }, { status: 403 });
  if (!supabaseAdmin)
    return Response.json({ error: "Database unavailable." }, { status: 500 });
  const client = supabaseAdmin;
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!validAuditDate(from) || !validAuditDate(to) || from > to)
    return Response.json(
      { error: "Choose a valid audit date range." },
      { status: 400 },
    );
  const companyId = requireCompanyId(authorization);
  const master = await loadStationAuditMaster(companyId);
  if (!canManageStationAudits(authorization, master.programmeSettings))
    return Response.json(
      { error: "Only configured audit managers can export audit records." },
      { status: 403 },
    );
  const stations = await loadAuditStations(
    companyId,
    authorization,
    master.programmeSettings,
  );
  const requestedStations = url.searchParams.has("stations")
    ? (url.searchParams.get("stations") || "").split(",")
    : null;
  const stationIds = stations
    .filter(
      (station) => !requestedStations || requestedStations.includes(station.id),
    )
    .map((station) => station.id);
  if (!stationIds.length)
    return Response.json(
      { error: "No stations are available in your Audit scope." },
      { status: 403 },
    );
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const auditsResult = await supabaseAdmin
    .from("ops_station_audits")
    .select(
      "id,audit_number,audit_type_id,location_id,scheduled_for,status_code,score,score_snapshot,assigned_to,assigned_name,started_at,completed_at,completed_by,response_due_at,system_cash_amount,physical_cash_amount,cash_variance_amount,system_shipment_count,physical_shipment_count,shipment_missing_count,shipment_excess_count,shipment_unresolved_count,overall_summary,station_summary,manager_summary,email_status,ops_audit_types(name,code)",
    )
    .eq("company_id", companyId)
    .is("deleted_at", null)
    .in("location_id", stationIds)
    .gte("scheduled_for", `${from}T00:00:00+05:30`)
    .lte("scheduled_for", `${to}T23:59:59.999+05:30`)
    .order("scheduled_for")
    .limit(5000);
  if (auditsResult.error)
    return Response.json(
      { error: auditsResult.error.message },
      { status: 500 },
    );
  const selectedAuditors = (url.searchParams.get("auditors") || "")
    .split("|")
    .filter(Boolean);
  const requestedType = url.searchParams.get("type") || "all";
  const requestedStatus = url.searchParams.get("status") || "all";
  const term = (url.searchParams.get("q") || "").toLowerCase();
  const audits = (auditsResult.data ?? []).filter(
    (audit) =>
      (requestedType === "all" || audit.audit_type_id === requestedType) &&
      (requestedStatus === "all" || auditTone(audit) === requestedStatus) &&
      (!selectedAuditors.length ||
        selectedAuditors.includes(audit.assigned_name || "Unassigned")) &&
      (url.searchParams.get("fast") !== "true" || isFastAudit(audit)) &&
      (!term ||
        `${audit.audit_number} ${stationById.get(audit.location_id)?.station_code} ${audit.assigned_name} ${stationById.get(audit.location_id)?.station_name}`
          .toLowerCase()
          .includes(term)),
  );
  const ids = audits.map((audit) => audit.id);
  const typeName = new Map(
    audits.map((audit: any) => [
      audit.id,
      audit.ops_audit_types?.name ?? audit.ops_audit_types?.code ?? "Audit",
    ]),
  );
  const [cash, responses, shipments, actions, comments, events] = ids.length
    ? await Promise.all([
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_cash_counts")
            .select(
              "audit_id,cash_side,denomination_value,note_count,computed_amount,notes",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("id")
            .range(from, to),
        ),
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_check_responses")
            .select(
              "audit_id,checklist_item_id,response_value,is_compliant,remarks,ops_audit_checklist_items(label,code)",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("id")
            .range(from, to),
        ),
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_shipments")
            .select(
              "audit_id,tracking_id,system_status_code,physical_status_code,discrepancy_code,remarks,required_action,due_at,is_resolved,station_response",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("id")
            .range(from, to),
        ),
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_actions")
            .select(
              "audit_id,title,corrective_action,preventive_action,severity_code,status_code,owner_name,owner_email,due_at,completed_at,completion_note",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("id")
            .range(from, to),
        ),
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_comments")
            .select(
              "audit_id,body,audience,requests_station_response,author_name,author_email,created_at",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("id")
            .range(from, to),
        ),
        allAuditRows((from, to) =>
          client
            .from("ops_station_audit_events")
            .select(
              "audit_id,event_type,actor_name,actor_email,created_at,before_data,after_data",
            )
            .eq("company_id", companyId)
            .in("audit_id", ids)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  const relatedError = [
    cash,
    responses,
    shipments,
    actions,
    comments,
    events,
  ].find((result) => result.error)?.error;
  if (relatedError)
    return Response.json({ error: relatedError.message }, { status: 500 });
  const actor = (id: string, type: string) =>
    (events.data ?? [])
      .filter((row) => row.audit_id === id && row.event_type === type)
      .at(-1);
  const localTime = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : "";
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      audits.map((audit: any) => ({
        "Audit number": audit.audit_number,
        "Audit type": typeName.get(audit.id),
        Station: stationById.get(audit.location_id)?.station_code,
        "Station name":
          stationById.get(audit.location_id)?.station_name ??
          stationById.get(audit.location_id)?.city,
        "Scheduled (IST)": localTime(audit.scheduled_for),
        Status: auditStatusLabel(audit.status_code),
        "Assigned auditor": audit.assigned_name,
        "Scheduled by":
          actor(audit.id, "scheduled")?.actor_name || "Not recorded",
        "Started by":
          actor(audit.id, "started")?.actor_name ||
          (audit.started_at ? audit.assigned_name : ""),
        "Completed by":
          actor(audit.id, "submitted")?.actor_name ||
          (audit.completed_by === audit.assigned_to ? audit.assigned_name : ""),
        "Started (IST)": localTime(audit.started_at),
        "Completed (IST)": localTime(audit.completed_at),
        "Duration minutes": auditDuration(audit),
        "Quality review (10 min or less)": isFastAudit(audit) ? "Yes" : "",
        "Response due": audit.response_due_at,
        "System cash": audit.system_cash_amount,
        "Physical cash": audit.physical_cash_amount,
        "Cash variance": audit.cash_variance_amount,
        "System shipments": audit.system_shipment_count,
        "Physical shipments": audit.physical_shipment_count,
        Missing: audit.shipment_missing_count,
        Excess: audit.shipment_excess_count,
        "Unresolved shipments": audit.shipment_unresolved_count,
        "Physical audit score (%)": audit.score,
        "Score rating": (audit.score_snapshot as any)?.rating || "Not scored",
        "Score review": (audit.score_snapshot as any)?.provisional ? "Provisional" : audit.score == null ? "Not scored" : "Assessed",
        Summary: audit.overall_summary,
        "Station response": audit.station_summary,
        "Manager note": audit.manager_summary,
        Email: audit.email_status,
      })),
    ),
    "Audit register",
  );
  const auditLookup = new Map(audits.map((audit) => [audit.id, audit]));
  const metadata = (auditId: string) => {
    const audit: any = auditLookup.get(auditId);
    return {
      "Audit number": audit?.audit_number,
      Station: stationById.get(audit?.location_id)?.station_code,
      "Audit type": typeName.get(auditId),
    };
  };
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (cash.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        Side: row.cash_side,
        Denomination: row.denomination_value,
        "Note count": row.note_count,
        Amount: row.computed_amount,
        Notes: row.notes,
      })),
    ),
    "Cash counts",
  );
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (responses.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        Check:
          row.ops_audit_checklist_items?.label ??
          row.ops_audit_checklist_items?.code,
        Response:
          row.response_value?.value ?? JSON.stringify(row.response_value ?? {}),
        "Employee / key custodians": (row.response_value?.employees || [])
          .map((p: any) => `${p.employee_code} · ${p.full_name}`)
          .join("; "),
        Compliant: row.is_compliant,
        Remarks: row.remarks,
      })),
    ),
    "Checklist",
  );
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (shipments.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        "Tracking ID": row.tracking_id,
        "System status": row.system_status_code,
        "Physical status": row.physical_status_code,
        Discrepancy: row.discrepancy_code,
        "Required action": row.required_action,
        Due: row.due_at,
        Resolved: row.is_resolved,
        "Station status": row.station_response?.label || "Response pending",
        "Station remarks": row.station_response?.remarks || "",
        "Employee ID": row.station_response?.employee?.employee_code || "",
        "Employee name": row.station_response?.employee?.full_name || "",
        "Responded by": row.station_response?.responded_name || "",
        "Response date": row.station_response?.responded_at || "",
        Remarks: row.remarks,
      })),
    ),
    "Shipment exceptions",
  );
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (actions.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        Title: row.title,
        "Corrective action": row.corrective_action,
        "Preventive action": row.preventive_action,
        Severity: row.severity_code,
        Status: row.status_code,
        Owner: row.owner_name || row.owner_email,
        Due: row.due_at,
        Completed: row.completed_at,
        "Completion note": row.completion_note,
      })),
    ),
    "Corrective actions",
  );
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (comments.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        Audience: row.audience,
        "Station reply requested": row.requests_station_response,
        Comment: row.body,
        Author: row.author_name || row.author_email,
        Created: row.created_at,
      })),
    ),
    "Conversation",
  );
  XLSX.utils.book_append_sheet(
    book,
    workbookSheet(
      (events.data ?? []).map((row: any) => ({
        ...metadata(row.audit_id),
        Event: row.event_type,
        User: row.actor_name || row.actor_email,
        "Date (IST)": localTime(row.created_at),
        Before: JSON.stringify(row.before_data),
        After: JSON.stringify(row.after_data),
      })),
    ),
    "Audit history",
  );
  const bytes = XLSX.write(book, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  }) as Buffer;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="station-audits-${from}-to-${to}.xlsx"`,
      "Cache-Control": "private, no-store",
    },
  });
}
