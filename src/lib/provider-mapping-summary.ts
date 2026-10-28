export type ProviderMappingSummaryStatus =
  | "ready"
  | "unmapped"
  | "identity_missing"
  | "payment_missing"
  | "source_missing";

export type ProviderMappingSummaryStationInput = {
  id: string;
  code: string;
  name?: string | null;
};

export type ProviderMappingSummarySourceInput = {
  providerMemberId: string;
  providerMemberName?: string | null;
  stationCode: string;
  workDate?: string | null;
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
  updatedAt?: string | null;
};

export type ProviderMappingSummaryWorkerInput = {
  id: string;
  dropxId?: string | null;
  fullName?: string | null;
};

export type ProviderMappingSummaryMethodInput = {
  id: string;
  name: string;
  componentCodes: string[];
  productionThresholdRequired?: boolean;
};

export type ProviderMappingSummaryDetail = {
  key: string;
  providerMemberId: string;
  providerMemberName: string;
  dropxId: string;
  dropxName: string;
  paymentMethod: string;
  status: ProviderMappingSummaryStatus;
  issues: string[];
  lastSeen: string;
};

export type ProviderMappingSummaryStation = {
  stationId: string;
  stationCode: string;
  stationName: string;
  total: number;
  mapped: number;
  ready: number;
  unmapped: number;
  dataIssues: number;
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
  methods
}: {
  stations: ProviderMappingSummaryStationInput[];
  sourceMembers: ProviderMappingSummarySourceInput[];
  mappings: ProviderMappingSummaryMappingInput[];
  workers: ProviderMappingSummaryWorkerInput[];
  methods: ProviderMappingSummaryMethodInput[];
}) {
  const stationById = new Map(stations.map(station => [station.id, station]));
  const stationByCode = new Map(stations.map(station => [text(station.code).toUpperCase(), station]));
  const workerById = new Map(workers.map(worker => [worker.id, worker]));
  const methodById = new Map(methods.map(method => [method.id, method]));
  const sourceByKey = new Map<string, ProviderMappingSummarySourceInput>();
  for (const source of sourceMembers) {
    const station = stationByCode.get(text(source.stationCode).toUpperCase());
    const providerMemberId = text(source.providerMemberId);
    if (!station || !providerMemberId) continue;
    const key = memberKey(station.id, providerMemberId);
    const existing = sourceByKey.get(key);
    if (!existing || sourceIsNewer(source, existing)) sourceByKey.set(key, source);
  }

  const mappingByKey = new Map<string, ProviderMappingSummaryMappingInput>();
  for (const mapping of mappings) {
    if (!stationById.has(mapping.stationId) || !text(mapping.providerMemberId)) continue;
    const key = memberKey(mapping.stationId, mapping.providerMemberId);
    const existing = mappingByKey.get(key);
    if (!existing || mappingIsNewer(mapping, existing)) mappingByKey.set(key, mapping);
  }

  const detailsByStation = new Map(stations.map(station => [station.id, [] as ProviderMappingSummaryDetail[]]));
  const keys = new Set([...sourceByKey.keys(), ...mappingByKey.keys()]);
  for (const key of keys) {
    const separator = key.indexOf("\u0000");
    const stationId = key.slice(0, separator);
    const source = sourceByKey.get(key);
    const mapping = mappingByKey.get(key);
    const memberId = text(source?.providerMemberId || mapping?.providerMemberId);
    const worker = mapping?.workforceId ? workerById.get(mapping.workforceId) : undefined;
    const method = mapping?.paymentMethodId ? methodById.get(mapping.paymentMethodId) : undefined;
    const issues: string[] = [];

    if (!source) issues.push("No recent source activity");
    if (!mapping) issues.push("Mapping missing");
    if (mapping && !mapping.workforceId) issues.push("DropX ID missing");
    if (mapping?.workforceId && !worker) issues.push("Workforce record missing");
    if (worker && !text(worker.dropxId)) issues.push("DropX ID missing");
    if (mapping && !mapping.paymentMethodId) issues.push("Payment method missing");
    if (mapping?.paymentMethodId && !method) issues.push("Payment method unavailable");
    if (mapping && method) {
      const missingComponents = method.componentCodes.filter(code => !configuredValue(mapping.paymentValues?.[code]));
      if (missingComponents.length) issues.push(`${missingComponents.length} payment value${missingComponents.length === 1 ? "" : "s"} missing`);
      if (method.productionThresholdRequired && !mapping.productionThresholdReady) issues.push("Production threshold missing");
    }

    let status: ProviderMappingSummaryStatus = "ready";
    if (!mapping) status = "unmapped";
    else if (!mapping.workforceId || !worker || !text(worker.dropxId)) status = "identity_missing";
    else if (issues.some(issue => issue.includes("Payment") || issue.includes("payment") || issue.includes("threshold"))) status = "payment_missing";
    else if (!source) status = "source_missing";

    detailsByStation.get(stationId)?.push({
      key,
      providerMemberId: memberId,
      providerMemberName: text(source?.providerMemberName),
      dropxId: text(worker?.dropxId),
      dropxName: text(worker?.fullName),
      paymentMethod: text(method?.name),
      status,
      issues,
      lastSeen: text(source?.workDate)
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
    return {
      stationId: station.id,
      stationCode: station.code,
      stationName: text(station.name),
      total: details.length,
      mapped,
      ready,
      unmapped,
      dataIssues,
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
  return {...totals, completionPercent: totals.total ? Math.round((totals.ready / totals.total) * 100) : 100};
}
