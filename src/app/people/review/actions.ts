"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAppNotification } from "@/lib/app-notifications";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { assignEmployeeToPosition } from "@/lib/position-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isWorkforceProfileType,
  nonEmployeeProfileConfigs,
  type WorkforceProfileType,
  workforceTable
} from "@/lib/workforce-profiles";

function reviewRedirect(params: { error?: string; notice?: string }): never {
  const search = new URLSearchParams();
  if (params.error) search.set("error", params.error);
  if (params.notice) search.set("notice", params.notice);
  redirect(`/people/review${search.size ? `?${search.toString()}` : ""}`);
}

function isNextRedirectError(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

function profileLabel(profileType: WorkforceProfileType) {
  if (profileType === "employee") return "Employee";
  if (profileType === "workforce") return "Workforce";
  return nonEmployeeProfileConfigs[profileType].label;
}

export async function reviewPeopleProfile(formData: FormData) {
  const authorization = await requirePagePermission("people_review", "edit");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) reviewRedirect({ error: "Supabase service role key is not configured." });

  const id = String(formData.get("id") ?? "").trim();
  const profileTypeValue = String(formData.get("profile_type") ?? "").trim();
  const action = String(formData.get("review_action") ?? "").trim().toLowerCase();
  const remarks = String(formData.get("return_remarks") ?? "").trim();

  try {
    if (!id) throw new Error("Profile is required.");
    if (!isWorkforceProfileType(profileTypeValue)) throw new Error("Choose a valid profile category.");
    if (profileTypeValue === "field_executive") {
      throw new Error("Workforce applicants must be reviewed through Workforce Lifecycle so agreement, provider ID and activation checks cannot be bypassed.");
    }
    if (!["approve", "return"].includes(action)) throw new Error("Choose a valid review action.");
    if (action === "return" && !remarks) throw new Error("Return remarks are required.");

    const profileType = profileTypeValue as WorkforceProfileType;
    const table = workforceTable(profileType);
    const statusColumn = profileType === "employee" ? "profile_completion_status" : "onboarding_status";
    const current = await supabaseAdmin
      .from(table)
      .select("*")
      .eq("id", id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    if (!current.data) throw new Error(`${profileLabel(profileType)} profile was not found.`);
    if (!authorization.hasAllLocationAccess &&
        !authorization.locationScopeIds.includes(String(current.data.location_id ?? ""))) {
      throw new Error("You do not have access to this profile location.");
    }
    const currentStatus = profileType === "employee"
      ? (current.data as { profile_completion_status?: unknown }).profile_completion_status
      : (current.data as { onboarding_status?: unknown }).onboarding_status;
    if (String(currentStatus ?? "").toLowerCase() !== "under_review") {
      throw new Error("Only profiles under review can be approved or returned.");
    }

    const reviewedAt = new Date().toISOString();
    const update = action === "approve"
      ? {
          [statusColumn]: "active",
          profile_return_remarks: null,
          profile_returned_at: null,
          ...(profileType === "employee" ? { profile_completed_at: reviewedAt } : {}),
          updated_at: reviewedAt
        }
      : {
          [statusColumn]: "returned",
          profile_return_remarks: remarks,
          profile_returned_at: reviewedAt,
          updated_at: reviewedAt
        };
    const result = await supabaseAdmin
      .from(table)
      .update(update)
      .eq("id", id)
      .eq("company_id", companyId);
    if (result.error) throw new Error(result.error.message);
    const orgPositionId = profileType === "employee"
      ? String((current.data as { org_position_id?: unknown }).org_position_id ?? "").trim()
      : "";
    if (action === "approve" && orgPositionId) {
      await assignEmployeeToPosition({
        actorUserId: authorization.userId,
        companyId,
        employeeId: id,
        positionId: orgPositionId,
        assignmentType: "permanent",
        reason: "Assigned when employee profile was approved"
      });
    }

    await createAppNotification({
      accountId: id,
      companyId,
      data: action === "return" ? { remarks } : {},
      eventCode: action === "approve" ? "profile_approved" : "profile_returned",
      profileType,
      sourceKey: `${id}:${action}:${reviewedAt}`,
      variables: { remarks }
    });

    revalidatePath("/people/review");
    revalidatePath(profileType === "employee"
      ? "/employees"
      : profileType === "workforce"
        ? "/field-executive"
        : nonEmployeeProfileConfigs[profileType].route);
    reviewRedirect({
      notice: action === "approve"
        ? `${profileLabel(profileType)} profile approved.`
        : `${profileLabel(profileType)} profile returned for correction.`
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    reviewRedirect({ error: error instanceof Error ? error.message : "Unable to review profile." });
  }
}
