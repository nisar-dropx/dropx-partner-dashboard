"use client";

import { useState } from "react";

type ReconciliationFailure = {
  cursor: number;
  enrolmentId: string;
  message: string;
};

type ReconciliationResult = {
  attempted: number;
  completed: number;
  failures: ReconciliationFailure[];
  fromDate: string;
  healthy: boolean;
  nextCursor: number | null;
  punchesReconciled: number;
  skipped: number;
  snapshotToken: string;
  totalMappings: number;
  toDate: string;
};

type RepairSummary = {
  attempted: number;
  completed: number;
  failures: ReconciliationFailure[];
  punchesReconciled: number;
  skipped: number;
  totalMappings: number;
};

async function requestBatch(
  cursor: number,
  limit = 50,
  from?: string,
  to?: string,
  snapshotToken?: string
) {
  const response = await fetch("/api/biometric/reconcile", {
    body: JSON.stringify({ cursor, from, limit, snapshotToken, to }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    method: "POST"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Attendance repair failed.");
  }
  return payload as ReconciliationResult;
}

export function AttendanceRepairControl() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RepairSummary | null>(null);

  async function repairRecentAttendance() {
    setRunning(true);
    setError(null);
    setSummary(null);
    const aggregate: RepairSummary = {
      attempted: 0,
      completed: 0,
      failures: [],
      punchesReconciled: 0,
      skipped: 0,
      totalMappings: 0
    };
    try {
      let cursor: number | null = 0;
      let batches = 0;
      let maximumBatches: number | null = null;
      let frozenWindow: { from: string; snapshotToken: string; to: string } | null = null;
      while (cursor !== null) {
        if (maximumBatches !== null && batches >= maximumBatches) {
          throw new Error("Attendance mappings changed during repair. Run it once more to finish the new mappings.");
        }
        const requestedCursor = cursor;
        const result = await requestBatch(
          cursor,
          50,
          frozenWindow?.from,
          frozenWindow?.to,
          frozenWindow?.snapshotToken
        );
        if (frozenWindow === null) {
          frozenWindow = { from: result.fromDate, snapshotToken: result.snapshotToken, to: result.toDate };
          maximumBatches = result.totalMappings + 2;
        } else if (
          result.fromDate !== frozenWindow.from ||
          result.toDate !== frozenWindow.to ||
          result.snapshotToken !== frozenWindow.snapshotToken
        ) {
          throw new Error("The attendance repair snapshot changed unexpectedly. Run the repair again.");
        }
        if (result.nextCursor !== null && result.nextCursor <= requestedCursor) {
          throw new Error("Attendance repair made no forward progress. Run it again or contact support.");
        }
        aggregate.attempted += result.attempted;
        aggregate.completed += result.completed;
        aggregate.punchesReconciled += result.punchesReconciled;
        aggregate.skipped += result.skipped;
        aggregate.totalMappings = result.totalMappings;
        aggregate.failures.push(...result.failures);
        setSummary({ ...aggregate, failures: [...aggregate.failures] });
        cursor = result.nextCursor;
        batches += 1;
      }

      // A processing payout can temporarily lock a daily rebuild. Retry each
      // failed ownership window once without rewinding the forward scan.
      const retryCursors = Array.from(new Set(aggregate.failures.map((failure) => failure.cursor)));
      let pendingFailures = [...aggregate.failures];
      for (const retryCursor of retryCursors) {
        const result = await requestBatch(
          retryCursor,
          1,
          frozenWindow?.from,
          frozenWindow?.to,
          frozenWindow?.snapshotToken
        );
        aggregate.completed += result.completed;
        aggregate.punchesReconciled += result.punchesReconciled;
        aggregate.skipped += result.skipped;
        pendingFailures = pendingFailures
          .filter((failure) => failure.cursor !== retryCursor)
          .concat(result.failures);
        aggregate.failures = pendingFailures;
        setSummary({ ...aggregate, failures: [...aggregate.failures] });
      }
      setSummary({ ...aggregate, failures: [...aggregate.failures] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attendance repair failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>Recent attendance repair</h2>
          <p className="subtle">Recheck the latest 62 days of mapped biometric punches for every profile status in this company.</p>
        </div>
        <button className="button secondary compact" disabled={running} onClick={repairRecentAttendance} type="button">
          {running ? "Repairing attendance…" : "Repair recent attendance"}
        </button>
      </div>
      {summary ? (
        <div className="panel-body">
          <p>
            Checked <strong>{summary.attempted}</strong> of <strong>{summary.totalMappings}</strong> ownership windows;
            rebuilt <strong>{summary.punchesReconciled}</strong> punches.
          </p>
          <p className="subtle" style={{ marginTop: 6 }}>
            {summary.completed} completed, {summary.skipped} safely skipped, {summary.failures.length} still blocked.
          </p>
        </div>
      ) : null}
      {error ? <div className="panel-body"><p className="error-text">{error}</p></div> : null}
    </section>
  );
}
