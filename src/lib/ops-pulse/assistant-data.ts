import { mapWithConcurrency } from "@/lib/bounded-concurrency";
import { loadReviewAttendanceHistory } from "./review-attendance-history-data";
import { summarizeAssistantAttendance } from "./assistant-attendance";
import { allRoutingRows } from "./people-review-routing";
import "server-only";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { callMcpTool } from "@/lib/mcp/tools";
import { indiaDate } from "@/lib/mcp/dates";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadOpsStationManpower } from "./station-manpower";
import { isScheduledShift, matchesShift, shiftLabel } from "@/lib/shift-attendance-view";
import { loadStationAuditWorkspace } from "./station-audits";
import { workspace as storeWorkspace } from "./store-audits/server";
import type { Master } from "./store-audits/model";
import type { CodLocationRow } from "./cod";
import { codStatusPortalStation } from "./cod-status-server";
import { fetchCodStatus } from "./cash-recon-worker";
import { documentInWorkspace } from "@/lib/business-document-workspace-policy";
import { assistantCatalog, checkedArguments } from "./assistant-policy";

export function scopedAssistantAuth(auth: AuthorizationContext, locations: CodLocationRow[]): AuthorizationContext {
  return { ...auth, readOnly: true, hasAllLocationAccess: false, isMasterOwner: false, locationScopeIds: locations.map(l => l.id) };
}
export async function readAssistantData(auth: AuthorizationContext, locations: CodLocationRow[], darkStore: boolean, name: string, raw: Record<string, unknown>, defaults: { from: string; to: string; asOf: string }) {
  if (!assistantCatalog(code => hasPermission(auth, code, "access"), darkStore).some(t => t.name === name)) throw Error("This data source is not available in your workspace or permissions.");
  const args = checkedArguments(raw, locations.map(l => l.station_code.toUpperCase()), defaults);
  const selected = locations.filter(l => args.stationCodes.includes(l.station_code.toUpperCase()));
  if (!selected.length) throw Error("Select at least one permitted location.");
  const scoped = scopedAssistantAuth(auth, selected);
  if (!supabaseAdmin) throw Error("Data source is unavailable.");
  const companyId = auth.companyId!;
  if (name === "ops_attendance_analysis") {
    if (selected.length > 20) throw Error("Select up to 20 locations for detailed attendance analysis.");
    if (args.to > indiaDate()) throw Error("Choose an attendance period ending today or earlier.");
    const histories = await mapWithConcurrency(selected, 3, location => loadReviewAttendanceHistory(companyId, location, args.to, { from: args.from }));
    return { ...summarizeAssistantAttendance(histories, args.from, args.to, { role: typeof raw.role === "string" ? raw.role.slice(0,100) : undefined, person: typeof raw.person === "string" ? raw.person.slice(0,100) : undefined }), checkedAt: new Date().toISOString() };
  }
  if (name === "ops_store_health_analysis") {
    const [facts, actions] = await Promise.all([
      allRoutingRows(supabaseAdmin.from("report_metric_facts").select("station_code,report_date,values_json,created_at").eq("company_id", companyId).eq("source_type", "qc_store_health_daily").in("station_code", args.stationCodes).gte("report_date", args.from).lte("report_date", args.to).order("created_at", { ascending: false }).order("id")),
      allRoutingRows(supabaseAdmin.from("ops_performance_followups").select("station_id,title,owner_label,due_date,status").eq("company_id", companyId).in("station_id", selected.map(l=>l.id)).not("status", "in", "(done,closed,completed,cancelled)").lte("due_date", args.to).order("due_date").order("id"))
    ]);
    const latest = new Map<string, typeof facts[number]>();
    for (const fact of facts) { const key = `${fact.station_code}|${fact.report_date}`; if (!latest.has(key)) latest.set(key, fact); }
    const rows = [...latest.values()].sort((a,b)=>a.report_date.localeCompare(b.report_date) || a.station_code.localeCompare(b.station_code));
    return { source: "Imported Store Health scorecards and saved review actions", from: args.from, to: args.to, checkedAt: new Date().toISOString(), note: "Store Health is normally available D-2; no imported row means missing data, not a zero score. Open actions are current outstanding items due by the period end. Percentage actual_number fields are fractions; use actual_text with its qualifiers and metric-specific dates. Reported status is authoritative; audit numbers can be dates, not measurements. Unscored metrics are unavailable, not zero. Imported narrative snippets may be incomplete; use structured metrics.", rows, openActions: actions.map(a=>({...a,stationCode:selected.find(l=>l.id===a.station_id)?.station_code})), truncated: false };
  }
  if (name === "ops_shift_status") {
    const result = await loadOpsStationManpower(companyId, selected, args.asOf, { historical: args.asOf < indiaDate() });
    return { source: "Shift Attendance · approved rosters and People punches", asOf: args.asOf, checkedAt: new Date().toISOString(), rows: selected.map(location => {
      const people = result.people.filter(p => p.locationId === location.id);
      const count = (filter: string) => people.filter(p => matchesShift(p, filter)).length;
      return { stationCode: location.station_code, people: people.length, scheduled: people.filter(isScheduledShift).length, punched: count("present"), notReported: count("missing"), upcoming: count("upcoming"), late: count("late"), missingPunch: count("single"), onLeave: count("leave"), weekOff: count("off"), noRoster: count("unassigned"), rosterPending: count("pending"), dataAvailable: people.length > 0,
        team: people.slice(0, 60).map(p => ({ name: p.name, designation: p.designation, shift: p.today.shiftName, from: p.today.shiftStartTime, to: p.today.shiftEndTime, status: shiftLabel(p), availability: p.availability, inTime: p.today.inTime, outTime: p.today.outTime })), teamTruncated: people.length > 60 };
    }) };
  }
  if (name === "ops_store_audit_summary") {
    const master = await supabaseAdmin.from("ops_store_audit_master").select("*").eq("company_id", companyId).maybeSingle();
    if (master.error || !master.data) throw Error("Store Audit Master is unavailable.");
    const result = await storeWorkspace({ ...scoped, isMasterOwner: auth.isMasterOwner }, master.data as Master, args.from, args.to);
    return { from: args.from, to: args.to, rows: result.audits.filter(a => scoped.locationScopeIds.includes(a.location_id)).map(a => ({ station: a.store_name, number: a.number, status: a.status, scheduledFor: a.scheduled_for, completedAt: a.completed_at, score: a.score, findings: a.findings.length })).slice(0, 100), truncated: result.audits.length > 100 };
  }
  if (name === "ops_station_audit_summary") {
    const result = await loadStationAuditWorkspace(companyId, { ...scoped, isMasterOwner: auth.isMasterOwner }, args.from, args.to);
    const audits = result.audits.filter(a => scoped.locationScopeIds.includes(a.location_id));
    return { from: args.from, to: args.to, rows: audits.slice(0, 100).map(a => ({ stationCode: selected.find(l => l.id === a.location_id)?.station_code, status: a.status_code, scheduledFor: a.scheduled_for, completedAt: a.completed_at })), truncated: result.truncated || audits.length > 100 };
  }
  if (name === "ops_cod_status") {
    if (args.asOf !== indiaDate()) throw Error("COD Status is a current snapshot. Use COD reports or ageing for a historical date.");
    if (selected.length > 5) throw Error("Select up to five stations for live COD checks, or ask for COD ageing across your scope.");
    return { checkedAt: new Date().toISOString(), rows: await Promise.all(selected.map(async l => {
      const code = await codStatusPortalStation(scoped, l);
      const snapshot = await fetchCodStatus(code, false);
      if (snapshot.version !== 1 || snapshot.stationCode !== code) throw Error("Unexpected COD response.");
      const rec = snapshot.reconciliation;
      const rem = snapshot.remittances;
      const latest = rem.data?.latestSubmitted;
      return { stationCode: l.station_code, fetchedAt: snapshot.fetchedAt, date: snapshot.date, cached: snapshot.cached, reconciliation: { state: rec.state, checkedAt: rec.checkedAt, pendingCount: rec.data?.pendingCount ?? null, pendingAmount: rec.data?.pendingAmount ?? null }, prepareDeposit: snapshot.prepareDeposit,
        remittances: { state: rem.state, checkedAt: rem.checkedAt, openCount: rem.data?.openCount ?? null, openAmount: rem.data?.openAmount ?? null, latestSubmitted: latest ? { code: latest.code, expectedAmount: latest.expectedAmount, actualAmount: latest.actualAmount, variance: latest.variance, submittedAt: latest.submittedAt, updatedAt: latest.updatedAt } : null } };
    })) };
  }
  if (name === "ops_business_documents") {
    const [documents, roles, stationMetadata] = await Promise.all([
      supabaseAdmin.from("business_document_records").select("id,document_type_id,scope_type,scope_id,additional_scope_ids,scope_label,document_type_code,expiry_date,status,document_types(name,doc_access_mode)").eq("company_id", companyId).eq("is_active", true).order("expiry_date").limit(1000),
      supabaseAdmin.from("document_type_role_access").select("document_type_id,role_id").eq("company_id", companyId),
      supabaseAdmin.from("stations").select("id,state,provider_id").eq("company_id", companyId).in("id", scoped.locationScopeIds)
    ]);
    if (documents.error || roles.error || stationMetadata.error) throw Error("Business document source is unavailable.");
    const rows = (documents.data ?? []).filter(d => {
      const type = Array.isArray(d.document_types) ? d.document_types[0] : d.document_types;
      const roleIds = roles.data.filter(r => r.document_type_id === d.document_type_id).map(r => r.role_id);
      const broadDocumentAccess = auth.hasAllLocationAccess || auth.isMasterOwner;
      // Match Business Documents' existing role/scope policy; a workspace filter cannot grant access.
      if (!broadDocumentAccess && d.scope_type === "provider") return false;
      return documentInWorkspace(d, stationMetadata.data) && (broadDocumentAccess || type?.doc_access_mode !== "role_based" || !roleIds.length || Boolean(auth.roleId && roleIds.includes(auth.roleId)));
    });
    return { asOf: indiaDate(), total: rows.length, truncated: documents.data.length === 1000 || rows.length > 100, rows: rows.slice(0, 100).map(d => ({ document: d.document_type_code, scope: d.scope_label, expiryDate: d.expiry_date, recordedStatus: d.status })) };
  }
  // Canonical read-only tools retain their own module authorization and source semantics.
  const result = await callMcpTool(scoped, name, args);
  return name === "ops_payment_inbox_summary" || name === "ops_roster_summary"
    ? { scopeNote: "Your assigned approval inbox across permitted locations; these personal counts are not a station total.", data: result }
    : result;
}
