/** Approved late-in / early-out permission waives that penalty; clocks still score Present/Half/Absent. */
export function regularizationPermissionWaivers(remark: string | null | undefined) {
  const text = String(remark ?? "").toLowerCase();
  return {
    late: /late[\s_-]*in[\s_-]*permission/.test(text),
    earlyOut: /early[\s_-]*out[\s_-]*permission/.test(text)
  };
}
