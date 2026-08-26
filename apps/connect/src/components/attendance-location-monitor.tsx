"use client";

import { useCallback, useEffect, useRef } from "react";

type Account = { id: string; profileType: string };

const HEARTBEAT_MS = 3 * 60 * 1000;
const LOCATION_TRACKING_MS = 9 * 60 * 60 * 1000;

function integrityPayload() {
  return {
    clientPlatform: "web",
    clientUserAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    vpnSuspected: false,
    mockLocation: false,
    developerMode: false
  };
}

function readPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      reject(new Error(error.message || "Unable to read device location."));
    }, {
      enableHighAccuracy: true,
      maximumAge: 30_000,
      timeout: 20_000
    });
  });
}

/**
 * Silent phone GPS reporter while Connect is open.
 * - Presence samples (even off-shift) so biometric buddy-punch can be caught immediately.
 * - In-shift samples for 9 hours after punch-in; continuous outside >50m for 30+ min flags.
 */
export function AttendanceLocationMonitor({ account }: { account: Account }) {
  const sessionId = useRef(`web-${Date.now()}`);
  const lastInTime = useRef<string | null>(null);

  const tick = useCallback(async () => {
    if (!navigator.onLine || typeof navigator.geolocation === "undefined") return;

    try {
      const statusResponse = await fetch(
        `/api/connect/attendance/punch?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`
      );
      const status = await statusResponse.json().catch(() => null);
      if (!statusResponse.ok || !status) return;

      const inTime = status.shift?.open && status.shift?.inTime ? String(status.shift.inTime) : null;
      lastInTime.current = inTime;
      if (inTime) {
        const elapsed = Date.now() - new Date(inTime).getTime();
        if (elapsed > LOCATION_TRACKING_MS) {
          // Past 9h window — do not keep sampling this shift.
          return;
        }
      }

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
    const timer = window.setInterval(run, HEARTBEAT_MS);
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
