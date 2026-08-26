"use client";

import {
  Camera,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Fingerprint,
  MapPin,
  LogIn,
  LogOut,
  Paperclip,
  ShieldAlert,
  UserCheck,
  UserX,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { matchSelfieToProfile } from "@/lib/face-match";
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
  };
  station: {
    id: string;
    code: string | null;
    name: string | null;
    latitude: number | null;
    longitude: number | null;
    radiusM: number | null;
  } | null;
  openFlags: OpenFlag[];
};
type LiveLocation = {
  lat: number;
  lng: number;
  accuracyM: number | null;
  altitudeM: number | null;
  capturedAt: string;
  distanceM: number | null;
  inside: boolean | null;
};

const HEARTBEAT_MS = 3 * 60 * 1000;
const REMINDER_MS = [9.5 * 60 * 60 * 1000, 10 * 60 * 60 * 1000] as const;

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
  if (row.remark.toLowerCase().match(/single|missing/)) return "miss";
  return row.status === "P" ? "present" : "off";
}

function emptyAttendanceRow(date: string): Row {
  return {
    date,
    status: "",
    inTime: "",
    outTime: "",
    punches: [],
    workHours: "",
    punchCount: 0,
    remark: "",
    regularization: null
  };
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

function integrityPayload() {
  return {
    clientPlatform: "web",
    clientUserAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    vpnSuspected: false,
    mockLocation: false,
    developerMode: false
  };
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
  const [liveLocation, setLiveLocation] = useState<LiveLocation | null>(null);
  const [locationError, setLocationError] = useState("");
  const [punchBusy, setPunchBusy] = useState(false);
  const [punchError, setPunchError] = useState("");
  const [punchMessage, setPunchMessage] = useState("");
  const [selfieFile, setSelfieFile] = useState<File | null>(null);
  const [selfiePreview, setSelfiePreview] = useState("");
  const [faceMatchLabel, setFaceMatchLabel] = useState("Selfie required · matched to profile photo");
  const [selfiePanelOpen, setSelfiePanelOpen] = useState(false);
  const [supportFlag, setSupportFlag] = useState<OpenFlag | null>(null);
  const [reminderText, setReminderText] = useState("");
  const sessionId = useRef(`web-${Date.now()}`);

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

  const refreshLocation = useCallback(async () => {
    if (!navigator.onLine) {
      setLocationError("Internet is required for attendance location.");
      return null;
    }
    try {
      const position = await readPosition();
      const station = punchStatus?.station;
      let distanceM: number | null = null;
      let inside: boolean | null = null;
      if (station?.latitude != null && station?.longitude != null) {
        distanceM = Math.round(haversineMeters(position.coords.latitude, position.coords.longitude, station.latitude, station.longitude));
        inside = station.radiusM != null ? distanceM <= station.radiusM : null;
      }
      const live: LiveLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
        altitudeM: Number.isFinite(position.coords.altitude ?? NaN) ? Number(position.coords.altitude) : null,
        capturedAt: new Date().toISOString(),
        distanceM,
        inside
      };
      setLiveLocation(live);
      setLocationError("");
      return live;
    } catch (reason) {
      setLocationError(reason instanceof Error ? reason.message : "Unable to read location.");
      return null;
    }
  }, [punchStatus?.station]);

  const sendHeartbeat = useCallback(async (live: LiveLocation) => {
    const form = new FormData();
    form.set("accountId", account.id);
    form.set("profileType", account.profileType);
    form.set("lat", String(live.lat));
    form.set("lng", String(live.lng));
    if (live.accuracyM != null) form.set("accuracyM", String(live.accuracyM));
    if (live.altitudeM != null) form.set("altitudeM", String(live.altitudeM));
    form.set("clientCapturedAt", live.capturedAt);
    form.set("sessionId", sessionId.current);
    form.set("integritySignals", JSON.stringify(integrityPayload()));
    await fetch("/api/connect/attendance/location-heartbeat", { method: "POST", body: form });
  }, [account.id, account.profileType]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance, refreshKey]);

  useEffect(() => {
    loadPunchStatus().catch((reason) => {
      setPunchError(reason instanceof Error ? reason.message : "Unable to load punch status.");
    });
  }, [loadPunchStatus, refreshKey]);

  useEffect(() => {
    refreshLocation().catch(() => undefined);
  }, [refreshLocation]);

  useEffect(() => {
    if (!punchStatus?.shift.open) {
      setReminderText("");
      return;
    }
    let cancelled = false;
    const tick = async () => {
      const live = await refreshLocation();
      if (cancelled || !live) return;
      await sendHeartbeat(live).catch(() => undefined);
      await loadPunchStatus().catch(() => undefined);
      if (punchStatus.shift.inTime) {
        const elapsed = Date.now() - new Date(punchStatus.shift.inTime).getTime();
        if (elapsed >= REMINDER_MS[1]) setReminderText("You have been punched in for 10 hours. Please punch out.");
        else if (elapsed >= REMINDER_MS[0]) setReminderText("You have been punched in for 9.5 hours. Please punch out soon.");
        else setReminderText("");
      }
    };
    tick().catch(() => undefined);
    const timer = window.setInterval(() => {
      tick().catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [punchStatus?.shift.open, punchStatus?.shift.inTime, refreshLocation, sendHeartbeat, loadPunchStatus]);

  useEffect(() => {
    return () => {
      if (selfiePreview) URL.revokeObjectURL(selfiePreview);
    };
  }, [selfiePreview]);

  const rowsByDay = useMemo(() => new Map((data?.rows ?? []).map((row) => [Number(row.date.slice(-2)), row])), [data]);
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(year, monthNumber, 0).getDate();
  const leading = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const total = (data?.rows ?? []).reduce((sum, row) => sum + minutes(row.workHours), 0);
  const futureMonth = month >= currentMonth;
  const openFlags = punchStatus?.openFlags ?? [];
  const outsideZone = liveLocation?.inside === false;
  const zoneUnknown = liveLocation != null && liveLocation.inside == null;

  function onSelfieChange(file: File | null) {
    if (selfiePreview) URL.revokeObjectURL(selfiePreview);
    setSelfieFile(file);
    setSelfiePreview(file ? URL.createObjectURL(file) : "");
    setFaceMatchLabel(file ? "Selfie ready · will match to profile on punch" : "Selfie required · matched to profile photo");
  }

  async function submitPunch(action: "in" | "out") {
    setPunchBusy(true);
    setPunchError("");
    setPunchMessage("");
    try {
      if (!navigator.onLine) throw new Error("Internet is required to punch.");
      if (!account.profilePhotoUrl) throw new Error("Add a profile photo first, then capture a selfie to punch.");
      if (!selfieFile) throw new Error("Capture a selfie before punching.");
      const live = (await refreshLocation()) ?? liveLocation;
      if (!live) throw new Error("Allow location access to punch.");
      if (live.inside !== true) {
        throw new Error(
          live.inside === false
            ? `You are outside the allocated station zone${live.distanceM != null ? ` (${live.distanceM}m away)` : ""}. Move inside to punch.`
            : "Station geofence is not configured. Contact admin before punching."
        );
      }
      const face = await matchSelfieToProfile(selfieFile, account.profilePhotoUrl);
      if (!face.ok) throw new Error(face.reason || "Selfie does not match your profile photo.");
      setFaceMatchLabel("Face matched · selfie is not uploaded");

      const form = new FormData();
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("action", action);
      form.set("lat", String(live.lat));
      form.set("lng", String(live.lng));
      if (live.accuracyM != null) form.set("accuracyM", String(live.accuracyM));
      if (live.altitudeM != null) form.set("altitudeM", String(live.altitudeM));
      form.set("clientCapturedAt", live.capturedAt);
      form.set("integritySignals", JSON.stringify(integrityPayload()));
      form.set("faceMatched", "true");
      const response = await fetch("/api/connect/attendance/punch", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to record punch.");
      setPunchMessage(`Punch ${action.toUpperCase()} saved.`);
      onSelfieChange(null);
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setPunchError(reason instanceof Error ? reason.message : "Unable to record punch.");
    } finally {
      setPunchBusy(false);
    }
  }

  return (
    <section className="dx-attendance">
      <div className="dx-title-row">
        <h1>Attendance</h1>
        <div className="dx-month-control">
          <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft /></button>
          <strong>{monthLabel(month)}</strong>
          <button aria-label="Next month" disabled={futureMonth} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight /></button>
        </div>
      </div>

      <div className="dx-gps-punch-card">
        <header>
          <div>
            <strong>GPS Punch</strong>
            <small>Match selfie to profile photo + be inside the station zone. Time is set by the server.</small>
          </div>
          <button type="button" onClick={() => refreshLocation()}><MapPin /> Refresh</button>
        </header>
        {reminderText ? <div className="dx-alert warn"><Clock3 /> {reminderText}</div> : null}
        {locationError ? <div className="dx-alert error">{locationError}</div> : null}
        {outsideZone ? (
          <div className="dx-alert error">
            You are outside the allocated zone{liveLocation?.distanceM != null ? ` (${liveLocation.distanceM}m away)` : ""}. Punch will not be allowed until you move inside.
          </div>
        ) : null}
        {zoneUnknown ? <div className="dx-alert warn">Station geofence is not configured. Punch is blocked until Master Location has coordinates and radius.</div> : null}
        {punchError ? <div className="dx-alert error">{punchError}</div> : null}
        {punchMessage ? <div className="dx-alert ok">{punchMessage}</div> : null}
        <div className="dx-gps-meta">
          <span><small>STATUS</small><strong>{punchStatus?.shift.open ? "On shift" : "Off shift"}</strong></span>
          <span><small>ZONE</small><strong>{liveLocation?.inside == null ? "Unknown" : liveLocation.inside ? "Inside" : "Outside"}</strong></span>
          <span><small>DISTANCE</small><strong>{liveLocation?.distanceM == null ? "--" : `${liveLocation.distanceM} m`}</strong></span>
          <span><small>ACCURACY</small><strong>{liveLocation?.accuracyM == null ? "--" : `${Math.round(liveLocation.accuracyM)} m`}</strong></span>
        </div>
        {punchStatus?.station ? (
          <p className="dx-gps-station">
            Station {punchStatus.station.code || punchStatus.station.name || "assigned"}
            {punchStatus.station.radiusM != null ? ` · allowed ${punchStatus.station.radiusM}m` : " · geofence radius not set in Master Location"}
          </p>
        ) : (
          <p className="dx-gps-station">No station coordinates configured — punch is blocked until location is set.</p>
        )}
        <div className="dx-selfie-row">
          <button type="button" className="secondary" onClick={() => setSelfiePanelOpen(true)}>
            <Camera /> {selfieFile ? "Retake selfie" : "Capture selfie"}
          </button>
          {selfiePreview ? <img alt="Selfie preview" className="dx-selfie-preview" src={selfiePreview} /> : null}
          <em>{faceMatchLabel}</em>
        </div>
        <div className="dx-gps-actions">
          <button
            disabled={punchBusy || Boolean(punchStatus?.shift.open) || outsideZone || zoneUnknown}
            onClick={() => submitPunch("in")}
            type="button"
          >
            <LogIn /> {punchBusy ? "Saving..." : "Punch In"}
          </button>
          <button
            disabled={punchBusy || !punchStatus?.shift.open || outsideZone || zoneUnknown}
            onClick={() => submitPunch("out")}
            type="button"
          >
            <LogOut /> {punchBusy ? "Saving..." : "Punch Out"}
          </button>
        </div>
        {openFlags.length ? (
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
        ) : null}
      </div>

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
            <div className="dx-legend"><span className="present">Present</span><span className="absent">Absent</span><span className="miss">Mis Punch</span><span className="off">Off / Future</span></div>
          </div> : null}
          {tab === "list" ? <div className="dx-attendance-list">
            {[...data.rows].sort((left, right) => right.date.localeCompare(left.date)).map((row) => <button key={row.date} onClick={() => { setSelected(row); setTab("calendar"); }}>
              <header><strong>{row.date.split("-").reverse().join("/")}</strong><em className={dayStatus(row, false)}>{row.status === "P" ? "Present" : row.status === "A" ? "Absent" : row.status}</em></header>
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
          <header><div><CalendarDays /><strong>{selected.date.split("-").reverse().join("/")}</strong></div><em className={dayStatus(selected, false)}>{selected.status === "P" ? "Present" : selected.status === "A" ? "Absent" : "No punch"}</em></header>
          <div><span><LogIn /><small>IN</small><strong>{selected.inTime || "--:--"}</strong></span><span><LogOut /><small>OUT</small><strong>{selected.outTime || "--:--"}</strong></span><span><Clock3 /><small>WORK</small><strong>{selected.workHours || "00:00"}</strong></span><span><Fingerprint /><small>PUNCHES</small><strong>{selected.punchCount}</strong></span></div>
          <footer>
            {selected.regularization ? <span className={`dx-request-status ${selected.regularization.status}`}>Regularization {selected.regularization.status}</span> : null}
            {selected.regularization?.status !== "pending" ? <button onClick={() => { setRequestError(""); setRegularizing(true); }}>Regularize</button> : null}
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
      {selfiePanelOpen ? (
        <SelfieCapturePanel
          onClose={() => setSelfiePanelOpen(false)}
          onCapture={(file) => {
            onSelfieChange(file);
            setSelfiePanelOpen(false);
          }}
        />
      ) : null}
      {supportFlag ? <SupportEvidenceSheet
        account={account}
        flag={supportFlag}
        onClose={() => setSupportFlag(null)}
        onSubmitted={() => {
          setSupportFlag(null);
          setPunchMessage("Support selfie submitted for review.");
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
        hint="Center your face in the circle for manager / HR review."
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
          <em>{row.status === "P" ? "Present" : row.status === "A" ? "Absent" : "No punch"}</em>
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
