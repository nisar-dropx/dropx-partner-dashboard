"use client";

import {
  Camera,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Fingerprint,
  LogIn,
  LogOut,
  Paperclip,
  ShieldAlert,
  UserCheck,
  UserX,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { SelfieCapturePanel } from "./selfie-capture-panel";

type Account = { id: string; profileType: string; profilePhotoUrl?: string | null };
type Regularization = {
  id: string;
  requestedInTime: string;
  requestedOutTime: string;
  reasonCode: string;
  remarks: string;
  hasAttachment: boolean;
  status: string;
  reviewRemarks: string;
  createdAt: string;
};
type Row = {
  date: string;
  status: string;
  statusLabel?: string | null;
  statusKind?: "attendance" | "leave";
  inTime: string;
  outTime: string;
  punches: string[];
  workHours: string;
  punchCount: number;
  remark: string;
  regularization: Regularization | null;
};
type Attendance = {
  month: string;
  summary: { present: number; absent: number; misPunch: number };
  rows: Row[];
};
type OpenFlag = {
  id: string;
  flag_type: string;
  severity: string;
  message: string;
  status: string;
  punch_date: string;
  created_at: string;
};
type PunchStatus = {
  enrolmentId: string;
  locationId: string | null;
  shift: {
    punchDate: string;
    open: boolean;
    inTime: string | null;
    outTime: string | null;
    punchCount: number;
    pendingApproval?: boolean;
    dutyOnly?: boolean;
  };
  openFlags: OpenFlag[];
};

const LOCATION_TRACKING_MS = 9 * 60 * 60 * 1000;

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "short", year: "2-digit" })
    .format(new Date(year, month - 1, 1))
    .replace(" ", "-");
}

function shiftMonth(value: string, amount: number) {
  const [year, month] = value.split("-").map(Number);
  const next = new Date(year, month - 1 + amount, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

function minutes(value: string) {
  const match = value.match(/(\d+):(\d+)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function dayStatus(row: Row | undefined, future: boolean) {
  if (future || !row) return "off";
  if (row.status === "A") return "absent";
  if (row.statusKind === "leave") return "leave";
  if (row.remark.toLowerCase().match(/single|missing/)) return "miss";
  return row.status === "P" ? "present" : "off";
}

function attendanceLabel(row: Row | undefined) {
  if (!row) return "No record";
  if (row.statusLabel) return row.statusLabel;
  const status = row.status.toUpperCase();
  if (status === "P") return "Present";
  if (status === "A") return "Absent";
  if (status === "WO") return "Weekly off";
  if (status === "HD") return "Half day";
  return row.status || "No punch";
}

function emptyAttendanceRow(date: string): Row {
  return {
    date,
    status: "",
    statusLabel: null,
    statusKind: "attendance",
    inTime: "",
    outTime: "",
    punches: [],
    workHours: "",
    punchCount: 0,
    remark: "",
    regularization: null
  };
}

function readPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported on this device."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (error) => {
      reject(new Error(error.message || "Unable to read device location. Allow location access."));
    }, {
      enableHighAccuracy: true,
      maximumAge: 10_000,
      timeout: 20_000
    });
  });
}

