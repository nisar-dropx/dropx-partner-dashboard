import { mappingProfileState, type MappingProfileState } from "./mapping-profile-status.ts";
export type ProviderMappingSummaryStatus =
  | "ready"
  | "unmapped"
  | "identity_missing"
  | "payment_missing"
  | "partial_coverage"
  | "source_missing";

export type ProviderMappingSummaryStationInput = {
  id: string;
  code: string;
  name?: string | null;
  cluster?: string | null;
  clusterKeys?: string[];
  region?: string | null;
};

export type ProviderMappingSummarySourceInput = {
  providerMemberId: string;
  providerMemberName?: string | null;
  stationCode: string;
  workDate?: string | null;
  outboundMonths?: string[] | null;
  outboundDates?: string[] | null;
};

export type ProviderMappingSummaryMappingInput = {
  id: string;
  stationId: string;
  providerMemberId: string;
  workforceId?: string | null;
  paymentMethodId?: string | null;
  paymentValues?: Record<string, unknown> | null;
  productionThresholdReady?: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  status?: string | null;
  updatedAt?: string | null;
};

export type ProviderMappingSummaryWorkerInput = {
  id: string;
  dropxId?: string | null;
  fullName?: string | null;
  onboardingStatus?: string | null;
};

export type ProviderMappingSummaryMethodInput = {
  id: string;
  name: string;
  componentCodes: string[];
  productionThresholdRequired?: boolean;
};

export type MappingSummaryProfile = { id: string; dropxId: string; fullName: string; state: MappingProfileState; status: string };

export type ProviderMappingSummaryDetail = {
  profiles: MappingSummaryProfile[];
  key: string;
  providerMemberId: string;
  providerMemberName: string;
  dropxId: string;
  dropxName: string;
  paymentMethod: string;
  status: ProviderMappingSummaryStatus;
  issues: string[];
  lastSeen: string;
  coverageLabel: string;
  coveragePercent: number;
};

