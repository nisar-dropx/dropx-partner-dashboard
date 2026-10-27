/** Recovery outcomes cannot turn an unpaid loss into an unowned exception. */
export function recoveryActionAllowed(o: { code: string; allocation_required: boolean; dispute_fields_enabled?: boolean }) {
  return o.code !== "already_recovered" && !o.dispute_fields_enabled && (o.allocation_required || o.code === "responsible_left");
}

export type LossRole = { readOnly?: boolean; isMasterOwner: boolean; roleCode: string | null; effectiveRoleCodes?: string[]; designationName?: string | null };

function normalizedLossRoleCode(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

function roleWords(value: unknown) {
  return ` ${String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()} `;
}

function hasRolePhrase(role: string, phrase: string) {
  return role.includes(` ${phrase} `);
}

/** Cluster Manager / City Manager / AOM and above — never Station Manager or ground staff. */
const CLUSTER_AND_ABOVE = new Set([
  "CM",
  "CLM",
  "AOM",
  "BH",
  "RH",
  "RM",
  "ZH",
  "NH",
  "GM",
  "HLM",
  "HRM",
  "SLPM",
  "SLP_MANAGER",
  "FINMGR",
  "FINANCE_MANAGER",
  "MP",
  "MANAGING_PARTNER",
  "OWNER",
  "CLUSTER_MANAGER",
  "CLUSTER_HEAD",
  "CITY_MANAGER",
  "AREA_OPERATIONS_MANAGER",
  "AREA_OPERATION_MANAGER",
  "BUSINESS_HEAD",
  "NATIONAL_HEAD",
  "GENERAL_MANAGER",
  "REGIONAL_HEAD",
  "REGIONAL_MANAGER",
  "ZONAL_HEAD",
]);

/** Debit targets stop at Station Manager. Managers above that stay out of the picker. */
const MANAGERIAL_DEBIT_CODES = new Set([
  "CM",
  "CLM",
  "AOM",
  "BH",
  "RH",
  "RM",
  "ZH",
  "NH",
  "GM",
  "HLM",
  "HRM",
  "SLPM",
  "FINMGR",
  "MP",
  "OWNER",
]);

/** Full code plus OPERATIONS_/FINANCE_ stripped form (FINANCE_MANAGER stays itself). */
function roleTokens(auth: LossRole) {
  const tokens = new Set<string>();
  for (const value of [auth.roleCode, ...(auth.effectiveRoleCodes ?? []), auth.designationName]) {
    const code = normalizedLossRoleCode(value);
    if (!code) continue;
    tokens.add(code);
    tokens.add(code.replace(/^(OPERATIONS|FINANCE)_/, ""));
  }
  return [...tokens];
}

function isClusterOrAboveTitle(value: unknown) {
  const role = roleWords(value);
  return (
    hasRolePhrase(role, "CLUSTER MANAGER") ||
    hasRolePhrase(role, "CLUSTER HEAD") ||
    hasRolePhrase(role, "CITY MANAGER") ||
    hasRolePhrase(role, "AREA OPERATIONS MANAGER") ||
    hasRolePhrase(role, "AREA OPERATION MANAGER") ||
    hasRolePhrase(role, "BUSINESS HEAD") ||
    hasRolePhrase(role, "REGIONAL HEAD") ||
    hasRolePhrase(role, "REGIONAL MANAGER") ||
    hasRolePhrase(role, "ZONAL HEAD") ||
    hasRolePhrase(role, "NATIONAL HEAD") ||
    hasRolePhrase(role, "GENERAL MANAGER") ||
    hasRolePhrase(role, "MANAGING PARTNER")
  );
}

/** Only the business-designated roles; a broad Master permission is insufficient. */
export function mayViewLossApprovals(auth: LossRole) {
  // Master ownership alone does not grant shipment redispute or final approval rights.
  const allowed = new Set(["SLPM", "NH", "FINMGR", "MANAGING_PARTNER", "MP", "SLP_MANAGER", "NATIONAL_HEAD", "FINANCE_MANAGER"]);
  return roleTokens(auth).some((code) => allowed.has(code));
}
export function mayActivateRedispute(auth: LossRole) { return !auth.readOnly && mayViewLossApprovals(auth); }

/**
 * “Already recovered” is Cluster Manager and above only.
 * Station / location actors must not see or set it — including when they have Losses edit.
 */
export function mayMarkAlreadyRecovered(auth: LossRole) {
  if (auth.readOnly) return false;
  if (mayActivateRedispute(auth)) return true;
  if (auth.isMasterOwner) return true;
  if (roleTokens(auth).some((code) => CLUSTER_AND_ABOVE.has(code))) return true;
  return isClusterOrAboveTitle(auth.designationName);
}

/** True when this person must never appear as a payroll debit target (CM / AOM / above). */
export function isLossRecoveryManagerialTarget(person: {
  designation?: string | null;
  designation_code?: string | null;
  designationCode?: string | null;
}) {
  const code = normalizedLossRoleCode(
    person.designationCode ?? person.designation_code ?? "",
  );
  if (code && MANAGERIAL_DEBIT_CODES.has(code)) return true;
  return isClusterOrAboveTitle(person.designation);
}

/** Station Manager and below only — hides manager identities and salaries from reportees. */
export function filterLossRecoveryDebitPeople<T extends { designation?: string | null }>(
  people: T[],
) {
  return people.filter((person) => !isLossRecoveryManagerialTarget(person));
}

export function receivedRecoveryError(details: Record<string, unknown>, amount: number) {
  if (Math.round(Number(details.received_amount) * 100) !== Math.round(amount * 100)) return "Enter the full loss amount received. Partial collections must remain outstanding.";
  if (String(details.receipt_reference ?? "").trim().length < 5) return "Enter the payment or receipt reference for final verification.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(details.received_date ?? ""))) return "Enter the date the recovery was received.";
  return "";
}

export function departedPersonError(details: Record<string, unknown>, remarks: string) {
  if (String(details.employee_id ?? "").trim().length < 2 || String(details.employee_name ?? "").trim().length < 2)
    return "Enter the responsible person’s employee ID and full name.";
  if (String(details.follow_up ?? "").trim().length < 10 || remarks.trim().length < 5)
    return "Record the recovery owner, next step and departure details. The balance remains outstanding.";
  return "";
}

export function defaultLossFilter(now = new Date()) {
  const day = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric" }).format(now));
  return day >= 25 ? "recoverable" : "";
}
export function lossStatusMatches(filter: string, recoverable: boolean, phase: string) {
  if (filter === "recoverable") return recoverable;
  if (filter === "nonrecoverable") return phase === "won";
  if (filter === "not_disputed") return phase === "accepted";
  if (filter === "sla_missed") return phase === "missed";
  if (filter === "amazon") return phase === "amazon";
  if (filter === "todo") return phase === "action" || phase === "respond";
  if (filter === "decided") return ["won", "lost", "accepted", "missed"].includes(phase);
  return true;
}

/** Missing a dispute deadline is a workflow fact, not proof of a final recovery decision. */
export function hasFinalLossOutcome(recoverable: boolean, sourceStatus: string | null | undefined, caseStatus?: string | null, stage?: string | null) {
  if (!["resolved", "sla_missed", "not_disputed"].includes(String(caseStatus ?? "").toLowerCase()) && ["eDSP1", "eDSP2", "NL1", "NL2"].includes(stage || "")) return false;
  return recoverable || /^non[ -]?recoverable(?:\b|$)/i.test(String(sourceStatus ?? "").trim());
}
