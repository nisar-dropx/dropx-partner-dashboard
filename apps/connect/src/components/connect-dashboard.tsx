"use client";

import {
  AlertTriangle,
  CalendarClock,
  ChevronRight,
  Clock3,
  Fingerprint,
  LogIn,
  LogOut,
  PersonStanding,
  UserRound,
  UserRoundX
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppAccount } from "./connect-profile-app";

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

type AttendanceRow = {
  date: string;
  status: string;
  inTime: string;
  outTime: string;
  punches: string[];
  workHours: string;
  punchCount: number;
  remark: string;
  regularization: Regularization | null;
};

type Attendance = {
  summary: { present: number; absent: number; misPunch: number };
  rows: AttendanceRow[];
};

type DashboardAlert = {
  label: string;
  danger: boolean;
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
  return <div className={`dx-dashboard-metric ${tone}`}>
    {icon}
    <small>{label}</small>
    <strong>{value}</strong>
  </div>;
}

export function ConnectDashboard({
  account,
  onAttendance,
  onProfile
}: {
  account: AppAccount;
  onAttendance: () => void;
  onProfile: () => void;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setProfile(null);
    setAttendance(null);
    setError("");
    const executive = account.profileType !== "employee" && account.profileType !== "user";
    const profileUrl = executive
      ? `/api/connect/field-executive-profile?executiveId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`
      : `/api/connect/profile?employeeId=${encodeURIComponent(account.id)}`;
    const month = localIsoDate().slice(0, 7);

    Promise.all([
      fetch(profileUrl).then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load profile.");
        return payload.profile as Profile;
      }),
      fetch(`/api/connect/attendance?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}&month=${month}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Unable to load attendance.");
          return payload as Attendance;
        }),
      fetch(`/api/connect/verification?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Unable to load verifications.");
          return (payload.verifications ?? []) as Verification[];
        })
    ]).then(([nextProfile, nextAttendance, nextVerifications]) => {
      setProfile(nextProfile);
      setAttendance(nextAttendance);
      setVerifications(nextVerifications);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load dashboard."));
  }, [account.id, account.profileType, refreshKey]);

  const alerts = useMemo(() => {
    if (!profile) return [] as DashboardAlert[];
    const rows: DashboardAlert[] = [];
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
      if (days < 0) rows.push({ label: `${label} expired`, danger: true });
      else if (days <= 30) rows.push({ label: `${label} expires in ${days} days`, danger: false });
    });
    const labels: Record<string, string> = {
      pan: "PAN verification",
      pan_aadhaar: "PAN-Aadhaar link",
      pf_uan: "PF UAN verification",
      dl: "Driving licence verification"
    };
    verifications.forEach((verification) => {
      if (!labels[verification.kind]) return;
      if (verification.blockSubmit) rows.push({ label: `${labels[verification.kind]} failed`, danger: true });
      else if (!verification.verified || verification.manualReview) rows.push({ label: `${labels[verification.kind]} requires review`, danger: false });
    });
    return rows.slice(0, 4);
  }, [profile, verifications]);

  if (!profile && !error) return <div className="dx-loader fullscreen"><span /><small>Loading dashboard...</small></div>;
  if (!profile || !attendance) return <div className="dx-alert error">{error}<button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>;

  const now = new Date();
  const today = attendance.rows.find((row) => row.date === localIsoDate());
  const present = today?.status.toUpperCase() === "P";
  const todayStatus = !today ? "No punch" : present ? "Present" : today.status.toUpperCase() === "A" ? "Absent" : "Mis Punch";
  const statusTone = present ? "green" : todayStatus === "Absent" ? "red" : "amber";
  const totalMinutes = attendance.rows.reduce((total, row) => total + workMinutes(row.workHours), 0);
  const totalHours = `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}`;
  const latestRequest = [...attendance.rows]
    .filter((row) => row.regularization)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstNameRaw = (account.name || account.reference || "there").trim().split(/\s+/)[0];
  const firstName = firstNameRaw.charAt(0).toUpperCase() + firstNameRaw.slice(1).toLowerCase();
  const profileStatus = profile.status || account.status || "active";
  const attendanceAllowed = (account.pageAccess ?? ["dashboard", "attendance", "settings"]).includes("attendance");

  return <section className="dx-dashboard">
    <header className="dx-dashboard-greeting">
      <h1>{greeting}, {firstName}</h1>
    </header>

    <section className="dx-dashboard-card today">
      <header><h2>Today&apos;s attendance</h2><Pill text={todayStatus} tone={statusTone} /></header>
      <div className="dx-dashboard-metrics">
        <Metric icon={<LogIn />} label="IN" value={today?.inTime || "--:--"} tone="green" />
        <Metric icon={<LogOut />} label="OUT" value={today?.outTime || "--:--"} tone="red" />
        <Metric icon={<Clock3 />} label="WORK" value={today?.workHours || "00:00"} tone="orange" />
        <Metric icon={<Fingerprint />} label="PUNCHES" value={today?.punchCount || 0} tone="purple" />
      </div>
      {attendanceAllowed ? <button className="dx-dashboard-link" onClick={onAttendance}>View attendance <ChevronRight /></button> : null}
    </section>

    <section className="dx-dashboard-card">
      <h2>Monthly summary</h2>
      <div className="dx-dashboard-metrics">
        <Metric icon={<PersonStanding />} label="PRESENT" value={attendance.summary.present} tone="green" />
        <Metric icon={<UserRoundX />} label="ABSENT" value={attendance.summary.absent} tone="red" />
        <Metric icon={<Clock3 />} label="MIS PUNCH" value={attendance.summary.misPunch} tone="orange" />
        <Metric icon={<Clock3 />} label="TOTAL" value={totalHours} tone="purple" />
      </div>
    </section>

    {alerts.length ? <section className="dx-dashboard-card">
      <h2>Requires attention</h2>
      <div className="dx-dashboard-alerts">
        {alerts.map((alert) => <button key={alert.label} onClick={onProfile}>
          <AlertTriangle className={alert.danger ? "danger" : ""} />
          <span>{alert.label}</span>
          <ChevronRight />
        </button>)}
      </div>
    </section> : null}

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

    <button className="dx-dashboard-profile" onClick={onProfile}>
      <i><UserRound /></i>
      <span><strong>My profile</strong><small><Pill text={profileStatus} tone={profileStatus === "active" ? "green" : "amber"} /> {profileStatus === "active" ? "100% completed" : "View profile status"}</small></span>
      <ChevronRight />
    </button>
  </section>;
}
