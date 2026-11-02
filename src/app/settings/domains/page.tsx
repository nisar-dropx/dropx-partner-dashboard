
import { ReportTable } from "@/components/report-table";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { formatDashboardDateTime } from "@/lib/date-format";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { addAllowedDomain, setAllowedDomainStatus } from "../domains-actions";

export const dynamic = "force-dynamic";

type AllowedDomain = {
  id: string;
  domain: string;
  is_active: boolean;
  updated_at: string | null;
};

function loadFlash() {
  const raw = cookies().get("dropx_domains_settings_flash")?.value;
  if (!raw) return { error: null as string | null, notice: null as string | null };
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; notice?: unknown };
    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      notice: typeof parsed.notice === "string" ? parsed.notice : null
    };
  } catch {
    return { error: null, notice: null };
  }
}

async function loadDomains(companyId: string) {
  if (!supabaseAdmin) return { domains: [] as AllowedDomain[], error: "Supabase service role key is not configured." };
  const { data, error } = await supabaseAdmin
    .from("company_allowed_domains")
    .select("id, domain, is_active, updated_at")
    .eq("company_id", companyId)
    .order("is_active", { ascending: false })
    .order("domain", { ascending: true });

  return {
    domains: (data ?? []) as AllowedDomain[],
    error: error?.message ?? null
  };
}

export default async function DomainsSettingsPage() {
  const authorization = await requirePagePermission("app_settings", "access");
  const companyId = requireCompanyId(authorization);
  const permission = authorization.permissions.app_settings;
  const canAdd = permission.canAdd || permission.canEdit;
  const canEdit = permission.canEdit;
  const flash = loadFlash();
  const { domains, error } = await loadDomains(companyId);
  const activeCount = domains.filter((domain) => domain.is_active).length;

  return (
    <AppShell active="Settings" pageCode="app_settings">
      <PageHead
        eyebrow="Configuration"
        title="Login domains"
        subtitle="Optionally restrict dashboard login to approved email domains for this company."
        action={<a className="button secondary" href="/settings">Back</a>}
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body">
            <strong>Domain setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run <code>scripts/company_allowed_domains_v1.sql</code> in Supabase SQL Editor.
            </p>
          </div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flash.error ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p>
          </div>
        </section>
      ) : null}

      {!error ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Allowed domains</h2>
                <p className="subtle">
                  {activeCount
                    ? `${activeCount} active domain${activeCount === 1 ? "" : "s"} allowed for login.`
                    : "No domain restriction is active. Any active user from this company can login."}
                </p>
              </div>
            </div>
            {canAdd ? (
              <form action={addAllowedDomain} className="panel-body">
                <div className="form-grid two">
                  <label>Email domain
                    <input className="field" name="domain" placeholder="dropxlogistics.com" required />
                  </label>
                  <div className="form-actions" style={{ alignSelf: "end" }}>
                    <SubmitButton pendingText="Saving">Add domain</SubmitButton>
                  </div>
                </div>
              </form>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Domain list</h2>
                <p className="subtle">Disable a domain to stop allowing new logins from that email domain.</p>
              </div>
            </div>
            <div className="table-wrap">
              <ReportTable className="data-table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {domains.length ? domains.map((domain) => (
                    <tr key={domain.id}>
                      <td><strong>{domain.domain}</strong></td>
                      <td>
                        <span className={`status-pill ${domain.is_active ? "good" : "warn"}`}>
                          {domain.is_active ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td>{formatDashboardDateTime(domain.updated_at)}</td>
                      <td>
                        {canEdit ? (
                          <form action={setAllowedDomainStatus}>
                            <input name="id" type="hidden" value={domain.id} />
                            <input name="is_active" type="hidden" value={domain.is_active ? "false" : "true"} />
                            <SubmitButton className="button secondary" pendingText="Updating">
                              {domain.is_active ? "Disable" : "Enable"}
                            </SubmitButton>
                          </form>
                        ) : "-"}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td className="empty-cell" colSpan={4}>No domains added yet.</td>
                    </tr>
                  )}
                </tbody>
              </ReportTable>
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
