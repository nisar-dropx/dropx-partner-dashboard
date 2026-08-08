import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectAccounts } from "../../../../src/lib/connect-auth";
import {
  isMissingProfileDraftTable,
  loadProfileDraft,
  profileDraftFileSlots,
  type ProfileDraftFileSlot
} from "../../../../src/lib/profile-drafts";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import {
  isWorkforceProfileType,
  type WorkforceProfileType
} from "../../../../src/lib/workforce-profiles";

function fileExt(name: string) {
  const ext = name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext ? `.${ext}` : "";
}

function parseObject(value: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseVerificationRows(values: FormDataEntryValue[]) {
  const rows: Record<string, unknown>[] = [];
  for (const value of values) {
    try {
      const parsed = JSON.parse(String(value ?? ""));
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          rows.push(item as Record<string, unknown>);
        }
      }
    } catch {
      // A malformed optional verification snapshot must not block saving the form draft.
    }
  }
  return rows;
}

async function authenticatedAccount(accountId: string, profileType: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (!isWorkforceProfileType(profileType)) throw new Error("Invalid workforce profile type.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin
    .from("connect_login_sessions")
    .select("country_code, mobile_number, expires_at, revoked_at")
    .eq("session_hash", sessionHash)
    .maybeSingle();
  if (sessionResult.error) throw new Error(sessionResult.error.message);
  const session = sessionResult.data;
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    cookies().delete(connectSessionCookieName);
    throw new Error("Connect session expired. Please log in again.");
  }
  const accounts = await findConnectAccounts(session.country_code, session.mobile_number);
  const account = accounts.find((item) => item.id === accountId && item.profileType === profileType);
  if (!account) throw new Error("Profile is not available for this login.");
  return { ...account, profileType: profileType as WorkforceProfileType };
}

async function signedUrl(path: string) {
  if (!supabaseAdmin || !path) return "";
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .createSignedUrl(path, 60 * 60);
  return result.data?.signedUrl ?? "";
}

async function serializeDraft(accountId: string, companyId: string, profileType: WorkforceProfileType) {
  const draft = await loadProfileDraft({ accountId, companyId, profileType });
  if (!draft) return null;
  const uploads = Object.fromEntries(
    profileDraftFileSlots.map((slot) => [slot, Boolean(draft.filePaths[slot])])
  );
  const uploadUrls = Object.fromEntries(
    await Promise.all(profileDraftFileSlots.map(async (slot) => [slot, await signedUrl(draft.filePaths[slot] ?? "")]))
  );
  return {
    data: draft.data,
    verificationResults: draft.verificationResults,
    uploads,
    uploadUrls,
    updatedAt: draft.updatedAt
  };
}

async function uploadDraftFile(
  file: FormDataEntryValue | null,
  companyId: string,
  profileType: WorkforceProfileType,
  accountId: string,
  slot: ProfileDraftFileSlot
) {
  if (!supabaseAdmin || !(file instanceof File) || file.size === 0) return null;
  if (file.size > 3_500_000) throw new Error(`${file.name || "File"} is too large. Each file must be smaller than 3.5 MB.`);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${companyId}/registration-drafts/${profileType}/${accountId}/${slot}-${Date.now()}${fileExt(safeName)}`;
  const result = await supabaseAdmin.storage
    .from("employee-profile-documents")
    .upload(path, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type || "application/octet-stream",
      upsert: true
    });
  if (result.error) throw new Error(result.error.message);
  return path;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = url.searchParams.get("accountId") ?? "";
    const profileType = url.searchParams.get("profileType") ?? "";
    const account = await authenticatedAccount(accountId, profileType);
    return NextResponse.json({
      ok: true,
      draft: await serializeDraft(account.id, account.companyId, account.profileType)
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load draft." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const formData = await request.formData();
    const accountId = String(formData.get("account_id") ?? "");
    const profileType = String(formData.get("profile_type") ?? "");
    const account = await authenticatedAccount(accountId, profileType);
    const current = await loadProfileDraft({
      accountId: account.id,
      companyId: account.companyId,
      profileType: account.profileType
    });
    const nextPaths = { ...(current?.filePaths ?? {}) };
    const replacedPaths: string[] = [];

    for (const slot of profileDraftFileSlots) {
      const path = await uploadDraftFile(
        formData.get(slot),
        account.companyId,
        account.profileType,
        account.id,
        slot
      );
      if (!path) continue;
      if (nextPaths[slot] && nextPaths[slot] !== path) replacedPaths.push(nextPaths[slot]!);
      nextPaths[slot] = path;
    }

    const saveResult = await supabaseAdmin.from("mob_app_registration_drafts").upsert({
      company_id: account.companyId,
      profile_type: account.profileType,
      account_id: account.id,
      draft_data: parseObject(formData.get("draft_data")),
      verification_results: parseVerificationRows(formData.getAll("profile_verification_results")),
      file_paths: nextPaths,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,profile_type,account_id" });
    if (saveResult.error) {
      if (isMissingProfileDraftTable(saveResult.error)) {
        throw new Error("Draft storage is not installed. Run scripts/mob_app_registration_drafts_v1.sql in Supabase.");
      }
      throw new Error(saveResult.error.message);
    }
    if (replacedPaths.length) {
      await supabaseAdmin.storage.from("employee-profile-documents").remove(replacedPaths);
    }
    return NextResponse.json({
      ok: true,
      draft: await serializeDraft(account.id, account.companyId, account.profileType),
      notice: "Details saved in draft"
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save draft." }, { status: 400 });
  }
}
