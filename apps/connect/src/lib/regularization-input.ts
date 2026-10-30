/** Shared by the form and API: never send missing punch times to the request RPC. */
export function regularizationClock(value: unknown) {
  const raw = String(value ?? "").trim();
  // Attendance rows use "--:--" when a punch is absent; treat that as blank.
  if (!raw || raw === "--:--" || raw === "—") return "";
  const match = raw.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
}

/** PostgREST time columns accept HH:MM:SS more reliably than HH:MM alone. */
export function regularizationTimeForRpc(value: string) {
  const clock = regularizationClock(value);
  return clock ? `${clock}:00` : null;
}

export function missingPunchReason(currentIn: unknown, currentOut: unknown) {
  const hasIn = Boolean(regularizationClock(currentIn));
  const hasOut = Boolean(regularizationClock(currentOut));
  if (!hasIn && !hasOut) return "missed_both";
  if (!hasIn) return "missed_in";
  if (!hasOut) return "missed_out";
  return "";
}

/**
 * Clock OUT earlier than clock IN is a valid overnight shift (OUT next calendar day).
 * Matches hr_review_attendance_regularization, which adds one day when out <= in.
 * Only identical IN and OUT are rejected.
 */
export function isOvernightRegularizationPair(inTime: string, outTime: string) {
  const inClock = regularizationClock(inTime);
  const outClock = regularizationClock(outTime);
  return Boolean(inClock && outClock && outClock < inClock);
}

export function regularizationTimeInput(input: {
  reason: string;
  currentIn: string;
  currentOut: string;
  requestedIn: string;
  requestedOut: string;
}) {
  const requestsIn = ["missed_in", "incorrect_in", "missed_both", "late_in_permission"].includes(input.reason);
  const requestsOut = ["missed_out", "incorrect_out", "missed_both", "early_out_permission"].includes(input.reason);
  const missing = missingPunchReason(input.currentIn, input.currentOut);
  if (input.reason === "other" && missing) {
    const label = missing === "missed_both" ? "Missed both punches" : missing === "missed_in" ? "Missed IN punch" : "Missed OUT punch";
    throw new Error(`Other only adds remarks; it cannot fill missing punches. Select ${label} and enter the actual time${missing === "missed_both" ? "s" : ""}.`);
  }
  const inTime = regularizationClock(requestsIn ? input.requestedIn : input.currentIn);
  const outTime = regularizationClock(requestsOut ? input.requestedOut : input.currentOut);
  if (!inTime) throw new Error(requestsIn
    ? "Enter the requested IN time in 24-hour format (HH:MM)."
    : "The existing IN punch is missing. Select Missed both punches.");
  if (!outTime) throw new Error(requestsOut
    ? "Enter the requested OUT time in 24-hour format (HH:MM)."
    : "The existing OUT punch is missing. Select Missed both punches.");
  if (outTime === inTime) {
    throw new Error("Requested IN and OUT times cannot be the same.");
  }
  return {
    inTime,
    outTime,
    inTimeRpc: `${inTime}:00`,
    outTimeRpc: `${outTime}:00`,
    overnight: outTime < inTime
  };
}
