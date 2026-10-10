import {
  allAuditRows,
  auditRowsForIds,
} from "@/lib/ops-pulse/station-audit-query";
import * as XLSX from "xlsx";
import { renderAuditProgressPdf } from "@/lib/ops-pulse/station-audit-progress-pdf";
import {
  auditProgress,
  auditReportRangeError,
  matchesAuditReportStatus,
} from "@/lib/ops-pulse/station-audit-progress";
import {
  appendAuditProgressSummary,
  auditWorkbookSheet,
} from "@/lib/ops-pulse/station-audit-progress-export";
import { loadAuditAssignees } from "@/lib/ops-pulse/station-audit-people";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import {
  canManageStationAudits,
  loadAuditStations,
  loadStationAuditMaster,
} from "@/lib/ops-pulse/station-audits";
import {
  auditAssigneeKey,
  auditDuration,
  auditResponseLabel,
  auditStatusLabel,
  isFastAudit,
} from "@/lib/ops-pulse/station-audit-planning";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const workbookSheet = auditWorkbookSheet;

export async function GET(request: Request) {
  try {
    return await exportAuditReport(request);
  } catch (error) {
    console.error("Audit export failed", error);
    return Response.json(
      {
        error:
          "The audit report could not be prepared. Please retry or select a shorter date range.",
      },
      { status: 500 },
    );
  }
}

