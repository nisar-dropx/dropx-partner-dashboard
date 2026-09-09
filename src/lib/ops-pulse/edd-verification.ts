import type { EddPackage } from "./edd-worker";
import type { PackageHistoryEvent } from "./tracking-lookup";

export type EddVerification = {
  state: string | null; edd: string | null; driverName: string | null; driverId?: string | null;
  firstDispatchAt: string | null; firstAttemptAt: string | null;
  historyComplete: boolean; lastUpdatedAt: string | null;
  rulesVersion?: number;
};
export type VerifiedEddPackage = EddPackage & {
  driverName?: string | null; sourceAt?: string; verifiedAt?: string | null;
  verification?: EddVerification | null; isAccessPoint?: boolean;
};
const istDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export function eddIstDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : istDateFormatter.format(date);
}
const dispatchStates = new Set(["IN_TRANSIT_TO_CUSTOMER", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_ATTEMPTED", "DELIVERY_FAILED", "DELIVERY_REJECTED", "REJECTED"]);
const attemptStates = new Set(["DELIVERY_ATTEMPTED", "DELIVERY_FAILED", "DELIVERY_REJECTED", "REJECTED"]);
export function eddHistoryFacts(history: PackageHistoryEvent[]) {
  const first = (states: Set<string>) => history.filter(e => states.has(e.state.trim().toUpperCase()) && e.time && !Number.isNaN(Date.parse(e.time)))
    .map(e => new Date(e.time!).toISOString()).sort()[0] ?? null;
  // IN_TRANSIT before induction is also used for merchant pickup/inbound transport.
  // Real KTUO history: pickup transit 31 Aug, inducted 4 Sep, delivery dispatch 9 Sep.
  const inductedAt = first(new Set(["INDUCTED"]));
  const customerTransit = history.filter(e => e.state.trim().toUpperCase() === "IN_TRANSIT" && inductedAt && e.time && Date.parse(e.time) >= Date.parse(inductedAt))
    .map(e => new Date(e.time!).toISOString()).sort()[0] ?? null;
  return { rulesVersion: 2, firstDispatchAt: [first(dispatchStates),customerTransit].filter((v):v is string=>!!v).sort()[0] ?? null, firstAttemptAt: first(attemptStates),
    // Empty/malformed history cannot prove that a shipment has never been dispatched.
    historyComplete: history.length > 0 && history.every(e => !!e.state.trim() && !!e.time && !Number.isNaN(Date.parse(e.time))) };
}
export function eddCurrentState(pkg: VerifiedEddPackage) {
  const verified = pkg.verification;
  // Delivery is terminal. Never resurrect a delivered TID from an older backlog row.
  if (verified?.state === "DELIVERED" || pkg.state === "DELIVERED") return "DELIVERED";
  return ((verified?.state && pkg.verifiedAt && (!pkg.sourceAt || Date.parse(pkg.verifiedAt) >= Date.parse(pkg.sourceAt)) ? verified.state : pkg.state) || "UNKNOWN").trim().toUpperCase();
}
