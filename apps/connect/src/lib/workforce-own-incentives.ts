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
      tiers: campaign.tiers ?? []
    })) : [],
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
