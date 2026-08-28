import "server-only";

import { supabaseAdmin } from "./supabase-admin";

const SELFIE_BUCKET = "employee-profile-documents";
const REMOVED_MARKER = "[removed]";

function isActiveSelfiePath(path: string | null | undefined) {
  const value = String(path ?? "").trim();
  return Boolean(value) && value !== REMOVED_MARKER && !value.startsWith("[");
}

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, size + i));
  return out;
}

/** Delete approved support selfies from storage and clear DB paths. */
export async function purgeSupportSelfiePaths(paths: Array<string | null | undefined>) {
  if (!supabaseAdmin) return;
  const unique = [...new Set(paths.map((path) => String(path ?? "").trim()).filter(isActiveSelfiePath))];
  if (!unique.length) return;

  const remove = await supabaseAdmin.storage.from(SELFIE_BUCKET).remove(unique);
  if (remove.error) {
    console.error("Unable to remove support selfies from storage", remove.error.message);
  }

  for (const batch of chunk(unique, 80)) {
    const update = await supabaseAdmin
      .from("attendance_location_reviews")
      .update({ selfie_path: REMOVED_MARKER, updated_at: new Date().toISOString() })
      .in("selfie_path", batch);
    if (update.error && !/does not exist|schema cache/i.test(update.error.message)) {
      console.error("Unable to clear selfie_path after purge", update.error.message);
    }
  }
}

export async function purgeSupportSelfiesForFlagIds(companyId: string, flagIds: string[]) {
  if (!supabaseAdmin || !flagIds.length) return;
  const paths: string[] = [];
  for (const batch of chunk(flagIds, 80)) {
    const result = await supabaseAdmin
      .from("attendance_location_reviews")
      .select("selfie_path")
      .eq("company_id", companyId)
      .in("flag_id", batch);
    if (result.error) continue;
    for (const row of result.data ?? []) {
      if (row.selfie_path) paths.push(String(row.selfie_path));
    }
  }
  await purgeSupportSelfiePaths(paths);
}

export async function purgeSupportSelfieForReviewId(companyId: string, reviewId: string) {
  if (!supabaseAdmin || !reviewId) return;
  const result = await supabaseAdmin
    .from("attendance_location_reviews")
    .select("selfie_path")
    .eq("company_id", companyId)
    .eq("id", reviewId)
    .maybeSingle();
  if (result.error || !result.data?.selfie_path) return;
  await purgeSupportSelfiePaths([String(result.data.selfie_path)]);
}
