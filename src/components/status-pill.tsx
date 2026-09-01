export function StatusPill({ status }: { status: string }) {
  const lower = status.toLowerCase();
  const tone = lower.includes("under review") || lower.includes("under_review")
    ? "under-review"
    : lower.includes("returned")
    ? "returned"
    : lower.includes("inactive")
    || lower.includes("disabled")
    || lower.includes("suspended")
    ? "bad"
    : lower.includes("active")
    || lower.includes("success")
    || lower.includes("verified")
    || lower.includes("cleared")
    || lower.includes("ready")
    || lower.includes("approved")
    || lower.includes("processed")
    || lower.includes("completed")
    || lower.includes("reporting")
    || lower === "no"
    ? "good"
    : lower.includes("pending")
      || lower.includes("partial")
      || lower.includes("draft")
      || lower.includes("docs")
      || lower.includes("review")
      || lower.includes("waiting")
      || lower.includes("heartbeat")
      || lower.includes("medium")
      ? "warn"
      : lower.includes("failed")
        || lower.includes("missed")
        || lower.includes("high")
        || lower.includes("hold")
        || lower.includes("missing")
        || lower.includes("not cleared")
        || lower.includes("short")
        ? "bad"
        : lower.includes("excess")
          ? "warn"
        : "";

  return <span className={`status-pill ${tone}`}>{status}</span>;
}
