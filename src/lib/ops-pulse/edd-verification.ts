import type { EddPackage } from "./edd-worker";
import type { PackageHistoryEvent } from "./tracking-lookup";

export type EddVerification = {
  state: string | null; edd: string | null; driverName: string | null; driverId?: string | null;
  firstDispatchAt: string | null; firstAttemptAt: string | null;
  historyComplete: boolean; lastUpdatedAt: string | null;
  rulesVersion?: number;
  attemptTimes?: string[];
  attemptCountComplete?: boolean;
  secondAttemptAt?: string | null;
  returnedAfterAttemptAt?: string | null;
  rejectedAt?: string | null;
  deliveredAt?: string | null;
  latestEventAt?: string | null;
  routeStationCode?: string | null;
};
export type VerifiedEddPackage = EddPackage & {
  driverName?: string | null; sourceAt?: string; verifiedAt?: string | null;
  verification?: EddVerification | null; isAccessPoint?: boolean;
};
export const EDD_PENDING_MAX_AGE_MS = 15 * 60 * 1000;
export function eddPendingEvidenceFresh(pkg: VerifiedEddPackage, now = Date.now()) {
  const checked = Date.parse(eddPendingEvidenceAt(pkg) || "");
  return Number.isFinite(checked) && checked <= now && now - checked <= EDD_PENDING_MAX_AGE_MS;
}
/** Only reuse complete history when a fresh per-package summary proves the
 * same last event. An unchanged label or a new batch timestamp is not proof. */
export function eddPendingEvidenceAt(pkg: VerifiedEddPackage) {
  const history = pkg.verification;
  const summaryAt = Date.parse(pkg.summaryCheckedAt || ""), eventAt = Date.parse(pkg.stateUpdatedAt || "");
  const historyEventAt = Date.parse(history?.latestEventAt || history?.lastUpdatedAt || "");
  if (history?.historyComplete && history.state === pkg.state && Number.isFinite(eventAt)
    && eventAt === historyEventAt && summaryAt >= Date.parse(pkg.verifiedAt || "")) return pkg.summaryCheckedAt;
  return pkg.verifiedAt;
}
export function eddNextCheckAt(state: string | null, now = Date.now()) {
  const status = (state || "").trim().toUpperCase();
  const delay = eddDeliveredState(status) ? 7 * 86400000 : ["INDUCTED", "RECEIVED"].includes(status) ? 5 * 60000 : 2 * 3600000;
  return new Date(now + delay).toISOString();
}

export type EddLookupObservation = {
  stationCode?: string | null;
  packageStatus?: string | null; estimatedArrivalTime?: string | null; promisedDeliveryTime?: string | null;
  driverName?: string | null; driverId?: string | null; lastUpdatedTime?: string | null;
  history?: PackageHistoryEvent[]; historyComplete?: boolean;
};
export function eddVerificationFromLookup(body: EddLookupObservation): EddVerification {
  const history = Array.isArray(body.history) ? body.history : [];
  const facts = eddHistoryFacts(history);
  return { state: body.packageStatus?.trim().toUpperCase() || null,
    edd: eddIstDate(body.estimatedArrivalTime) || eddIstDate(body.promisedDeliveryTime),
    driverName: body.driverName || null, driverId: body.driverId || null, routeStationCode: body.stationCode || null, lastUpdatedAt: body.lastUpdatedTime || null, ...facts,
    historyComplete: facts.historyComplete && (body.historyComplete === true || (body.historyComplete == null && history.length < 20)) };
}
/** Reconcile the same live result in the table immediately, even while its dialog is open. */
export function applyEddLookup(pkg: EddPackage, body: EddLookupObservation, checkedAt: string): EddPackage {
  const verification = mergeEddVerification(pkg.verification, eddVerificationFromLookup(body));
  const next = { ...pkg, verification, verifiedAt: checkedAt,
    driverId: body.driverId || pkg.driverId, driverName: body.driverName || pkg.driverName };
  return { ...next, state: eddCurrentState(next) };
}
/** A partial read must not erase positive evidence already observed. It still
 * cannot establish absence of attempts, or an exact attempt count. */