export function ConnectAttendance({ account }: { account: Account }) {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [month, setMonth] = useState(currentMonth);
  const [tab, setTab] = useState<"calendar" | "list" | "punches">("calendar");
  const [data, setData] = useState<Attendance | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [regularizing, setRegularizing] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [punchStatus, setPunchStatus] = useState<PunchStatus | null>(null);
  const [supportFlag, setSupportFlag] = useState<OpenFlag | null>(null);
  const [supportNotice, setSupportNotice] = useState("");

  const loadAttendance = useCallback(() => {
    setData(null);
    setError("");
    fetch(`/api/connect/attendance?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}&month=${month}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load attendance.");
        setData(payload);
        setSelected(payload.rows?.find((row: Row) => row.date === new Date().toISOString().slice(0, 10)) ?? payload.rows?.at(-1) ?? null);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load attendance."));
  }, [account.id, account.profileType, month]);

  const loadPunchStatus = useCallback(async () => {
    const response = await fetch(
      `/api/connect/attendance/punch?accountId=${encodeURIComponent(account.id)}&profileType=${encodeURIComponent(account.profileType)}`
    );
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Unable to load punch status.");
    setPunchStatus(payload);
    return payload as PunchStatus;
  }, [account.id, account.profileType]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance, refreshKey]);

  useEffect(() => {
    loadPunchStatus().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadPunchStatus().catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [loadPunchStatus, refreshKey]);

  const rowsByDay = useMemo(() => new Map((data?.rows ?? []).map((row) => [Number(row.date.slice(-2)), row])), [data]);
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  const leading = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const total = (data?.rows ?? []).reduce((sum, row) => sum + minutes(row.workHours), 0);
  const futureMonth = month >= currentMonth;
  const openFlags = punchStatus?.openFlags ?? [];
  const monitoringActive =
    Boolean(punchStatus?.shift.open && punchStatus.shift.inTime) &&
    Date.now() - new Date(punchStatus!.shift.inTime!).getTime() <= LOCATION_TRACKING_MS;

  return (
    <section className="dx-attendance">
      <div className="dx-title-row">
        <div>
          <small className="dx-page-eyebrow">My work record</small>
          <h1>Attendance</h1>
          <p>Review your shifts, punches and regularization.</p>
        </div>
        <div className="dx-month-control">
          <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft /></button>
          <strong>{monthLabel(month)}</strong>
          <button aria-label="Next month" disabled={futureMonth} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight /></button>
        </div>
      </div>

      {supportNotice ? <div className="dx-alert ok">{supportNotice}</div> : null}

      {punchStatus?.shift.pendingApproval ? (
        <div className="dx-alert" role="status">
          Duty status is on (pending manager approval). Calendar / attendance will update only after your flag is approved.
        </div>
      ) : null}

      {openFlags.length ? (
        <div className="dx-gps-punch-card">
          <header>
            <div>
              <strong>Location review needed</strong>
              <small>
                Submit a support selfie with live GPS for manager approval only — this does not mark attendance until approved.
              </small>
            </div>
          </header>
          <div className="dx-flag-list">
            {openFlags.map((flag) => (
              <div key={flag.id}>
                <ShieldAlert />
                <div>
                  <strong>{flag.flag_type.replaceAll("_", " ")}</strong>
                  <small>{flag.message}</small>
                </div>
                <button type="button" onClick={() => setSupportFlag(flag)}>Support selfie</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {monitoringActive ? (
        <p className="dx-form-hint" style={{ marginTop: openFlags.length ? 8 : 0 }}>
          Location monitoring is on for this shift (up to 9 hours from punch-in). Punch in/out on the station biometric device.
        </p>
      ) : null}

      {error ? <div className="dx-alert error">{error}<button onClick={() => setMonth((value) => `${value}`)}>Retry</button></div> : null}
      {!data && !error ? <div className="dx-loader"><span /><small>Loading attendance...</small></div> : null}
      {data ? <>
        <div className="dx-attendance-summary">
          <div><i><UserCheck /></i><span>Present<strong>{data.summary.present}</strong></span></div>
          <div><i><UserX /></i><span>Absent<strong>{data.summary.absent}</strong></span></div>
          <div><i><Clock3 /></i><span>Mis Punch<strong>{data.summary.misPunch}</strong></span></div>
          <p><Clock3 /> Total Hours <strong>{Math.floor(total / 60)}:{String(total % 60).padStart(2, "0")}</strong></p>
        </div>
        <div className="dx-tabs-card">
          <nav>
            {(["calendar", "list", "punches"] as const).map((item) => (
              <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </nav>
          {tab === "calendar" ? <div className="dx-calendar">
            <div className="dx-week">{["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className="dx-days">
              {Array.from({ length: leading }).map((_, index) => <span key={`blank-${index}`} />)}
              {Array.from({ length: days }, (_, index) => index + 1).map((day) => {
                const row = rowsByDay.get(day);
                const future = new Date(year, monthNumber - 1, day) > now;
                const date = `${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                return <button className={`${dayStatus(row, future)} ${selected?.date === date ? "selected" : ""}`} disabled={future} key={day} onClick={() => !future && setSelected(row ?? emptyAttendanceRow(date))}>{day}</button>;
              })}
            </div>
            <div className="dx-legend"><span className="present">Present</span><span className="leave">Approved leave</span><span className="absent">Absent</span><span className="miss">Mis Punch</span><span className="off">Off / Future</span></div>
          </div> : null}
          {tab === "list" ? <div className="dx-attendance-list">
            {[...data.rows].sort((left, right) => right.date.localeCompare(left.date)).map((row) => <button key={row.date} onClick={() => { setSelected(row); setTab("calendar"); }}>
              <header><strong>{row.date.split("-").reverse().join("/")}</strong><em className={dayStatus(row, false)}>{attendanceLabel(row)}</em></header>
              <span><small>IN</small>{row.inTime || "--:--"}</span><span><small>OUT</small>{row.outTime || "--:--"}</span><span><small>HRS</small>{row.workHours || "00:00"}</span>
            </button>)}
          </div> : null}
          {tab === "punches" ? <div className="dx-punches">
            {[...data.rows].sort((left, right) => right.date.localeCompare(left.date)).flatMap((row) => {
              const punches = row.punches?.length ? row.punches : [row.inTime, row.outTime].filter(Boolean);
              return [...punches].sort((left, right) => right.localeCompare(left)).map((time, index) => <div key={`${row.date}-${index}-${time}`}><Fingerprint /><span>{row.date.split("-").reverse().join("/")}</span><strong>{time}</strong></div>);
            })}
          </div> : null}
        </div>
        {tab === "calendar" && selected ? <div className="dx-selected-day">
          <header><div><CalendarDays /><strong>{selected.date.split("-").reverse().join("/")}</strong></div><em className={dayStatus(selected, false)}>{attendanceLabel(selected)}</em></header>
          <div><span><LogIn /><small>IN</small><strong>{selected.inTime || "--:--"}</strong></span><span><LogOut /><small>OUT</small><strong>{selected.outTime || "--:--"}</strong></span><span><Clock3 /><small>WORK</small><strong>{selected.workHours || "00:00"}</strong></span><span><Fingerprint /><small>PUNCHES</small><strong>{selected.punchCount}</strong></span></div>
          {selected.remark ? <p className="dx-attendance-day-note">{selected.remark}</p> : null}
          <footer>
            {selected.regularization ? <span className={`dx-request-status ${selected.regularization.status}`}>Regularization {selected.regularization.status}</span> : null}
            {selected.regularization?.status !== "pending" && selected.statusKind !== "leave" ? <button onClick={() => { setRequestError(""); setRegularizing(true); }}>Regularize</button> : null}
          </footer>
        </div> : null}
      </> : null}
      {regularizing && selected ? <RegularizationSheet
        account={account}
        row={selected}
        onClose={() => setRegularizing(false)}
        onSubmitted={() => {
          setRegularizing(false);
          setRefreshKey((value) => value + 1);
        }}
        error={requestError}
        setError={setRequestError}
      /> : null}
      {supportFlag ? <SupportEvidenceSheet
        account={account}
        flag={supportFlag}
        onClose={() => setSupportFlag(null)}
        onSubmitted={() => {
          setSupportFlag(null);
          setSupportNotice("Support selfie submitted for review.");
          setRefreshKey((value) => value + 1);
        }}
      /> : null}
    </section>
  );
}

