import "server-only";
import { cache } from "react";
import { hasPermission, isCompanyOwner, type AuthorizationContext } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { reviewCapabilities, reviewRole, reviewRoutingIssue } from "@/lib/ops-pulse/review-policy";

export const loadReviewActor = cache(async (companyId: string, userId: string, roleCode: string | null, roleName: string | null) => {
  if (!supabaseAdmin) throw new Error("Review access is unavailable.");
  const link = await supabaseAdmin.from("hr_user_person_links").select("person_id")
    .eq("company_id", companyId).eq("user_id", userId).eq("status", "active").maybeSingle();
  if (link.error) throw new Error("Unable to check your People role.");
  let labels: string[] = [];
  let displayLabel: string | null = null;
  if (link.data?.person_id) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const result = await supabaseAdmin.from("hr_work_assignments")
      .select("position_title,designations(code,name),hr_engagements!inner(person_id,status)")
      .eq("company_id", companyId).eq("hr_engagements.person_id", link.data.person_id)
      .eq("hr_engagements.status", "active").eq("is_primary", true)
      .lte("effective_from", day).or(`effective_to.is.null,effective_to.gte.${day}`);
    if (result.error) throw new Error("Unable to check your People designation.");
    labels = (result.data ?? []).map((row) => {
      const designation = Array.isArray(row.designations) ? row.designations[0] : row.designations;
      displayLabel ??= designation?.name || row.position_title || null;
      return `${designation?.code ?? ""} ${designation?.name ?? ""} ${row.position_title ?? ""}`.trim();
    });
  }
  // People is authoritative for named people; station logins use their existing portal role.
  const roleLabels = labels.length ? labels : [`${roleCode ?? ""} ${roleName ?? ""}`];
  return {
    programManager: roleLabels.some((label) => reviewRole(label) === "program"),
    nationalHead: roleLabels.some((label) => reviewRole(label) === "national"),
    tech: roleLabels.some((label) => reviewRole(label) === "tech") || ["TECH", "OPERATIONS_TECH"].includes(roleCode ?? ""),
    stationUser: roleLabels.some((label) => reviewRole(label) === "station"),
    label: displayLabel || roleName || "Reviewer"
  };
});

export async function getReviewAccess(
  authorization: AuthorizationContext,
  stationId: string,
  review: { status: string; current_step_order: number } | null,
  steps: { step_order: number; reviewer_user_id: string | null; reviewer_role: string; status: string; bypassed_at?: string | null; proxy_reviewer_user_id?: string | null }[],
  options?: { inScope?: boolean }
) {
  const actor = await loadReviewActor(authorization.companyId!, authorization.userId, authorization.roleCode, authorization.roleName);
  const pendingSteps = steps.filter((step) => step.status !== "skipped" && ["cluster","aom","national"].includes(reviewRole(step.reviewer_role))).sort((a, b) => a.step_order - b.step_order);
  const current = pendingSteps.find((step) => step.step_order === review?.current_step_order && step.status === "pending");
  // Review Desk already filtered the station into permittedLocations — trust that over a second scope check.
  const inScope = options?.inScope ?? (authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(stationId));
  const capabilities = reviewCapabilities({
    userId: authorization.userId,
    owner: isCompanyOwner(authorization) || /managing[ _]partner/i.test(`${authorization.roleCode} ${authorization.roleName}`),
    programManager: actor.programManager,
    nationalHead: actor.nationalHead,
    tech: actor.tech,
    stationUser: actor.stationUser,
    inScope,
    canView: hasPermission(authorization, "performance_review", "access"),
    canAdd: hasPermission(authorization, "performance_review", "add"),
    canEdit: hasPermission(authorization, "performance_review", "edit"),
    closed: review?.status === "closed",
    firstReviewerId: pendingSteps[0]?.reviewer_user_id ?? null,
    currentReviewerId: current?.proxy_reviewer_user_id || current?.reviewer_user_id || null,
    currentIsFirst: current?.step_order === pendingSteps[0]?.step_order,
    hasProxy: Boolean(current?.proxy_reviewer_user_id),
    higherReviewer: pendingSteps.some(step => step.reviewer_user_id === authorization.userId && step.step_order > (current?.step_order ?? pendingSteps[0]?.step_order ?? 0)),
    currentRole: current?.reviewer_role ?? null
  });
  const routingIssue = reviewRoutingIssue(steps);
  return { actor, routingIssue, ...capabilities, canComplete: capabilities.canComplete && !routingIssue };
}
