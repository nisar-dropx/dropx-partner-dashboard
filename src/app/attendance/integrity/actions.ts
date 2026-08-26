"use server";

import { revalidatePath } from "next/cache";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { resolveIntegrityFlag } from "@/lib/biometric/attendance-gps";
import { supabaseAdmin } from "@/lib/supabase-admin";

function clean(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export async function reviewAttendanceLocationPackage(formData: FormData) {
  const authorization = await requirePagePermission("attendance_integrity", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const reviewId = clean(formData.get("review_id"));
  const action = clean(formData.get("review_action")).toLowerCase();
  const remarks = clean(formData.get("review_remarks"));
  if (!reviewId) throw new Error("Review id is required.");
  if (!["approve", "return", "reject"].includes(action)) throw new Error("Choose a valid review action.");
  if ((action === "return" || action === "reject") && remarks.length < 3) {
    throw new Error("Enter review remarks.");
  }

  const existing = await supabaseAdmin
    .from("attendance_location_reviews")
    .select("id, status, flag_id, company_id")
    .eq("id", reviewId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (!existing.data) throw new Error("Support package not found.");
  if (!["pending", "returned"].includes(String(existing.data.status))) {
    throw new Error("This support package has already been decided.");
  }

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
    await resolveIntegrityFlag(String(existing.data.flag_id), authorization.userId);
  }

  revalidatePath("/attendance/integrity");
}

export async function dismissAttendanceIntegrityFlag(formData: FormData) {
  const authorization = await requirePagePermission("attendance_integrity", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const flagId = clean(formData.get("flag_id"));
  if (!flagId) throw new Error("Flag id is required.");
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
  revalidatePath("/attendance/integrity");
}
