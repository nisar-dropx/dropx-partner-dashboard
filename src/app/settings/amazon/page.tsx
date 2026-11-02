
import { ReportTable } from "@/components/report-table";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { isCompanyOwner, requirePagePermission } from "@/lib/authorization";
import { amazonTaskDefinitions, isAmazonConnectorSetupError, loadAmazonConnectors } from "@/lib/amazon-connectors";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { isSupabaseAdminConfigured } from "@/lib/supabase-admin";
import { saveAmazonConnector, warmupAmazonPortalSession } from "./actions";

export const dynamic = "force-dynamic";

function parseFlash() {
  const raw = cookies().get("dropx_amazon_connector_flash")?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { error?: string; notice?: string };
  } catch {
    return null;
  }
}

function formatDateTime(value: string | null | undefined) {
  return formatDashboardDateTime(value);
}

function effectiveTaskStatus({
  connectorReady,
  taskEnabled,
  sourceUrl,
  savedStatus
}: {
  connectorReady: boolean;
  taskEnabled: boolean;
  sourceUrl: string | null | undefined;
  savedStatus: string | null | undefined;
}) {
  if (!taskEnabled) return "Paused";
  if (!connectorReady || !sourceUrl) return "Not configured";
  if (!savedStatus || savedStatus === "Not configured") return "Ready";
  return savedStatus;
}