export function mergeEddVerification(previous: EddVerification | null | undefined, next: EddVerification): EddVerification {
  if (!previous) return next;
  const earliest = (a?: string | null, b?: string | null) => [a,b].filter((v): v is string => !!v).sort()[0] ?? null;
  const preserved = { ...next, deliveredAt: earliest(previous.deliveredAt, next.deliveredAt),
    firstDispatchAt: (previous.rulesVersion ?? 0) >= 2 ? earliest(previous.firstDispatchAt, next.firstDispatchAt) : next.firstDispatchAt };
  if (next.historyComplete || previous.rulesVersion !== 3) return preserved;
  const times = (previous.attemptTimes?.length ?? 0) > (next.attemptTimes?.length ?? 0) ? previous.attemptTimes : next.attemptTimes;
  return { ...preserved, firstAttemptAt: earliest(previous.firstAttemptAt,next.firstAttemptAt),
    attemptTimes: times, secondAttemptAt: times?.[1] ?? next.secondAttemptAt, attemptCountComplete: false,
    rejectedAt: previous.rejectedAt || next.rejectedAt };
}
const istDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
export function eddIstDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : istDateFormatter.format(date);
}
const dispatchStates = new Set(["IN_TRANSIT_TO_CUSTOMER", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_ATTEMPTED", "DELIVERY_FAILED", "DELIVERY_REJECTED", "REJECTED"]);
const attemptStates = new Set(["DELIVERY_ATTEMPTED", "DELIVERY_FAILED"]);
const rejectedStates = new Set(["DELIVERY_REJECTED", "REJECTED"]);
const deliveredStates = new Set(["DELIVERED", "CASH_AT_STATION", "CASH_IN_ASSOCIATE"]);
export function eddDeliveredState(state: string | null | undefined) {
  return deliveredStates.has((state || "").trim().toUpperCase());
}
export function eddSourceMeaning(state: string) {
  if (eddDeliveredState(state)) return state === "DELIVERED" ? "Delivered to customer" : "Delivered parcel; cash collection state";
  if (state === "INDUCTED") return "Station induction; check history for earlier dispatch/attempt";
  if (state === "RECEIVED") return "Station receipt or returned parcel; history distinguishes them";
  if (state === "IN_TRANSIT_TO_CUSTOMER" || state === "OUT_FOR_DELIVERY") return "Out for customer delivery";
  if (state === "IN_TRANSIT") return "Inbound or outbound; requires scan sequence";
  if (rejectedStates.has(state)) return "Rejected; separate from HFR/HCR";
  if (attemptStates.has(state)) return "Unsuccessful attempt; distinct cycles determine HFR/HCR";
  if (state === "IN_TRANSIT_DS_TO_FC") return "In transit back to fulfilment centre";
  if (state === "IN_TRANSIT_DS_TO_DS") return "Transfer between stations; not fresh station pending";
  if (state === "MANIFESTED") return "Shipment registered; station receipt not established";
  return "Exception/other state; does not establish fresh pending or FC readiness";
}
export function eddHistoryFacts(history: PackageHistoryEvent[]) {
  const first = (states: Set<string>) => history.filter(e => states.has(e.state.trim().toUpperCase()) && e.time && !Number.isNaN(Date.parse(e.time)))
    .map(e => new Date(e.time!).toISOString()).sort()[0] ?? null;
  // IN_TRANSIT before induction is also used for merchant pickup/inbound transport.
  // Real KTUO history: pickup transit 31 Aug, inducted 4 Sep, delivery dispatch 9 Sep.
  const inductedAt = first(new Set(["INDUCTED"]));
  const customerTransit = history.filter(e => e.state.trim().toUpperCase() === "IN_TRANSIT" && inductedAt && e.time && Date.parse(e.time) >= Date.parse(inductedAt))
    .map(e => new Date(e.time!).toISOString()).sort()[0] ?? null;
  const valid = history.filter(e => e.time && Number.isFinite(Date.parse(e.time))).map(e => ({
    state: e.state.trim().toUpperCase(), reason: e.reasonCode?.trim().toUpperCase() || "", time: new Date(e.time!).toISOString()
  })).sort((a,b) => a.time.localeCompare(b.time));
  const attemptTimes: string[] = [];
  let dispatchedSinceAttempt = false, attemptCountComplete = true;
  let returnedAfterAttemptAt: string | null = null, rejectedAt: string | null = null, deliveredAt: string | null = null;
  const seen = new Set<string>();
  for (const event of valid) {
    const key = `${event.state}:${event.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Some source histories begin after the original induction. A positively
    // observed failed visit, station return, then transit also establishes a
    // new outbound cycle; requiring the missing induction loses real HCRs.
    const returnRedispatch = attemptTimes.length > 0 && returnedAfterAttemptAt
      && event.time > returnedAfterAttemptAt;
    const outbound = ["IN_TRANSIT_TO_CUSTOMER", "OUT_FOR_DELIVERY"].includes(event.state)
      || event.state === "IN_TRANSIT" && Boolean(inductedAt && event.time >= inductedAt || returnRedispatch);
    if (outbound) { dispatchedSinceAttempt = true; returnedAfterAttemptAt = null; }
    const rejected = rejectedStates.has(event.state) || /REJECT|CUSTOMER_REFUSED/.test(event.reason);
    if (rejected) rejectedAt = event.time;
    if (deliveredStates.has(event.state)) deliveredAt = event.time;
    if (attemptStates.has(event.state) && !rejected && !attemptTimes.includes(event.time)) {
      if (!attemptTimes.length || dispatchedSinceAttempt) {
        attemptTimes.push(event.time); returnedAfterAttemptAt = null;
      } else if (event.time !== attemptTimes.at(-1)) {
        // Multiple outcome scans without a new outbound cycle cannot prove
        // another customer visit. Keep a lower bound, never invent HCR.
        attemptCountComplete = false;
      }
      dispatchedSinceAttempt = false;
    }
    if (["INDUCTED", "RECEIVED"].includes(event.state) && attemptTimes.length
      && event.time > attemptTimes.at(-1)! && !returnedAfterAttemptAt) returnedAfterAttemptAt = event.time;
  }
  return { rulesVersion: 3, firstDispatchAt: [first(dispatchStates),customerTransit].filter((v):v is string=>!!v).sort()[0] ?? null, firstAttemptAt: attemptTimes[0] ?? null,
    attemptTimes, attemptCountComplete, secondAttemptAt: attemptTimes[1] ?? null, returnedAfterAttemptAt, rejectedAt, deliveredAt, latestEventAt: valid.at(-1)?.time ?? null,
    // Empty/malformed history cannot prove that a shipment has never been dispatched.
    historyComplete: history.length > 0 && history.every(e => !!e.state.trim() && !!e.time && !Number.isNaN(Date.parse(e.time))) };
}
export function eddCurrentState(pkg: VerifiedEddPackage) {
  const verified = pkg.verification;
  // Delivery is terminal. Never resurrect a delivered TID from an older backlog row.
  if (eddDeliveredState(verified?.state) || eddDeliveredState(pkg.state) || verified?.deliveredAt) {
    // Preserve the cash state for source-status audit, while treating its
    // parcel outcome as delivered everywhere that consumes this function.
    if (eddDeliveredState(pkg.state)) return pkg.state!.trim().toUpperCase();
    return eddDeliveredState(verified?.state) ? verified!.state! : "DELIVERED";
  }
  return ((verified?.state && pkg.verifiedAt && (!pkg.sourceAt || Date.parse(pkg.verifiedAt) >= Date.parse(pkg.sourceAt)) ? verified.state : pkg.state) || "UNKNOWN").trim().toUpperCase();
}

export type EddAttemptCategory = "hfr" | "hcr" | "rejected" | "returningToFc" | "unknown" | "none";
/** Attempt cohort and current movement are separate: a reattempt can be on
 * road, and a RECEIVED shipment may be a return rather than fresh EDD stock. */
export function eddAttemptLifecycle(pkg: VerifiedEddPackage) {
  const history = pkg.verification, state = eddCurrentState(pkg);
  const times = history?.attemptTimes ?? [];
  const complete = history?.rulesVersion === 3 && history.historyComplete && history.attemptCountComplete === true;
  const observedAttempts = times.length || (history?.firstAttemptAt ? 1 : 0);
  let category: EddAttemptCategory = "none";
  if (eddDeliveredState(state)) category = "none";
  else if (state === "IN_TRANSIT_DS_TO_FC") category = "returningToFc";
  else if (rejectedStates.has(state) || history?.rejectedAt) category = "rejected";
  else if (times.length >= 2) category = "hcr"; // Positive evidence of two distinct cycles suffices.
  else if (complete && times.length === 1) category = "hfr";
  else if (observedAttempts || attemptStates.has(state)) category = "unknown";
  return { category, state, observedAttempts, complete: Boolean(complete),
    firstAttemptAt: times[0] ?? history?.firstAttemptAt ?? null,
    secondAttemptAt: history?.secondAttemptAt ?? times[1] ?? null,
    lastAttemptAt: times.at(-1) ?? history?.firstAttemptAt ?? null,
    returnedAt: history?.returnedAfterAttemptAt ?? null,
    atStation: ["INDUCTED", "RECEIVED"].includes(state) };
}
