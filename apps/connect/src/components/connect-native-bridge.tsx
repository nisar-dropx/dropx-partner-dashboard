"use client";

import { useEffect } from "react";
import type { AppAccount } from "./connect-profile-app";

const POLL_MS = 60 * 1000;

type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    DropxOne?: DropxOnePlugin;
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
    integrityCheckIntervalSeconds: number;
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
  integrityCheckIntervalSeconds: number;
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
  // Capacitor.registerPlugin is a build-time helper exported by the @capacitor/core
  // npm package, not a method on the runtime window.Capacitor bridge object — calling
  // it here always returned null, silently skipping every native call below. An
  // already-registered native plugin is reachable at runtime via Capacitor.Plugins.
  const cap = capacitor();
  return cap?.Plugins?.DropxOne ?? null;
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
  attendanceSettings?: { locationTrackingEnabled?: boolean; integrityCheckIntervalSeconds?: number };
  shift?: { inTime?: string | null };
} | null): AttendanceTrackingState {
  // Admin-editable at /attendance/integrity (hr_company_settings.integrity_check_interval_seconds);
  // 30s here is only the fallback if the server payload is missing/malformed, matching that
  // column's own DB default so a read failure never silently disables repeat checks.
  const integrityCheckIntervalSeconds =
    typeof payload?.attendanceSettings?.integrityCheckIntervalSeconds === "number"
      && payload.attendanceSettings.integrityCheckIntervalSeconds >= 15
      ? payload.attendanceSettings.integrityCheckIntervalSeconds
      : 30;

  const locationTrackingEnabled = payload?.attendanceSettings?.locationTrackingEnabled === true;
  if (!locationTrackingEnabled) {
    return { shouldTrack: false, integrityCheckIntervalSeconds };
  }

  const inTime = payload?.shift?.inTime ? String(payload.shift.inTime) : "";
  if (!inTime) {
    return { shouldTrack: false, integrityCheckIntervalSeconds };
  }

  return { shouldTrack: true, integrityCheckIntervalSeconds };
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
    locationTrackingEnabled: state.shouldTrack,
    integrityCheckIntervalSeconds: state.integrityCheckIntervalSeconds
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
      return { shouldTrack: false, integrityCheckIntervalSeconds: 30 };
    }
    return shouldRunBackgroundTracking(payload);
  } catch {
    return { shouldTrack: false, integrityCheckIntervalSeconds: 30 };
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

    // Re-enabled: the crash (Capacitor's Bridge.getPermissionStates() throwing a
    // NullPointerException on plugin.getPluginHandle().getPluginAnnotation()) was
    // ionic-team/capacitor issue #8589 — R8 full mode folds that getter to always return null
    // because it can't see PluginHandle's constructor actually assigns it via reflection.
    // Fixed with the documented proguard-rules.pro keep rules for PluginHandle's annotation
    // fields, not app code, so no JS-side workaround is needed any more.
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