export default async function AmazonConnectorPage() {
  const authorization = await requirePagePermission("amazon_connector", "access");
  if (!isCompanyOwner(authorization)) redirect("/unauthorized?page=amazon_connector&action=owner");

  const companyId = requireCompanyId(authorization);
  const flash = parseFlash();
  const loaded = await loadAmazonConnectors(companyId);
  const setupNeeded = loaded.error && isAmazonConnectorSetupError({ message: loaded.error });
  const enabledCount = loaded.connectors.filter((entry) => entry.connector?.is_enabled).length;
  const syncCount = loaded.connectors.reduce((count, entry) => count + entry.tasks.filter((task) => task.is_enabled).length, 0);

  return (
    <AppShell active="Settings" pageCode="amazon_connector">
      <PageHead
        eyebrow="Owner Configuration"
        title="Amazon Connector"
        subtitle="Securely store the YMS, LSC, and SCC portal access needed for report pulls and future automation checks."
        action={
          <div className="page-actions">
            <span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>
            <PendingLink className="button secondary compact" href="/settings">Back</PendingLink>
          </div>
        }
      />

      {flash?.error ? <div className="alert danger"><strong>Unable to save</strong><span>{flash.error}</span></div> : null}
      {flash?.notice ? <div className="alert success"><strong>Saved</strong><span>{flash.notice}</span></div> : null}
      {setupNeeded ? (
        <div className="alert danger">
          <strong>Database setup needed</strong>
          <span>Run <code>scripts/amazon_connectors_v1.sql</code> in Supabase SQL Editor, then refresh this page.</span>
        </div>
      ) : loaded.error ? (
        <div className="alert danger"><strong>Connector unavailable</strong><span>{loaded.error}</span></div>
      ) : null}

      <section className="summary-grid">
        <div className="metric-card"><span>Portals</span><strong>{loaded.connectors.length}</strong><small>YMS, LSC, SCC</small></div>
        <div className="metric-card"><span>Enabled</span><strong>{enabledCount}</strong><small>Credential checks allowed</small></div>
        <div className="metric-card"><span>Automation Tasks</span><strong>{syncCount}</strong><small>Ready for worker scheduling</small></div>
        <div className="metric-card"><span>Access</span><strong>Owner</strong><small>Credentials are owner-only</small></div>
      </section>

      <div className="whatsapp-settings-stack">
        {loaded.connectors.map(({ definition, connector, tasks }) => {
          const connectorReady = Boolean(connector?.is_enabled && connector.status === "Ready");
          const taskRows = tasks.length ? tasks : amazonTaskDefinitions[definition.code].map((task) => ({
            connector_id: "",
            id: task.code,
            is_enabled: false,
            last_message: null,
            last_run_at: null,
            last_status: "Not configured",
            next_run_at: null,
            source_url: task.sourceUrl,
            sync_interval_minutes: task.interval,
            task_code: task.code,
            task_name: task.name
          }));

          return (
            <section className="panel" key={definition.code}>
              <div className="panel-head">
                <div>
                  <h2>{definition.name}</h2>
                  <p className="subtle">{definition.description}</p>
                </div>
                <StatusPill status={connector?.status ?? "Not configured"} />
              </div>
              <form action={saveAmazonConnector}>
                <input name="portal_code" type="hidden" value={definition.code} />
                <input name="portal_name" type="hidden" value={definition.name} />
                <div className="form-grid three">
                  <label>Connector
                    <span className="checkbox-row">
                      <input defaultChecked={Boolean(connector?.is_enabled)} name="is_enabled" type="checkbox" />
                      Enable this portal
                    </span>
                  </label>
                  <label>Automation
                    <span className="checkbox-row">
                      <input defaultChecked={Boolean(connector?.sync_enabled)} name="sync_enabled" type="checkbox" />
                      Allow scheduled checks
                    </span>
                  </label>
                  <label>Auth Mode
                    <select className="select" defaultValue={connector?.auth_mode ?? "credential_login"} name="auth_mode">
                      <option value="credential_login">Credential login</option>
                      <option value="manual_session">Manual session</option>
                      <option value="api_token">API token</option>
                    </select>
                  </label>
                  <label>Username
                    <input className="field" defaultValue={connector?.username ?? ""} name="username" placeholder="Portal username or email" />
                  </label>
                  <label>Password
                    <input className="field" name="password" placeholder={connector?.password_secret_id ? "Saved. Leave blank to keep." : "Portal password"} type="password" />
                  </label>
                  <label>MFA authenticator setup key
                    <input className="field" name="mfa_secret" placeholder={connector?.mfa_secret_id ? "Saved. Leave blank to keep." : "Optional TOTP setup key"} type="password" />
                    <span className="muted">
                      Save the authenticator setup key or otpauth URL, not the current 6-digit code. Amazon push/captcha challenges still need manual approval.
                    </span>
                  </label>
                  <label>Base URL
                    <input className="field" defaultValue={connector?.base_url ?? definition.baseUrl} name="base_url" required />
                  </label>
                  <label>Start URL
                    <input className="field" defaultValue={connector?.login_url ?? definition.loginUrl} name="login_url" required />
                  </label>
                  <label>Check Every
                    <input className="field" defaultValue={connector?.sync_interval_minutes ?? 30} min={5} max={1440} name="sync_interval_minutes" type="number" />
                  </label>
                  <label>Timezone
                    <input className="field" defaultValue={connector?.timezone ?? "Asia/Kolkata"} name="timezone" />
                  </label>
                  <label className="span-2">Notes
                    <input className="field" defaultValue={connector?.notes ?? ""} name="notes" placeholder="Internal note for this credential or portal" />
                  </label>
                </div>
                <div className="field-hint" style={{ marginTop: 12 }}>
                  <strong>{definition.shortName} worker login:</strong> Login worker once saves this portal&apos;s backend browser session. Your Chrome login is not reused. Approve MFA, captcha, or manual checks in that worker if Amazon asks. This does not touch biometric attendance or the bio.dropxlogistics.com middleware.
                </div>

                <div className="panel-body">
                  <h3>Automation coverage</h3>
                  <p className="subtle">Enabled tasks use these source URLs when Ops Pulse portal checks run through the browser worker.</p>
                  <div className="table-wrap">
                    <ReportTable>
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Enabled</th>
                          <th>Source URL</th>
                          <th>Interval</th>
                          <th>Last Run</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {taskRows.map((task) => {
                          const displayStatus = effectiveTaskStatus({
                            connectorReady,
                            savedStatus: task.last_status,
                            sourceUrl: task.source_url,
                            taskEnabled: task.is_enabled
                          });

                          return (
                            <tr key={task.task_code}>
                              <td><strong>{task.task_name}</strong></td>
                              <td>
                                <input defaultChecked={task.is_enabled} name="enabled_tasks" type="checkbox" value={task.task_code} />
                              </td>
                              <td>
                                <input className="field" defaultValue={task.source_url} name={`task_url_${task.task_code}`} />
                              </td>
                              <td>
                                <input className="field" defaultValue={task.sync_interval_minutes} min={5} max={1440} name={`task_interval_${task.task_code}`} type="number" />
                              </td>
                              <td>{formatDateTime(task.last_run_at)}</td>
                              <td><StatusPill status={displayStatus} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </ReportTable>
                  </div>
                  {connector?.last_error_message ? <p className="field-hint">Last error: {connector.last_error_message}</p> : null}
                </div>
                <div className="form-actions">
                  <SubmitButton pendingText="Saving">Save {definition.shortName}</SubmitButton>
                  <button className="button secondary" formAction={warmupAmazonPortalSession} type="submit">
                    Login worker once
                  </button>
                </div>
              </form>
            </section>
          );
        })}
      </div>
    </AppShell>
  );
}
