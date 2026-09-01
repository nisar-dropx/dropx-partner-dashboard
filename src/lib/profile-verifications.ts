import { supabaseAdmin } from "@/lib/supabase-admin";
import type { WorkforceProfileType } from "@/lib/workforce-profiles";

type VerificationKind = "pan" | "pan_aadhaar" | "dl" | "vehicle" | "bank" | "pf_uan";

type ProfileType = WorkforceProfileType;

function canonicalProfileType(profileType: ProfileType): ProfileType {
  return profileType === "field_executive" ? "workforce" : profileType;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function isMissingVerificationTable(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("connect_profile_verifications") || message.includes("schema cache") || message.includes("does not exist");
}

export async function saveProfileVerification({
  accountId,
  companyId,
  kind,
  profileType,
  result
}: {
  accountId: string;
  companyId: string;
  kind: VerificationKind;
  profileType: ProfileType;
  result: Record<string, unknown>;
}) {
  if (!supabaseAdmin || !text(result.inputKey)) return;
  const saveResult = await supabaseAdmin.from("connect_profile_verifications").upsert({
    company_id: companyId,
    profile_type: canonicalProfileType(profileType),
    account_id: accountId,
    kind,
    input_key: text(result.inputKey),
    verified: result.verified === true,
    manual_review: result.manualReview === true,
    block_submit: result.blockSubmit === true,
    display_name: text(result.name || result.accountName || result.ownerName),
    message: text(result.message || result.warning),
    details: { ...result, kind },
    verified_at: result.verified === true ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  }, { onConflict: "company_id,profile_type,account_id,kind" });
  if (saveResult.error && !isMissingVerificationTable(saveResult.error)) {
    throw new Error(saveResult.error.message);
  }
}

export async function saveProfileVerifications({
  accountId,
  companyId,
  profileType,
  values
}: {
  accountId: string;
  companyId: string;
  profileType: ProfileType;
  values: FormDataEntryValue[] | string[];
}) {
  const seen = new Set<string>();
  for (const value of values) {
    const raw = text(value);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const kind = text(record.kind) as VerificationKind;
      if (!["pan", "pan_aadhaar", "dl", "vehicle", "bank", "pf_uan"].includes(kind)) continue;
      const key = `${kind}:${text(record.inputKey)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await saveProfileVerification({ accountId, companyId, kind, profileType, result: record });
    }
  }
}
