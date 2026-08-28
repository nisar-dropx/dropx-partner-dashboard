import { AppShell } from "@/components/app-shell";
import { AppNotificationComposer, type AppNotificationRecipient } from "@/components/app-notification-composer";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { workforceProfileTypes, workforceTable, type WorkforceProfileType } from "@/lib/workforce-profiles";
import { sendAppNotification } from "./actions";

export const dynamic = "force-dynamic";

type Recipient = {
  id: string;
  profileType: WorkforceProfileType;
  name: string;
  reference: string;
  biometricId: string;
  category: string;
  location: string;
  designation: string;
  mobile: string;
  countryCode: string;
  email: string;
  provider: string;
  model: string;
  status: string;
};

const profileLabels: Record<WorkforceProfileType, string> = {
  employee: "Employee",
  workforce: "Workforce",
  field_executive: "Field executive",
  contractor: "Independent contractor",
  vendor: "Vendor",
  worker: "Worker"
};

async function loadRecipients(companyId: string) {
  if (!supabaseAdmin) return [] as Recipient[];
  const results = await Promise.all(workforceProfileTypes.map(async (profileType) => {
    const referenceColumn = profileType === "employee" ? "employee_code" : "dropx_id";
    const profileColumns = profileType === "employee"
      ? `id, full_name, biometric_id, designation_id, mobile, mobile_country_code, email, profile_completion_status, ${referenceColumn}, stations (station_code, providers (name), location_models (code, name))`
      : `id, full_name, biometric_id, designation, mobile, mobile_country_code, email, onboarding_status, ${referenceColumn}, stations (station_code, providers (name), location_models (code, name))`;
    const result = await supabaseAdmin!
      .from(workforceTable(profileType))
      .select(profileColumns)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("full_name")
      .limit(5000);
    if (result.error) {
      console.error(`[app-notifications] Unable to load ${profileType} recipients:`, result.error.message);
      return [] as Recipient[];
    }
    const rows = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    const employeeDesignationIds = profileType === "employee"
      ? Array.from(new Set(rows.map((row) => row.designation_id).filter(Boolean)))
      : [];
    const designationResult = employeeDesignationIds.length
      ? await supabaseAdmin!.from("designations").select("id, name").in("id", employeeDesignationIds)
      : { data: [], error: null };
    const designationById = new Map((designationResult.data ?? []).map((row) => [String(row.id), String(row.name ?? "")]));
    return rows.map((record) => {
      const station = Array.isArray(record.stations) ? record.stations[0] : record.stations;
      const stationRecord = station as { station_code?: string; providers?: unknown; location_models?: unknown } | null;
      const providerRelation = Array.isArray(stationRecord?.providers) ? stationRecord?.providers[0] : stationRecord?.providers;
      const modelRelation = Array.isArray(stationRecord?.location_models) ? stationRecord?.location_models[0] : stationRecord?.location_models;
      return ({
      id: String(record.id),
      profileType,
      name: String(record.full_name ?? "Unnamed"),
      reference: String(record[referenceColumn] ?? ""),
      biometricId: String(record.biometric_id ?? ""),
      category: profileLabels[profileType],
      location: String(stationRecord?.station_code ?? ""),
      designation: profileType === "employee"
        ? designationById.get(String(record.designation_id ?? "")) ?? ""
        : String(record.designation ?? ""),
      mobile: String(record.mobile ?? ""),
      countryCode: String(record.mobile_country_code ?? "91"),
      email: String(record.email ?? ""),
      provider: String((providerRelation as { name?: string } | null)?.name ?? ""),
      model: String((modelRelation as { code?: string; name?: string } | null)?.code ?? (modelRelation as { name?: string } | null)?.name ?? ""),
      status: String(record.profile_completion_status ?? record.onboarding_status ?? "Active")
    });
    });
  }));
  return results.flat();
}

async function loadHistory(companyId: string) {
  if (!supabaseAdmin) return [];
  const result = await supabaseAdmin
    .from("mob_app_notifications")
    .select("id, event_code, recipient_profile_type, recipient_account_id, title, body, created_at, read_at, push_status")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(100);
  return result.error ? [] : result.data ?? [];
}

export default async function AppNotificationsPage({
  searchParams
}: {
  searchParams?: { sent?: string; error?: string };
}) {
  const authorization = await requirePagePermission("notifications_app", "access");
  const companyId = requireCompanyId(authorization);
  const recipients = await loadRecipients(companyId);
  const history = await loadHistory(companyId);
  const recipientByKey = new Map(recipients.map((row) => [`${row.profileType}:${row.id}`, row]));

  return (
    <AppShell active="App Notifications" pageCode="notifications_app">
      <main className="app-notifications-page">
        <header>
          <p>NOTIFICATIONS</p>
          <h1>App notifications</h1>
          <span>Send personalized Android and web notifications to one or many DropX One accounts.</span>
        </header>
        {searchParams?.sent ? <div className="success-banner">{searchParams.sent} {searchParams.sent === "1" ? "notification" : "notifications"} sent.</div> : null}
        {searchParams?.error ? <div className="error-banner">{searchParams.error}</div> : null}
        <section className="app-notification-composer">
          <div>
            <h2>New notification</h2>
            <p>The notification appears in both the Android and web inbox.</p>
          </div>
          <AppNotificationComposer action={sendAppNotification} recipients={recipients as AppNotificationRecipient[]} />
        </section>
        <section className="app-notification-history">
          <div>
            <h2>Notification history</h2>
            <span>{history.length} latest records</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Sent</th><th>Recipient</th><th>Message</th><th>Inbox</th><th>Push</th></tr></thead>
              <tbody>
                {history.map((row) => {
                  const recipient = recipientByKey.get(`${row.recipient_profile_type}:${row.recipient_account_id}`);
                  return <tr key={row.id}>
                    <td>{formatDashboardDateTime(row.created_at)}</td>
                    <td><strong>{recipient?.name ?? "Account"}</strong><small>{recipient?.reference} · {profileLabels[row.recipient_profile_type as WorkforceProfileType] ?? row.recipient_profile_type}</small></td>
                    <td>
                      <strong>{row.title}</strong>
                      <small>{row.body}</small>
                      <small>{row.event_code === "attendance_punch_in" ? "Punch In" : row.event_code === "attendance_punch_out" ? "Punch Out" : "Manual"}</small>
                    </td>
                    <td><span className={row.read_at ? "status-pill read" : "status-pill unread"}>{row.read_at ? "Read" : "Unread"}</span></td>
                    <td><span className="status-pill neutral">{row.push_status === "not_configured" ? "Inbox only" : row.push_status}</span></td>
                  </tr>;
                })}
                {!history.length ? <tr><td colSpan={5}>No app notifications have been sent.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </AppShell>
  );
}
