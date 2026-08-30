import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isNonEmployeeProfileType, workforceTable } from "@/lib/workforce-profiles";

const BUCKET = "employee-profile-documents";
const DEFAULT_MATCH_PERCENT = 60;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const SAFE_ERROR_PREFIXES = [
  "Connect session expired",
  "This profile is not available",
  "Profile photo changes are not available",
  "Profile type is invalid",
  "Face verification session is invalid",
  "Face verification session expired",
  "Face verification was already used",
  "Face match must be",
  "Face match score is invalid",
  "Live face checks are required",
  "New profile photo is required",
  "New profile photo must be",
  "Live verification selfie is required",
  "Live verification selfie must be",
  "Profile was not found"
];

function safeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  return SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix)) ? message : fallback;
}

function extension(file: File) {
  const fromName = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (fromName) return `.${fromName}`;
  return file.type === "image/png" ? ".png" : ".jpg";
}

function requireImage(value: FormDataEntryValue | null, label: string) {
  if (!(value instanceof File) || !value.size) throw new Error(`${label} is required.`);
  if (!value.type.startsWith("image/")) throw new Error(`${label} must be an image.`);
  if (value.size > MAX_PHOTO_BYTES) throw new Error(`${label} must be smaller than 8 MB.`);
  return value;
}

async function sessionAccounts() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const result = await supabaseAdmin.from("connect_login_sessions")
    .select("country_code,mobile_number,expires_at,revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data || result.data.revoked_at || new Date(result.data.expires_at).getTime() < Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new Error("Connect session expired. Please log in again.");
  }
  return findConnectAccounts(result.data.country_code, result.data.mobile_number);
}

async function requireAccount(accountId: string, profileType: string) {
  const account = (await sessionAccounts()).find((item) => item.id === accountId && item.profileType === profileType);
  if (!account) throw new Error("This profile is not available for the signed-in account.");
  if (profileType !== "employee" && !isNonEmployeeProfileType(profileType)) {
    throw new Error("Profile photo changes are not available for this account type.");
  }
  return account;
}

async function policy(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin.from("connect_identity_verification_policies")
    .select("profile_photo_match_percent,require_profile_photo_liveness")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (result.data) return result.data;
  const created = await supabaseAdmin.from("connect_identity_verification_policies").insert({
    company_id: companyId,
    profile_photo_match_percent: DEFAULT_MATCH_PERCENT,
    require_profile_photo_liveness: true
  }).select("profile_photo_match_percent,require_profile_photo_liveness").single();
  if (created.error || !created.data) throw new Error(created.error?.message ?? "Identity verification policy could not be initialized.");
  return created.data;
}

export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ healthy: false, feature: "verified-profile-photo" }, { status: 503 });
  }
  const admin = supabaseAdmin;
  const tables = [
    "connect_identity_verification_policies",
    "connect_profile_photo_challenges",
    "connect_profile_photo_verifications"
  ] as const;
  const results = await Promise.all(tables.map((table) =>
    admin.from(table).select("id", { count: "exact", head: true }).limit(1)
  ));
  const healthy = results.every((result) => !result.error);
  return NextResponse.json(
    { healthy, feature: "verified-profile-photo", policySource: "master" },
    { status: healthy ? 200 : 503 }
  );
}

