"use client";

import { useCallback, useEffect, useRef } from "react";
import { readResilientPosition } from "@/lib/read-geolocation";

type Account = { id: string; profileType: string };

const POLL_MS = 30 * 1000;
const LOCATION_TRACKING_MS = 9 * 60 * 60 * 1000;
const PUNCH_CORRELATION_MS = 3 * 60 * 1000;

function integrityPayload() {
  const native = typeof window !== "undefined" && (
    (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
    || /Capacitor/i.test(navigator.userAgent)
  );
  return {
    clientPlatform: native ? "android" : "web",
    clientUserAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    vpnSuspected: false,
    mockLocation: false,
    developerMode: false
  };
}

const readPosition = readResilientPosition;

async function postBiometricPunchLocation(
  account: Account,
  punch: { id: string; punchTime: string },
  position: GeolocationPosition,
  sessionId: string
) {
  const form = new FormData();
  form.set("accountId", account.id);
  form.set("profileType", account.profileType);
  form.set("punchId", punch.id);
  form.set("lat", String(position.coords.latitude));
  form.set("lng", String(position.coords.longitude));
  if (Number.isFinite(position.coords.accuracy)) form.set("accuracyM", String(position.coords.accuracy));
  if (Number.isFinite(position.coords.altitude ?? NaN)) {
    form.set("altitudeM", String(position.coords.altitude));
  }
  form.set("clientCapturedAt", new Date(position.timestamp).toISOString());
  form.set("sessionId", sessionId);
  form.set("integritySignals", JSON.stringify(integrityPayload()));
  await fetch("/api/connect/attendance/biometric-punch-location", { method: "POST", body: form });
}

async function finalizeMissingPunchLocation(
  account: Account,
  punch: { id: string; punchTime: string },
  punchDate: string
) {
  const form = new FormData();
  form.set("accountId", account.id);
  form.set("profileType", account.profileType);
  form.set("punchId", punch.id);
  form.set("punchDate", punchDate);
  form.set("finalize", "true");
  await fetch("/api/connect/attendance/biometric-punch-location", { method: "POST", body: form });
}

/**
 * Silent phone GPS reporter while Connect is open.
 * - Fresh GPS at each biometric punch when location flags are ON.
 * - In-shift samples for 9 hours after punch-in when location tracking is ON.
 */
export function AttendanceLocationMonitor({ account }: { account: Account }) {
  const sessionId = useRef(`web-${Date.now()}`);
  const reportedPunchIds = useRef(new Set<string>());
  const finalizedPunchIds = useRef(new Set<string>());

  const tick = useCallback(async () => {
    if (!navigator.onLine || typeof navigator.geolocation === "undefined") return;

    try {
      const statusResponse = await fetch(
        `/api/connect/attendance/punch?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`
      );
      const status = await statusResponse.json().catch(() => null);
      if (!statusResponse.ok || !status) return;

      const integrityFlags = status.attendanceSettings?.integrityFlagsEnabled === true;
      const locationTracking = status.attendanceSettings?.locationTrackingEnabled === true;
      if (!integrityFlags && !locationTracking) return;

      const latestPunch = status.latestBiometricPunch as
        | { id: string; punchTime: string; needsLocation: boolean }
        | null
        | undefined;

      if (integrityFlags && latestPunch?.needsLocation && latestPunch.id) {
        const punchAgeMs = Date.now() - new Date(latestPunch.punchTime).getTime();
        if (punchAgeMs >= 0 && punchAgeMs <= PUNCH_CORRELATION_MS && !reportedPunchIds.current.has(latestPunch.id)) {
          const position = await readPosition(0);
          await postBiometricPunchLocation(account, latestPunch, position, sessionId.current);
          reportedPunchIds.current.add(latestPunch.id);
        } else if (
          punchAgeMs > PUNCH_CORRELATION_MS &&
          !finalizedPunchIds.current.has(latestPunch.id)
        ) {
          await finalizeMissingPunchLocation(
            account,
            latestPunch,
            String(status.shift?.punchDate ?? new Date().toISOString().slice(0, 10))
          );
          finalizedPunchIds.current.add(latestPunch.id);
        }
      }

      if (!locationTracking) return;

      const inTime = status.shift?.inTime ? String(status.shift.inTime) : null;
      if (!inTime) return;

      const position = await readPosition();
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("lat", String(position.coords.latitude));
      form.set("lng", String(position.coords.longitude));
      if (Number.isFinite(position.coords.accuracy)) form.set("accuracyM", String(position.coords.accuracy));
      if (Number.isFinite(position.coords.altitude ?? NaN)) {
        form.set("altitudeM", String(position.coords.altitude));
      }
      form.set("clientCapturedAt", new Date().toISOString());
      form.set("sessionId", sessionId.current);
      form.set("integritySignals", JSON.stringify(integrityPayload()));
      await fetch("/api/connect/attendance/location-heartbeat", { method: "POST", body: form });
    } catch {
      // Silent — monitoring must not interrupt Connect UX.
    }
  }, [account.id, account.profileType]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) tick().catch(() => undefined);
    };
    run();
    const timer = window.setInterval(run, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick]);

  return null;
}
