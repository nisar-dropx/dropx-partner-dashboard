import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import {
  assertConnectProfilePhotoUpdateAllowed,
  connectProfilePhotoUsage,
  countConnectProfilePhotoUpdatesThisMonth,
  isConnectProfilePhotoSchemaError,
  loadConnectProfilePhotoPolicy
} from "../../../../src/lib/connect-profile-photo-policy";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { isNonEmployeeProfileType, workforceTable } from "../../../../src/lib/workforce-profiles";

const BUCKET = "employee-profile-documents";
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const CHALLENGE_TTL_MS = 30 * 60 * 1000;

const SAFE_ERROR_PREFIXES = [
  "Connect session expired",
  "This account is not available",
  "This profile is not available",
  "Profile photo changes are not available",
  "Profile photo self-service updates are disabled",
  "You have reached the limit of",
  "Profile type is invalid",
  "Face verification session is invalid",
  "Face verification session expired",
  "Face verification was already used",
  "Face verification was already used",
  "Face match must be",
  "Face match score is invalid",
  "Live face checks are required",
  "New profile photo is required",
  "New profile photo must be",
  "Live verification selfie is required",
  "Live verification selfie must be",
  "Profile was not found",
  "Profile photo verification is not configured"
];

function safeError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : "";
  if (SAFE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))) return message;
  if (isConnectProfilePhotoSchemaError(message)) {
    return "Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.";
  }
  return fallback;
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

function assertPhotoAccount(profileType: string) {
  if (profileType === "user") throw new Error("Profile photo changes are not available for this account type.");
  if (profileType !== "employee" && !isNonEmployeeProfileType(profileType)) {
    throw new Error("Profile photo changes are not available for this account type.");
  }
}

async function resolveAccount(accountId: string, profileType: string) {
  assertPhotoAccount(profileType);
  return requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
}

function workforceUpdateTable(profileType: string) {
  if (profileType === "employee") return "employees" as const;
  if (isNonEmployeeProfileType(profileType)) return workforceTable(profileType);
  throw new Error("Profile type is invalid.");
}

async function signedProfilePhoto(path: string) {
  if (!supabaseAdmin) return "";
  const signed = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
  return signed.data?.signedUrl ?? "";
}

async function completedVerificationResponse({
  companyId,
  challengeId,
  settings,
  updatesUsed
}: {
  companyId: string;
  challengeId: string;
  settings: Awaited<ReturnType<typeof loadConnectProfilePhotoPolicy>>;
  updatesUsed: number;
}) {
  const existing = await supabaseAdmin!.from("connect_profile_photo_verifications")
    .select("verified_photo_path,match_percent")
    .eq("company_id", companyId)
    .eq("challenge_id", challengeId)
    .maybeSingle();
  if (existing.error || !existing.data?.verified_photo_path) return null;
  const usage = connectProfilePhotoUsage(settings, updatesUsed);
  return NextResponse.json({
    ok: true,
    profilePhotoUrl: await signedProfilePhoto(existing.data.verified_photo_path),
    matchPercent: Number(existing.data.match_percent),
    monthlyLimit: usage.monthlyLimit,
    updatesUsed: usage.updatesUsed,
    updatesRemaining: usage.updatesRemaining
  });
}

export async function GET(request: Request) {
  if (!supabaseAdmin) {
    return NextResponse.json({ healthy: false, feature: "verified-profile-photo" }, { status: 503 });
  }
  const url = new URL(request.url);
  const accountId = String(url.searchParams.get("accountId") ?? "").trim();
  const profileType = String(url.searchParams.get("profileType") ?? "").trim();
  const tables = [
    "connect_identity_verification_policies",
    "connect_profile_photo_challenges",
    "connect_profile_photo_verifications"
  ] as const;
  const results = await Promise.all(tables.map((table) =>
    supabaseAdmin!.from(table).select("id", { count: "exact", head: true }).limit(1)
  ));
  const healthy = results.every((result) => !result.error);
  if (!accountId || !profileType) {
    return NextResponse.json(
      { healthy, feature: "verified-profile-photo", policySource: "master" },
      { status: healthy ? 200 : 503 }
    );
  }
  try {
    const account = await resolveAccount(accountId, profileType);
    const [policy, updatesUsed] = await Promise.all([
      loadConnectProfilePhotoPolicy(account.companyId),
      countConnectProfilePhotoUpdatesThisMonth({
        companyId: account.companyId,
        accountId: account.id,
        profileType
      })
    ]);
    const usage = connectProfilePhotoUsage(policy, updatesUsed);
    let blocked = false;
    let error: string | undefined;
    try {
      assertConnectProfilePhotoUpdateAllowed(policy, updatesUsed);
    } catch (reason) {
      blocked = true;
      error = safeError(reason, "Profile photo updates are not available right now.");
    }
    return NextResponse.json({
      healthy,
      feature: "verified-profile-photo",
      policySource: "master",
      requiredMatchPercent: policy.profile_photo_match_percent,
      requireLiveness: policy.require_profile_photo_liveness,
      monthlyLimit: usage.monthlyLimit,
      updatesUsed: usage.updatesUsed,
      updatesRemaining: usage.updatesRemaining,
      blocked,
      error
    });
  } catch (error) {
    return NextResponse.json({
      healthy,
      error: safeError(error, "Photo verification is temporarily unavailable. Please try again.")
    }, { status: 400 });
  }
}

