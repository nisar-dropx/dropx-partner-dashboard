"use client";

import { useEffect } from "react";
import type { AppAccount } from "./connect-profile-app";

const POLL_MS = 60 * 1000;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  registerPlugin?: (name: string) => DropxOnePlugin;
  Plugins?: {
    PushNotifications?: PushNotificationsPlugin;
    StatusBar?: {
      setOverlaysWebView?: (options: { overlay: boolean }) => Promise<void>;
    };
  };
};

type DropxOnePlugin = {
  configureAttendance?: (options: {
    accountId: string;
    profileType: string;
    serverUrl: string;
    locationTrackingEnabled: boolean;
  }) => Promise<void>;
  startBackgroundLocation?: () => Promise<void>;
  stopBackgroundLocation?: () => Promise<void>;
};

type PushNotificationsPlugin = {
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  addListener: (
    event: "registration" | "registrationError" | "pushNotificationReceived" | "pushNotificationActionPerformed",
    handler: (payload: { value?: string; notification?: { title?: string; body?: string } }) => void
  ) => Promise<{ remove: () => void }>;
};

type AttendanceTrackingState = {
  shouldTrack: boolean;
};

function capacitor(): CapacitorLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Capacitor?: CapacitorLike }).Capacitor;
}

function isNativeApp() {
  const cap = capacitor();
  return Boolean(cap?.isNativePlatform?.() || /Capacitor/i.test(navigator.userAgent));
}

function dropxOnePlugin(): DropxOnePlugin | null {
  const cap = capacitor();
  if (!cap?.registerPlugin) return null;
  try {
    return cap.registerPlugin("DropxOne");
  } catch {
    return null;
  }
}

function pushPlugin(): PushNotificationsPlugin | null {
  const cap = capacitor();
  return cap?.Plugins?.PushNotifications ?? null;
}

/**
 * Background GPS starts when:
 * 1. Station location tracking is ON (People → Location Attendance master), and
 * 2. Worker has punched IN at least once today (first biometric punch).
 *
 * Keeps sending even after punch-out. The server stops storing samples after 9 hours
 * from that first punch-in.
 */
function shouldRunBackgroundTracking(payload: {
  attendanceSettings?: { locationTrackingEnabled?: boolean };
  shift?: { inTime?: string | null };
} | null): AttendanceTrackingState {
  const locationTrackingEnabled = payload?.attendanceSettings?.locationTrackingEnabled === true;
  if (!locationTrackingEnabled) {
    return { shouldTrack: false };
  }

  const inTime = payload?.shift?.inTime ? String(payload.shift.inTime) : "";
  if (!inTime) {
    return { shouldTrack: false };
  }

  return { shouldTrack: true };
}

async function registerPushToken(account: AppAccount, token: string) {
  const deviceId = `android-${account.id.slice(0, 8)}-${navigator.userAgent.length}`;
  await fetch("/api/connect/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: account.id,
      profileType: account.profileType,
      deviceId,
      pushToken: token,
      platform: capacitor()?.getPlatform?.() ?? "android",
      appVersion: "dropx-one-capacitor"
    })
  });
}

async function syncAttendanceContext(account: AppAccount, state: AttendanceTrackingState) {
  const plugin = dropxOnePlugin();
  if (!plugin?.configureAttendance) return;
  const serverUrl = window.location.origin.replace(/\/$/, "");
  await plugin.configureAttendance({
    accountId: account.id,
    profileType: account.profileType,
    serverUrl,
    locationTrackingEnabled: state.shouldTrack
  });
  if (state.shouldTrack) {
    await plugin.startBackgroundLocation?.();
  } else {
    await plugin.stopBackgroundLocation?.();
  }
}

async function readAttendanceTrackingState(account: AppAccount): Promise<AttendanceTrackingState> {
  try {
    const response = await fetch(
      `/api/connect/attendance/punch?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`,
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      return { shouldTrack: false };
    }
    return shouldRunBackgroundTracking(payload);
  } catch {
    return { shouldTrack: false };
  }
}

export function ConnectNativeBridge({ account }: { account: AppAccount | null }) {
  useEffect(() => {
    if (!isNativeApp()) return;
    document.documentElement.classList.add("native-app");
    capacitor()?.Plugins?.StatusBar?.setOverlaysWebView?.({ overlay: false }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isNativeApp() || !account) return;

    let cancelled = false;
    let pushListener: { remove: () => void } | undefined;

    const sync = async () => {
      const state = await readAttendanceTrackingState(account);
      if (cancelled) return;
      await syncAttendanceContext(account, state);
    };

    const boot = async () => {
      await sync();

      const push = pushPlugin();
      if (!push) return;
      const permission = await push.requestPermissions();
      if (permission.receive !== "granted" || cancelled) return;
      await push.register();
      pushListener = await push.addListener("registration", async (event) => {
        if (!event.value || cancelled) return;
        await registerPushToken(account, event.value);
      });
    };

    boot().catch(() => undefined);
    const interval = window.setInterval(() => {
      sync().catch(() => undefined);
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      pushListener?.remove();
      dropxOnePlugin()?.stopBackgroundLocation?.().catch(() => undefined);
    };
  }, [account?.id, account?.profileType]);

  return null;
}