export async function PUT(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json() as { accountId?: string; profileType?: string };
    const accountId = String(body.accountId ?? "").trim();
    const profileType = String(body.profileType ?? "").trim();
    const account = await requireAccount(accountId, profileType);
    const settings = await policy(account.companyId);
    const challenge = await supabaseAdmin.from("connect_profile_photo_challenges").insert({
      company_id: account.companyId,
      account_id: account.id,
      profile_type: profileType,
      required_match_percent: settings.profile_photo_match_percent,
      require_liveness: settings.require_profile_photo_liveness,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    }).select("id,required_match_percent,require_liveness,expires_at").single();
    if (challenge.error || !challenge.data) throw new Error(challenge.error?.message ?? "Face verification could not be started.");
    return NextResponse.json({ ok: true, challenge: challenge.data });
  } catch (error) {
    return NextResponse.json({ error: safeError(error, "Photo verification is temporarily unavailable. Please try again.") }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const uploadedPaths: string[] = [];
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const form = await request.formData();
    const accountId = String(form.get("account_id") ?? "").trim();
    const profileType = String(form.get("profile_type") ?? "").trim();
    const challengeId = String(form.get("challenge_id") ?? "").trim();
    const account = await requireAccount(accountId, profileType);
    const challenge = await supabaseAdmin.from("connect_profile_photo_challenges")
      .select("id,required_match_percent,require_liveness,expires_at,consumed_at")
      .eq("id", challengeId)
      .eq("company_id", account.companyId)
      .eq("account_id", account.id)
      .eq("profile_type", profileType)
      .maybeSingle();
    if (challenge.error || !challenge.data) throw new Error("Face verification session is invalid. Start again.");
    if (challenge.data.consumed_at || new Date(challenge.data.expires_at).getTime() < Date.now()) {
      throw new Error("Face verification session expired. Start again.");
    }

    const matchPercent = Number(form.get("match_percent"));
    const matchScore = Number(form.get("match_score"));
    const livenessPassed = String(form.get("liveness_passed")) === "true";
    if (!Number.isFinite(matchPercent) || matchPercent < challenge.data.required_match_percent) {
      throw new Error(`Face match must be ${challenge.data.required_match_percent}% or higher.`);
    }
    if (!Number.isFinite(matchScore) || matchScore < 0 || matchScore > 1) throw new Error("Face match score is invalid.");
    if (challenge.data.require_liveness && !livenessPassed) throw new Error("Live face checks are required.");

    const candidate = requireImage(form.get("profile_photo"), "New profile photo");
    const liveSelfie = requireImage(form.get("live_selfie"), "Live verification selfie");
    const table = profileType === "employee"
      ? "employees"
      : isNonEmployeeProfileType(profileType)
        ? workforceTable(profileType)
        : (() => { throw new Error("Profile type is invalid."); })();
    const current = await supabaseAdmin.from(table).select("profile_photo_path").eq("company_id", account.companyId).eq("id", account.id).maybeSingle();
    if (current.error || !current.data) throw new Error(current.error?.message ?? "Profile was not found.");

    const basePath = `${account.companyId}/${profileType}/${account.id}/verified-photo/${Date.now()}`;
    const photoPath = `${basePath}-profile${extension(candidate)}`;
    const selfiePath = `${basePath}-live-selfie${extension(liveSelfie)}`;
    for (const [path, file] of [[photoPath, candidate], [selfiePath, liveSelfie]] as const) {
      const uploaded = await supabaseAdmin.storage.from(BUCKET).upload(path, Buffer.from(await file.arrayBuffer()), {
        contentType: file.type,
        upsert: false
      });
      if (uploaded.error) throw new Error(uploaded.error.message);
      uploadedPaths.push(path);
    }

    const updatedAt = new Date().toISOString();
    const updated = await supabaseAdmin.from(table).update({ profile_photo_path: photoPath, updated_at: updatedAt })
      .eq("company_id", account.companyId).eq("id", account.id);
    if (updated.error) throw new Error(updated.error.message);
    const verification = await supabaseAdmin.from("connect_profile_photo_verifications").insert({
      company_id: account.companyId,
      account_id: account.id,
      profile_type: profileType,
      challenge_id: challengeId,
      previous_photo_path: current.data.profile_photo_path,
      verified_photo_path: photoPath,
      live_selfie_path: selfiePath,
      match_percent: matchPercent,
      match_score: matchScore,
      liveness_passed: livenessPassed,
      verified_at: updatedAt
    }).select("id").single();
    if (verification.error || !verification.data) {
      await supabaseAdmin.from(table).update({ profile_photo_path: current.data.profile_photo_path, updated_at: updatedAt })
        .eq("company_id", account.companyId).eq("id", account.id);
      throw new Error(verification.error?.message ?? "Profile photo verification audit could not be saved.");
    }
    const consumed = await supabaseAdmin.from("connect_profile_photo_challenges").update({ consumed_at: updatedAt })
      .eq("id", challengeId).is("consumed_at", null).select("id").maybeSingle();
    if (consumed.error || !consumed.data) {
      await supabaseAdmin.from(table).update({ profile_photo_path: current.data.profile_photo_path, updated_at: updatedAt })
        .eq("company_id", account.companyId).eq("id", account.id);
      await supabaseAdmin.from("connect_profile_photo_verifications").delete().eq("id", verification.data.id);
      throw new Error(consumed.error?.message ?? "Face verification was already used. Start again.");
    }
    const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(photoPath, 60 * 60);
    return NextResponse.json({ ok: true, profilePhotoUrl: signed.data?.signedUrl ?? "", matchPercent });
  } catch (error) {
    if (uploadedPaths.length && supabaseAdmin) await supabaseAdmin.storage.from(BUCKET).remove(uploadedPaths);
    return NextResponse.json({ error: safeError(error, "Profile photo could not be updated. Please try again.") }, { status: 400 });
  }
}
