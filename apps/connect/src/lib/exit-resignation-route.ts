import {
  type DesignationLabel,
  isBusinessOrNationalHeadDesignation,
  isClusterManagerDesignation,
  isFinanceHeadDesignation,
  isFloorResignationDesignation,
  isHrPeopleDesignation,
  isManagingPartnerDesignation
} from "./approval-designation-labels";

export type ResignationTier = "floor" | "mid" | "business_head" | "hr" | "managing_partner";

export type ResignationSeatKind = "cluster_manager" | "business_head" | "hr" | "managing_partner";

export type PlannedResignationSeat = {
  kind: ResignationSeatKind;
  label: string;
  skippable: boolean;
};

export type ChainManagerSeat = {
  userId: string;
  name: string;
  positionTitle?: string | null;
  designation: DesignationLabel | null;
};

export type ResolvedResignationSeat =
  | {
      kind: ResignationSeatKind;
      label: string;
      status: "resolved";
      assignedUserId: string | null;
      approverSource: "reporting_manager" | "role";
      approverRole: "REPORTING_MANAGER" | "HR_MANAGER" | "OWNER";
      detail: string;
    }
  | {
      kind: ResignationSeatKind;
      label: string;
      status: "skipped";
      reason: string;
    };

export function classifyResignationTier(designation: DesignationLabel | null | undefined): ResignationTier {
  if (isManagingPartnerDesignation(designation)) return "managing_partner";
  if (isHrPeopleDesignation(designation)) return "hr";
  if (isBusinessOrNationalHeadDesignation(designation) || isFinanceHeadDesignation(designation)) return "business_head";
  if (isFloorResignationDesignation(designation)) return "floor";
  return "mid";
}

export function planResignationSeats(tier: ResignationTier): PlannedResignationSeat[] {
  switch (tier) {
    case "floor":
      return [
        { kind: "cluster_manager", label: "Cluster Manager", skippable: true },
        { kind: "business_head", label: "Business / National Head", skippable: true },
        { kind: "hr", label: "HR approval", skippable: false }
      ];
    case "mid":
      return [
        { kind: "business_head", label: "Business / National Head", skippable: true },
        { kind: "hr", label: "HR approval", skippable: false }
      ];
    case "business_head":
      return [{ kind: "hr", label: "HR approval", skippable: false }];
    case "hr":
      return [{ kind: "managing_partner", label: "Managing Partner", skippable: false }];
    case "managing_partner":
      return [{ kind: "managing_partner", label: "Owner / Managing Partner", skippable: false }];
  }
}

function matchesSeatKind(kind: ResignationSeatKind, designation: DesignationLabel | null | undefined) {
  if (kind === "cluster_manager") return isClusterManagerDesignation(designation);
  if (kind === "business_head") return isBusinessOrNationalHeadDesignation(designation);
  return false;
}

export function resolveResignationSeats(input: {
  seats: PlannedResignationSeat[];
  chain: ChainManagerSeat[];
}): { resolved: ResolvedResignationSeat[]; skipped: Array<{ kind: ResignationSeatKind; label: string; reason: string }> } {
  const resolved: ResolvedResignationSeat[] = [];
  const skipped: Array<{ kind: ResignationSeatKind; label: string; reason: string }> = [];
  const usedUserIds = new Set<string>();

  for (const seat of input.seats) {
    if (seat.kind === "cluster_manager" || seat.kind === "business_head") {
      const match = input.chain.find((row) => !usedUserIds.has(row.userId) && matchesSeatKind(seat.kind, row.designation));
      if (!match) {
        const reason = `${seat.label} was not found in the reporting line`;
        skipped.push({ kind: seat.kind, label: seat.label, reason });
        resolved.push({ kind: seat.kind, label: seat.label, status: "skipped", reason });
        continue;
      }
      usedUserIds.add(match.userId);
      resolved.push({
        kind: seat.kind,
        label: seat.label,
        status: "resolved",
        assignedUserId: match.userId,
        approverSource: "reporting_manager",
        approverRole: "REPORTING_MANAGER",
        detail: match.positionTitle || match.designation?.name || seat.label
      });
      continue;
    }

    resolved.push({
      kind: seat.kind,
      label: seat.label,
      status: "resolved",
      assignedUserId: null,
      approverSource: "role",
      approverRole: seat.kind === "managing_partner" ? "OWNER" : "HR_MANAGER",
      detail: seat.kind === "managing_partner" ? "Managing Partner / Owner queue" : "Shared HR approval queue"
    });
  }

  const active = resolved.filter((row) => row.status === "resolved");
  if (!active.length) {
    resolved.push({
      kind: "hr",
      label: "HR approval",
      status: "resolved",
      assignedUserId: null,
      approverSource: "role",
      approverRole: "HR_MANAGER",
      detail: "Shared HR approval queue (fallback)"
    });
  }

  return { resolved, skipped };
}

export function resignationRouteSummary(resolved: ResolvedResignationSeat[]) {
  return resolved
    .filter((row) => row.status === "resolved")
    .map((row) => row.label)
    .join(" → ");
}
