import crypto from "crypto";
import type { AuthorizationContext, PagePermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";

const SERVICE_KEY_HEADER = "x-service-key";

export class ServiceAuthError extends Error {}

function keysMatch(presented: string, expected: string) {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Unattended callers (the report auto worker's scheduled runs) cannot hold a
 * browser session, so they present a shared key instead. The key alone grants
 * nothing: it is paired with a real active profile, which supplies the company
 * scope and the audit user that every import batch is written against.
 * Returns null when no key is presented, so session auth can take over.
 */
export async function getServiceAuthorization(request: Request): Promise<AuthorizationContext | null> {
  const presented = (request.headers.get(SERVICE_KEY_HEADER) ?? "").trim();
  if (!presented) return null;

  const expected = (process.env.REPORT_IMPORT_SERVICE_KEY ?? "").trim();
  if (!expected || !keysMatch(presented, expected)) {
    throw new ServiceAuthError("Service key is not valid.");
  }
  if (!supabaseAdmin) throw new ServiceAuthError("Supabase service key is not configured.");

  const serviceEmail = (process.env.REPORT_IMPORT_SERVICE_EMAIL ?? "").trim().toLowerCase();
  if (!serviceEmail) throw new ServiceAuthError("REPORT_IMPORT_SERVICE_EMAIL is not set.");

  const serviceCompanyId = (process.env.REPORT_IMPORT_SERVICE_COMPANY_ID ?? "").trim();
  let query = supabaseAdmin
    .from("profiles")
    .select("id, email, full_name, company_id, role_id, is_active")
    .ilike("email", serviceEmail)
    .eq("is_active", true);
  if (serviceCompanyId) query = query.eq("company_id", serviceCompanyId);
  const { data: profiles, error } = await query;
  if (error) throw new ServiceAuthError(error.message);
  // The same address can exist in several companies, so never guess a scope.
  if ((profiles ?? []).length > 1) {
    throw new ServiceAuthError(
      `${serviceEmail} matches ${profiles!.length} active profiles. Set REPORT_IMPORT_SERVICE_COMPANY_ID.`
    );
  }
  const profile = profiles?.[0];
  if (!profile?.company_id) {
    throw new ServiceAuthError(`No active profile with a company for ${serviceEmail}.`);
  }

  const { data: company } = await supabaseAdmin
    .from("companies")
    .select("id, code, name, is_master, is_active")
    .eq("id", profile.company_id)
    .maybeSingle();
  if (!company?.is_active) throw new ServiceAuthError("Service profile company is not active.");

  const importPermission: PagePermission = { canView: true, canAdd: true, canEdit: true };
  return {
    companyCode: company.code,
    companyId: company.id,
    companyName: company.name,
    email: profile.email,
    fullName: profile.full_name,
    hasAllLocationAccess: true,
    isMasterCompany: Boolean(company.is_master),
    isMasterOwner: false,
    locationScopeIds: [],
    permissions: { imports: importPermission, master_imports: importPermission },
    roleCode: null,
    roleId: profile.role_id,
    roleName: "Report automation",
    userId: profile.id
  };
}
