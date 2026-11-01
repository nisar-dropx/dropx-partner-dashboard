export type WorkforceIncentiveTier = { minimum: number; amount: number };

export type WorkforceIncentivePlan = {
  id: string;
  company_id: string;
  code: string;
  name: string;
  provider_id: string | null;
  location_model_id: string | null;
  station_id: string | null;
  designation_id: string | null;
  incentive_type: "conversion" | "performance" | "attendance";
  cycle_type: "daily" | "half_monthly" | "monthly";
  metric: "delivery_conversion" | "total_delivery" | "total_activity" | "amazon_delivery" | "swa_delivery" | "c_return" | "mfn" | "attendance_compliance";
  calculation_type: "tiered_flat" | "flat_threshold" | "per_unit_above_threshold";
  threshold_value: unknown;
  rate_value: unknown;
  flat_amount: unknown;
  maximum_amount: unknown;
  minimum_activity: unknown;
  reporting_time?: string | null;
  minimum_present_days?: unknown;
  allowed_late_days?: unknown;
  attendance_required?: boolean | null;
  reporting_time_required?: boolean | null;
  attendance_threshold_type?: "minimum_days" | "maximum_absent_days" | null;
  maximum_absent_days?: unknown;
  attendance_reward_type?: "flat" | "per_shipment" | null;
  tiers: unknown;
  effective_from: string;
  effective_to: string;
  status: string;
  approved_at: string | null;
};

export type WorkforceIncentiveAttendance = {
  id: string;
  workDate: string;
  providerId: string;
  locationModelId: string | null;
  stationId: string | null;
  inTime: string | null;
};

export type WorkforceIncentiveSource = {
  id: string;
  workDate: string;
  providerId: string;
  locationModelId: string | null;
  stationId: string | null;
  totalDelivery: unknown;
  totalActivity: unknown;
  amazonDelivery: unknown;
  swaDelivery: unknown;
  customerReturn: unknown;
  mfn: unknown;
  deliveryAssignedCount: unknown;
};

export type WorkforceIncentiveCycle = {
  amount: number;
  cycleEnd: string;
  cycleKey: string;
  cycleLabel: string;
  cycleStart: string;
  denominator: number | null;
  metricValue: number;
  numerator: number | null;
  presentDays?: number;
  lateDays?: number;
  minimumPresentDays?: number;
  allowedLateDays?: number;
  reportingTime?: string;
  attendanceRequired?: boolean;
  reportingTimeRequired?: boolean;
  attendanceThresholdType?: "minimum_days" | "maximum_absent_days";
  maximumAbsentDays?: number;
  expectedDays?: number;
  reportingDays?: number;
  shipmentCount?: number;
  rewardType?: "flat" | "per_shipment";
  status: "earned" | "in_progress" | "below_minimum" | "not_qualified";
};

export type WorkforceIncentivePlanResult = {
  id: string;
  code: string;
  name: string;
  amount: number;
  cycles: WorkforceIncentiveCycle[];
};

