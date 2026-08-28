"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { resolveIntegrityFlag } from "@/lib/biometric/attendance-gps";
import {
  purgeSupportSelfieForReviewId,
  purgeSupportSelfiesForFlagIds
} from "@/lib/purge-support-selfies";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function integrityRedirect(formData: FormData, kind: "error" | "notice", message: string) {
  const requested = clean(formData.get("return_to"));
  const returnTo = requested.startsWith("/attendance/integrity") ? requested.split("?")[0] : "/attendance/integrity";
  redirect(`${returnTo}?tab=reviews&${kind}=${encodeURIComponent(message)}`);
}

async function assertCanReviewTeamOrIntegrity(companyId: string, userId: string, profileId: string | null) {
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Login required.");
  if (hasPermission(authorization, "attendance_integrity", "edit")) {
    return authorization;
  }
  if (!profileId || !supabaseAdmin) throw new Error("Not allowed.");
  const employee = await supabaseAdmin
    .from("employees")
    .select("employee_code")
    .eq("company_id", companyId)
    .eq("id", profileId)
    .maybeSingle();
  const code = employee.data?.employee_code;
  if (!code) throw new Error("Not allowed.");
  const linked = await supabaseAdmin
    .from("profiles")
    .select("reports_to_user_id")
    .eq("company_id", companyId)
    .eq("employee_id", code)
    .maybeSingle();
  if (linked.data?.reports_to_user_id !== userId) throw new Error("Not allowed to review this employee.");
  return authorization;
}

export async function reviewAttendanceLocationPackage(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Login required.");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const reviewId = clean(formData.get("review_id"));
  const actionRaw = clean(formData.get("review_action") || formData.get("decision")).toLowerCase();
  const action =
    actionRaw === "approved" || actionRaw === "approve"
      ? "approve"
      : actionRaw === "returned" || actionRaw === "return"
        ? "return"
        : actionRaw === "rejected" || actionRaw === "reject"
          ? "reject"
          : "";
  const remarks = clean(formData.get("review_remarks"));
  if (!reviewId) integrityRedirect(formData, "error", "Review id is required.");
  if (!["approve", "return", "reject"].includes(action)) integrityRedirect(formData, "error", "Choose a valid review action.");
  if ((action === "return" || action === "reject") && remarks.length < 3) {
    integrityRedirect(formData, "error", "Enter review remarks when rejecting.");
  }

  const existing = await supabaseAdmin
    .from("attendance_location_reviews")
    .select("id, status, flag_id, punch_id, company_id, profile_id, selfie_path")
    .eq("id", reviewId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) throw new Error("Support package not found.");
  if (!["pending", "returned"].includes(String(existing.data.status))) {
    throw new Error("This support package has already been decided.");
  }

  await assertCanReviewTeamOrIntegrity(companyId, authorization.userId, existing.data.profile_id as string | null);

  const now = new Date().toISOString();
  const status = action === "approve" ? "approved" : action === "return" ? "returned" : "rejected";
  const update = await supabaseAdmin
    .from("attendance_location_reviews")
    .update({
      status,
      review_remarks: remarks || null,
      reviewed_by: authorization.userId,
      reviewed_at: now,
      updated_at: now
    })
    .eq("id", reviewId)
    .eq("company_id", companyId);
  if (update.error) throw new Error(update.error.message);

  if (action === "approve" && existing.data.flag_id) {
    // resolveIntegrityFlag also activates any held punch linked to the flag.
    await resolveIntegrityFlag(String(existing.data.flag_id), authorization.userId);
  }

  if (action === "reject" && existing.data.flag_id) {
    await supabaseAdmin
      .from("attendance_integrity_flags")
      .update({
        status: "dismissed",
        resolved_at: now,
        resolved_by: authorization.userId,
        updated_at: now
      })
      .eq("company_id", companyId)
      .eq("id", existing.data.flag_id)
      .eq("status", "open");
  }

  if (action === "approve" || action === "return" || action === "reject") {
    await purgeSupportSelfieForReviewId(companyId, reviewId).catch((error) => {
      console.error("support package selfie purge failed", error instanceof Error ? error.message : error);
    });
  }

  revalidatePath("/attendance/integrity");
  integrityRedirect(formData, "notice", action === "approve" ? "Support package approved." : action === "return" ? "Support package returned." : "Support package rejected.");
}

export async function approveAttendanceIntegrityFlag(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Login required.");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const flagId = clean(formData.get("flag_id"));
  if (!flagId) throw new Error("Flag id is required.");

  const flag = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, profile_id, status")
    .eq("id", flagId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (flag.error) throw new Error(flag.error.message);
  if (!flag.data) throw new Error("Flag not found.");
  if (String(flag.data.status) !== "open") throw new Error("This flag is no longer open.");
  await assertCanReviewTeamOrIntegrity(companyId, authorization.userId, flag.data.profile_id as string | null);

  const now = new Date().toISOString();
  const pendingReviews = await supabaseAdmin
    .from("attendance_location_reviews")
    .select("id")
    .eq("company_id", companyId)
    .eq("flag_id", flagId)
    .in("status", ["pending", "returned"]);
  if (pendingReviews.error) throw new Error(pendingReviews.error.message);

  for (const review of pendingReviews.data ?? []) {
    const reviewUpdate = await supabaseAdmin
      .from("attendance_location_reviews")
      .update({
        status: "approved",
        reviewed_by: authorization.userId,
        reviewed_at: now,
        updated_at: now
      })
      .eq("id", review.id)
      .eq("company_id", companyId);
    if (reviewUpdate.error) throw new Error(reviewUpdate.error.message);
  }

  await resolveIntegrityFlag(flagId, authorization.userId);
  await purgeSupportSelfiesForFlagIds(companyId, [flagId]).catch((error) => {
    console.error("approve flag selfie purge failed", error instanceof Error ? error.message : error);
  });
  revalidatePath("/attendance/integrity");
}

export async function dismissAttendanceIntegrityFlag(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) throw new Error("Login required.");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const flagId = clean(formData.get("flag_id"));
  if (!flagId) throw new Error("Flag id is required.");

  const flag = await supabaseAdmin
    .from("attendance_integrity_flags")
    .select("id, profile_id")
    .eq("id", flagId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (flag.error) throw new Error(flag.error.message);
  if (!flag.data) throw new Error("Flag not found.");
  await assertCanReviewTeamOrIntegrity(companyId, authorization.userId, flag.data.profile_id as string | null);

  const now = new Date().toISOString();
  const result = await supabaseAdmin
    .from("attendance_integrity_flags")
    .update({
      status: "dismissed",
      resolved_at: now,
      resolved_by: authorization.userId,
      updated_at: now
    })
    .eq("id", flagId)
    .eq("company_id", companyId);
  if (result.error) throw new Error(result.error.message);

  const reviewUpdate = await supabaseAdmin
    .from("attendance_location_reviews")
    .update({
      status: "rejected",
      reviewed_by: authorization.userId,
      reviewed_at: now,
      updated_at: now
    })
    .eq("company_id", companyId)
    .eq("flag_id", flagId)
    .in("status", ["pending", "returned"]);
  if (reviewUpdate.error && !/does not exist|schema cache/i.test(reviewUpdate.error.message)) {
    throw new Error(reviewUpdate.error.message);
  }

  await purgeSupportSelfiesForFlagIds(companyId, [flagId]).catch((error) => {
    console.error("dismiss flag selfie purge failed", error instanceof Error ? error.message : error);
  });
  revalidatePath("/attendance/integrity");
}