export async function PUT(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json() as { accountId?: string; profileType?: string };
    const accountId = String(body.accountId ?? "").trim();
    const profileType = String(body.profileType ?? "").trim();
    const account = await resolveAccount(accountId, profileType);
    const [settings, updatesUsed] = await Promise.all([
      loadConnectProfilePhotoPolicy(account.companyId),
      countConnectProfilePhotoUpdatesThisMonth({
        companyId: account.companyId,
        accountId: account.id,
        profileType
      })
    ]);
    const usage = assertConnectProfilePhotoUpdateAllowed(settings, updatesUsed);
    const nowIso = new Date().toISOString();
    const openChallenge = await supabaseAdmin.from("connect_profile_photo_challenges")
      .select("id,required_match_percent,require_liveness,expires_at")
      .eq("company_id", account.companyId)
      .eq("account_id", account.id)
      .eq("profile_type", profileType)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openChallenge.error) {
      if (isConnectProfilePhotoSchemaError(openChallenge.error.message)) {
        throw new Error("Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.");
      }
      throw new Error(openChallenge.error.message);
    }
    if (openChallenge.data) {
      return NextResponse.json({
        ok: true,
        challenge: openChallenge.data,
        monthlyLimit: usage.monthlyLimit,
        updatesUsed: usage.updatesUsed,
        updatesRemaining: usage.updatesRemaining
      });
    }
    const challenge = await supabaseAdmin.from("connect_profile_photo_challenges").insert({
      company_id: account.companyId,
      account_id: account.id,
      profile_type: profileType,
      required_match_percent: settings.profile_photo_match_percent,
      require_liveness: settings.require_profile_photo_liveness,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()
    }).select("id,required_match_percent,require_liveness,expires_at").single();
    if (challenge.error || !challenge.data) {
      if (isConnectProfilePhotoSchemaError(challenge.error?.message ?? "")) {
        throw new Error("Profile photo verification is not configured on the server yet. Ask HR to apply the latest Connect database update.");
      }
      throw new Error(challenge.error?.message ?? "Face verification could not be started.");
    }
    return NextResponse.json({
      ok: true,
      challenge: challenge.data,
      monthlyLimit: usage.monthlyLimit,
      updatesUsed: usage.updatesUsed,
      updatesRemaining: usage.updatesRemaining
    });
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
    const account = await resolveAccount(accountId, profileType);
    const [settings, updatesUsed] = await Promise.all([
      loadConnectProfilePhotoPolicy(account.companyId),
      countConnectProfilePhotoUpdatesThisMonth({
        companyId: account.companyId,
        accountId: account.id,
        profileType
      })
    ]);
    assertConnectProfilePhotoUpdateAllowed(settings, updatesUsed);

    const challenge = await supabaseAdmin.from("connect_profile_photo_challenges")
      .select("id,required_match_percent,require_liveness,expires_at,consumed_at")
      .eq("id", challengeId)
      .eq("company_id", account.companyId)
      .eq("account_id", account.id)
      .eq("profile_type", profileType)
      .maybeSingle();
    if (challenge.error || !challenge.data) throw new Error("Face verification session is invalid. Start again.");
    if (challenge.data.consumed_at) {
      const replay = await completedVerificationResponse({
        companyId: account.companyId,
        challengeId,
        settings,
        updatesUsed
      });
      if (replay) return replay;
      throw new Error("Face verification was already used. Start again.");
    }
    if (new Date(challenge.data.expires_at).getTime() < Date.now()) {
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
    const table = workforceUpdateTable(profileType);
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
      const replay = await completedVerificationResponse({
        companyId: account.companyId,
        challengeId,
        settings,
        updatesUsed: updatesUsed + 1
      });
      if (replay) return replay;
      await supabaseAdmin.from(table).update({ profile_photo_path: current.data.profile_photo_path, updated_at: updatedAt })
        .eq("company_id", account.companyId).eq("id", account.id);
      await supabaseAdmin.from("connect_profile_photo_verifications").delete().eq("id", verification.data.id);
      throw new Error(consumed.error?.message ?? "Face verification was already used. Start again.");
    }
    const signedUrl = await signedProfilePhoto(photoPath);
    const nextUsage = connectProfilePhotoUsage(settings, updatesUsed + 1);
    return NextResponse.json({
      ok: true,
      profilePhotoUrl: signedUrl,
      matchPercent,
      monthlyLimit: nextUsage.monthlyLimit,
      updatesUsed: nextUsage.updatesUsed,
      updatesRemaining: nextUsage.updatesRemaining
    });
  } catch (error) {
    if (uploadedPaths.length && supabaseAdmin) await supabaseAdmin.storage.from(BUCKET).remove(uploadedPaths);
    return NextResponse.json({ error: safeError(error, "Profile photo could not be updated. Please try again.") }, { status: 400 });
  }
}
