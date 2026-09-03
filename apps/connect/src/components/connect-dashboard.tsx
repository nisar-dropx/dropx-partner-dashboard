"use client";

import {
  AlertTriangle,
  CalendarDays,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Fingerprint,
  IndianRupee,
  LogIn,
  LogOut,
  PersonStanding,
  Target,
  UserRound,
  UserRoundX
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppAccount } from "./connect-profile-app";
import {
  dashboardMotivationContext,
  isSafeProfessionalMotivation,
  isTooSimilarMotivation,
  motivationSlotKey,
  selectFallbackMotivation,
  type MotivationHistoryEntry
} from "../lib/dashboard-motivation";
import {
  attendanceCompactNudge,
  attendanceDayInsight,
  isCurrentAttendanceAttentionDate,
  type AttendanceInsightRow
} from "../lib/attendance-insights";
import { readJsonResponse, userFacingError } from "../lib/user-facing-error";

type Profile = {
  editable: Record<string, string>;
  status: string;
};

type Verification = {
  kind: string;
  verified: boolean;
  manualReview?: boolean;
  blockSubmit?: boolean;
};

type Regularization = {
  status: string;
};

type AttendanceRow = AttendanceInsightRow & {
  date: string;
  status: string;
  statusLabel?: string | null;
  statusKind?: "attendance" | "leave";
  attendanceStatus?: string | null;
  inTime: string;
  outTime: string;
  punches: string[];
  workHours: string;
  punchCount: number;
  remark: string;
  regularization: Regularization | null;
};

type Attendance = {
  summary: {
    present: number;
    fullDay?: number;
    halfDay?: number;
    absent: number;
    needsReview?: number;
    misPunch: number;
  };
  rows: AttendanceRow[];
};

type DashboardAlert = {
  label: string;
  detail?: string;
  danger: boolean;
  target?: "profile" | "attendance";
};

type OpenFlagNotice = {
  id: string;
  punch_date: string;
  supportStatus?: "needed" | "pending_review" | "returned";
  supportSubmitted?: boolean;
  message?: string;
};

type PunchState = {
  punchDate?: string;
  open?: boolean;
};

function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function displayDate(value: string) {
  const parts = value.split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : value;
}

function workMinutes(value: string) {
  const match = value.match(/^(\d+):(\d+)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function parseDate(value = "") {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  if (local) return new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]));
  return null;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function Pill({ text, tone }: { text: string; tone: "green" | "amber" | "red" }) {
  return <em className={`dx-dashboard-pill ${tone}`}>{titleCase(text)}</em>;
}