export type WorkforceIncentiveResult = {
  amount: number;
  bySource: Map<string, number>;
  plans: WorkforceIncentivePlanResult[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const countMetrics = new Set(["total_delivery", "total_activity", "amazon_delivery", "swa_delivery", "c_return", "mfn"]);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function validDate(value: string) {
  return DATE.test(value) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function number(value: unknown, label: string) {
  const parsed = value == null ? 0 : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number.`);
  return parsed;
}

function cents(value: number) {
  const result = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(result)) throw new Error("Incentive amounts exceed the supported range.");
  return result;
}

function dateParts(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

function monthEnd(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string) {
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.floor((end - start) / 86_400_000) + 1;
}

function cycleFor(date: string, cycleType: WorkforceIncentivePlan["cycle_type"]) {
  const { year, month, day } = dateParts(date);
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  if (cycleType === "daily") return { key: date, start: date, end: date, label: `${day} ${new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)))} ${year}` };
  if (cycleType === "monthly") return { key: prefix, start: `${prefix}-01`, end: monthEnd(year, month), label: prefix };
  const second = day >= 16;
  return {
    key: `${prefix}-${second ? "H2" : "H1"}`,
    start: `${prefix}-${second ? "16" : "01"}`,
    end: second ? monthEnd(year, month) : `${prefix}-15`,
    label: `${second ? "16–" + monthEnd(year, month).slice(-2) : "1–15"} ${new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)))} ${year}`
  };
}

function tiers(value: unknown): WorkforceIncentiveTier[] {
  if (!Array.isArray(value)) throw new Error("Incentive tiers need Workforce review.");
  const parsed = value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Incentive tiers need Workforce review.");
    const row = entry as Record<string, unknown>;
    return { minimum: number(row.minimum, "Tier minimum"), amount: number(row.amount, "Tier amount") };
  }).sort((left, right) => left.minimum - right.minimum);
  if (!parsed.length || parsed.some((row, index) => index > 0 && row.minimum <= parsed[index - 1].minimum)) {
    throw new Error("Incentive tier minimums must be unique and ascending.");
  }
  return parsed;
}

function metric(source: WorkforceIncentiveSource, key: WorkforceIncentivePlan["metric"]) {
  if (key === "total_delivery") return number(source.totalDelivery, "Total delivery");
  if (key === "total_activity") return number(source.totalActivity, "Total activity");
  if (key === "amazon_delivery") return number(source.amazonDelivery, "Amazon delivery");
  if (key === "swa_delivery") return number(source.swaDelivery, "SWA delivery");
  if (key === "c_return") return number(source.customerReturn, "Customer return");
  if (key === "mfn") return number(source.mfn, "MFN");
  return 0;
}

function wholeNumber(value: unknown, label: string) {
  const parsed = number(value, label);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a whole number.`);
  return parsed;
}

function timeMinutes(value: string, label: string) {
  if (!TIME.test(value)) throw new Error(`${label} needs Workforce review.`);
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function kolkataMinutes(value: string) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("A biometric punch-in needs Workforce review.");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error("A biometric punch-in needs Workforce review.");
  return hour * 60 + minute;
}

function activePlan(plan: WorkforceIncentivePlan) {
  return plan.status === "active"
    || (plan.status === "closed" && Boolean(plan.approved_at) && Boolean(plan.effective_to));
}