function SupportEvidenceSheet({
  account,
  flag,
  onClose,
  onSubmitted
}: {
  account: Account;
  flag: OpenFlag;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [remarks, setRemarks] = useState("");
  const [selfie, setSelfie] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState("");
  const [selfiePanelOpen, setSelfiePanelOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    return () => {
      if (selfiePreview) URL.revokeObjectURL(selfiePreview);
    };
  }, [selfiePreview]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (!selfie) throw new Error("Capture a support selfie.");
      if (!navigator.onLine) throw new Error("Internet is required.");
      const position = await readPosition();
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("flagId", flag.id);
      form.set("punchDate", flag.punch_date);
      form.set("lat", String(position.coords.latitude));
      form.set("lng", String(position.coords.longitude));
      if (Number.isFinite(position.coords.accuracy)) form.set("accuracyM", String(position.coords.accuracy));
      form.set("clientCapturedAt", new Date().toISOString());
      form.set("remarks", remarks);
      form.set("selfie", selfie);
      const response = await fetch("/api/connect/attendance/support-evidence", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit support evidence.");
      onSubmitted();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to submit support evidence.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button aria-label="Close support sheet" className="dx-sheet-scrim" onClick={onClose} />
    <aside className="dx-regularization-sheet" role="dialog" aria-modal="true">
      <header>
        <div>
          <strong>Support selfie + location</strong>
          <small>Attach evidence for manager / HR review. Location and time are captured automatically.</small>
        </div>
        <button aria-label="Close" onClick={onClose}><X /></button>
      </header>
      <form onSubmit={submit}>
        <div className="dx-regularization-day">
          <span><small>FLAG</small><strong>{flag.flag_type.replaceAll("_", " ")}</strong></span>
          <em>{flag.punch_date.split("-").reverse().join("/")}</em>
        </div>
        <p className="dx-form-hint">{flag.message}</p>
        <div className="dx-selfie-row">
          <button type="button" className="secondary" onClick={() => setSelfiePanelOpen(true)}>
            <Camera /> {selfie ? "Retake selfie" : "Capture selfie"}
          </button>
          {selfiePreview ? <img alt="Support selfie preview" className="dx-selfie-preview" src={selfiePreview} /> : null}
        </div>
        <label>Remarks<textarea placeholder="Optional notes for your manager" rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label>
        {error ? <p className="dx-form-error">{error}</p> : null}
        <div className="dx-sheet-actions">
          <button className="secondary" onClick={onClose} type="button">Cancel</button>
          <button disabled={saving} type="submit">{saving ? "Submitting..." : "Submit for review"}</button>
        </div>
      </form>
    </aside>
    {selfiePanelOpen ? (
      <SelfieCapturePanel
        title="Support selfie"
        hint="Complete live checks (blink + head turns), then capture. A printed photo will not pass."
        requireLiveness
        onClose={() => setSelfiePanelOpen(false)}
        onCapture={(file) => {
          if (selfiePreview) URL.revokeObjectURL(selfiePreview);
          setSelfie(file);
          setSelfiePreview(URL.createObjectURL(file));
          setSelfiePanelOpen(false);
        }}
      />
    ) : null}
  </>;
}

function RegularizationSheet({
  account,
  row,
  onClose,
  onSubmitted,
  error,
  setError
}: {
  account: Account;
  row: Row;
  onClose: () => void;
  onSubmitted: () => void;
  error: string;
  setError: (message: string) => void;
}) {
  const [inTime, setInTime] = useState(row.regularization?.requestedInTime || row.inTime || "");
  const [outTime, setOutTime] = useState(row.regularization?.requestedOutTime || row.outTime || "");
  const [reason, setReason] = useState(row.regularization?.reasonCode || "");
  const [remarks, setRemarks] = useState(row.regularization?.remarks || "");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("attendanceDate", row.date);
      form.set("currentInTime", row.inTime);
      form.set("currentOutTime", row.outTime);
      form.set("requestedInTime", inTime);
      form.set("requestedOutTime", outTime);
      form.set("reasonCode", reason);
      form.set("remarks", remarks);
      if (attachment) form.set("attachment", attachment);
      const response = await fetch("/api/connect/attendance", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit regularization request.");
      onSubmitted();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "Unable to submit regularization request.");
    } finally {
      setSaving(false);
    }
  }

  return <>
    <button aria-label="Close regularization" className="dx-sheet-scrim" onClick={onClose} />
    <aside className="dx-regularization-sheet" role="dialog" aria-modal="true" aria-labelledby="regularization-title">
      <header>
        <div><strong id="regularization-title">Attendance regularization</strong><small>Request a correction for this attendance day.</small></div>
        <button aria-label="Close" onClick={onClose}><X /></button>
      </header>
      <form onSubmit={submit}>
        <div className="dx-regularization-day">
          <span><small>DATE</small><strong>{row.date.split("-").reverse().join("/")}</strong></span>
          <em>{attendanceLabel(row)}</em>
        </div>
        <div className="dx-time-grid">
          <label>Requested IN<input required type="time" value={inTime} onChange={(event) => setInTime(event.target.value)} /></label>
          <label>Requested OUT<input required type="time" value={outTime} onChange={(event) => setOutTime(event.target.value)} /></label>
        </div>
        <label>Reason<select required value={reason} onChange={(event) => setReason(event.target.value)}>
          <option value="">Select reason</option>
          <option value="missed_in">Missed IN punch</option>
          <option value="missed_out">Missed OUT punch</option>
          <option value="missed_both">Missed both punches</option>
          <option value="incorrect_in">Incorrect IN time</option>
          <option value="incorrect_out">Incorrect OUT time</option>
          <option value="other">Other</option>
        </select></label>
        <label>Remarks<textarea required minLength={5} placeholder="Briefly explain the correction" rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label>
        <label className="dx-attachment"><Paperclip /><span>{attachment?.name || "Attach supporting file (optional)"}</span><input accept=".jpg,.jpeg,.png,.webp,.pdf" type="file" onChange={(event) => setAttachment(event.target.files?.[0] ?? null)} /></label>
        {error ? <p className="dx-form-error">{error}</p> : null}
        <div className="dx-sheet-actions"><button className="secondary" onClick={onClose} type="button">Cancel</button><button disabled={saving} type="submit">{saving ? "Submitting..." : "Submit request"}</button></div>
      </form>
    </aside>
  </>;
}
