import { getAuthorization, hasPermission } from "@/lib/authorization";
import { reconcileBiometricAttendance } from "@/lib/biometric/attendance-reconciliation";
import {
  ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
  ATTENDANCE_RECONCILIATION_MAX_BATCH_SIZE,
  parsePositiveInteger,
  resolveAttendanceReconciliationWindow
} from "@/lib/biometric/attendance-reconciliation-policy";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const runtime = "nodejs";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store" };
const SHA256 = /^[0-9a-f]{64}$/i;

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function optionalDate(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${label} must use YYYY-MM-DD.`);
  return value;
}

function paginationValue(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error("Pagination values must be whole numbers.");
  }
  return String(value);
}

export async function POST(request: Request) {
  const startedAtMs = Date.now();
  try {
    if (!sameOrigin(request)) return reply({ error: "Invalid request origin." }, 403);
    const authorization = await getAuthorization();
    if (!authorization) return reply({ error: "Sign in is required." }, 401);
    if (
      authorization.readOnly ||
      !authorization.isMasterOwner ||
      !authorization.companyId ||
      !authorization.hasAllLocationAccess ||
      !hasPermission(authorization, "app_settings", "edit")
    ) {
      return reply({ error: "Company-owner access with company-wide Settings edit permission is required." }, 403);
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return reply({ error: "Content-Type must be application/json." }, 415);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "Request body must be valid JSON." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply({ error: "Request body must be a JSON object." }, 400);
    }
    const input = body as Record<string, unknown>;

    let parsed: { batchSize: number; cursor: number; fromDate: string; snapshotToken: string | null; toDate: string };
    try {
      const window = resolveAttendanceReconciliationWindow({
        catchup: true,
        fromDate: optionalDate(input.from, "Attendance reconciliation start date"),
        toDate: optionalDate(input.to, "Attendance reconciliation end date")
      });
      parsed = {
        batchSize: parsePositiveInteger(paginationValue(input.limit), {
          fallback: ATTENDANCE_RECONCILIATION_DEFAULT_BATCH_SIZE,
          maximum: ATTENDANCE_RECONCILIATION_MAX_BATCH_SIZE
        }),
        cursor: parsePositiveInteger(paginationValue(input.cursor), {
          fallback: 0,
          maximum: 10_000_000,
          minimum: 0
        }),
        fromDate: window.fromDate,
        snapshotToken: input.snapshotToken === undefined || input.snapshotToken === null || input.snapshotToken === ""
          ? null
          : typeof input.snapshotToken === "string" && SHA256.test(input.snapshotToken)
            ? input.snapshotToken.toLowerCase()
            : (() => { throw new Error("Attendance repair snapshot is invalid."); })(),
        toDate: window.toDate
      };
    } catch (error) {
      return reply({ error: error instanceof Error ? error.message : "Invalid attendance reconciliation request." }, 400);
    }

    const result = await reconcileBiometricAttendance({
      batchSize: parsed.batchSize,
      companyId: authorization.companyId,
      cursor: parsed.cursor,
      deadlineAtMs: startedAtMs + (maxDuration - 45) * 1000,
      expectedSnapshotToken: parsed.snapshotToken,
      fromDate: parsed.fromDate,
      leaseContention: "fail",
      leaseOwnerId: authorization.userId,
      serializeByCompany: true,
      toDate: parsed.toDate
    });
    return reply({ ...result, healthy: result.failures.length === 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reconcile biometric attendance.";
    return reply({ error: message }, /mappings changed/i.test(message) ? 409 : 500);
  }
}