function Metric({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone: "green" | "red" | "orange" | "purple";
}) {
  return (
    <div className={`dx-dashboard-metric ${tone}`}>
      <span className="dx-dashboard-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="dx-dashboard-metric-copy">
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

export function ConnectDashboard({
  account,
  onAttendance,
  onAdvances,
  onLeave,
  onPerformance,
  onProfile,
  onRoster,
  variant = "people"
}: {
  account: AppAccount;
  onAttendance: () => void;
  onAdvances: () => void;
  onLeave: () => void;
  onPerformance: () => void;
  onProfile: () => void;
  onRoster: () => void;
  variant?: "people" | "workforce";
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [openFlags, setOpenFlags] = useState<OpenFlagNotice[]>([]);
  const [punchState, setPunchState] = useState<PunchState | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [motivation, setMotivation] = useState("");

  useEffect(() => {
    if (!profile || !attendance) {
      setMotivation("");
      return;
    }

    const dashboardProfile = profile;
    const dashboardAttendance = attendance;
    let cancelled = false;
    const storageKey = `dropx-one:dashboard-motivation:v2:${account.companyId}:${account.profileType}:${account.id}`;

    function readHistory() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
        if (!Array.isArray(parsed)) return [] as MotivationHistoryEntry[];
        return parsed.filter((entry): entry is MotivationHistoryEntry =>
          Boolean(entry) && typeof entry.key === "string" && typeof entry.message === "string"
        ).slice(0, 16);
      } catch {
        return [] as MotivationHistoryEntry[];
      }
    }

    function saveHistory(entry: MotivationHistoryEntry, history: MotivationHistoryEntry[]) {
      const next = [entry, ...history.filter((item) => item.key !== entry.key)].slice(0, 16);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // The message remains available when private browsing blocks local storage.
      }
    }

    async function refreshMotivation() {
      const now = new Date();
      const todayRow = dashboardAttendance.rows.find((row) => row.date === localIsoDate(now));
      const context = dashboardMotivationContext({
        date: now,
        dateOfBirth: dashboardProfile.editable.dateOfBirth,
        status: todayRow?.status,
        statusKind: todayRow?.statusKind,
        statusLabel: todayRow?.statusLabel
      });
      const slotKey = motivationSlotKey(now, context);
      const history = readHistory();
      const cached = history.find((entry) => entry.key === slotKey);
      if (cached) {
        if (!cancelled) setMotivation(cached.message);
        return;
      }

      const recent = history.map((entry) => entry.message).slice(0, 12);
      const fallback = selectFallbackMotivation(`${account.id}:${slotKey}`, recent, context);
      if (!cancelled) setMotivation(fallback);

      try {
        const response = await fetch("/api/connect/motivation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
            hour: now.getHours(),
            localDate: localIsoDate(now),
            context,
            recent,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
          })
        });
        const payload = await response.json();
        const candidate = typeof payload.message === "string" ? payload.message.replace(/\s+/g, " ").trim() : "";
        const message = isSafeProfessionalMotivation(candidate) && !isTooSimilarMotivation(candidate, recent)
          ? candidate
          : fallback;
        if (!cancelled) {
          setMotivation(message);
          saveHistory({ key: slotKey, message }, history);
        }
      } catch {
        if (!cancelled) saveHistory({ key: slotKey, message: fallback }, history);
      }
    }

    setMotivation("");
    void refreshMotivation();
    const timer = window.setInterval(() => void refreshMotivation(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account.companyId, account.id, account.profileType, attendance, profile]);

  useEffect(() => {
    setProfile(null);
    setAttendance(null);
    setOpenFlags([]);
    setPunchState(null);
    setError("");
    const executive = account.profileType !== "employee" && account.profileType !== "user";
    const profileUrl = executive
      ? `/api/connect/field-executive-profile?executiveId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`
      : `/api/connect/profile?employeeId=${encodeURIComponent(account.id)}`;
    const month = localIsoDate().slice(0, 7);

    Promise.all([
      fetch(profileUrl).then(async (response) => {
        const payload = await readJsonResponse<{ profile: Profile }>(response, "Unable to load profile. Please try again.");
        return payload.profile as Profile;
      }),
      fetch(`/api/connect/attendance?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}&month=${month}`)
        .then(async (response) => {
          return readJsonResponse<Attendance>(response, "Unable to load attendance. Please try again.");
        }),
      fetch(`/api/connect/verification?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`)
        .then(async (response) => {
          const payload = await readJsonResponse<{ verifications?: Verification[] }>(response, "Unable to load profile checks. Please try again.");
          return (payload.verifications ?? []) as Verification[];
        }),
      fetch(`/api/connect/attendance/punch?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`)
        .then(async (response) => {
          const payload = await readJsonResponse<{ openFlags?: OpenFlagNotice[]; shift?: PunchState | null }>(response, "Unable to refresh punch status.");
          return {
            flags: (payload.openFlags ?? []) as OpenFlagNotice[],
            shift: (payload.shift ?? null) as PunchState | null
          };
        })
        .catch(() => ({ flags: [] as OpenFlagNotice[], shift: null as PunchState | null }))
    ]).then(([nextProfile, nextAttendance, nextVerifications, punchPayload]) => {
      setProfile(nextProfile);
      setAttendance(nextAttendance);
      setVerifications(nextVerifications);
      setOpenFlags(punchPayload.flags);
      setPunchState(punchPayload.shift);
    }).catch((reason) => setError(userFacingError(reason, "Unable to load dashboard. Please try again.")));
  }, [account.id, account.profileType, refreshKey]);

  const alerts = useMemo(() => {
    if (!profile) return [] as DashboardAlert[];
    const rows: DashboardAlert[] = [];
    for (const flag of openFlags) {
      const reviewPending = flag.supportStatus === "pending_review" || flag.supportSubmitted === true;
      const dateLabel = displayDate(flag.punch_date);
      if (reviewPending) {
        rows.push({
          label: `Attendance review pending · ${dateLabel}`,
          danger: false,
          target: "attendance"
        });
      } else {
        rows.push({
          label: `Action needed on Attendance · ${dateLabel}`,
          danger: true,
          target: "attendance"
        });
      }
    }
    const fields: Record<string, string> = {
      "Driving licence": profile.editable.drivingLicenseExpiry,
      "Vehicle registration": profile.editable.registrationExpiry,
      "Vehicle insurance": profile.editable.insuranceExpiry,
      "Pollution certificate": profile.editable.pollutionExpiry
    };
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    Object.entries(fields).forEach(([label, value]) => {
      const expiry = parseDate(value);
      if (!expiry) return;
      const days = Math.ceil((expiry.getTime() - start.getTime()) / 86400000);
      if (days < 0) rows.push({ label: `${label} expired`, danger: true, target: "profile" });
      else if (days <= 30) rows.push({ label: `${label} expires in ${days} days`, danger: false, target: "profile" });
    });
    const labels: Record<string, string> = {
      pan: "PAN verification",
      pan_aadhaar: "PAN-Aadhaar link",
      pf_uan: "PF UAN verification",
      dl: "Driving licence verification"
    };
    verifications.forEach((verification) => {
      if (!labels[verification.kind]) return;
      if (verification.blockSubmit) rows.push({ label: `${labels[verification.kind]} failed`, danger: true, target: "profile" });
      else if (!verification.verified || verification.manualReview) rows.push({ label: `${labels[verification.kind]} requires review`, danger: false, target: "profile" });
    });
    const todayDate = localIsoDate();
    [...(attendance?.rows ?? [])]
      .sort((left, right) => right.date.localeCompare(left.date))
      .forEach((row) => {
        if (rows.length >= 6) return;
        if (row.date === todayDate || !isCurrentAttendanceAttentionDate(row.date, todayDate)) return;
        const insight = attendanceDayInsight(row, {
          today: false,
          shiftOpen: row.date === punchState?.punchDate && punchState?.open === true
        });
        const nudge = attendanceCompactNudge(row);
        if (!nudge) return;
        rows.push({
          label: `Yesterday · ${nudge.headline}`,
          detail: nudge.detail,
          danger: nudge.tone === "red",
          target: "attendance"
        });
      });
    return rows.slice(0, 6);
  }, [attendance?.rows, openFlags, profile, punchState?.open, punchState?.punchDate, verifications]);

  if (!profile && !error) return <div className="dx-loader fullscreen"><span /><small>Loading dashboard...</small></div>;
  if (!profile || !attendance) return <div className="dx-alert error">{error}<button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>;

  const now = new Date();
  const today = attendance.rows.find((row) => row.date === localIsoDate());
  const todayInsight = attendanceDayInsight(today, {
    today: true,
    shiftOpen: today?.date === punchState?.punchDate && punchState?.open === true
  });
  const todayNudge = attendanceCompactNudge(today, {
    today: true,
    shiftOpen: today?.date === punchState?.punchDate && punchState?.open === true
  });
  const todayStatus = todayInsight.label;
  const statusTone = todayInsight.tone === "green" ? "green" : todayInsight.tone === "red" ? "red" : "amber";
  const totalMinutes = attendance.rows.reduce((total, row) => total + workMinutes(row.workHours), 0);
  const totalHours = `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}`;
  const latestRequest = [...attendance.rows]
    .filter((row) => row.regularization)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const todayLabel = new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "short"
  }).format(now);
  const firstNameRaw = (account.name || account.reference || "there").trim().split(/\s+/)[0];
  const firstName = firstNameRaw.charAt(0).toUpperCase() + firstNameRaw.slice(1).toLowerCase();
  const profileStatus = profile.status || account.status || "active";
  const attendanceAllowed = (account.pageAccess ?? ["dashboard", "attendance", "settings"]).includes("attendance");
  const pageAccess = account.pageAccess ?? ["dashboard", "profile", "attendance", "leave", "settings"];
  const profileAllowed = pageAccess.includes("profile");
  const rosterAllowed = pageAccess.includes("roster");
  const leaveAllowed = pageAccess.includes("leave");
  const performanceAllowed = account.profileType === "employee" || account.profileType === "contractor" || pageAccess.includes("performance");
  const advancesAllowed = pageAccess.includes("advances");
  const fullDayCount = attendance.summary.fullDay ?? attendance.summary.present;
  const halfDayCount = attendance.summary.halfDay ?? 0;
  const reviewCount = attendance.rows.filter((row) => attendanceDayInsight(row, {
    today: row.date === localIsoDate(now),
    shiftOpen: row.date === punchState?.punchDate && punchState?.open === true
  }).needsRegularization).length;
  const trackedDays = fullDayCount + halfDayCount + attendance.summary.absent + reviewCount;
  const attendanceRate = trackedDays ? Math.round(((fullDayCount + halfDayCount * 0.5) / trackedDays) * 100) : 0;
  const workforce = variant === "workforce";

  return <section className={`dx-dashboard${workforce ? " dx-workforce-dashboard" : ""}`}>
    <header className="dx-dashboard-greeting">
      <div>
        <small className="dx-page-eyebrow">{workforce ? "Workforce" : "Today"} · {todayLabel}</small>
        <h1>{greeting}, {firstName}</h1>
        <p className="dx-dashboard-motivation" aria-live="polite">
          {workforce ? "Shift, attendance and work updates in one place." : motivation || "A fresh moment is ready for thoughtful progress."}
        </p>
      </div>
      <span className="dx-live-chip"><i /> {workforce ? "Workforce" : "Live"}</span>
    </header>

    <section className="dx-dashboard-card today">
      <header><div><small>Today</small><h2>Attendance</h2></div><Pill text={todayStatus} tone={statusTone} /></header>
      {today?.scheduledStart && today.scheduledStart !== "--:--" ? <p className="dx-dashboard-shift-expectation">
        <CalendarClock />
        <span><strong>Report by {today.scheduledStart}</strong><small>{today.shiftName || "Rostered shift"} · {today.scheduledStart}–{today.scheduledEnd}</small></span>
      </p> : null}
      <div className="dx-dashboard-metrics">
        <Metric icon={<LogIn />} label="In" value={today?.inTime || "--:--"} tone="green" />
        <Metric icon={<LogOut />} label="Out" value={today?.outTime || "--:--"} tone="red" />
        <Metric icon={<Clock3 />} label="Work" value={today?.workHours || "00:00"} tone="orange" />
        <Metric icon={<Fingerprint />} label="Punches" value={today?.punchCount || 0} tone="purple" />
      </div>
      {today && todayNudge ? <button className={`dx-dashboard-attendance-nudge ${todayNudge.tone}`} onClick={onAttendance}>
        <AlertTriangle />
        <span><strong>{todayNudge.headline}</strong><small>{todayNudge.detail}</small></span>
        <ChevronRight />
      </button> : null}
      {attendanceAllowed ? <button className="dx-dashboard-link" onClick={onAttendance}>View attendance <ChevronRight /></button> : null}
    </section>

    {alerts.length ? <section className="dx-dashboard-card">
      <h2>Requires attention</h2>
      <div className="dx-dashboard-alerts">
        {alerts.map((alert) => (
          <button
            key={alert.label}
            onClick={alert.target === "attendance" && attendanceAllowed ? onAttendance : onProfile}
          >
            <AlertTriangle className={alert.danger ? "danger" : ""} />
            <span><strong>{alert.label}</strong>{alert.detail ? <small>{alert.detail}</small> : null}</span>
            <ChevronRight />
          </button>
        ))}
      </div>
    </section> : null}

    <section className="dx-dashboard-card dx-dashboard-summary-card">
      <header><div><small>This month</small><h2>Summary</h2></div></header>
      <div className="dx-dashboard-metrics">
        <Metric icon={<CheckCircle2 />} label="Full day" value={fullDayCount} tone="green" />
        <Metric icon={<PersonStanding />} label="Half day" value={halfDayCount} tone="orange" />
        <Metric icon={<UserRoundX />} label="Absent" value={attendance.summary.absent} tone="red" />
        <Metric icon={<Clock3 />} label="Needs review" value={reviewCount} tone="purple" />
      </div>
      <div className="dx-month-progress">
        <span><b>{attendanceRate}%</b><small>Attendance score · {totalHours} hrs</small></span>
        <i aria-label={`${attendanceRate}% attendance rate`}><b style={{ width: `${attendanceRate}%` }} /></i>
      </div>
    </section>

    <section className="dx-dashboard-card dx-dashboard-actions">
      <header><div><small>{workforce ? "Work tools" : "Shortcuts"}</small><h2>Quick actions</h2></div></header>
      <div>
        {attendanceAllowed ? <button onClick={onAttendance}><i className="blue"><Fingerprint /></i><span><strong>Attendance</strong><small>View punches</small></span><ChevronRight /></button> : null}
        {workforce && rosterAllowed ? <button onClick={onRoster}><i className="amber"><CalendarClock /></i><span><strong>My roster</strong><small>Shift and swap requests</small></span><ChevronRight /></button> : null}
        {leaveAllowed ? <button onClick={onLeave}><i className="pink"><CalendarDays /></i><span><strong>Time off</strong><small>Request leave</small></span><ChevronRight /></button> : null}
        {performanceAllowed ? <button onClick={onPerformance}><i className="purple"><Target /></i><span><strong>Performance</strong><small>Goals & reviews</small></span><ChevronRight /></button> : null}
        {!workforce && advancesAllowed ? <button onClick={onAdvances}><i className="amber"><IndianRupee /></i><span><strong>My pay</strong><small>Advances</small></span><ChevronRight /></button> : null}
        {profileAllowed ? <button onClick={onProfile}><i className="green"><UserRound /></i><span><strong>Profile</strong><small>Personal details</small></span><ChevronRight /></button> : null}
      </div>
    </section>

    {latestRequest?.regularization && attendanceAllowed ? <section className="dx-dashboard-card">
      <h2>Recent requests</h2>
      <button className="dx-dashboard-request" onClick={onAttendance}>
        <CalendarClock />
        <span><strong>Attendance regularization</strong><small>{displayDate(latestRequest.date)}</small></span>
        <Pill
          text={latestRequest.regularization.status || "pending"}
          tone={latestRequest.regularization.status === "approved" ? "green" : latestRequest.regularization.status === "rejected" ? "red" : "amber"}
        />
        <ChevronRight />
      </button>
    </section> : null}

    {profileAllowed ? <button className="dx-dashboard-profile dx-dashboard-profile-status" onClick={onProfile}>
      <i><UserRound /></i>
      <span><strong>My profile</strong><small><Pill text={profileStatus} tone={profileStatus === "active" ? "green" : "amber"} /> {profileStatus === "active" ? "100% completed" : "View profile status"}</small></span>
      <ChevronRight />
    </button> : null}
  </section>;
}
