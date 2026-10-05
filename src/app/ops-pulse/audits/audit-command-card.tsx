import Link from "next/link";
import { hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  canManageStationAudits,
  loadStationAuditMaster,
  loadAuditStations,
} from "@/lib/ops-pulse/station-audits";
import {
  addAuditDays,
  auditDay,
  auditQueueBucket,
} from "@/lib/ops-pulse/station-audit-planning";
export async function AuditCommandCard({
  authorization,
}: {
  authorization: AuthorizationContext;
}) {
  if (
    !hasPermission(authorization, "station_audits", "access") ||
    !supabaseAdmin ||
    !authorization.companyId
  )
    return null;
  try {
    const companyId = authorization.companyId;
    const master = await loadStationAuditMaster(companyId);
    const manager = canManageStationAudits(
      authorization,
      master.programmeSettings,
    );
    const stations = await loadAuditStations(
      companyId,
      authorization,
      master.programmeSettings,
    );
    if (!stations.length) return null;
    let query = supabaseAdmin
      .from("ops_station_audits")
      .select(
        "id,scheduled_for,status_code,completed_at,response_due_at,station_response_status",
      )
      .eq("company_id", companyId)
      .in(
        "location_id",
        stations.map((s) => s.id),
      )
      .is("deleted_at", null)
      .neq("status_code", "closed");
    query = manager
      ? query
          .eq("assigned_to", authorization.userId)
          .eq("assignment_verified", true)
      : query
          .not("completed_at", "is", null)
          .eq("station_response_status", "requested")
          .eq("status_code", "awaiting_station_response");
    const result = await query.order("scheduled_for").limit(1501);
    if (result.error) throw new Error(result.error.message);
    const rows = result.data || [];
    const today = auditDay();
    const count = (bucket: string) =>
      rows.filter((a) => auditQueueBucket(a, today) === bucket).length;
    return (
      <section
        className="panel"
        style={{ margin: "16px 0", borderLeft: "4px solid #ec6026" }}
      >
        <div
          className="panel-body"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <strong>
              {manager ? "My audit queue" : "Station audit responses"}
            </strong>
            <p className="subtle">
              {manager
                ? `${count("overdue")} overdue · ${count("today")} today · ${count("next2")} in the next 2 days · ${count("week")} later this week · ${count("followup")} awaiting response / review`
                : `${rows.length} audits awaiting your station’s response`}
            </p>
            <small>
              For {authorization.fullName || "you"} · live authorized scope
            </small>
          </div>
          <Link className="button compact" href="/ops-pulse/audits">
            {manager ? "Open my audits →" : "Open responses →"}
          </Link>
        </div>
      </section>
    );
  } catch {
    return (
      <section className="panel">
        <div className="panel-body">
          <strong>Audit queue temporarily unavailable</strong>
          <p>
            <Link href="/ops-pulse/audits">Open audits to retry →</Link>
          </p>
        </div>
      </section>
    );
  }
}
