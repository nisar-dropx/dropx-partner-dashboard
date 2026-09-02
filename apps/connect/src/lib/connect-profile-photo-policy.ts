import "server-only";

import { supabaseAdmin } from "./supabase-admin";

const DEFAULT_MATCH_PERCENT = 60;
const DEFAULT_MONTHLY_LIMIT = 2;

export type ConnectProfilePhotoPolicy = {
  profile_photo_match_percent: number;
  require_profile_photo_liveness: boolean;
  profile_photo_monthly_updates_limit: number;
};

function db() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  return supabaseAdmin;
}

export function isConnectProfilePhotoSchemaError(message: string) {
  return /schema cache|could not find the table|relation .* does not exist|column .* does not exist|connect_identity_verification_policies|connect_profile_photo_/i.test(message);
}

function istMonthBounds() {
  const istDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const [year, month] = istDate.split("-");
  const start = `${year}-${month}-01T00:00:00+05:30`;
  const nextYear = Number(month) === 12 ? Number(year) + 1 : Number(year);
  const nextMonth = Number(month) === 12 ? 1 : Number(month) + 1;
  const end = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+05:30`;
  return { start, end };
}

export async function loadConnectProfilePhotoPolicy(companyId: string): Promise<ConnectProfilePhotoPolicy> {
  const result = await db().from("connect_identity_verification_policies")
    .select("profile_photo_match_percent,require_profile_photo_liveness,profile_photo_monthly_updates_limit")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (result.error) {
    if (isConnectProfilePhotoSchemaError(result.error.message)) {
      throw new Error("Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.");
    }
    throw new Error(result.error.message);
  }
  if (result.data) {
    return {
      profile_photo_match_percent: Number(result.data.profile_photo_match_percent ?? DEFAULT_MATCH_PERCENT),
      require_profile_photo_liveness: Boolean(result.data.require_profile_photo_liveness ?? true),
      profile_photo_monthly_updates_limit: Number(result.data.profile_photo_monthly_updates_limit ?? DEFAULT_MONTHLY_LIMIT)
    };
  }
  const created = await db().from("connect_identity_verification_policies").upsert({
    company_id: companyId,
    profile_photo_match_percent: DEFAULT_MATCH_PERCENT,
    require_profile_photo_liveness: true,
    profile_photo_monthly_updates_limit: DEFAULT_MONTHLY_LIMIT,
    is_active: true,
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id" }).select("profile_photo_match_percent,require_profile_photo_liveness,profile_photo_monthly_updates_limit").single();
  if (created.error || !created.data) {
    if (isConnectProfilePhotoSchemaError(created.error?.message ?? "")) {
      throw new Error("Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.");
    }
    throw new Error(created.error?.message ?? "Identity verification policy could not be initialized.");
  }
  return {
    profile_photo_match_percent: Number(created.data.profile_photo_match_percent),
    require_profile_photo_liveness: Boolean(created.data.require_profile_photo_liveness),
    profile_photo_monthly_updates_limit: Number(created.data.profile_photo_monthly_updates_limit ?? DEFAULT_MONTHLY_LIMIT)
  };
}

export async function countConnectProfilePhotoUpdatesThisMonth({
  companyId,
  accountId,
  profileType
}: {
  companyId: string;
  accountId: string;
  profileType: string;
}) {
  const { start, end } = istMonthBounds();
  const result = await db().from("connect_profile_photo_verifications")
    .select("id", { count: "exact", head: true })
    .eq("company_id", companyId)
    .eq("account_id", accountId)
    .eq("profile_type", profileType)
    .gte("verified_at", start)
    .lt("verified_at", end);
  if (result.error) {
    if (isConnectProfilePhotoSchemaError(result.error.message)) {
      throw new Error("Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.");
    }
    throw new Error(result.error.message);
  }
  return result.count ?? 0;
}

export function connectProfilePhotoUsage(policy: ConnectProfilePhotoPolicy, updatesUsed: number) {
  const monthlyLimit = Math.max(0, Number(policy.profile_photo_monthly_updates_limit ?? DEFAULT_MONTHLY_LIMIT));
  const used = Math.max(0, updatesUsed);
  const updatesRemaining = monthlyLimit === 0 ? 0 : Math.max(0, monthlyLimit - used);
  return { monthlyLimit, updatesUsed: used, updatesRemaining };
}

export function assertConnectProfilePhotoUpdateAllowed(policy: ConnectProfilePhotoPolicy, updatesUsed: number) {
  const usage = connectProfilePhotoUsage(policy, updatesUsed);
  if (usage.monthlyLimit === 0) {
    throw new Error("Profile photo self-service updates are disabled for your company.");
  }
  if (usage.updatesRemaining <= 0) {
    throw new Error(`You have reached the limit of ${usage.monthlyLimit} profile photo update${usage.monthlyLimit === 1 ? "" : "s"} this month. Try again next month.`);
  }
  return usage;
}
