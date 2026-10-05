export type FleetAuditProgrammeConfig = {
  enabled: boolean;
  physicalPerMonth: number;
  virtualPerMonth: number;
  excludedWeekdays: number[];
  maxPhysicalPerDay: number;
  maxVirtualPerDay: number;
  minGapDays: number;
  maxPhysicalStationsPerDay: number;
  autoMoveForLeave: boolean;
  emailTitle: string;
  emailSubjectPrefix: string;
  primaryColor: string;
  accentColor: string;
  alertColor: string;
  includeEvidence: boolean;
};

export const defaultFleetAuditProgrammeConfig: FleetAuditProgrammeConfig = {
  enabled: true,
  physicalPerMonth: 1,
  virtualPerMonth: 1,
  excludedWeekdays: [0],
  maxPhysicalPerDay: 4,
  maxVirtualPerDay: 6,
  minGapDays: 7,
  maxPhysicalStationsPerDay: 1,
  autoMoveForLeave: true,
  emailTitle: "DropX Vehicle Audit Report",
  emailSubjectPrefix: "DropX Vehicle Audit",
  primaryColor: "#111a2e",
  accentColor: "#d91f5d",
  alertColor: "#c92a45",
  includeEvidence: true
};

const text = (value: unknown) => String(value ?? "").trim();
const integer = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
};
const color = (value: unknown, fallback: string) => /^#[0-9a-f]{6}$/i.test(text(value)) ? text(value) : fallback;

export function normalizeFleetAuditProgrammeConfig(value: unknown): FleetAuditProgrammeConfig {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const excluded = Array.isArray(input.excludedWeekdays)
    ? [...new Set(input.excludedWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : defaultFleetAuditProgrammeConfig.excludedWeekdays;
  return {
    enabled: input.enabled !== false,
    physicalPerMonth: integer(input.physicalPerMonth, 1, 1, 1),
    virtualPerMonth: integer(input.virtualPerMonth, 1, 1, 1),
    excludedWeekdays: excluded.length ? excluded : [0],
    maxPhysicalPerDay: integer(input.maxPhysicalPerDay, 4, 1, 20),
    maxVirtualPerDay: integer(input.maxVirtualPerDay, 6, 1, 30),
    minGapDays: integer(input.minGapDays, 7, 1, 21),
    maxPhysicalStationsPerDay: integer(input.maxPhysicalStationsPerDay, 1, 1, 5),
    autoMoveForLeave: input.autoMoveForLeave !== false,
    emailTitle: text(input.emailTitle) || defaultFleetAuditProgrammeConfig.emailTitle,
    emailSubjectPrefix: text(input.emailSubjectPrefix) || defaultFleetAuditProgrammeConfig.emailSubjectPrefix,
    primaryColor: color(input.primaryColor, defaultFleetAuditProgrammeConfig.primaryColor),
    accentColor: color(input.accentColor, defaultFleetAuditProgrammeConfig.accentColor),
    alertColor: color(input.alertColor, defaultFleetAuditProgrammeConfig.alertColor),
    includeEvidence: input.includeEvidence !== false
  };
}

export function auditProgrammeFromRiskWeights(value: unknown) {
  const weights = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return normalizeFleetAuditProgrammeConfig(weights.audit_programme);
}
