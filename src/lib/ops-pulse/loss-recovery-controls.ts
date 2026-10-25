/** Recovery outcomes cannot turn an unpaid loss into an unowned exception. */
export function recoveryActionAllowed(o: { code: string; allocation_required: boolean; dispute_fields_enabled?: boolean }) {
  return !o.dispute_fields_enabled && (o.allocation_required || o.code === "already_recovered" || o.code === "responsible_left");
}

export function mayActivateRedispute(auth: {
  readOnly?: boolean; isMasterOwner: boolean; roleCode: string | null;
  effectiveRoleCodes?: string[]; designationName?: string | null;
}) {
  if (auth.readOnly) return false;
  if (auth.isMasterOwner) return true;
  const allowed = new Set([
    "AOM", "RM", "RH", "ZH", "NH", "BH", "HLM", "SLPM", "FINMGR", "MANAGING_PARTNER", "OWNER",
    "AREA_OPERATIONS_MANAGER", "REGIONAL_HEAD", "NATIONAL_HEAD", "BUSINESS_HEAD", "HEAD_OF_OPERATIONS", "FINANCE_MANAGER", "SLP_MANAGER",
  ]);
  return [auth.roleCode, ...(auth.effectiveRoleCodes ?? []), auth.designationName]
    .some(value => {
      const code = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      return allowed.has(code) || allowed.has(code.replace(/^(OPERATIONS|FINANCE)_/, ""));
    });
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