export type ProviderMappingSummaryStation = {
  stationId: string;
  stationCode: string;
  stationName: string;
  cluster: string;
  clusterKeys: string[];
  region: string;
  total: number;
  mapped: number;
  ready: number;
  unmapped: number;
  dataIssues: number;
  profileCompleted: number; profilePending: number; profileReview: number; profileUnknown: number;
  profiles: MappingSummaryProfile[];
  completionPercent: number;
  details: ProviderMappingSummaryDetail[];
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function memberKey(stationId: string, memberId: string) {
  return `${text(stationId)}\u0000${text(memberId).toUpperCase()}`;
}

function mappingIsNewer(left: ProviderMappingSummaryMappingInput, right: ProviderMappingSummaryMappingInput) {
  const leftKey = `${text(left.effectiveFrom)}\u0000${text(left.updatedAt)}\u0000${text(left.id)}`;
  const rightKey = `${text(right.effectiveFrom)}\u0000${text(right.updatedAt)}\u0000${text(right.id)}`;
  return leftKey.localeCompare(rightKey) > 0;
}

function sourceIsNewer(left: ProviderMappingSummarySourceInput, right: ProviderMappingSummarySourceInput) {
  return text(left.workDate).localeCompare(text(right.workDate)) > 0;
}

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validDate(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
}

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`};
}

function canonicalMapping(mapping: ProviderMappingSummaryMappingInput) {
  const status = text(mapping.status || (mapping.effectiveTo ? "closed" : "active")).toLowerCase();
  return status !== "cancelled" && status !== "removed" && status !== "deleted";
}

function mappingCoversDate(mapping: ProviderMappingSummaryMappingInput, date: string) {
  const from = text(mapping.effectiveFrom);
  const to = text(mapping.effectiveTo);
  return canonicalMapping(mapping) && (!from || from <= date) && (!to || to >= date);
}

function mappingIntersectsMonths(mapping: ProviderMappingSummaryMappingInput, months: string[]) {
  if (!canonicalMapping(mapping)) return false;
  if (!months.length) return true;
  const from = text(mapping.effectiveFrom);
  const to = text(mapping.effectiveTo);
  return months.some(month => {
    const bounds = monthBounds(month);
    return (!from || from <= bounds.end) && (!to || to >= bounds.start);
  });
}

function datesWithinMonths(dates: string[] | null | undefined, months: string[]) {
  const selected = new Set(months);
  return [...new Set((dates ?? []).map(text).filter(date => validDate(date) && (!selected.size || selected.has(date.slice(0, 7)))))].sort();
}

function daysCoveredInMonths(mappings: ProviderMappingSummaryMappingInput[], months: string[]) {
  const days = new Set<string>();
  for (const month of months) {
    const {start, end} = monthBounds(month);
    const cursor = new Date(`${start}T00:00:00.000Z`);
    const last = new Date(`${end}T00:00:00.000Z`);
    while (cursor <= last) {
      const date = cursor.toISOString().slice(0, 10);
      if (mappings.some(mapping => mappingCoversDate(mapping, date))) days.add(date);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return days.size;
}

function configuredValue(value: unknown) {
  if (value === null || value === undefined || value === "") return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

export function buildProviderMappingSummary({
  stations,
  sourceMembers,
  mappings,
  workers,
  methods,
  selectedMonths = []
}: {
  stations: ProviderMappingSummaryStationInput[];
  sourceMembers: ProviderMappingSummarySourceInput[];
  mappings: ProviderMappingSummaryMappingInput[];
  workers: ProviderMappingSummaryWorkerInput[];
  methods: ProviderMappingSummaryMethodInput[];
  selectedMonths?: string[];
}) {
  const months = [...new Set(selectedMonths.map(text).filter(validMonth))].sort();
  const stationById = new Map(stations.map(station => [station.id, station]));
  const stationByCode = new Map(stations.map(station => [text(station.code).toUpperCase(), station]));
  const workerById = new Map(workers.map(worker => [worker.id, worker]));
  const methodById = new Map(methods.map(method => [method.id, method]));
  const sourceByKey = new Map<string, ProviderMappingSummarySourceInput>();
  for (const source of sourceMembers) {
    const station = stationByCode.get(text(source.stationCode).toUpperCase());
    const providerMemberId = text(source.providerMemberId);
    const sourceMonths = [...new Set([...(source.outboundMonths ?? []).map(text).filter(validMonth), ...(source.outboundDates ?? []).map(value => text(value).slice(0, 7)).filter(validMonth)])];
    if (!station || !providerMemberId || (months.length && !sourceMonths.some(month => months.includes(month)))) continue;
    const key = memberKey(station.id, providerMemberId);
    const existing = sourceByKey.get(key);
    if (!existing) sourceByKey.set(key, source);
    else {
      const newest = sourceIsNewer(source, existing) ? source : existing;
      sourceByKey.set(key, {
        ...newest,
        outboundMonths: [...new Set([...(existing.outboundMonths ?? []), ...(source.outboundMonths ?? [])])],
        outboundDates: [...new Set([...(existing.outboundDates ?? []), ...(source.outboundDates ?? [])])]
      });
    }
  }

  const mappingsByKey = new Map<string, ProviderMappingSummaryMappingInput[]>();
  for (const mapping of mappings) {
    if (!stationById.has(mapping.stationId) || !text(mapping.providerMemberId) || !mappingIntersectsMonths(mapping, months)) continue;
    const key = memberKey(mapping.stationId, mapping.providerMemberId);
    const existing = mappingsByKey.get(key) ?? [];
    existing.push(mapping);
    mappingsByKey.set(key, existing);
  }

  const detailsByStation = new Map(stations.map(station => [station.id, [] as ProviderMappingSummaryDetail[]]));
  // A month-filtered summary is activity-grained: only provider IDs with
  // outbound activity in the selected month(s) belong in that month. Saved
  // mappings remain available to evaluate those IDs, but a mapping with no
  // selected-month activity must not become a false "source missing" issue.
  const keys = new Set(sourceByKey.keys());
  if (!months.length) {
    for (const key of mappingsByKey.keys()) keys.add(key);
  }
  for (const key of keys) {
    const separator = key.indexOf("\u0000");
    const stationId = key.slice(0, separator);
    const source = sourceByKey.get(key);
    const mappingPeriods = [...(mappingsByKey.get(key) ?? [])].sort((left, right) => {
      if (mappingIsNewer(left, right)) return -1;
      if (mappingIsNewer(right, left)) return 1;
      return 0;
    });
    const requiredDates = datesWithinMonths(source?.outboundDates, months);
    const coveredRequiredDates = requiredDates.filter(date => mappingPeriods.some(mapping => mappingCoversDate(mapping, date)));
    const relevantPeriods = requiredDates.length
      ? [...new Set(requiredDates.map(date => mappingPeriods.find(mapping => mappingCoversDate(mapping, date))).filter(Boolean))] as ProviderMappingSummaryMappingInput[]
      : mappingPeriods.slice(0, 1);
    const mapping = relevantPeriods[0] ?? mappingPeriods[0];
    const memberId = text(source?.providerMemberId || mapping?.providerMemberId);
    const worker = mapping?.workforceId ? workerById.get(mapping.workforceId) : undefined;
    const method = mapping?.paymentMethodId ? methodById.get(mapping.paymentMethodId) : undefined;
    const issues: string[] = [];

    if (!source) issues.push("No recent source activity");
    if (!mapping) issues.push("Mapping missing");
    if (mapping && requiredDates.length && coveredRequiredDates.length < requiredDates.length) {
      issues.push(`Mapping covers ${coveredRequiredDates.length} of ${requiredDates.length} active days`);
    }
    if (mapping && !mapping.workforceId) issues.push("DropX ID missing");
    if (mapping?.workforceId && !worker) issues.push("Workforce record missing");
    if (worker && !text(worker.dropxId)) issues.push("DropX ID missing");
    if (mapping && !mapping.paymentMethodId) issues.push("Payment method missing");
    if (mapping?.paymentMethodId && !method) issues.push("Payment method unavailable");
    for (const period of relevantPeriods.length ? relevantPeriods : mapping ? [mapping] : []) {
      const periodMethod = period.paymentMethodId ? methodById.get(period.paymentMethodId) : undefined;
      if (period && !period.paymentMethodId) issues.push("Payment method missing");
      if (period.paymentMethodId && !periodMethod) issues.push("Payment method unavailable");
      if (periodMethod) {
        const missingComponents = periodMethod.componentCodes.filter(code => !configuredValue(period.paymentValues?.[code]));
        if (missingComponents.length) issues.push(`${missingComponents.length} payment value${missingComponents.length === 1 ? "" : "s"} missing`);
        if (periodMethod.productionThresholdRequired && !period.productionThresholdReady) issues.push("Production threshold missing");
      }
    }

    let status: ProviderMappingSummaryStatus = "ready";
    if (!mapping) status = "unmapped";
    else if (!mapping.workforceId || !worker || !text(worker.dropxId)) status = "identity_missing";
    else if (issues.some(issue => issue.includes("Payment") || issue.includes("payment") || issue.includes("threshold"))) status = "payment_missing";
    else if (requiredDates.length && coveredRequiredDates.length < requiredDates.length) status = "partial_coverage";
    else if (!source) status = "source_missing";

    const calendarCoverageDays = months.length ? daysCoveredInMonths(mappingPeriods, months) : 0;
    const coverageLabel = requiredDates.length
      ? `${coveredRequiredDates.length}/${requiredDates.length} active day${requiredDates.length === 1 ? "" : "s"}`
      : months.length && mappingPeriods.length
        ? `${calendarCoverageDays} mapped day${calendarCoverageDays === 1 ? "" : "s"}`
        : mappingPeriods.length ? "Mapping period saved" : "No mapped days";
    const coveragePercent = requiredDates.length
      ? Math.round((coveredRequiredDates.length / requiredDates.length) * 100)
      : mappingPeriods.length ? 100 : 0;

    detailsByStation.get(stationId)?.push({
      key,
      profiles: [...new Set((relevantPeriods.length ? relevantPeriods : mapping ? [mapping] : []).map(p=>p.workforceId).filter(Boolean))].flatMap(id=>{
        const person=workerById.get(id!);
        return person ? [{id:person.id,dropxId:text(person.dropxId),fullName:text(person.fullName),state:mappingProfileState(person.onboardingStatus),status:text(person.onboardingStatus)}] : [];
      }),
      providerMemberId: memberId,
      providerMemberName: text(source?.providerMemberName),
      dropxId: text(worker?.dropxId),
      dropxName: text(worker?.fullName),
      paymentMethod: text(method?.name),
      status,
      issues: [...new Set(issues)],
      lastSeen: requiredDates.at(-1) ?? text(source?.workDate),
      coverageLabel,
      coveragePercent
    });
  }

  return stations.map(station => {
    const details = (detailsByStation.get(station.id) ?? []).sort((left, right) => {
      const readyOrder = Number(left.status === "ready") - Number(right.status === "ready");
      return readyOrder || left.providerMemberId.localeCompare(right.providerMemberId);
    });
    const mapped = details.filter(detail => detail.status !== "unmapped" && detail.status !== "identity_missing").length;
    const ready = details.filter(detail => detail.status === "ready").length;
    const unmapped = details.filter(detail => detail.status === "unmapped").length;
    const dataIssues = details.length - ready - unmapped;
    const profiles = uniqueMappingProfiles(details.flatMap(d=>d.profiles));
    return {
      stationId: station.id,
      stationCode: station.code,
      clusterKeys: station.clusterKeys ?? [],
      stationName: text(station.name),
      cluster: text(station.cluster) || "Unassigned",
      region: text(station.region) || "Unassigned",
      total: details.length,
      mapped,
      ready,
      unmapped,
      dataIssues,
      profiles, ...mappingProfileTotals(profiles),
      completionPercent: details.length ? Math.round((ready / details.length) * 100) : 100,
      details
    } satisfies ProviderMappingSummaryStation;
  }).sort((left, right) => {
    const attention = (right.unmapped + right.dataIssues) - (left.unmapped + left.dataIssues);
    return attention || left.stationCode.localeCompare(right.stationCode);
  });
}

export function providerMappingSummaryTotals(stations: ProviderMappingSummaryStation[]) {
  const totals = stations.reduce((sum, station) => ({
    stations: sum.stations + 1,
    total: sum.total + station.total,
    mapped: sum.mapped + station.mapped,
    ready: sum.ready + station.ready,
    unmapped: sum.unmapped + station.unmapped,
    dataIssues: sum.dataIssues + station.dataIssues
  }), {stations: 0, total: 0, mapped: 0, ready: 0, unmapped: 0, dataIssues: 0});
  return {...totals, ...mappingProfileTotals(uniqueMappingProfiles(stations.flatMap(s=>s.profiles))), completionPercent: totals.total ? Math.round((totals.ready / totals.total) * 100) : 100};
}

export function uniqueMappingProfiles(profiles: MappingSummaryProfile[]) {
  return [...new Map(profiles.map(p=>[p.id,p])).values()];
}
export function mappingProfileTotals(profiles: MappingSummaryProfile[]) {
  return {profileCompleted:profiles.filter(p=>p.state==="completed").length,profilePending:profiles.filter(p=>p.state==="pending").length,profileReview:profiles.filter(p=>p.state==="review").length,profileUnknown:profiles.filter(p=>p.state==="unknown").length};
}
