/** Shared by the form and API: never send missing punch times to the request RPC. */
export function regularizationClock(value: unknown) {
  const match = String(value ?? "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "";
}

export function missingPunchReason(currentIn: unknown, currentOut: unknown) {
  const hasIn = Boolean(regularizationClock(currentIn));
  const hasOut = Boolean(regularizationClock(currentOut));
  if (!hasIn && !hasOut) return "missed_both";
  if (!hasIn) return "missed_in";
  if (!hasOut) return "missed_out";
  return "";
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
  if (outTime <= inTime) throw new Error("Requested OUT time must be after IN time.");
  return { inTime, outTime };
}
