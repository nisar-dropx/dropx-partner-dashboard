import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { productDefinitions } from "@/lib/product-ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assignProductOwner, purgeVerifiedLegacyWorkforceAliases, removeProductOwner } from "@/app/platform-admin/actions";

type CompanyRow = {
  id: string;
  name: string;
  is_active: boolean;
};

type CompanyUserRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email: string | null;
};

type ProductOwnerRow = {
  id: string;
  company_id: string;
  product_code: string;
  user_id: string;
};

type LegacyWorkforceCleanupPreview = {
  active_canonical_rows: number;
  canonical_rows: number;
  contractor_rows: number;
  field_executive_rows: number;
  legacy_workforce_rows: number;
  unmatched_rows: number;
};

function loadFlash() {
  const raw = cookies().get("dropx_platform_access_owners_flash")?.value;
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

async function loadPlatformAccessOwners(companyId: string) {
  if (!supabaseAdmin) {
    return {
      company: null as CompanyRow | null,
      companyUsers: [] as CompanyUserRow[],
      productOwners: [] as ProductOwnerRow[],
      setupPending: false,
      error: "Supabase service role key is not configured."
    };
  }

  const [companyResult, companyUserResult, productOwnerResult] = await Promise.all([
    supabaseAdmin
      .from("companies")
      .select("id, name, is_active")
      .eq("id", companyId)
      .maybeSingle(),
    supabaseAdmin
      .from("profiles")
      .select("id, company_id, full_name, email")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("full_name"),
    supabaseAdmin
      .from("company_product_owners")
      .select("id, company_id, product_code, user_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("product_code")
  ]);

  if (companyResult.error) {
    return { company: null as CompanyRow | null, companyUsers: [] as CompanyUserRow[], productOwners: [] as ProductOwnerRow[], setupPending: false, error: companyResult.error.message };
  }
  if (companyUserResult.error) {
    return { company: companyResult.data as CompanyRow | null, companyUsers: [] as CompanyUserRow[], productOwners: [] as ProductOwnerRow[], setupPending: false, error: companyUserResult.error.message };
  }

  const productOwnerMessage = String(productOwnerResult.error?.message ?? "").toLowerCase();
  const setupPending = Boolean(productOwnerResult.error && (
    productOwnerResult.error.code === "42P01" ||
    productOwnerResult.error.code === "PGRST205" ||
    productOwnerMessage.includes("does not exist") ||
    productOwnerMessage.includes("schema cache")
  ));
  if (productOwnerResult.error && !setupPending) {
    return {
      company: companyResult.data as CompanyRow | null,
      companyUsers: (companyUserResult.data ?? []) as CompanyUserRow[],
      productOwners: [] as ProductOwnerRow[],
      setupPending: false,
      error: productOwnerResult.error.message
    };
  }

  return {
    company: companyResult.data as CompanyRow | null,
    companyUsers: (companyUserResult.data ?? []) as CompanyUserRow[],
    productOwners: (productOwnerResult.data ?? []) as ProductOwnerRow[],
    setupPending,
    error: null
  };
}

async function loadLegacyWorkforceCleanupPreview() {
  if (!supabaseAdmin) return { data: null as LegacyWorkforceCleanupPreview | null, pending: false, error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin.rpc("preview_legacy_workforce_alias_cleanup");
  if (result.error) {
    const message = result.error.message.toLowerCase();
    const pending = message.includes("preview_legacy_workforce_alias_cleanup") && (
      message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find")
    );
    return { data: null as LegacyWorkforceCleanupPreview | null, pending, error: pending ? null : result.error.message };
  }
  const raw = (result.data ?? {}) as Partial<Record<keyof LegacyWorkforceCleanupPreview, unknown>>;
  return {
    data: {
      active_canonical_rows: Number(raw.active_canonical_rows ?? 0),
      canonical_rows: Number(raw.canonical_rows ?? 0),
      contractor_rows: Number(raw.contractor_rows ?? 0),
      field_executive_rows: Number(raw.field_executive_rows ?? 0),
      legacy_workforce_rows: Number(raw.legacy_workforce_rows ?? 0),
      unmatched_rows: Number(raw.unmatched_rows ?? 0)
    },
    pending: false,
    error: null as string | null
  };
}

export const dynamic = "force-dynamic";

export default async function PlatformAccessOwnersPage() {
  const authorization = await requirePagePermission("company_master", "access");
  if (!authorization.isMasterOwner) {
    redirect("/unauthorized?page=platform_access_owners&reason=super_admin_only");
  }
  const companyId = requireCompanyId(authorization);

  const [{ company, companyUsers, productOwners, setupPending, error }, cleanupPreview] = await Promise.all([
    loadPlatformAccessOwners(companyId),
    loadLegacyWorkforceCleanupPreview()
  ]);
  const flash = loadFlash();

  return (
    <AppShell active="Platform & Access Owners" pageCode="company_master">
      <PageHead
        eyebrow="Super Admin Master"
        title="Platform & Access Owners"
        subtitle="Assign the accountable owner for each platform. The owner receives administration rights only inside that platform; this master remains Super Admin-only."
      />

      {error ? (
        <section className="panel message-panel error">
          <div className="panel-body"><strong>Unable to load access owners</strong><p className="subtle" style={{ marginTop: 6 }}>{error}</p></div>
        </section>
      ) : null}

      {!error && (flash.error || flash.notice) ? (
        <section className={`panel message-panel ${flash.error ? "error" : "success"}`}>
          <div className="panel-body"><strong>{flash.error ? "Action required" : "Completed"}</strong><p className="subtle" style={{ marginTop: 6 }}>{flash.error ?? flash.notice}</p></div>
        </section>
      ) : null}

      {!error ? (
        <section className="panel">
          <div className="panel-head toolbar">
            <div>
              <h2>Access owner assignments</h2>
              <p className="subtle">Assign a platform and an active company user. The current company comes from authenticated access and is never hardcoded.</p>
            </div>
          </div>
          {setupPending ? (
            <div className="panel-body message-panel warning">Apply the committed company product-owner migration before assigning owners.</div>
          ) : (
            <>
              <div className="panel-body">
                <div className="subtle" style={{ marginBottom: 16 }}>Company: <strong>{company?.name ?? "Company unavailable"}</strong></div>
                <form action={assignProductOwner} className="form-grid two">
                  <label>Platform
                    <select className="field" name="product_code" required defaultValue="">
                      <option value="" disabled>Select platform</option>
                      {productDefinitions.map((product) => <option key={product.code} value={product.code}>{product.name}</option>)}
                    </select>
                  </label>
                  <label>Access owner
                    <select className="field" name="user_id" required defaultValue="">
                      <option value="" disabled>Select active user</option>
                      {companyUsers.map((user) => <option key={user.id} value={user.id}>{user.full_name ?? user.email ?? "Unnamed"}{user.email ? ` · ${user.email}` : ""}</option>)}
                    </select>
                  </label>
                  <div className="form-actions"><SubmitButton className="button" pendingText="Assigning">Assign Access Owner</SubmitButton></div>
                </form>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Platform</th><th>Access owner</th><th>Action</th></tr></thead>
                  <tbody>
                    {productOwners.length ? productOwners.map((assignment) => {
                      const product = productDefinitions.find((item) => item.code === assignment.product_code);
                      const user = companyUsers.find((item) => item.id === assignment.user_id);
                      return <tr key={assignment.id}>
                        <td><strong>{product?.name ?? assignment.product_code}</strong></td>
                        <td>{user?.full_name ?? user?.email ?? "Unknown user"}<div className="subtle">{user?.email ?? ""}</div></td>
                        <td><form action={removeProductOwner}><input type="hidden" name="id" value={assignment.id} /><SubmitButton className="button secondary compact" pendingText="Removing">Remove</SubmitButton></form></td>
                      </tr>;
                    }) : <tr><td className="empty-cell" colSpan={3}>No access owners assigned yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head toolbar">
          <div>
            <h2>Workforce cutover cleanup</h2>
            <p className="subtle">Super Admin-only reconciliation of canonical Workforce rows and obsolete contractor/field-executive aliases.</p>
          </div>
        </div>
        {cleanupPreview.pending ? (
          <div className="panel-body message-panel warning">The committed Workforce cleanup migration is still deploying. Refresh after the migration completes.</div>
        ) : cleanupPreview.error ? (
          <div className="panel-body message-panel error">Unable to verify Workforce aliases: {cleanupPreview.error}</div>
        ) : cleanupPreview.data ? (
          <div className="panel-body">
            <div className="summary-grid" style={{ marginBottom: 18 }}>
              <div className="metric-card"><strong>{cleanupPreview.data.legacy_workforce_rows}</strong><span>Legacy aliases</span></div>
              <div className="metric-card"><strong>{cleanupPreview.data.canonical_rows}</strong><span>Canonical matches</span></div>
              <div className="metric-card"><strong>{cleanupPreview.data.unmatched_rows}</strong><span>Unmatched</span></div>
            </div>
            {cleanupPreview.data.unmatched_rows > 0 ? (
              <div className="message-panel error">Deletion is blocked because {cleanupPreview.data.unmatched_rows} legacy row(s) do not have an exact canonical Workforce identity.</div>
            ) : cleanupPreview.data.legacy_workforce_rows > 0 ? (
              <form action={purgeVerifiedLegacyWorkforceAliases}>
                <SubmitButton
                  className="button danger"
                  confirmDescription={`This will delete ${cleanupPreview.data.contractor_rows} contractor and ${cleanupPreview.data.field_executive_rows} field-executive aliases only after all registration and workflow checks pass.`}
                  confirmMessage={`Delete ${cleanupPreview.data.legacy_workforce_rows} verified legacy Workforce aliases?`}
                  confirmSubmitText="Delete verified aliases"
                  pendingText="Verifying and deleting"
                >
                  Delete verified legacy aliases
                </SubmitButton>
              </form>
            ) : (
              <div className="message-panel success">No duplicate legacy Workforce aliases remain. Canonical Workforce registrations are preserved.</div>
            )}
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
