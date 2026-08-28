import { NextRequest, NextResponse } from "next/server";
import { resolveConnectAttendanceWorker } from "@/lib/connect-attendance-worker";
import {
  finalizeBiometricPunchLocationIfMissing,
  recordBiometricPunchLocation
} from "@/lib/connect-biometric-punch-location";

export const dynamic = "force-dynamic";

function parseCoordinate(value: FormDataEntryValue | null, label: string) {
  const num = Number(String(value ?? "").trim());
  if (!Number.isFinite(num)) throw new Error(`${label} is required.`);
  return num;
}

function parseOptionalNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function parseIntegritySignals(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const accountId = String(formData.get("accountId") ?? "").trim();
    const profileType = String(formData.get("profileType") ?? "").trim();
    const punchId = String(formData.get("punchId") ?? "").trim();
    const finalize = String(formData.get("finalize") ?? "").trim().toLowerCase() === "true";
    if (!accountId) throw new Error("Account is required.");
    if (!punchId) throw new Error("Punch is required.");

    const worker = await resolveConnectAttendanceWorker({ accountId, profileType, requirePeopleScope: true });

    if (finalize) {
      const result = await finalizeBiometricPunchLocationIfMissing({ worker, punchId });
      return NextResponse.json({ ok: true, finalize: true, result });
    }

    const lat = parseCoordinate(formData.get("lat"), "Latitude");
    const lng = parseCoordinate(formData.get("lng"), "Longitude");
    if (lat < -90 || lat > 90) throw new Error("Latitude is out of range.");
    if (lng < -180 || lng > 180) throw new Error("Longitude is out of range.");

    const result = await recordBiometricPunchLocation({
      worker,
      punchId,
      lat,
      lng,
      accuracyM: parseOptionalNumber(formData.get("accuracyM")),
      altitudeM: parseOptionalNumber(formData.get("altitudeM")),
      clientCapturedAt: String(formData.get("clientCapturedAt") ?? "").trim() || null,
      sessionId: String(formData.get("sessionId") ?? "").trim() || null,
      integritySignals: parseIntegritySignals(formData.get("integritySignals"))
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to record punch location.";
    const status = message.includes("Login") ? 401 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
