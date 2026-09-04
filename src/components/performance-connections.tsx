"use client";

import type { PerformanceConnection } from "@/lib/ops-pulse/performance-review";
import { savePerformanceConnection } from "@/app/ops-pulse/performance/actions";
import { ReviewActionForm } from "@/components/review-action-form";

/** HH:MM in IST from an ISO timestamp. */
function clockValue(value: string | null) {
  if (!value) return "";
  return new Date(new Date(value).getTime() + 330 * 60000).toISOString().slice(11, 16);
}

function persistedConnectionId(id: string | undefined) {
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}

/** Simple station timing row — same 3 time fields as before (no connection/vehicle list). */
export function PerformanceConnections({
  connections,
  date,
  stationCode,
  canEdit
}: {
  connections: PerformanceConnection[];
  date: string;
  stationCode: string;
  canEdit: boolean;
}) {
  const primary = connections[0] ?? null;
  const arrival = clockValue(primary?.arrival_at ?? null);
  const unloading = clockValue(primary?.unloading_at ?? null);
  const clearance = clockValue(primary?.clearance_at ?? null);

  if (!canEdit) {
    return (
      <div className="performance-operations-form review-station-times" aria-label="Station timings">
        <label>Vehicle arrival<strong>{arrival || "—"}</strong></label>
        <label>Unloading complete<strong>{unloading || "—"}</strong></label>
        <label>Station clear<strong>{clearance || "—"}</strong></label>
      </div>
    );
  }

  return (
    <ReviewActionForm
      key={`${stationCode}-${date}-${primary?.id ?? "new"}-${primary?.version ?? 0}`}
      action={savePerformanceConnection}
      className="performance-operations-form review-station-times"
    >
      <input type="hidden" name="source_date" value={date} />
      <input type="hidden" name="station_code" value={stationCode} />
      <input type="hidden" name="connection_id" value={persistedConnectionId(primary?.id)} />
      <input type="hidden" name="version" value={primary?.version ?? 1} />
      <label>
        Vehicle arrival
        <input name="arrival" type="time" required defaultValue={arrival} />
      </label>
      <label>
        Unloading complete
        <input name="unloading" type="time" defaultValue={unloading} />
      </label>
      <label>
        Station clear
        <input name="clearance" type="time" defaultValue={clearance} />
      </label>
      <button className="button secondary">Save timings</button>
    </ReviewActionForm>
  );
}
