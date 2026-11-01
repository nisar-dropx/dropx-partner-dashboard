import {
  calculateWorkforceIncentives,
  type WorkforceIncentiveCycle,
  type WorkforceIncentivePlan
} from "../../../../src/lib/workforce-incentive-calculation.ts";

/** DropX One projection of the same plan engine used by the payout worksheet. */
export type OwnCampaign = WorkforceIncentivePlan;
export type IncentiveSource = {
  id: string;
  work_date: string;
  provider_id: string;
  location_model_id: string | null;
  station_id: string | null;
  total_delivery: unknown;
  total_activity: unknown;
  amazon_delivery: unknown;
  swa_delivery: unknown;
  c_return: unknown;
  mfn: unknown;
  delivery_assigned_count: unknown;
};
export type IncentiveAttendance = {
  id: string;
  work_date: string;
  provider_id: string;
  location_model_id: string | null;
  station_id: string | null;
  in_time: string | null;
};
export type OwnIncentiveSummary = {
  amount: number;
  campaigns: Array<{
    id: string;
    name: string;
    amount: number;
    workDays: number;
    cycles: WorkforceIncentiveCycle[];
  }>;
};

export function ownIncentives(input: {
  companyId: string;
  canonical: boolean;
  designationId: string | null;
  from: string;
  to: string;
  sources: IncentiveSource[];
  attendance?: IncentiveAttendance[];
  campaigns: OwnCampaign[];
}) {
  const result = calculateWorkforceIncentives({
    companyId: input.companyId,
    designationId: input.designationId,
    from: input.from,
    to: input.to,
    plans: input.canonical ? input.campaigns.map((campaign) => ({
      ...campaign,
      code: campaign.code || campaign.id,
      location_model_id: campaign.location_model_id ?? null,
      incentive_type: campaign.incentive_type ?? "performance",
      cycle_type: campaign.cycle_type ?? "daily",
      minimum_activity: campaign.minimum_activity ?? 0,
      minimum_present_days: campaign.minimum_present_days ?? 0,
      allowed_late_days: campaign.allowed_late_days ?? 0,
      attendance_required: campaign.attendance_required ?? true,
      reporting_time_required: campaign.reporting_time_required ?? true,
      attendance_threshold_type: campaign.attendance_threshold_type ?? "minimum_days",
      maximum_absent_days: campaign.maximum_absent_days ?? 0,
      attendance_reward_type: campaign.attendance_reward_type ?? "flat",
      tiers: campaign.tiers ?? []
    })) : [],
    attendance: (input.attendance ?? []).map((record) => ({
      id: record.id,
      workDate: record.work_date,
      providerId: record.provider_id,
      locationModelId: record.location_model_id,
      stationId: record.station_id,
      inTime: record.in_time
    })),
    sources: input.sources.map((source) => ({
      id: source.id,
      workDate: source.work_date,
      providerId: source.provider_id,
      locationModelId: source.location_model_id,
      stationId: source.station_id,
      totalDelivery: source.total_delivery,
      totalActivity: source.total_activity,
      amazonDelivery: source.amazon_delivery,
      swaDelivery: source.swa_delivery,
      customerReturn: source.c_return,
      mfn: source.mfn,
      deliveryAssignedCount: source.delivery_assigned_count ?? 0
    }))
  });
  return {
    bySource: result.bySource,
    summary: {
      amount: result.amount,
      campaigns: result.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        amount: plan.amount,
        workDays: plan.cycles.filter((cycle) => cycle.status === "earned").length,
        cycles: plan.cycles
      }))
    } satisfies OwnIncentiveSummary
  };
}
