import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { productDefinitions } from "@/lib/product-ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { assignProductOwner, removeProductOwner } from "@/app/platform-admin/actions";

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

async function loadPlatformAccessOwners() {
  if (!supabaseAdmin) {
    return {
      companies: [] as CompanyRow[],
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
      .order("name"),
    supabaseAdmin
      .from("profiles")
      .select("id, company_id, full_name, email")
      .eq("is_active", true)
      .order("full_name"),
    supabaseAdmin
      .from("company_product_owners")
      .select("id, company_id, product_code, user_id")
      .eq("is_active", true)
      .order("product_code")
  ]);

  if (companyResult.error) {
    return { companies: [] as CompanyRow[], companyUsers: [] as CompanyUserRow[], productOwners: [] as ProductOwnerRow[], setupPending: false, error: companyResult.error.message };
  }
  if (companyUserResult.error) {
    return { companies: (companyResult.data ?? []) as CompanyRow[], companyUsers: [] as CompanyUserRow[], productOwners: [] as ProductOwnerRow[], setupPending: false, error: companyUserResult.error.message };
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
      companies: (companyResult.data ?? []) as CompanyRow[],
      companyUsers: (companyUserResult.data ?? []) as CompanyUserRow[],
      productOwners: [] as ProductOwnerRow[],
      setupPending: false,
      error: productOwnerResult.error.message
    };
  }

  return {
    companies: (companyResult.data ?? []) as CompanyRow[],
    companyUsers: (companyUserResult.data ?? []) as CompanyUserRow[],
    productOwners: (productOwnerResult.data ?? []) as ProductOwnerRow[],
    setupPending,
    error: null
  };
}

export const dynamic = "force-dynamic";

export default async function PlatformAccessOwnersPage() {
  const authorization = await requirePagePermission("company_master", "access");
  if (!authorization.isMasterOwner) {
    redirect("/unauthorized?page=platform_access_owners&reason=super_admin_only");
  }

  const { companies, companyUsers, productOwners, setupPending, error } = await loadPlatformAccessOwners();
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
              <p className="subtle">Select a company, platform, and active user. Assignments are stored centrally and are never hardcoded.</p>
            </div>
          </div>
          {setupPending ? (
            <div className="panel-body message-panel warning">Apply the committed company product-owner migration before assigning owners.</div>
          ) : (
            <>
              <div className="panel-body">
                <form action={assignProductOwner} className="form-grid three">
                  <label>Company
                    <select className="field" name="company_id" required defaultValue="">
                      <option value="" disabled>Select company</option>
                      {companies.filter((company) => company.is_active).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                    </select>
                  </label>
                  <label>Platform
                    <select className="field" name="product_code" required defaultValue="">
                      <option value="" disabled>Select platform</option>
                      {productDefinitions.map((product) => <option key={product.code} value={product.code}>{product.name}</option>)}
                    </select>
                  </label>
                  <label>Access owner
                    <select className="field" name="user_id" required defaultValue="">
                      <option value="" disabled>Select active user</option>
                      {companyUsers.map((user) => {
                        const company = companies.find((item) => item.id === user.company_id);
                        return <option key={user.id} value={user.id}>{user.full_name ?? user.email ?? "Unnamed"} · {company?.name ?? "Unknown company"}</option>;
                      })}
                    </select>
                  </label>
                  <div className="form-actions"><SubmitButton className="button" pendingText="Assigning">Assign Access Owner</SubmitButton></div>
                </form>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Platform</th><th>Access owner</th><th>Company</th><th>Action</th></tr></thead>
                  <tbody>
                    {productOwners.length ? productOwners.map((assignment) => {
                      const product = productDefinitions.find((item) => item.code === assignment.product_code);
                      const user = companyUsers.find((item) => item.id === assignment.user_id);
                      const company = companies.find((item) => item.id === assignment.company_id);
                      return <tr key={assignment.id}>
                        <td><strong>{product?.name ?? assignment.product_code}</strong></td>
                        <td>{user?.full_name ?? user?.email ?? "Unknown user"}<div className="subtle">{user?.email ?? ""}</div></td>
                        <td>{company?.name ?? "Unknown company"}</td>
                        <td><form action={removeProductOwner}><input type="hidden" name="id" value={assignment.id} /><SubmitButton className="button secondary compact" pendingText="Removing">Remove</SubmitButton></form></td>
                      </tr>;
                    }) : <tr><td className="empty-cell" colSpan={4}>No access owners assigned yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      ) : null}
    </AppShell>
  );
}
