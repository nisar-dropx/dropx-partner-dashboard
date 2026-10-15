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
  const reviewVersion = String(formData.get("review_version") ?? "").trim();
  const remarks = String(formData.get("return_remarks") ?? "").trim();

  try {
    if (!id) throw new Error("Profile is required.");
    if (!isWorkforceProfileType(profileTypeValue)) throw new Error("Choose a valid profile category.");
    if (profileTypeValue === "field_executive") {
      throw new Error("Workforce applicants must be reviewed through Workforce Lifecycle so agreement, provider ID and activation checks cannot be bypassed.");
    }
    if (!["approve", "return"].includes(action)) throw new Error("Choose a valid review action.");
    if (!reviewVersion) throw new Error("Profile review version is unavailable. Refresh the review queue and try again.");
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
    const returnedProfileEdit = current.data.profile_edit_review_pending === true;
    if (String(currentStatus ?? "").toLowerCase() !== "under_review" && !returnedProfileEdit) {
      throw new Error("Only profiles under review can be approved or returned.");
    }
    const currentUpdatedAt = String(current.data.updated_at ?? "").trim();
    if (!currentUpdatedAt) {
      throw new Error("Profile review version is unavailable. Refresh the review queue and try again.");
    }
    if (currentUpdatedAt !== reviewVersion) {
      throw new Error("Profile changed while you were reviewing it. Refresh the review queue and try again.");
    }

    const supportsProfileEditReview = Object.prototype.hasOwnProperty.call(
      current.data,
      "profile_edit_review_pending"
    );

    const reviewedAt = new Date().toISOString();
    const approvesWorkforceIdentityException = action === "approve" &&
      profileType === "workforce" &&
      Boolean((current.data as { identity_exception_required?: unknown }).identity_exception_required);
    const workforceLifecycleUpdate = profileType === "workforce"
      ? action === "approve" || returnedProfileEdit
        ? { lifecycle_status: "active", is_active: true }
        : { lifecycle_status: "onboarding", is_active: false }
      : {};
    const update = action === "approve"
      ? {
          [statusColumn]: "active",
          ...workforceLifecycleUpdate,
          profile_return_remarks: null,
          profile_returned_at: null,
          ...(supportsProfileEditReview ? { profile_edit_review_pending: false } : {}),
          ...(profileType === "employee" ? { profile_completed_at: reviewedAt } : {}),
          ...(approvesWorkforceIdentityException
            ? {
                identity_exception_approved_at: reviewedAt,
                identity_exception_approved_by: authorization.userId
              }
            : {}),
          updated_at: reviewedAt
        }
      : {
          // A returned self-edit remains operationally active and stays in the
          // independent review queue until an administrator approves it. The
          // user can correct it only through the OTP-protected self-edit flow.
          [statusColumn]: returnedProfileEdit ? "active" : "returned",
          ...workforceLifecycleUpdate,
          profile_return_remarks: remarks,
          profile_returned_at: reviewedAt,
          ...(returnedProfileEdit ? { profile_edit_review_pending: true } : {}),
          updated_at: reviewedAt
        };
    let updateQuery = supabaseAdmin
      .from(table)
      .update(update)
      .eq("id", id)
      .eq("company_id", companyId)
      .eq(statusColumn, currentStatus)
      .eq("updated_at", reviewVersion);
    if (supportsProfileEditReview) {
      updateQuery = updateQuery.eq("profile_edit_review_pending", returnedProfileEdit);
    }
    const result = await updateQuery
      .select("id")
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) {
      throw new Error("Profile changed while you were reviewing it. Refresh the review queue and try again.");
    }
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
      data: action === "return" ? { remarks, profileEdit: returnedProfileEdit } : {},
      eventCode: action === "approve" ? "profile_approved" : "profile_returned",
      profileType,
      sourceKey: `${id}:${action}:${reviewedAt}`,
      variables: { remarks }
    });

    revalidatePath("/people/review");
    revalidatePath(profileType === "employee"
      ? "/employees"
      : profileType === "workforce"
        ? "/workforce"
        : nonEmployeeProfileConfigs[profileType].route);
    reviewRedirect({
      notice: action === "approve"
        ? `${profileLabel(profileType)} profile approved.`
        : returnedProfileEdit
          ? `${profileLabel(profileType)} profile changes returned for OTP-protected correction; approval is still pending.`
          : `${profileLabel(profileType)} profile returned for correction.`
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    reviewRedirect({ error: error instanceof Error ? error.message : "Unable to review profile." });
  }
}
