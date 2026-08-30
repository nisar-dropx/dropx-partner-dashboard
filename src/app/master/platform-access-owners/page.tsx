import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { productDefinitions } from "@/lib/product-ownership";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  assignProductOwner,
  purgeVerifiedLegacyWorkforceAliases,
  reconcileLegacyWorkforceAliases,
  removeProductOwner
} from "@/app/platform-admin/actions";

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
  unmatched_breakdown: Array<{
    count: number;
    designation: string;
    designation_active: boolean;
    profile_destination: string;
    reason: string;
    source: string;
  }>;
  unmatched_missing_canonical: number;
  unmatched_non_workforce_target: number;
  unmatched_without_link: number;
  unmatched_rows: number;
};

type LegacyWorkforceReferencePreview = {
  breakdown: Array<{
    columns: string;
    kind: string;
    profile_type: string;
    rows: number;
    table: string;
  }>;
  candidate_rows: number;
  direct_foreign_keys: number;
  polymorphic_references: number;
};

type LegacyWorkforceSourceRow = {
  company_id: string;
  designation: string | null;
  id: string;
};

type LegacyWorkforceDesignationRow = {
  code: string;
  company_id: string;
  is_active: boolean;
  name: string;
  profile_destination: string | null;
  designation_category: { people_module?: string | null } | Array<{ people_module?: string | null }> | null;
};

type WorkforceIdentityLinkRow = {
  company_id: string;
  legacy_profile_id: string;
  legacy_profile_type: string;
  target_profile_id: string;
  target_profile_type: string;
};