export function calculateWorkforceIncentives(input: {
  companyId: string;
  designationId: string | null;
  from: string;
  to: string;
  sources: WorkforceIncentiveSource[];
  attendance?: WorkforceIncentiveAttendance[];
  plans: WorkforceIncentivePlan[];
}): WorkforceIncentiveResult {
  if (!validDate(input.from) || !validDate(input.to) || input.from > input.to) throw new Error("Invalid incentive period.");
  const hasApplicablePlan = input.plans.some((plan) =>
    activePlan(plan)
    && (!plan.designation_id || plan.designation_id === input.designationId)
    && plan.effective_from <= input.to
    && plan.effective_to >= input.from);
  if (!hasApplicablePlan) return { amount: 0, bySource: new Map(), plans: [] };
  const bySource = new Map<string, number>();
  for (const source of input.sources) {
    if (!source.id || bySource.has(source.id) || !validDate(source.workDate) || source.workDate < input.from || source.workDate > input.to || !source.providerId) {
      throw new Error("Duplicate or invalid incentive source needs Workforce review.");
    }
    number(source.deliveryAssignedCount, "Delivery assigned count");
    for (const key of countMetrics) {
      const value = metric(source, key as WorkforceIncentivePlan["metric"]);
      if (!Number.isSafeInteger(value)) throw new Error("Incentive activity counts need Workforce review.");
    }
    bySource.set(source.id, 0);
  }
  const attendance = input.attendance ?? [];
  const seenAttendance = new Set<string>();
  for (const record of attendance) {
    if (!record.id || seenAttendance.has(record.id) || !validDate(record.workDate) || record.workDate < input.from || record.workDate > input.to || !record.providerId) {
      throw new Error("Duplicate or invalid attendance incentive source needs Workforce review.");
    }
    if (record.inTime !== null) kolkataMinutes(record.inTime);
    seenAttendance.add(record.id);
  }

  const seenPlans = new Set<string>();
  const planResults: WorkforceIncentivePlanResult[] = [];
  let totalCents = 0;
  for (const plan of input.plans) {
    if (!plan.id || plan.company_id !== input.companyId || seenPlans.has(plan.id)) throw new Error("Incentive plan scope or identity could not be verified.");
    seenPlans.add(plan.id);
    if (!activePlan(plan) || (plan.designation_id && plan.designation_id !== input.designationId)) continue;
    if (!validDate(plan.effective_from) || !validDate(plan.effective_to) || plan.effective_from > plan.effective_to) throw new Error("An incentive plan date needs Workforce review.");
    if (!["daily", "half_monthly", "monthly"].includes(plan.cycle_type) || !["tiered_flat", "flat_threshold", "per_unit_above_threshold"].includes(plan.calculation_type)) {
      throw new Error("An incentive policy needs Workforce review.");
    }
    if (plan.incentive_type === "conversion" && (plan.metric !== "delivery_conversion" || plan.calculation_type !== "tiered_flat" || plan.cycle_type !== "half_monthly")) {
      throw new Error("A conversion incentive plan needs Workforce review.");
    }
    if (plan.incentive_type === "performance" && !countMetrics.has(plan.metric)) throw new Error("A performance incentive metric needs Workforce review.");
    if (plan.incentive_type === "attendance" && (plan.metric !== "attendance_compliance" || plan.calculation_type !== "flat_threshold" || !["half_monthly", "monthly"].includes(plan.cycle_type))) {
      throw new Error("An attendance incentive plan needs Workforce review.");
    }
    const minimumActivity = number(plan.minimum_activity, "Minimum activity");
    const planTiers = plan.calculation_type === "tiered_flat" ? tiers(plan.tiers) : [];
    const threshold = number(plan.threshold_value, "Threshold");
    const rate = number(plan.rate_value, "Rate");
    const flat = number(plan.flat_amount, "Flat amount");
    const maximum = plan.maximum_amount == null ? null : number(plan.maximum_amount, "Maximum amount");

    if (plan.incentive_type === "attendance") {
      const attendanceRequired = plan.attendance_required !== false;
      const reportingTimeRequired = plan.reporting_time_required !== false;
      if (!attendanceRequired && !reportingTimeRequired) throw new Error("An attendance incentive plan needs at least one eligibility rule.");
      const reportingTime = reportingTimeRequired ? String(plan.reporting_time ?? "").slice(0, 8) : "";
      const reportingMinutes = reportingTimeRequired ? timeMinutes(reportingTime, "Reporting time") : null;
      const minimumPresentDays = wholeNumber(plan.minimum_present_days, "Minimum reporting days");
      const allowedLateDays = wholeNumber(plan.allowed_late_days, "Allowed late days");
      const thresholdType = plan.attendance_threshold_type === "maximum_absent_days" ? "maximum_absent_days" : "minimum_days";
      const maximumAbsentDays = wholeNumber(plan.maximum_absent_days, "Allowed absent days");
      const rewardType = plan.attendance_reward_type === "per_shipment" ? "per_shipment" : "flat";
      if ((attendanceRequired && thresholdType === "minimum_days" && minimumPresentDays <= 0)
        || (rewardType === "flat" ? flat <= 0 : rate <= 0)) throw new Error("An attendance incentive plan needs Workforce review.");
      const eligibleAttendance = attendance.filter((record) =>
        record.workDate >= plan.effective_from && record.workDate <= plan.effective_to
        && (!plan.provider_id || plan.provider_id === record.providerId)
        && (!plan.location_model_id || plan.location_model_id === record.locationModelId)
        && (!plan.station_id || plan.station_id === record.stationId));
      const eligibleSources = input.sources.filter((source) =>
        source.workDate >= plan.effective_from && source.workDate <= plan.effective_to
        && (!plan.provider_id || plan.provider_id === source.providerId)
        && (!plan.location_model_id || plan.location_model_id === source.locationModelId)
        && (!plan.station_id || plan.station_id === source.stationId));
      if (!eligibleAttendance.length && !eligibleSources.length) continue;
      const grouped = new Map<string, { cycle: ReturnType<typeof cycleFor>; records: WorkforceIncentiveAttendance[]; sources: WorkforceIncentiveSource[] }>();
      for (const record of eligibleAttendance) {
        const cycle = cycleFor(record.workDate, plan.cycle_type);
        const current = grouped.get(cycle.key) ?? { cycle, records: [], sources: [] };
        current.records.push(record);
        grouped.set(cycle.key, current);
      }
      for (const source of eligibleSources) {
        const cycle = cycleFor(source.workDate, plan.cycle_type);
        const current = grouped.get(cycle.key) ?? { cycle, records: [], sources: [] };
        current.sources.push(source);
        grouped.set(cycle.key, current);
      }
      const cycles: WorkforceIncentiveCycle[] = [];
      let planCents = 0;
      for (const group of [...grouped.values()].sort((left, right) => left.cycle.start.localeCompare(right.cycle.start))) {
        const punches = new Map<string, string>();
        for (const record of group.records) {
          if (!record.inTime) continue;
          const current = punches.get(record.workDate);
          if (!current || new Date(record.inTime).getTime() < new Date(current).getTime()) punches.set(record.workDate, record.inTime);
        }
        const presentDays = punches.size;
        const evaluationStart = [group.cycle.start, plan.effective_from, input.from].sort().at(-1) as string;
        const evaluationEnd = [group.cycle.end, plan.effective_to].sort().at(0) as string;
        const expectedDays = daysInclusive(evaluationStart, evaluationEnd);
        const requiredPresentDays = attendanceRequired
          ? thresholdType === "maximum_absent_days" ? Math.max(expectedDays - maximumAbsentDays, 0) : minimumPresentDays
          : 0;
        const activityDays = new Set(group.sources.filter((source) =>
          number(source.totalActivity, "Total activity") > 0 || number(source.totalDelivery, "Total delivery") > 0).map((source) => source.workDate));
        const reportingDays = new Set([...activityDays, ...punches.keys()]);
        const cutoffMissDays = new Set<string>();
        if (reportingTimeRequired && reportingMinutes !== null) {
          for (const day of reportingDays) {
            const punch = punches.get(day);
            if (!punch || kolkataMinutes(punch) > reportingMinutes) cutoffMissDays.add(day);
          }
        }
        const lateDays = cutoffMissDays.size;
        const shipmentCount = group.sources.reduce((sum, source) => sum + number(source.totalDelivery, "Total delivery"), 0);
        const complete = evaluationEnd <= input.to;
        const attendanceQualified = !attendanceRequired || presentDays >= requiredPresentDays;
        const reportingQualified = !reportingTimeRequired || (reportingDays.size > 0 && lateDays <= allowedLateDays);
        const reward = rewardType === "per_shipment" ? shipmentCount * rate : flat;
        const qualified = attendanceQualified && reportingQualified && (rewardType !== "per_shipment" || shipmentCount > 0);
        const awardCents = complete && qualified ? cents(maximum === null ? reward : Math.min(reward, maximum)) : 0;
        const status: WorkforceIncentiveCycle["status"] = !complete
          ? "in_progress"
          : attendanceRequired && presentDays < requiredPresentDays ? "below_minimum" : qualified ? "earned" : "not_qualified";
        cycles.push({
          amount: awardCents / 100,
          cycleEnd: group.cycle.end,
          cycleKey: group.cycle.key,
          cycleLabel: group.cycle.label,
          cycleStart: group.cycle.start,
          denominator: attendanceRequired ? requiredPresentDays : reportingDays.size,
          metricValue: presentDays,
          numerator: presentDays,
          presentDays,
          lateDays,
          minimumPresentDays: requiredPresentDays,
          allowedLateDays,
          reportingTime: reportingTimeRequired ? reportingTime.slice(0, 5) : undefined,
          attendanceRequired,
          reportingTimeRequired,
          attendanceThresholdType: thresholdType,
          maximumAbsentDays,
          expectedDays,
          reportingDays: reportingDays.size,
          shipmentCount,
          rewardType,
          status
        });
        if (awardCents && group.sources.length) {
          const weights = group.sources.map((source) => rewardType === "per_shipment"
            ? number(source.totalDelivery, "Total delivery")
            : Math.max(number(source.totalActivity, "Total activity"), number(source.totalDelivery, "Total delivery")));
          const weightTotal = weights.reduce((sum, value) => sum + value, 0);
          let distributed = 0;
          group.sources.forEach((source, index) => {
            const portion = index === group.sources.length - 1
              ? awardCents - distributed
              : Math.floor(awardCents * (weightTotal > 0 ? weights[index] / weightTotal : 1 / group.sources.length));
            distributed += portion;
            bySource.set(source.id, (cents(bySource.get(source.id) ?? 0) + portion) / 100);
          });
        }
        planCents += awardCents;
      }
      totalCents += planCents;
      planResults.push({ id: plan.id, code: plan.code, name: plan.name, amount: planCents / 100, cycles });
      continue;
    }

    const eligibleSources = input.sources.filter((source) =>
      source.workDate >= plan.effective_from && source.workDate <= plan.effective_to
      && (!plan.provider_id || plan.provider_id === source.providerId)
      && (!plan.location_model_id || plan.location_model_id === source.locationModelId)
      && (!plan.station_id || plan.station_id === source.stationId));
    if (!eligibleSources.length) continue;
    const grouped = new Map<string, { cycle: ReturnType<typeof cycleFor>; sources: WorkforceIncentiveSource[] }>();
    for (const source of eligibleSources) {
      const cycle = cycleFor(source.workDate, plan.cycle_type);
      const current = grouped.get(cycle.key) ?? { cycle, sources: [] };
      current.sources.push(source);
      grouped.set(cycle.key, current);
    }
    const cycles: WorkforceIncentiveCycle[] = [];
    let planCents = 0;
    for (const group of [...grouped.values()].sort((left, right) => left.cycle.start.localeCompare(right.cycle.start))) {
      group.sources.sort((left, right) => left.id.localeCompare(right.id));
      const complete = group.cycle.end <= input.to;
      const numerator = plan.metric === "delivery_conversion"
        ? group.sources.reduce((sum, source) => sum + number(source.totalDelivery, "Total delivery"), 0)
        : null;
      const denominator = plan.metric === "delivery_conversion"
        ? group.sources.reduce((sum, source) => sum + number(source.deliveryAssignedCount, "Delivery assigned count"), 0)
        : null;
      const metricValue = plan.metric === "delivery_conversion"
        ? denominator && denominator > 0 ? (Number(numerator) / denominator) * 100 : 0
        : group.sources.reduce((sum, source) => sum + metric(source, plan.metric), 0);
      const activity = plan.metric === "delivery_conversion" ? Number(denominator ?? 0) : metricValue;
      let award = 0;
      if (complete && activity >= minimumActivity) {
        if (plan.calculation_type === "tiered_flat") {
          award = [...planTiers].reverse().find((tier) => metricValue >= tier.minimum)?.amount ?? 0;
        } else if (plan.calculation_type === "flat_threshold") {
          award = metricValue >= threshold ? flat : 0;
        } else {
          award = Math.max(metricValue - threshold, 0) * rate;
        }
      }
      if (maximum !== null) award = Math.min(award, maximum);
      const awardCents = cents(award);
      const status: WorkforceIncentiveCycle["status"] = !complete
        ? "in_progress"
        : activity < minimumActivity
          ? "below_minimum"
          : awardCents > 0 ? "earned" : "not_qualified";
      cycles.push({
        amount: awardCents / 100,
        cycleEnd: group.cycle.end,
        cycleKey: group.cycle.key,
        cycleLabel: group.cycle.label,
        cycleStart: group.cycle.start,
        denominator,
        metricValue: Math.round(metricValue * 100) / 100,
        numerator,
        status
      });
      if (!awardCents) continue;
      const weights = group.sources.map((source) => plan.metric === "delivery_conversion"
        ? number(source.deliveryAssignedCount, "Delivery assigned count")
        : Math.max(metric(source, plan.metric), number(source.totalActivity, "Total activity")));
      const weightTotal = weights.reduce((sum, value) => sum + value, 0);
      let distributed = 0;
      group.sources.forEach((source, index) => {
        const portion = index === group.sources.length - 1
          ? awardCents - distributed
          : Math.floor(awardCents * (weightTotal > 0 ? weights[index] / weightTotal : 1 / group.sources.length));
        distributed += portion;
        bySource.set(source.id, (cents(bySource.get(source.id) ?? 0) + portion) / 100);
      });
      planCents += awardCents;
    }
    totalCents += planCents;
    planResults.push({ id: plan.id, code: plan.code, name: plan.name, amount: planCents / 100, cycles });
  }
  return { amount: totalCents / 100, bySource, plans: planResults };
}
