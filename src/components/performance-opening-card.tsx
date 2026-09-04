import type { PerformanceOperationalSnapshot } from "@/lib/ops-pulse/performance-review";
import {TrendButton} from "@/components/performance-trends";

function timeText(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(date);
  return value.slice(0, 5);
}

function durationText(minutes: number | null) {
  if (minutes == null) return "Shift not linked";
  if (minutes <= 0) return "On time";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min late`;
  return `${hours} hr${hours === 1 ? "" : "s"}${remainder ? ` ${remainder} min` : ""} late`;
}

type OpeningSnapshot = Pick<PerformanceOperationalSnapshot, "firstPunchAt" | "firstPunchBy" | "openingFirstOtherPunch" | "openingLateMinutes" | "scheduledOpeningTime" | "openingShiftName" | "openingShiftSource" | "openingWindowStart" | "openingWindowEnd">;

export function PerformanceOpeningCard({ snapshot }: { snapshot: OpeningSnapshot }) {
  const earlier = snapshot.openingFirstOtherPunch;
  const isLate = (snapshot.openingLateMinutes ?? 0) > 0;
  const variance = snapshot.firstPunchAt ? durationText(snapshot.openingLateMinutes) : "No People opening punch";
  return <details className={`performance-fact-card opening ${isLate ? "late" : earlier ? "opening-warning" : ""}`} name="performance-review-fact">
    <summary>
      <span>Station opened · People</span>
      <strong>{timeText(snapshot.firstPunchAt)}</strong>
      <small>{earlier ? <b className="opening-warning">Earlier non-People punch</b> : snapshot.firstPunchAt && snapshot.scheduledOpeningTime ? <b className={isLate ? "late" : "on-time"}>{variance}</b> : null}{snapshot.firstPunchBy || "No People opening punch"}</small>
    </summary>
    <div className="performance-opening-popover"><div className="review-opening-history"><TrendButton group="opening" metric="opening" label="Station opening"/></div>
      <p><span>Station opening shift</span><b>{timeText(snapshot.scheduledOpeningTime)}</b></p>
      <p><span>First People opening punch</span><b>{timeText(snapshot.firstPunchAt)}</b></p>
      <p><span>People profile</span><b>{snapshot.firstPunchBy || "No People opening punch"}</b></p>
      <p><span>Variance</span><b className={isLate ? "late" : ""}>{variance}</b></p>
      {earlier ? <div className="performance-opening-exception" role="note">
        <p className="performance-opening-explanation">The first station punch was by a non-People profile. It does not count as the station opening.</p>
        <p><span>First station punch</span><b>{timeText(earlier.time)}</b></p>
        <p><span>Individual</span><b>{earlier.name}</b></p>
        <p><span>Profile</span><b>{earlier.profileLabel}</b></p>
        <p><span>Profile / biometric ID</span><b>{earlier.workerCode}</b></p>
      </div> : null}
      <p><span>Opening schedule</span><b>{snapshot.openingShiftName || "Not linked"}</b></p>
      <p><span>Source</span><b>{snapshot.openingShiftSource || "No approved station roster"}</b></p>
      <p><span>Opening punch window</span><b>{snapshot.openingWindowStart.slice(0, 5)}–{snapshot.openingWindowEnd.slice(0, 5)}</b></p>
    </div>
  </details>;
}
