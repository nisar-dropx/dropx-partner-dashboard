import "server-only";

import { paymentRoutingDay } from "@/lib/payment-delegation-policy";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Position = {
  id: string;
  reports_to_position_id: string | null;
};

type Assignment = {
  is_active: boolean;
  position_id: string;
  profile_id: string;
  valid_from: string;
  valid_until: string | null;
};

type Profile = {
  id: string;
  reports_to_user_id: string | null;
};

export type PaymentReportingHierarchy = {
  isSameOrAbove(managerUserId: string | null | undefined, reportUserId: string | null | undefined): boolean;
  isStrictlyAbove(managerUserId: string | null | undefined, reportUserId: string | null | undefined): boolean;
};

function reaches(start: string, target: string, parentById: ReadonlyMap<string, string | null>) {
  const visited = new Set<string>();
  let current: string | null | undefined = start;
  while (current && !visited.has(current)) {
    if (current === target) return true;
    visited.add(current);
    current = parentById.get(current);
  }
  return false;
}

/**
 * Payment take-over authority comes only from the active People reporting
 * tree. Position assignments are authoritative when both people have them;
 * profiles.reports_to_user_id is retained solely for legacy People records
 * that have not yet been moved to positions.
 */
export async function loadPaymentReportingHierarchy(companyId: string, at = new Date()): Promise<PaymentReportingHierarchy> {
  const denyAll: PaymentReportingHierarchy = {
    isSameOrAbove: (manager, report) => Boolean(manager && report && manager === report),
    isStrictlyAbove: () => false
  };
  if (!supabaseAdmin) return denyAll;

  const [positionsResult, assignmentsResult, profilesResult] = await Promise.all([
    supabaseAdmin
      .from("org_positions")
      .select("id,reports_to_position_id")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("position_assignments")
      .select("position_id,profile_id,valid_from,valid_until,is_active")
      .eq("company_id", companyId)
      .eq("is_active", true),
    supabaseAdmin
      .from("profiles")
      .select("id,reports_to_user_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
  ]);
  if (positionsResult.error || assignmentsResult.error || profilesResult.error) {
    throw new Error("Could not verify the active People reporting hierarchy.");
  }

  const day = paymentRoutingDay(at);
  const positions = (positionsResult.data ?? []) as Position[];
  const assignments = ((assignmentsResult.data ?? []) as Assignment[]).filter((assignment) => (
    assignment.is_active &&
    assignment.valid_from <= day &&
    (!assignment.valid_until || assignment.valid_until >= day)
  ));
  const profiles = (profilesResult.data ?? []) as Profile[];
  const parentPositionById = new Map(positions.map((position) => [position.id, position.reports_to_position_id]));
  const positionsByUser = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    if (!parentPositionById.has(assignment.position_id)) continue;
    const current = positionsByUser.get(assignment.profile_id) ?? new Set<string>();
    current.add(assignment.position_id);
    positionsByUser.set(assignment.profile_id, current);
  }
  const managerByUser = new Map(profiles.map((profile) => [profile.id, profile.reports_to_user_id]));

  function strictlyAbove(managerUserId: string | null | undefined, reportUserId: string | null | undefined) {
    if (!managerUserId || !reportUserId || managerUserId === reportUserId) return false;
    const managerPositions = positionsByUser.get(managerUserId);
    const reportPositions = positionsByUser.get(reportUserId);

    if (managerPositions?.size && reportPositions?.size) {
      for (const reportPosition of reportPositions) {
        for (const managerPosition of managerPositions) {
          if (reportPosition !== managerPosition && reaches(reportPosition, managerPosition, parentPositionById)) return true;
        }
      }
      // Both people are represented in the position tree. A stale legacy
      // reports_to_user_id must never create a cross-tree approval path.
      return false;
    }

    return reaches(reportUserId, managerUserId, managerByUser);
  }

  return {
    isSameOrAbove: (manager, report) => Boolean(manager && report && (manager === report || strictlyAbove(manager, report))),
    isStrictlyAbove: strictlyAbove
  };
}