type CanonicalWorkforceRow = {
  company_id: string;
  id: string;
  source_profile_id: string | null;
  source_profile_type: string;
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

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function identityKey(profileType: string, profileId: string) {
  return `${profileType}:${profileId}`;
}

async function loadLegacyWorkforceCleanupPreview(companyId: string) {
  if (!supabaseAdmin) return { data: null as LegacyWorkforceCleanupPreview | null, pending: false, error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin.rpc("preview_legacy_workforce_alias_cleanup");
  if (result.error) {
    const message = result.error.message.toLowerCase();
    const pending = message.includes("preview_legacy_workforce_alias_cleanup") && (
      message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find")
    );
    return { data: null as LegacyWorkforceCleanupPreview | null, pending, error: pending ? null : result.error.message };
  }
  const [contractorResult, executiveResult, designationResult, identityLinkResult, workforceResult] = await Promise.all([
    supabaseAdmin.from("contractors").select("id, company_id, designation").eq("company_id", companyId).limit(5000),
    supabaseAdmin.from("field_executives").select("id, company_id, designation").eq("company_id", companyId).limit(5000),
    supabaseAdmin
      .from("designations")
      .select("code, company_id, is_active, name, profile_destination, designation_category:designation_categories!designations_designation_category_id_fkey(people_module)")
      .eq("company_id", companyId)
      .limit(5000),
    supabaseAdmin
      .from("workforce_identity_links")
      .select("company_id, legacy_profile_id, legacy_profile_type, target_profile_id, target_profile_type")
      .eq("company_id", companyId)
      .in("legacy_profile_type", ["contractor", "field_executive"])
      .limit(5000),
    supabaseAdmin
      .from("workforce")
      .select("company_id, id, source_profile_id, source_profile_type")
      .eq("company_id", companyId)
      .limit(5000)
  ]);

  const diagnosticError = contractorResult.error ?? executiveResult.error ?? designationResult.error ?? identityLinkResult.error ?? workforceResult.error;
  if (diagnosticError) {
    return { data: null as LegacyWorkforceCleanupPreview | null, pending: false, error: `Cleanup diagnostic failed: ${diagnosticError.message}` };
  }

  const designations = (designationResult.data ?? []) as LegacyWorkforceDesignationRow[];
  const deliveryNetworkDesignations = designations.filter((designation) =>
    firstRelation(designation.designation_category)?.people_module === "delivery_network"
  );
  const links = new Map(
    ((identityLinkResult.data ?? []) as WorkforceIdentityLinkRow[]).map((link) => [
      identityKey(link.legacy_profile_type, link.legacy_profile_id),
      link
    ])
  );
  const canonicalRows = new Map(
    ((workforceResult.data ?? []) as CanonicalWorkforceRow[]).map((workforce) => [workforce.id, workforce])
  );
  const candidates = [
    ...((contractorResult.data ?? []) as LegacyWorkforceSourceRow[]).map((row) => ({ ...row, source: "contractor" })),
    ...((executiveResult.data ?? []) as LegacyWorkforceSourceRow[]).map((row) => ({ ...row, source: "field_executive" }))
  ].flatMap((source) => {
    const designationValue = String(source.designation ?? "").trim();
    const designation = deliveryNetworkDesignations.find((item) =>
      item.code.trim().toLowerCase() === designationValue.toLowerCase() ||
      item.name.trim().toLowerCase() === designationValue.toLowerCase()
    );
    return designation ? [{ source, designation }] : [];
  });

  const unmatched = candidates.flatMap(({ source, designation }) => {
    const link = links.get(identityKey(source.source, source.id));
    if (!link) return [{ source, designation, reason: "No identity link" }];
    if (link.target_profile_type !== "workforce") {
      return [{ source, designation, reason: `Linked to ${link.target_profile_type}` }];
    }
    const canonical = canonicalRows.get(link.target_profile_id);
    if (!canonical || canonical.company_id !== source.company_id || canonical.source_profile_type !== source.source || canonical.source_profile_id !== source.id) {
      return [{ source, designation, reason: "Canonical Workforce row missing" }];
    }
    return [];
  });
  const grouped = new Map<string, LegacyWorkforceCleanupPreview["unmatched_breakdown"][number]>();
  for (const item of unmatched) {
    const designationValue = String(item.source.designation ?? "Unassigned");
    const destination = String(item.designation.profile_destination ?? "not_set");
    const key = [item.source.source, designationValue, destination, item.designation.is_active, item.reason].join("|");
    const existing = grouped.get(key);
    grouped.set(key, {
      count: (existing?.count ?? 0) + 1,
      designation: designationValue,
      designation_active: item.designation.is_active,
      profile_destination: destination,
      reason: item.reason,
      source: item.source.source
    });
  }

  const raw = (result.data ?? {}) as Partial<Record<keyof LegacyWorkforceCleanupPreview, unknown>>;
  return {
    data: {
      active_canonical_rows: Number(raw.active_canonical_rows ?? 0),
      canonical_rows: Number(raw.canonical_rows ?? 0),
      contractor_rows: Number(raw.contractor_rows ?? 0),
      field_executive_rows: Number(raw.field_executive_rows ?? 0),
      legacy_workforce_rows: Number(raw.legacy_workforce_rows ?? 0),
      unmatched_breakdown: Array.from(grouped.values()).sort((left, right) => right.count - left.count),
      unmatched_missing_canonical: unmatched.filter((item) => item.reason === "Canonical Workforce row missing").length,
      unmatched_non_workforce_target: unmatched.filter((item) => item.reason.startsWith("Linked to ")).length,
      unmatched_without_link: unmatched.filter((item) => item.reason === "No identity link").length,
      unmatched_rows: Number(raw.unmatched_rows ?? 0)
    },
    pending: false,
    error: null as string | null
  };
}

async function loadLegacyWorkforceReferencePreview() {
  if (!supabaseAdmin) return { data: null as LegacyWorkforceReferencePreview | null, pending: false, error: "Supabase service role key is not configured." };
  const result = await supabaseAdmin.rpc("preview_legacy_workforce_reference_blockers");
  if (result.error) {
    const message = result.error.message.toLowerCase();
    const pending = message.includes("preview_legacy_workforce_reference_blockers") && (
      message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find")
    );
    return { data: null as LegacyWorkforceReferencePreview | null, pending, error: pending ? null : result.error.message };
  }
  const raw = (result.data ?? {}) as Partial<Record<keyof LegacyWorkforceReferencePreview, unknown>>;
  const breakdown = Array.isArray(raw.breakdown) ? raw.breakdown : [];
  return {
    data: {
      breakdown: breakdown.map((item) => {
        const row = item as Partial<LegacyWorkforceReferencePreview["breakdown"][number]>;
        return {
          columns: String(row.columns ?? ""),
          kind: String(row.kind ?? ""),
          profile_type: String(row.profile_type ?? ""),
          rows: Number(row.rows ?? 0),
          table: String(row.table ?? "")
        };
      }),
      candidate_rows: Number(raw.candidate_rows ?? 0),
      direct_foreign_keys: Number(raw.direct_foreign_keys ?? 0),
      polymorphic_references: Number(raw.polymorphic_references ?? 0)
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

  const [{ company, companyUsers, productOwners, setupPending, error }, cleanupPreview, referencePreview] = await Promise.all([
    loadPlatformAccessOwners(companyId),
    loadLegacyWorkforceCleanupPreview(companyId),
    loadLegacyWorkforceReferencePreview()
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
              <>
                <div className="message-panel error">Deletion is blocked because {cleanupPreview.data.unmatched_rows} legacy row(s) do not have an exact canonical Workforce identity.</div>
                <form action={reconcileLegacyWorkforceAliases} style={{ marginTop: 18 }}>
                  <SubmitButton
                    className="button primary"
                    confirmDescription="This copies resumable registration state, repairs exact Workforce identity links and re-keys workflow history. It does not delete any profile."
                    confirmMessage="Reconcile legacy Workforce identities now?"
                    confirmSubmitText="Reconcile safely"
                    pendingText="Reconciling"
                  >
                    Reconcile before deletion
                  </SubmitButton>
                </form>
                <div className="summary-grid" style={{ marginTop: 18, marginBottom: 18 }}>
                  <div className="metric-card"><strong>{cleanupPreview.data.unmatched_without_link}</strong><span>No identity link</span></div>
                  <div className="metric-card"><strong>{cleanupPreview.data.unmatched_non_workforce_target}</strong><span>Linked outside Workforce</span></div>
                  <div className="metric-card"><strong>{cleanupPreview.data.unmatched_missing_canonical}</strong><span>Missing canonical row</span></div>
                </div>
                {cleanupPreview.data.unmatched_breakdown.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Source</th><th>Designation</th><th>Destination</th><th>Status</th><th>Reason</th><th>Rows</th></tr></thead>
                      <tbody>{cleanupPreview.data.unmatched_breakdown.map((item) => (
                        <tr key={`${item.source}:${item.designation}:${item.profile_destination}:${item.reason}`}>
                          <td>{item.source}</td><td><strong>{item.designation}</strong></td><td>{item.profile_destination}</td>
                          <td>{item.designation_active ? "Active" : "Inactive"}</td><td>{item.reason}</td><td>{item.count}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : cleanupPreview.data.legacy_workforce_rows > 0 && referencePreview.data && (
              referencePreview.data.direct_foreign_keys > 0 || referencePreview.data.polymorphic_references > 0
            ) ? (
              <>
                <div className="message-panel error">
                  Deletion remains blocked by {referencePreview.data.direct_foreign_keys} direct database reference(s) and {referencePreview.data.polymorphic_references} workflow reference(s). No rows will be deleted until both reach zero.
                </div>
                <form action={reconcileLegacyWorkforceAliases} style={{ marginTop: 18 }}>
                  <SubmitButton
                    className="button primary"
                    confirmDescription="This re-keys verified pay, shift, registration and workflow history to canonical Workforce identities. It does not delete any profile."
                    confirmMessage="Reconcile the remaining verified Workforce references now?"
                    confirmSubmitText="Reconcile safely"
                    pendingText="Reconciling"
                  >
                    Reconcile remaining references
                  </SubmitButton>
                </form>
                {referencePreview.data.breakdown.length ? (
                  <div className="table-wrap" style={{ marginTop: 18 }}>
                    <table>
                      <thead><tr><th>Kind</th><th>Table</th><th>Columns</th><th>Identity</th><th>Rows</th></tr></thead>
                      <tbody>{referencePreview.data.breakdown.map((item) => (
                        <tr key={`${item.kind}:${item.table}:${item.columns}:${item.profile_type}`}>
                          <td>{item.kind}</td><td><strong>{item.table}</strong></td><td>{item.columns}</td><td>{item.profile_type}</td><td>{item.rows}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                ) : null}
              </>
            ) : cleanupPreview.data.legacy_workforce_rows > 0 && referencePreview.pending ? (
              <div className="message-panel warning">The Workforce reference audit is still deploying. Deletion remains disabled.</div>
            ) : cleanupPreview.data.legacy_workforce_rows > 0 && referencePreview.error ? (
              <div className="message-panel error">Unable to verify workflow references: {referencePreview.error}. Deletion remains disabled.</div>
            ) : cleanupPreview.data.legacy_workforce_rows > 0 ? (
              <form action={purgeVerifiedLegacyWorkforceAliases}>
                <SubmitButton
                  className="button danger"
                  confirmDescription={`This deletes up to 100 verified aliases per run, only after all identity, registration, database and workflow checks pass. ${cleanupPreview.data.legacy_workforce_rows} remain in total.`}
                  confirmMessage="Delete the next verified legacy Workforce batch?"
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