async function exportAuditReport(request: Request) {
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
  const format = url.searchParams.get("format") || "xlsx";
  if (format !== "xlsx" && format !== "pdf" && format !== "csv")
    return Response.json(
      { error: "Choose Excel, PDF or CSV." },
      { status: 400 },
    );
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const rangeError = auditReportRangeError(from, to);
  if (rangeError) return Response.json({ error: rangeError }, { status: 400 });
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
  const auditsResult = await allAuditRows((start, end) =>
    client
      .from("ops_station_audits")
      .select(
        "id,audit_number,audit_type_id,location_id,scheduled_for,status_code,score,score_snapshot,assigned_to,assigned_name,assignment_verified,started_at,completed_at,completed_by,response_due_at,station_response_status,system_cash_amount,physical_cash_amount,cash_variance_amount,system_shipment_count,physical_shipment_count,shipment_missing_count,shipment_excess_count,shipment_unresolved_count,overall_summary,station_summary,manager_summary,email_status,ops_audit_types(name,code)",
      )
      .eq("company_id", companyId)
      .is("deleted_at", null)
      .in("location_id", stationIds)
      .gte("scheduled_for", `${from}T00:00:00+05:30`)
      .lte("scheduled_for", `${to}T23:59:59.999+05:30`)
      .order("scheduled_for")
      .order("id")
      .range(start, end),
  );
  if (auditsResult.error)
    return Response.json(
      { error: auditsResult.error.message },
      { status: 500 },
    );
  const selectedAuditors = (url.searchParams.get("auditors") || "")
    .split(",")
    .filter(Boolean);
  const requestedType = url.searchParams.get("type") || "all";
  const requestedStatus = url.searchParams.get("status") || "all";
  const term = (url.searchParams.get("q") || "").toLowerCase();
  const now = Date.now();
  const assignees = await loadAuditAssignees(
    companyId,
    master.programmeSettings.scheduler_role_ids,
    stationIds,
  );
  const names = new Map(assignees.map((person) => [person.id, person.name]));
  const auditorName = (audit: {
    assigned_to: string | null;
    assigned_name: string | null;
    assignment_verified: boolean;
  }) =>
    audit.assignment_verified && audit.assigned_to
      ? names.get(audit.assigned_to) || audit.assigned_name || "Former auditor"
      : `${audit.assigned_name || "Unassigned"}${audit.assigned_name ? " (assignment unconfirmed)" : ""}`;
  const audits = (auditsResult.data ?? []).filter(
    (audit) =>
      (requestedType === "all" || audit.audit_type_id === requestedType) &&
      matchesAuditReportStatus(audit, requestedStatus, now) &&
      (!selectedAuditors.length ||
        selectedAuditors.includes(auditAssigneeKey(audit))) &&
      (url.searchParams.get("fast") !== "true" || isFastAudit(audit)) &&
      (!term ||
        `${audit.audit_number} ${stationById.get(audit.location_id)?.station_code} ${auditorName(audit)} ${stationById.get(audit.location_id)?.station_name}`
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
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_cash_counts")
            .select(
              "audit_id,cash_side,denomination_value,note_count,computed_amount,notes",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
            .order("id")
            .range(from, to),
        ),
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_check_responses")
            .select(
              "audit_id,checklist_item_id,response_value,is_compliant,remarks,ops_audit_checklist_items(label,code)",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
            .order("id")
            .range(from, to),
        ),
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_shipments")
            .select(
              "audit_id,tracking_id,system_status_code,physical_status_code,discrepancy_code,remarks,required_action,due_at,is_resolved,station_response",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
            .order("id")
            .range(from, to),
        ),
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_actions")
            .select(
              "audit_id,title,corrective_action,preventive_action,severity_code,status_code,owner_name,owner_email,due_at,completed_at,completion_note",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
            .order("id")
            .range(from, to),
        ),
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_comments")
            .select(
              "audit_id,body,audience,requests_station_response,author_name,author_email,created_at",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
            .order("id")
            .range(from, to),
        ),
        auditRowsForIds(ids, (batchIds, from, to) =>
          client
            .from("ops_station_audit_events")
            .select(
              "audit_id,event_type,actor_name,actor_email,created_at,before_data,after_data",
            )
            .eq("company_id", companyId)
            .in("audit_id", batchIds)
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
  const register = audits.map((audit: any) => ({
    "Audit number": audit.audit_number,
    "Audit type": typeName.get(audit.id),
    Station: stationById.get(audit.location_id)?.station_code,
    "Station name":
      stationById.get(audit.location_id)?.station_name ??
      stationById.get(audit.location_id)?.city,
    "Scheduled (IST)": localTime(audit.scheduled_for),
    Status: auditStatusLabel(audit.status_code),
    Completion: auditProgress(audit, now).completion,
    "Fieldwork submitted": auditProgress(audit, now).submitted ? "Yes" : "No",
    "Overdue audit": auditProgress(audit, now).overdue ? "Yes" : "No",
    "Days overdue": auditProgress(audit, now).daysOverdue,
    "Station response status": auditResponseLabel(audit, now),
    "Next action": auditProgress(audit, now).nextAction,
    "Assigned auditor": auditorName(audit),
    "Scheduled by": actor(audit.id, "scheduled")?.actor_name || "Not recorded",
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
    "Response due (IST)": localTime(audit.response_due_at),
    "Open in OpsPulse": `${url.origin}/ops-pulse/audits?audit=${encodeURIComponent(audit.id)}`,
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
    "Score review": (audit.score_snapshot as any)?.provisional
      ? "Provisional"
      : audit.score == null
        ? "Not scored"
        : "Assessed",
    Summary: audit.overall_summary,
    "Station response": audit.station_summary,
    "Manager note": audit.manager_summary,
    Email: audit.email_status,
  }));
  if (format === "csv") {
    // One row per audit: who audits which station and when. The byte-order mark
    // keeps station names readable when the file is opened in Excel.
    // Text that a spreadsheet would run as a formula is stored as plain text.
    const safe = register.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && /^[=+-@]/.test(value)
            ? `'${value}`
            : value,
        ]),
      ),
    );
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(safe));
    return new Response(`﻿${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="station-audits-${from}-to-${to}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  appendAuditProgressSummary(book, audits, {
    from,
    to,
    now,
    auditorName,
    register,
    stations: stations.filter((station) => stationIds.includes(station.id)),
    filters: `Type: ${master.auditTypes.find((type) => type.id === requestedType)?.name || "All"}; status: ${requestedStatus}; auditors: ${selectedAuditors.map((id) => names.get(id) || id).join(", ") || "All"}; search: ${term || "None"}; quick audits only: ${url.searchParams.get("fast") === "true" ? "Yes" : "No"}`,
  });
  XLSX.utils.book_append_sheet(book, workbookSheet(register), "Audit register");
  if (format === "pdf") {
    const pdf = await renderAuditProgressPdf(book, from, to);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="station-audits-${from}-to-${to}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
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
