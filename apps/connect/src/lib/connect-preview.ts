import "server-only";
import { createHash } from "crypto";
import { cookies } from "next/headers";
import { cache } from "react";
import { supabaseAdmin } from "./supabase-admin";
import { connectSessionCookieName, findConnectPreviewAccounts, type ConnectAccount } from "./connect-auth";
import { connectPreviewCookieName, previewProfileTables, previewRoleAllowed, samePreviewTarget, type PreviewTarget } from "./connect-preview-policy";
import { readPreview } from "./connect-preview-cookie";

const db = () => { if (!supabaseAdmin) throw new Error("Database unavailable."); return supabaseAdmin; };
export const previewNoStore = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
export const getConnectPreviewActor = cache(async (ownAccounts?: ConnectAccount[]) => {
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) return null;
  const session = await db().from("connect_login_sessions").select("id,country_code,mobile_number,expires_at,revoked_at")
    .eq("session_hash", createHash("sha256").update(token).digest("hex")).maybeSingle();
  if (session.error || !session.data || session.data.revoked_at || Date.parse(session.data.expires_at) <= Date.now()) return null;
  const accounts = ownAccounts ?? await findConnectPreviewAccounts(session.data.country_code, session.data.mobile_number);
  const companyIds = [...new Set(accounts.map(a => a.companyId))];
  if (!companyIds.length) return null;
  const local = session.data.mobile_number.startsWith(session.data.country_code)
    ? session.data.mobile_number.slice(session.data.country_code.length) : session.data.mobile_number;
  const profiles = await db().from("profiles").select("id,company_id,is_master_owner,role_id")
    .eq("is_active", true).in("company_id", companyIds)
    .or(`mobile_country_code.eq.${session.data.country_code},mobile_country_code.is.null`)
    .or(`mobile.eq.${local},mobile.eq.${session.data.mobile_number}`);
  if (profiles.error) throw profiles.error;
  const roleIds = (profiles.data ?? []).flatMap(p => p.role_id ? [p.role_id] : []);
  const roles = roleIds.length ? await db().from("user_roles").select("id,company_id,code")
    .eq("is_active", true).in("id", roleIds) : { data: [], error: null };
  if (roles.error) throw roles.error;
  const eligible = companyIds.filter(companyId => {
    const designationEligible = accounts.some(a => a.companyId === companyId &&
      ["employee", "contractor"].includes(a.profileType) && previewRoleAllowed(false, null, a.designationCode));
    return designationEligible || (profiles.data ?? []).some(p => p.company_id === companyId &&
      previewRoleAllowed(Boolean(p.is_master_owner), roles.data?.find(r => r.id === p.role_id && r.company_id === companyId)?.code));
  });
  return { sessionId: session.data.id, token, companyIds: eligible, accounts };
});

export async function loadPreviewAccount(target: PreviewTarget, actor: NonNullable<Awaited<ReturnType<typeof getConnectPreviewActor>>>) {
  if (!actor.companyIds.includes(target.companyId)) throw new Error("Choose a profile in your company.");
  let query = db().from(previewProfileTables[target.profileType]).select("id,mobile,mobile_country_code")
    .eq("company_id", target.companyId).eq("id", target.id).eq("is_active", true);
  if (["workforce", "contractor", "employee"].includes(target.profileType)) query = query.is("deleted_at", null);
  const result = await query.maybeSingle();
  if (result.error || !result.data?.mobile) throw new Error("This profile is not available in DropX One.");
  const countryCode = String(result.data.mobile_country_code || "91");
  const mobile = String(result.data.mobile).replace(/\D/g, "");
  const accounts = await findConnectPreviewAccounts(countryCode, mobile.startsWith(countryCode) ? mobile : countryCode + mobile);
  const account = accounts.find(a => samePreviewTarget(target, a) && !a.onboardingBeta);
  if (!account) throw new Error("This profile is no longer available in DropX One.");
  return { ...account, isDefault: false, readOnlyPreview: true };
}

export const resolveConnectPreview = cache(async (): Promise<ConnectAccount | null> => {
  const value = cookies().get(connectPreviewCookieName)?.value;
  if (!value) return null;
  const actor = await getConnectPreviewActor();
  const target = actor ? readPreview(value, actor.token) : null;
  if (!actor || !target) throw new Error("Your user preview has expired. Exit preview and choose a profile again.");
  return loadPreviewAccount(target, actor);
});

export async function searchConnectPreviewUsers(actor: NonNullable<Awaited<ReturnType<typeof getConnectPreviewActor>>>, input: string) {
  const search = input.replace(/[^a-zA-Z0-9@ ._+-]/g, "").trim().slice(0, 80);
  if (search.length < 2 || !actor.companyIds.length) return [];
  const results = await Promise.all(Object.entries(previewProfileTables).map(async ([type, table]) => {
    const profileType = type as PreviewTarget["profileType"];
    const ref = type === "user" ? "employee_id" : type === "employee" ? "employee_code" : "dropx_id";
    const role = type === "user" ? "role" : type === "employee" ? "designation_id" : "designation";
    let query = db().from(table).select(`id,company_id,full_name,email,${ref},${role}`)
      .in("company_id", actor.companyIds).eq("is_active", true)
      .or(`full_name.ilike.%${search}%,email.ilike.%${search}%,mobile.ilike.%${search}%,${ref}.ilike.%${search}%`)
      .order("full_name").limit(30);
    if (["contractor", "workforce", "employee"].includes(type)) query = query.is("deleted_at", null);
    const result = await query;
    if (result.error) throw new Error("Unable to search profiles. Please try again.");
    return (result.data ?? []).map(raw => {
      const row = raw as unknown as Record<string, string | null>;
      return { id: row.id!, companyId: row.company_id!, profileType, name: row.full_name || "Unnamed profile",
        email: row.email || "", reference: row[ref] || "", role: type === "employee" ? "Employee" : row[role] || type };
    });
  }));
  return results.flat().sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}
