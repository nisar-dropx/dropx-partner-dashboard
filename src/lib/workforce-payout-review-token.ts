import { createHmac, timingSafeEqual } from "node:crypto";

import { isWorkforcePayoutCalculationPublishable } from "./workforce-payout-publication-eligibility.ts";

export { workforcePayoutLocationSetHash } from "./workforce-payout-publication.ts";

type ReviewTokenPayload = {
  c: string;
  t: "workforce" | "helper";
  s: string;
  l: string;
  f: string;
  e: string;
  st: "ready" | "returned";
  h: string;
  r: string;
  p: string;
  g: string;
  iat: number;
};

export type WorkforcePayoutReviewTokenStatus = ReviewTokenPayload["st"];
export type WorkforcePayoutReviewDisplayStatus = "Ready for review" | "Returned";

const TOKEN_TTL_SECONDS = 30 * 60;

function secret() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
}

function signature(encodedPayload: string) {
  return createHmac("sha256", secret()).update(encodedPayload).digest("base64url");
}

export function createWorkforcePayoutReviewToken(input: {
  companyId: string;
  subjectType: "workforce" | "helper";
  subjectId: string;
  locationId: string;
  periodStart: string;
  periodEnd: string;
  status: "Ready for review" | "Returned";
  dependencyHash?: string | null;
  calculationHash?: string | null;
  publicationSnapshotHash?: string | null;
  locationSetHash?: string | null;
}) {
  if (!secret()) return null;
  const payload: ReviewTokenPayload = {
    c: input.companyId,
    t: input.subjectType,
    s: input.subjectId,
    l: input.locationId,
    f: input.periodStart,
    e: input.periodEnd,
    st: input.status === "Returned" ? "returned" : "ready",
    h: String(input.dependencyHash ?? ""),
    r: String(input.calculationHash ?? ""),
    p: String(input.publicationSnapshotHash ?? ""),
    g: String(input.locationSetHash ?? ""),
    iat: Math.floor(Date.now() / 1000)
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

export function payoutReviewPresentation(
  calculatedStatus: string,
  persistedStatus?: string | null,
  subjectType: "workforce" | "helper" = "helper"
): {
  status: string;
  tokenStatus: WorkforcePayoutReviewDisplayStatus | null;
} {
  const status = persistedStatus === "under_review" ? "Under Review"
    : persistedStatus === "approved" ? "Approved"
      : persistedStatus === "returned" ? "Returned"
        : persistedStatus === "cancelled" ? "Cancelled"
          : calculatedStatus;
  const calculationPublishable = calculatedStatus === "Ready for review"
    || (subjectType === "workforce" && isWorkforcePayoutCalculationPublishable(calculatedStatus));
  const tokenStatus = calculationPublishable
    && (status === calculatedStatus || status === "Ready for review" || status === "Returned")
    ? status === "Returned" ? "Returned" : "Ready for review"
    : null;
  return { status, tokenStatus };
}

export function workforcePayoutReviewTokenDetails(token: unknown, expected: {
  companyId: string;
  subjectType: "workforce" | "helper";
  subjectId: string;
  locationId: string;
  periodStart: string;
  periodEnd: string;
  dependencyHash?: string | null;
  publicationSnapshotHash?: string | null;
  locationSetHash?: string | null;
}) {
  if (!secret() || typeof token !== "string" || token.length > 2_000) return null;
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expectedSignature = signature(encoded);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ReviewTokenPayload;
    const now = Math.floor(Date.now() / 1000);
    const valid = payload.c === expected.companyId
      && payload.t === expected.subjectType
      && payload.s === expected.subjectId
      && payload.l === expected.locationId
      && payload.f === expected.periodStart
      && payload.e === expected.periodEnd
      && (payload.st === "ready" || payload.st === "returned")
      && typeof payload.h === "string"
      && typeof payload.r === "string"
      && typeof payload.p === "string"
      && typeof payload.g === "string"
      && (expected.dependencyHash == null || payload.h === expected.dependencyHash)
      && (expected.publicationSnapshotHash == null || payload.p === expected.publicationSnapshotHash)
      && (expected.locationSetHash == null || payload.g === expected.locationSetHash)
      && Number.isInteger(payload.iat)
      && payload.iat <= now + 60
      && payload.iat >= now - TOKEN_TTL_SECONDS;
    return valid ? {
      status: payload.st,
      dependencyHash: payload.h,
      calculationHash: payload.r,
      publicationSnapshotHash: payload.p,
      locationSetHash: payload.g
    } : null;
  } catch {
    return null;
  }
}

export function workforcePayoutReviewTokenStatus(
  token: unknown,
  expected: Parameters<typeof workforcePayoutReviewTokenDetails>[1]
) {
  return workforcePayoutReviewTokenDetails(token, expected)?.status ?? null;
}

export function verifyWorkforcePayoutReviewToken(token: unknown, expected: Parameters<typeof workforcePayoutReviewTokenStatus>[1]) {
  return workforcePayoutReviewTokenStatus(token, expected) !== null;
}
