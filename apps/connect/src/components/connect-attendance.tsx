"use client";

import {
  Camera,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Fingerprint,
  Info,
  LogIn,
  LogOut,
  Paperclip,
  ShieldAlert,
  UserCheck,
  UserX,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SelfieCapturePanel } from "./selfie-capture-panel";
import { todayInIndia } from "@/lib/india-date";
import { stampSupportSelfieBlob } from "@/lib/support-selfie-stamp";

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
  supportStatus?: "needed" | "pending_review" | "returned";
  supportSubmitted?: boolean;
};
type StationGeo = {
  id: string;
  code: string | null;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusM: number | null;
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
  station: StationGeo | null;
  stations?: StationGeo[];
  openFlags: OpenFlag[];
};

type GeofenceGate = {
  status: "checking" | "inside" | "outside" | "unknown";
  distanceM: number | null;
  radiusM: number | null;
  stationLabel: string;
  message: string;
};

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function evaluateClientGeofence(lat: number, lng: number, stations: StationGeo[]): GeofenceGate {
  const usable = stations.filter(
    (row) =>
      row.latitude != null &&
      row.longitude != null &&
      Number.isFinite(row.latitude) &&
      Number.isFinite(row.longitude) &&
      row.radiusM != null &&
      row.radiusM > 0
  );
  if (!usable.length) {
    return {
      status: "unknown",
      distanceM: null,
      radiusM: null,
      stationLabel: "station",
      message: "Station geofence is not configured. Contact admin."
    };
  }
  const ranked = usable
    .map((station) => {
      const distanceM = haversineMeters(lat, lng, station.latitude as number, station.longitude as number);
      return { station, distanceM, radiusM: station.radiusM as number };
    })
    .sort((left, right) => left.distanceM - right.distanceM);
  const best = ranked[0];
  const stationLabel = best.station.code || best.station.name || "station";
  if (best.distanceM <= best.radiusM) {
    return {
      status: "inside",
      distanceM: Math.round(best.distanceM),
      radiusM: best.radiusM,
      stationLabel,
      message: `Inside ${stationLabel} (${Math.round(best.distanceM)}m · allowed ${best.radiusM}m)`
    };
  }
  return {
    status: "outside",
    distanceM: Math.round(best.distanceM),
    radiusM: best.radiusM,
    stationLabel,
    message: `You are outside the allowed location (${Math.round(best.distanceM)}m from ${stationLabel}, allowed ${best.radiusM}m). Move inside the station perimeter to enable the camera.`
  };
}

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
        setSelected(payload.rows?.find((row: Row) => row.date === todayInIndia()) ?? payload.rows?.at(-1) ?? null);
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

  const supportStationKey = [
    punchStatus?.station?.id,
    punchStatus?.station?.latitude,
    punchStatus?.station?.longitude,
    punchStatus?.station?.radiusM,
    ...(punchStatus?.stations ?? []).flatMap((row) => [row.id, row.latitude, row.longitude, row.radiusM])
  ].join("|");

  const supportStations = useMemo(() => {
    const rows = [
      ...(punchStatus?.station ? [punchStatus.station] : []),
      ...(punchStatus?.stations ?? [])
    ];
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = row.id || `${row.latitude},${row.longitude}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed by supportStationKey
  }, [supportStationKey]);

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

      {openFlags.length ? (
        <div className="dx-gps-punch-card">
          <header>
            <div>
              <strong>
                {openFlags.every((flag) => flag.supportStatus === "pending_review" || flag.supportSubmitted)
                  ? "Review pending"
                  : "Action needed"}
              </strong>
              <small>
                {openFlags.every((flag) => flag.supportStatus === "pending_review" || flag.supportSubmitted)
                  ? "Your selfie was submitted. Waiting for review."
                  : "Submit a selfie with your current location to continue."}
              </small>
            </div>
          </header>
          <div className="dx-flag-list">
            {openFlags.map((flag) => {
              const reviewPending = flag.supportStatus === "pending_review" || flag.supportSubmitted === true;
              const needsResubmit = flag.supportStatus === "returned";
              return (
                <div key={flag.id}>
                  <ShieldAlert />
                  <div>
                    <strong>{reviewPending ? "Review pending" : "Location check"}</strong>
                    <small>
                      {reviewPending
                        ? "Selfie submitted — you cannot send again until review finishes."
                        : needsResubmit
                          ? "Please submit a new selfie."
                          : "Take a live selfie at your station."}
                    </small>
                  </div>
                  {reviewPending ? (
                    <em className="dx-request-status pending">Pending</em>
                  ) : (
                    <button type="button" onClick={() => setSupportFlag(flag)}>
                      {needsResubmit ? "Resubmit selfie" : "Submit selfie"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
        stations={supportStations}
        onClose={() => setSupportFlag(null)}
        onSubmitted={() => {
          setSupportFlag(null);
          setSupportNotice("Selfie submitted. Review is pending.");
          setRefreshKey((value) => value + 1);
        }}
      /> : null}
    </section>
  );
}

function SupportEvidenceSheet({
  account,
  flag,
  stations,
  onClose,
  onSubmitted
}: {
  account: Account;
  flag: OpenFlag;
  stations: StationGeo[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [remarks, setRemarks] = useState("");
  const [selfie, setSelfie] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState("");
  const [captureMeta, setCaptureMeta] = useState<{
    lat: number;
    lng: number;
    accuracyM: number | null;
    capturedAt: string;
    stationLabel: string;
  } | null>(null);
  const [selfiePanelOpen, setSelfiePanelOpen] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [geofence, setGeofence] = useState<GeofenceGate>({
    status: "checking",
    distanceM: null,
    radiusM: null,
    stationLabel: "station",
    message: "Checking your location…"
  });

  useEffect(() => {
    return () => {
      if (selfiePreview) URL.revokeObjectURL(selfiePreview);
    };
  }, [selfiePreview]);

  const selfiePanelOpenRef = useRef(false);
  selfiePanelOpenRef.current = selfiePanelOpen;

  useEffect(() => {
    let cancelled = false;
    async function checkLocation(options?: { quiet?: boolean }) {
      // Never flip to "checking" while the camera is open — that remounted the panel
      // and reset blink progress back to 0%.
      if (!options?.quiet && !selfiePanelOpenRef.current) {
        setGeofence((prev) =>
          prev.status === "inside" || prev.status === "outside"
            ? prev
            : {
                status: "checking",
                distanceM: null,
                radiusM: null,
                stationLabel: "station",
                message: "Checking your location…"
              }
        );
      }
      try {
        const position = await readPosition();
        if (cancelled) return;
        const next = evaluateClientGeofence(position.coords.latitude, position.coords.longitude, stations);
        setGeofence(next);
        if (next.status === "outside" && selfiePanelOpenRef.current) {
          setSelfiePanelOpen(false);
        }
      } catch (reason) {
        if (cancelled) return;
        if (selfiePanelOpenRef.current) return;
        setGeofence({
          status: "unknown",
          distanceM: null,
          radiusM: null,
          stationLabel: "station",
          message: reason instanceof Error ? reason.message : "Unable to read location. Allow GPS to continue."
        });
      }
    }
    checkLocation().catch(() => undefined);
    const timer = window.setInterval(() => {
      if (selfiePanelOpenRef.current) return;
      checkLocation({ quiet: true }).catch(() => undefined);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [stations]);

  const cameraAllowed = geofence.status === "inside";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (!selfie) throw new Error("Capture a support selfie.");
      if (!navigator.onLine) throw new Error("Internet is required.");
      const position = await readPosition();
      const gate = evaluateClientGeofence(position.coords.latitude, position.coords.longitude, stations);
      setGeofence(gate);
      if (gate.status === "outside") {
        throw new Error(gate.message);
      }
      if (gate.status !== "inside") {
        throw new Error(gate.message || "Move inside the allowed station location to submit.");
      }
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("flagId", flag.id);
      form.set("punchDate", flag.punch_date);
      form.set("lat", String(position.coords.latitude));
      form.set("lng", String(position.coords.longitude));
      if (Number.isFinite(position.coords.accuracy)) form.set("accuracyM", String(position.coords.accuracy));
      form.set("clientCapturedAt", captureMeta?.capturedAt ?? new Date().toISOString());
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
          <strong>Submit selfie</strong>
          <small>Stay inside your station. Camera stays off while you are outside.</small>
        </div>
        <button aria-label="Close" onClick={onClose}><X /></button>
      </header>
      <form onSubmit={submit}>
        <div className="dx-regularization-day">
          <span><small>DATE</small><strong>{flag.punch_date.split("-").reverse().join("/")}</strong></span>
        </div>
        <p className="dx-form-hint">Take a live selfie at your station to continue.</p>
        <div className={`dx-alert ${geofence.status === "inside" ? "ok" : geofence.status === "checking" ? "" : "error"}`} role="status">
          {geofence.message}
        </div>
        <div className="dx-selfie-row">
          <button
            type="button"
            className="secondary"
            disabled={!cameraAllowed}
            onClick={() => {
              if (!cameraAllowed) return;
              setSelfiePanelOpen(true);
            }}
          >
            <Camera />{" "}
            {!cameraAllowed
              ? geofence.status === "checking"
                ? "Checking location…"
                : "Camera disabled outside location"
              : selfie
                ? "Retake selfie"
                : "Capture selfie"}
          </button>
          {selfiePreview ? <img alt="Selfie preview" className="dx-selfie-preview" src={selfiePreview} /> : null}
        </div>
        <label>Remarks<textarea placeholder="Optional notes" rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label>
        {error ? <p className="dx-form-error">{error}</p> : null}
        <div className="dx-sheet-actions">
          <button className="secondary" onClick={onClose} type="button">Cancel</button>
          <button disabled={saving || !cameraAllowed || !selfie} type="submit">{saving ? "Submitting..." : "Submit"}</button>
        </div>
      </form>
    </aside>
    {selfiePanelOpen ? (
      <SelfieCapturePanel
        title="Selfie"
        hint="Step 1: match your profile face. Step 2: blink once + turn left/right. Step 3: capture."
        profilePhotoUrl={account.profilePhotoUrl}
        requireFaceMatch
        requireLiveness
        onClose={() => setSelfiePanelOpen(false)}
        onCapture={async (file) => {
          const position = await readPosition();
          const capturedAt = new Date().toISOString();
          const gate = evaluateClientGeofence(position.coords.latitude, position.coords.longitude, stations);
          if (gate.status !== "inside") {
            throw new Error(gate.message || "Move inside the allowed station location to capture.");
          }
          const stampedBlob = await stampSupportSelfieBlob(file, {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            capturedAt,
            stationLabel: gate.stationLabel
          });
          const stampedFile = new File([stampedBlob], file.name, { type: "image/jpeg" });
          if (selfiePreview) URL.revokeObjectURL(selfiePreview);
          setSelfie(stampedFile);
          setSelfiePreview(URL.createObjectURL(stampedFile));
          setCaptureMeta({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            capturedAt,
            stationLabel: gate.stationLabel
          });
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
  const requestsInTime = ["missed_in", "incorrect_in", "missed_both", "other"].includes(reason);
  const requestsOutTime = ["missed_out", "incorrect_out", "missed_both", "other"].includes(reason);
  const proofTimeLabel = !reason
    ? "requested attendance time"
    : requestsInTime && requestsOutTime
      ? "requested IN and OUT times"
      : requestsInTime
        ? "requested IN time"
        : "requested OUT time";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason) {
      setError("Select a regularization reason.");
      return;
    }
    if (requestsInTime && !inTime) {
      setError("Enter the requested IN time.");
      return;
    }
    if (requestsOutTime && !outTime) {
      setError("Enter the requested OUT time.");
      return;
    }
    if (!attachment && !row.regularization?.hasAttachment) {
      setError(`Upload workplace CCTV proof with a visible timestamp matching the ${proofTimeLabel}.`);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("attendanceDate", row.date);
      form.set("currentInTime", row.inTime);
      form.set("currentOutTime", row.outTime);
      form.set("requestedInTime", requestsInTime ? inTime : row.inTime);
      form.set("requestedOutTime", requestsOutTime ? outTime : row.outTime);
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
        <label>Reason<select required value={reason} onChange={(event) => { setReason(event.target.value); setError(""); }}>
          <option value="">Select reason</option>
          <option value="missed_in">Missed IN punch</option>
          <option value="missed_out">Missed OUT punch</option>
          <option value="missed_both">Missed both punches</option>
          <option value="incorrect_in">Incorrect IN time</option>
          <option value="incorrect_out">Incorrect OUT time</option>
          <option value="other">Other</option>
        </select></label>
        {reason ? <div className={`dx-time-grid ${requestsInTime !== requestsOutTime ? "single" : ""}`}>
          {requestsInTime ? <label>Requested IN<input required type="time" value={inTime} onChange={(event) => setInTime(event.target.value)} /></label> : null}
          {requestsOutTime ? <label>Requested OUT<input required type="time" value={outTime} onChange={(event) => setOutTime(event.target.value)} /></label> : null}
        </div> : <p className="dx-time-prompt">Select a reason to enter only the time that needs correction.</p>}
        <label>Remarks<textarea required minLength={5} placeholder="Briefly explain the correction" rows={3} value={remarks} onChange={(event) => setRemarks(event.target.value)} /></label>
        <div className="dx-evidence-info" role="note">
          <Info aria-hidden="true" />
          <span><strong>Workplace CCTV proof is mandatory</strong>Upload a clear screenshot showing you were present at the workplace at the {proofTimeLabel}. The CCTV date and time must be visible; you do not need to be standing near the biometric device.</span>
        </div>
        <label className="dx-attachment required"><Paperclip /><span>{attachment?.name || (row.regularization?.hasAttachment ? "Existing proof attached · choose to replace" : "Upload workplace CCTV proof")}</span><em>Required</em><input accept="image/jpeg,image/png,image/webp" required={!row.regularization?.hasAttachment} type="file" onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          if (file && !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
            setAttachment(null);
            setError("Use a JPG, PNG or WebP CCTV screenshot.");
            event.target.value = "";
            return;
          }
          if (file && file.size > 5 * 1024 * 1024) {
            setAttachment(null);
            setError("CCTV proof must be 5 MB or smaller.");
            event.target.value = "";
            return;
          }
          setError("");
          setAttachment(file);
        }} /></label>
        <p className="dx-evidence-format">JPG, PNG or WebP · maximum 5 MB · timestamp must match the requested attendance time</p>
        {error ? <p className="dx-form-error">{error}</p> : null}
        <div className="dx-sheet-actions"><button className="secondary" onClick={onClose} type="button">Cancel</button><button disabled={saving || (!attachment && !row.regularization?.hasAttachment)} type="submit">{saving ? "Submitting..." : "Submit request"}</button></div>
      </form>
    </aside>
  </>;
}
