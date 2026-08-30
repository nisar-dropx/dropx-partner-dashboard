export const BIOMETRIC_ONLINE_WINDOW_MS = 10 * 60 * 1000;

export type BiometricDeviceHealthStatus =
  | "Reporting"
  | "Heartbeat only"
  | "Disconnected today"
  | "Disconnected"
  | "Inactive";

export type BiometricDeviceHealth = {
  status: BiometricDeviceHealthStatus;
  tone: "good" | "warn" | "bad" | "neutral";
};

type DeviceSignal = {
  is_active?: boolean | null;
  last_seen_at?: string | null;
  status?: string | null;
};

function indiaDateKey(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Kolkata",
    year: "numeric"
  }).format(date);
}

export function biometricDeviceHealth(device: DeviceSignal, now = new Date()): BiometricDeviceHealth {
  if (device.is_active === false) return { status: "Inactive", tone: "neutral" };

  const storedStatus = String(device.status ?? "").trim().toLowerCase();
  const lastSeen = device.last_seen_at ? new Date(device.last_seen_at) : null;
  const lastSeenTime = lastSeen?.getTime() ?? Number.NaN;
  const hasValidLastSeen = Number.isFinite(lastSeenTime);
  const disconnectedSignal = storedStatus.includes("disconnect") || storedStatus.includes("offline");
  const recentlySeen = hasValidLastSeen && now.getTime() - lastSeenTime <= BIOMETRIC_ONLINE_WINDOW_MS;

  if (!disconnectedSignal && recentlySeen) {
    return storedStatus.includes("heartbeat")
      ? { status: "Heartbeat only", tone: "warn" }
      : { status: "Reporting", tone: "good" };
  }

  if (hasValidLastSeen && lastSeen && indiaDateKey(lastSeen) === indiaDateKey(now)) {
    return { status: "Disconnected today", tone: "warn" };
  }

  return { status: "Disconnected", tone: "bad" };
}

export function biometricHealthPriority(status: BiometricDeviceHealthStatus) {
  if (status === "Disconnected") return 0;
  if (status === "Disconnected today") return 1;
  if (status === "Heartbeat only") return 2;
  if (status === "Reporting") return 3;
  return 4;
}
