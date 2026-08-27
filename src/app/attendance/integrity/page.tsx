import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { getAuthorization, hasPermission, type AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { redirect } from "next/navigation";
import {
  approveAttendanceIntegrityFlag,
  dismissAttendanceIntegrityFlag,
  reviewAttendanceLocationPackage
} from "./actions";

export const dynamic = "force-dynamic";

type FlagRow = {
  id: string;
  enrolment_id: string;
  profile_type: string | null;
  profile_id: string | null;
  punch_date: string;
  flag_type: string;
  severity: string;
  message: string;
  status: string;
  created_at: string;
  details: Record<string, unknown> | null;
  location_id?: string | null;
};

type ReviewRow = {
  id: string;
  flag_id: string | null;
  punch_id: string | null;
  enrolment_id: string;
  profile_type: string;
  profile_id: string;
  punch_date: string;
  selfie_path: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  remarks: string | null;
  status: string;
  review_remarks: string | null;
  created_at: string;
  server_received_at: string;
};

function formatWhen(value: string | null | undefined) {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata"
  }).format(new Date(value));
}

function asNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asText(value: unknown) {
  if (value == null) return "";
  const text = String(value).trim();
  return text || "";
}

function mapsUrl(lat: number, lng: number) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}`;
}

function FlagLocationDetails({ details }: { details: Record<string, unknown> | null }) {
  if (!details) return <span className="subtle">No location details stored on this flag.</span>;
  const lat = asNumber(details.lat);
  const lng = asNumber(details.lng);
  const distanceM = asNumber(details.distanceM);
  const radiusM = asNumber(details.radiusM);
  const outsideMinutes = asNumber(details.outsideMinutes) ?? (asNumber(details.outsideMs) != null ? Math.round((asNumber(details.outsideMs) as number) / 60000) : null);
  const station =
    asText(details.stationCode) ||
    asText(details.stationName) ||
    asText(details.stationLabel) ||
    "Station";
  const accuracyM = asNumber(details.accuracyM);
  const reason = asText(details.reason) || asText(details.flagReason);

  return (
    <div className="form-grid" style={{ gap: 6 }}>
      <div>
        <strong>{station}</strong>
        <div className="subtle">
          {distanceM != null ? `${Math.round(distanceM)}m from station` : "Distance unknown"}
          {radiusM != null ? ` · allowed ${Math.round(radiusM)}m` : " · allowed 50m"}
          {outsideMinutes != null ? ` · outside ${outsideMinutes} min` : ""}
        </div>
      </div>
      {lat != null && lng != null ? (
        <div>
          <div className="subtle">Device GPS {lat.toFixed(5)}, {lng.toFixed(5)}{accuracyM != null ? ` ±${Math.round(accuracyM)}m` : ""}</div>
          <a href={mapsUrl(lat, lng)} target="_blank" rel="noreferrer">
            Open device location on map
          </a>
        </div>
      ) : (
        <div className="subtle">Device coordinates were not captured on this flag.</div>
      )}
      {reason ? <div className="subtle">Why flagged: {reason.replaceAll("_", " ")}</div> : null}
    </div>
  );
}

async function loadManagedEmployeeProfileIds(companyId: string, managerUserId: string) {
  if (!supabaseAdmin) return [] as string[];
  const reports = await supabaseAdmin
    .from("profiles")
    .select("employee_id")
    .eq("company_id", companyId)
    .eq("reports_to_user_id", managerUserId)
    .not("employee_id", "is", null);
  if (reports.error || !reports.data?.length) return [];
  const codes = reports.data.map((row) => String(row.employee_id)).filter(Boolean);
  if (!codes.length) return [];
  const employees = await supabaseAdmin
    .from("employees")
    .select("id")
    .eq("company_id", companyId)
    .in("employee_code", codes);
  if (employees.error) return [];
  return (employees.data ?? []).map((row) => String(row.id));
}

async function resolveIntegrityAccess(): Promise<{
  authorization: AuthorizationContext;
  companyId: string;
  canEdit: boolean;
  managedProfileIds: string[] | null;
}> {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  const canViewAll = hasPermission(authorization, "attendance_integrity", "view");
  const canEdit = hasPermission(authorization, "attendance_integrity", "edit");

  if (canViewAll) {
    return {
      authorization,
      companyId,
      canEdit,
      managedProfileIds: null
    };
  }

  const managedProfileIds = await loadManagedEmployeeProfileIds(companyId, authorization.userId);
  if (!managedProfileIds.length) {
    redirect("/unauthorized?page=attendance_integrity&action=view");
  }
  return {
    authorization,
    companyId,
    canEdit: true,
    managedProfileIds
  };
}

export default async function AttendanceIntegrityPage({
  searchParams
}: {
  searchParams?: { tab?: string; flagId?: string };
}) {
  const { companyId, canEdit, managedProfileIds } = await resolveIntegrityAccess();
  const tab = searchParams?.tab === "flags" || searchParams?.flagId ? "flags" : searchParams?.tab === "reviews" ? "reviews" : "flags";
  const highlightFlagId = searchParams?.flagId ?? "";

  let flags: FlagRow[] = [];
  let reviews: ReviewRow[] = [];
  let loadError = "";

  if (!isSupabaseAdminConfigured || !supabaseAdmin) {
    loadError = "Supabase service role key is not configured.";
  } else {
    const [flagsResult, reviewsResult] = await Promise.all([
      supabaseAdmin
        .from("attendance_integrity_flags")
        .select("id, enrolment_id, profile_type, profile_id, punch_date, flag_type, severity, message, status, created_at, details, location_id")
        .eq("company_id", companyId)
        .eq("status", "open")
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("attendance_location_reviews")
        .select("id, flag_id, punch_id, enrolment_id, profile_type, profile_id, punch_date, selfie_path, lat, lng, accuracy_m, remarks, status, review_remarks, created_at, server_received_at")
        .eq("company_id", companyId)
        .in("status", ["pending", "returned"])
        .order("created_at", { ascending: false })
        .limit(100)
    ]);
    if (flagsResult.error || reviewsResult.error) {
      loadError = flagsResult.error?.message || reviewsResult.error?.message || "Unable to load integrity queue.";
      if (/does not exist|schema cache/i.test(loadError)) {
        loadError = "Run scripts/attendance_gps_integrity_v1.sql in Supabase before using this queue.";
      }
    } else {
      flags = (flagsResult.data ?? []) as FlagRow[];
      reviews = (reviewsResult.data ?? []) as ReviewRow[];
      if (managedProfileIds) {
        const allowed = new Set(managedProfileIds);
        flags = flags.filter((row) => row.profile_id && allowed.has(row.profile_id));
        reviews = reviews.filter((row) => allowed.has(row.profile_id));
      }
    }
  }

  return (
    <AppShell active="onboard" pageCode="attendance_integrity">
      <PageHead
        title="Attendance Integrity"
        subtitle={
          managedProfileIds
            ? "People review for your team: see why they were flagged, how far from the station, and open device GPS on the map."
            : "People review queue for GPS / outside-zone flags and support selfie packages. Check device location and distance from site."
        }
      />
      {loadError ? <div className="panel"><p className="subtle">{loadError}</p></div> : null}
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{managedProfileIds ? "My team flags" : "People location flags"}</h2>
            <p className="subtle">
              Outside-zone flags open after the phone stays beyond the station radius (default 50m) for more than 30 minutes during a shift.
            </p>
          </div>
          <div className="button-row">
            <a className={`button ${tab === "flags" ? "" : "secondary"}`} href="/attendance/integrity?tab=flags">
              Open flags ({flags.length})
            </a>
            <a className={`button ${tab === "reviews" ? "" : "secondary"}`} href="/attendance/integrity?tab=reviews">
              Support packages ({reviews.length})
            </a>
          </div>
        </div>

        {tab === "reviews" ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Enrolment</th>
                  <th>Device location</th>
                  <th>Selfie</th>
                  <th>Remarks</th>
                  <th>Status</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {reviews.length ? reviews.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.punch_date}</strong>
                      <div className="subtle">{formatWhen(row.server_received_at)}</div>
                    </td>
                    <td>
                      <strong>{row.enrolment_id}</strong>
                      <div className="subtle">{row.profile_type}</div>
                    </td>
                    <td>
                      {Number(row.lat).toFixed(5)}, {Number(row.lng).toFixed(5)}
                      <div className="subtle">±{row.accuracy_m == null ? "--" : `${Math.round(Number(row.accuracy_m))}m`}</div>
                      <a href={mapsUrl(Number(row.lat), Number(row.lng))} target="_blank" rel="noreferrer">
                        Open map
                      </a>
                    </td>
                    <td><code>{row.selfie_path.split("/").slice(-1)[0]}</code></td>
                    <td>{row.remarks || "--"}</td>
                    <td><StatusPill status={row.status} /></td>
                    <td>
                      {canEdit ? (
                        <form action={reviewAttendanceLocationPackage} className="form-grid" style={{ minWidth: 220 }}>
                          <input type="hidden" name="review_id" value={row.id} />
                          <label>
                            Remarks
                            <textarea name="review_remarks" rows={2} placeholder="Optional notes" />
                          </label>
                          <div className="button-row">
                            <SubmitButton name="decision" value="approved">Approve</SubmitButton>
                            <SubmitButton className="secondary" name="decision" value="rejected">Reject</SubmitButton>
                          </div>
                        </form>
                      ) : (
                        <span className="subtle">View only</span>
                      )}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} className="empty-cell">No pending support packages.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Person</th>
                  <th>Why flagged</th>
                  <th>Device vs station</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {flags.length ? flags.map((row) => (
                  <tr key={row.id} className={highlightFlagId === row.id ? "is-selected" : undefined} id={row.id}>
                    <td>
                      <strong>{row.punch_date}</strong>
                      <div className="subtle">{formatWhen(row.created_at)}</div>
                      <div className="subtle">{row.flag_type.replaceAll("_", " ")}</div>
                    </td>
                    <td>
                      <strong>{row.enrolment_id}</strong>
                      <div className="subtle">{row.profile_type || "--"}</div>
                    </td>
                    <td>
                      <div>{row.message}</div>
                      <div className="subtle"><StatusPill status={row.severity} /></div>
                    </td>
                    <td>
                      <FlagLocationDetails details={row.details} />
                    </td>
                    <td><StatusPill status={row.status} /></td>
                    <td>
                      {canEdit ? (
                        <div className="button-row">
                          <form action={approveAttendanceIntegrityFlag}>
                            <input type="hidden" name="flag_id" value={row.id} />
                            <SubmitButton>Approve</SubmitButton>
                          </form>
                          <form action={dismissAttendanceIntegrityFlag}>
                            <input type="hidden" name="flag_id" value={row.id} />
                            <SubmitButton className="secondary">Dismiss</SubmitButton>
                          </form>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={6} className="empty-cell">No open flags.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
