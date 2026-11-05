import type { RecoveryPerson } from "./nl-loss-policy";

const PRIVATE_PAY_KEYS = [
  "salary_payable",
  "salary_gross",
  "salary_source",
  "recovery_limit",
  "override_limit",
  "reserved",
] as const;

export function isWorkforceRecoveryRef(value: unknown) {
  return String(value ?? "").startsWith("workforce:");
}

function withoutPrivatePay<T extends Record<string, unknown>>(value: T): T {
  const copy = { ...value };
  for (const key of PRIVATE_PAY_KEYS) delete (copy as Record<string, unknown>)[key];
  return copy;
}

/** People expose only a recovery ceiling and a safe blocker, never salary breakdowns. */
export function recoveryPersonPayDisclosure(person: RecoveryPerson): RecoveryPerson {
  const ready = person.recovery_limit != null && Number.isFinite(person.recovery_limit);
  if (isWorkforceRecoveryRef(person.ref)) return {
    ...person, pay_detail_access: "workforce", pay_check_state: ready ? "ready" : "unavailable",
  };
  return {
    ...withoutPrivatePay(person as RecoveryPerson & Record<string, unknown>),
    recovery_limit: ready ? person.recovery_limit : null,
    pay_detail_access: "recovery_limit",
    pay_check_state: ready ? "ready" : "unavailable",
  };
}

export function redactRecoveryAllocation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const allocation = value as Record<string, unknown>;
  return isWorkforceRecoveryRef(allocation.ref) ? allocation : withoutPrivatePay(allocation);
}

export function redactRecoverySnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.allocations)) return snapshot;
  return {
    ...snapshot,
    allocations: snapshot.allocations.map(redactRecoveryAllocation),
  };
}

export function privacySafeRecoveryError(messageValue: unknown, includesPeopleProfile: boolean) {
  const message = String(messageValue ?? "Recovery could not be saved.");
  // Explicit capacity messages are safe; raw salary/gross messages remain redacted.
  if (/^[^:]+: (maximum available recovery is|Recovery unavailable:)/.test(message)) return message;
  if (!includesPeopleProfile || !/(salary|payable|take-home|gross pay|payroll)/i.test(message)) return message;
  if (/(unavailable|refresh|mapping|complete payroll)/i.test(message)) {
    return "Salary eligibility is unavailable for the selected People profile. Complete payroll or mapping and retry.";
  }
  if (/(more than|exceed|limit)/i.test(message)) {
    return "The selected monthly recovery exceeds available pay. Spread it over more instalments.";
  }
  return "Salary eligibility for the selected People profile could not be verified.";
}
