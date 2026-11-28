"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAppNotification } from "@/lib/app-notifications";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { enqueueActivationAutomation } from "@/lib/lifecycle-automation";
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
    const approvesWorkforceIdentityException = action === "approve" &&
      profileType === "workforce" &&
      Boolean((current.data as { identity_exception_required?: unknown }).identity_exception_required);
    // Returning a registration requests corrections; it is not an operational
    // deactivation. Preserve the profile's existing is_active value.
    const workforceLifecycleUpdate = profileType === "workforce"
      ? action === "approve"
        ? { lifecycle_status: "active", is_active: true }
        : { lifecycle_status: "onboarding" }
      : {};
    const update = action === "approve"
      ? {
          [statusColumn]: "active",
          ...workforceLifecycleUpdate,
          profile_return_remarks: null,
          profile_returned_at: null,
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
          [statusColumn]: "returned",
          ...workforceLifecycleUpdate,
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

    if (action === "approve" && (profileType === "employee" || profileType === "contractor" || profileType === "workforce")) {
      const row = current.data as Record<string, unknown>;
      const station = row.location_id
        ? await supabaseAdmin.from("stations").select("station_code").eq("id", row.location_id).maybeSingle()
        : { data: null };
      let designationCode: string | null = null;
      let designationName = String(row.designation ?? "").trim() || null;
      if (row.designation_id) {
        const designation = await supabaseAdmin
          .from("designations")
          .select("code,name")
          .eq("id", row.designation_id)
          .maybeSingle();
        designationCode = designation.data?.code ?? null;
        designationName = designation.data?.name ?? designationName;
      }
      const isDeliveryAssociate = profileType === "workforce" &&
        /\bDA\b|DELIVERY\s*ASSOCIATE/i.test(`${designationCode || ""} ${designationName || ""}`);
      await enqueueActivationAutomation({
        companyId,
        profileType,
        profileId: id,
        pan: (row.pan_number as string | null) ?? null,
        email: (row.email as string | null) ?? null,
        fullName: (row.full_name as string | null) ?? null,
        dob: (row.date_of_birth as string | null) ?? null,
        gender: (row.gender as string | null) ?? null,
        doj: (row.date_of_join as string | null) ?? null,
        mobile: (row.mobile as string | null) ?? null,
        designation: designationName,
        designationCode,
        stationCode: station.data?.station_code ?? null,
        isDeliveryAssociate,
        fatherName: (row.father_name as string | null) ?? null,
        address: (row.address as string | null) ?? null,
        stateCode: (row.state_code as string | null) ?? null,
        state: (row.state_code as string | null) ?? null,
        pincode: ((row.pincode ?? row.postal_pin) as string | null) ?? null,
        landmark: (row.landmark as string | null) ?? null,
        drivingLicenseNo: (row.driving_license_no as string | null) ?? null,
        dlFrontPath: (row.dl_front_path as string | null) ?? null,
        dlBackPath: (row.dl_back_path as string | null) ?? null,
        dropxId: ((row.employee_code ?? row.dropx_id) as string | null) ?? null
      }).catch((error) => console.error("[people-review] activation automation", error));
    }

    revalidatePath("/people/review");
    revalidatePath(profileType === "employee"
      ? "/employees"
      : profileType === "workforce"
        ? "/workforce"
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

const profileEditReviewTypes = new Set<WorkforceProfileType>([
  "employee",
  "workforce",
  "contractor",
  "vendor"
]);

export async function reviewProfileEdit(formData: FormData) {
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
    if (!isWorkforceProfileType(profileTypeValue) || !profileEditReviewTypes.has(profileTypeValue)) {
      throw new Error("Choose a valid profile category.");
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
    const operationalProfileEditReview =
      String(currentStatus ?? "").trim().toLowerCase() === "active" &&
      current.data.profile_edit_review_pending === true &&
      current.data.is_active === true &&
      current.data.deleted_at == null &&
      current.data.deactivated_at == null &&
      (profileType !== "workforce" ||
        String(current.data.lifecycle_status ?? "").trim().toLowerCase() === "active");
    if (!operationalProfileEditReview) {
      throw new Error("Only active profiles with changes awaiting review can be reviewed here.");
    }

    const currentUpdatedAt = String(current.data.updated_at ?? "").trim();
    if (!currentUpdatedAt || currentUpdatedAt !== reviewVersion) {
      throw new Error("Profile changed while you were reviewing it. Refresh the review queue and try again.");
    }

    const reviewedAt = new Date().toISOString();
    const update = action === "approve"
      ? {
          profile_edit_review_pending: false,
          profile_return_remarks: null,
          profile_returned_at: null,
          updated_at: reviewedAt
        }
      : {
          profile_edit_review_pending: true,
          profile_return_remarks: remarks,
          profile_returned_at: reviewedAt,
          updated_at: reviewedAt
        };
    let updateQuery = supabaseAdmin
      .from(table)
      .update(update)
      .eq("id", id)
      .eq("company_id", companyId)
      .eq(statusColumn, currentStatus)
      .eq("profile_edit_review_pending", true)
      .eq("is_active", true)
      .eq("updated_at", reviewVersion);
    if (profileType === "workforce") {
      updateQuery = updateQuery
        .eq("lifecycle_status", "active")
        .is("deleted_at", null)
        .is("deactivated_at", null);
    } else {
      if (Object.prototype.hasOwnProperty.call(current.data, "deleted_at")) {
        updateQuery = updateQuery.is("deleted_at", null);
      }
      if (Object.prototype.hasOwnProperty.call(current.data, "deactivated_at")) {
        updateQuery = updateQuery.is("deactivated_at", null);
      }
    }
    const result = await updateQuery.select("id").maybeSingle();
    if (result.error) throw new Error(result.error.message);
    if (!result.data) {
      throw new Error("Profile changed while you were reviewing it. Refresh the review queue and try again.");
    }

    if (action === "return") {
      await createAppNotification({
        accountId: id,
        companyId,
        data: { remarks, profileEdit: true },
        eventCode: "profile_returned",
        profileType,
        sourceKey: `${id}:profile-edit:return:${reviewedAt}`,
        variables: { remarks }
      });
    }

    revalidatePath("/people/review");
    revalidatePath(profileType === "employee"
      ? "/employees"
      : profileType === "workforce"
        ? "/workforce"
        : nonEmployeeProfileConfigs[profileType].route);
    reviewRedirect({
      notice: action === "approve"
        ? `${profileLabel(profileType)} profile changes approved.`
        : `${profileLabel(profileType)} profile changes returned for OTP-protected correction; approval is still pending.`
    });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    reviewRedirect({ error: error instanceof Error ? error.message : "Unable to review profile changes." });
  }
}
