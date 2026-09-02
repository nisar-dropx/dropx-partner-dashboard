"use client";

import { useState, type CSSProperties } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Clock3, Gauge, LogIn, MapPin, UserRoundCheck, Users2 } from "lucide-react";
import { StationLiveRefresh } from "@/components/station-live-refresh";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { OpsStationManpowerPerson } from "@/lib/ops-pulse/station-manpower";

type AttendanceState = "on-time" | "late" | "missing" | "away";
const arrivalClockFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const displayClockFormatter = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

function tier(designation: string) {
  const value = designation.trim().toLowerCase().replaceAll("-", " ");
  if (/\b(assistant team lead|asst\.? team lead|shift in ?charge|shift lead|shift manager|supervisor)\b/.test(value)) return 1;
  if (/\b(station manager|store manager|team lead|team leader|site lead|location head|location manager)\b/.test(value)) return 0;
  if (/\b(picker|packer|associate|helper|loader|sorter|executive|telecaller|quality control|qc)\b/.test(value)) return 2;
  if (/\b(manager|head|lead|in ?charge)\b/.test(value)) return 0;
  return 3;
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function clock(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : displayClockFormatter.format(date);
}

function duration(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function attendanceState(person: OpsStationManpowerPerson): AttendanceState {
  if (person.availability === "On leave" || person.availability === "Roster off") return "away";
  if (person.today.lateMinutes > 0) return "late";
  if (person.today.reported) return "on-time";
  return "missing";
}

function stateLabel(person: OpsStationManpowerPerson) {
  const state = attendanceState(person);
  if (state === "late") return `Late ${person.today.lateMinutes}m`;
  if (state === "on-time") return person.availability === "Working" ? "On time · working" : "On time · completed";
  if (state === "away") return person.availability;
  return "Not reported";
}

function shiftClock(shiftName: string | null) {
  const match = String(shiftName ?? "").match(/·\s*(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!match) return null;
  return { start: Number(match[1]) * 60 + Number(match[2]), startLabel: `${match[1]}:${match[2]}`, endLabel: `${match[3]}:${match[4]}` };
}

function arrivalMinutes(value: string | null, shiftStart: number) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = arrivalClockFormatter.formatToParts(date);
  const local = Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return shiftStart >= 18 * 60 && local < 8 * 60 ? local + 1440 : local;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function locationExperience(location: CodLocationRow) {
  const relatedModel = Array.isArray(location.location_models) ? location.location_models[0] : location.location_models;
  const model = String(relatedModel?.name ?? relatedModel?.code ?? "").trim();
  const value = `${model} ${location.station_code} ${location.station_name ?? ""}`.toLowerCase();
  if (/amazon now|q[ -]?commerce|quick commerce|dark store/.test(value)) return { noun: "store", lead: "Store leadership", schedules: "store shifts", model };
  if (/\bho\b|head office|corporate office/.test(value)) return { noun: "office", lead: "Team leadership", schedules: "work schedules", model };
  return { noun: "station", lead: "Station leadership", schedules: "station shifts", model };
}

function ShiftInsight({ people, shiftName, locationCode }: { people: OpsStationManpowerPerson[]; shiftName: string | null; locationCode: string }) {
  const shift = shiftClock(shiftName);
  const scheduled = Boolean(shift);
  const expectedPeople = people.filter((person) => attendanceState(person) !== "away");
  const expected = scheduled ? expectedPeople.length : 0;
  const onTime = expectedPeople.filter((person) => attendanceState(person) === "on-time").length;
  const late = expectedPeople.filter((person) => attendanceState(person) === "late").length;
  const missing = expectedPeople.filter((person) => attendanceState(person) === "missing").length;
  const away = people.filter((person) => attendanceState(person) === "away").length;
  const reported = onTime + late;
  const [selectedState, setSelectedState] = useState<AttendanceState | "all">("all");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const selectedPeople = selectedPersonId
    ? people.filter((person) => `${person.workerType}:${person.id}` === selectedPersonId)
    : selectedState === "all" ? people : people.filter((person) => attendanceState(person) === selectedState);
  const shiftTitle = shiftName?.split(" · ")[0] ?? "Shift not assigned";
  const lateValues = expectedPeople.map((person) => person.today.lateMinutes).filter(Boolean);
  const maxArrivalOffset = shift ? Math.max(120, ...expectedPeople.map((person) => {
    const arrival = arrivalMinutes(person.today.inTime, shift.start);
    return arrival === null ? 0 : arrival - shift.start + 15;
  })) : 120;
  const timelineEnd = Math.ceil(maxArrivalOffset / 30) * 30;
  const timelineLength = timelineEnd + 15;
  const scheduledPosition = 15 / timelineLength * 100;
  const shiftStart = shift?.start ?? 0;

  function chooseState(state: AttendanceState | "all") {
    setSelectedState(state);
    setSelectedPersonId(null);
    setExpanded(true);
  }

  return <section className={`station-shift-insight ${late || missing ? "needs-attention" : "is-ready"}`}>
    <header className="station-shift-heading"><div><span className="station-shift-kicker"><CalendarClock size={13} />{shiftTitle}</span><h3>{shift ? `${shift.startLabel}–${shift.endLabel}` : "Needs a roster or effective shift"}</h3><p>{scheduled ? `${expected} expected · ${reported} reported${late ? ` · median late arrival ${median(lateValues)} min` : missing ? ` · ${missing} still not reported` : " · everyone reported on time"}` : `${people.length} active ${people.length === 1 ? "person has" : "people have"} no shift assignment for this date.`}</p></div><div className="station-shift-score"><strong>{expected ? Math.round(reported / expected * 100) : "—"}{expected ? "%" : ""}</strong><span>reported</span></div><button type="button" className={`station-shift-toggle ${expanded ? "active" : ""}`} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "Hide" : "Details"}<ChevronDown size={13} /></button></header>
    {scheduled ? <>
      <div className="station-shift-kpis" aria-label={`${locationCode} ${shiftTitle} attendance breakdown`}>
        <button type="button" className={selectedState === "all" ? "active" : ""} onClick={() => chooseState("all")}><span>Expected</span><strong>{expected}</strong></button>
        <button type="button" className={`on-time ${selectedState === "on-time" ? "active" : ""}`} onClick={() => chooseState("on-time")}><span>On time</span><strong>{onTime}</strong></button>
        <button type="button" className={`late ${selectedState === "late" ? "active" : ""}`} onClick={() => chooseState("late")}><span>Late</span><strong>{late}</strong></button>
        <button type="button" className={`missing ${selectedState === "missing" ? "active" : ""}`} onClick={() => chooseState("missing")}><span>Missing</span><strong>{missing}</strong></button>
        {away ? <button type="button" className={`away ${selectedState === "away" ? "active" : ""}`} onClick={() => chooseState("away")}><span>Leave / off</span><strong>{away}</strong></button> : null}
      </div>
      <div className="station-attendance-bar station-attendance-bar-summary" aria-label={`${onTime} on time, ${late} late, ${missing} not reported`}>
        {onTime ? <button type="button" className="on-time" style={{ width: `${onTime / Math.max(1, expected) * 100}%` }} onClick={() => chooseState("on-time")} aria-label={`${onTime} reported on time`}><span>{onTime}</span></button> : null}
        {late ? <button type="button" className="late" style={{ width: `${late / Math.max(1, expected) * 100}%` }} onClick={() => chooseState("late")} aria-label={`${late} reported late`}><span>{late}</span></button> : null}
        {missing ? <button type="button" className="missing" style={{ width: `${missing / Math.max(1, expected) * 100}%` }} onClick={() => chooseState("missing")} aria-label={`${missing} have not reported`}><span>{missing}</span></button> : null}
      </div>
      {expanded ? <div className="station-arrival-visual">
        <div className="station-arrival-head"><span>Shift reporting</span><small>Click a colour or arrival marker to inspect people</small></div>
        <div className="station-arrival-timeline">
          <span className="station-scheduled-line" style={{ left: `${scheduledPosition}%` }} />
          {expectedPeople.map((person, index) => {
            const state = attendanceState(person);
            const arrival = shift ? arrivalMinutes(person.today.inTime, shiftStart) : null;
            const position = arrival === null ? Math.max(86, 98 - Math.floor(index / 3) * 1.2) : Math.max(1, Math.min(96, ((arrival - shiftStart + 15) / timelineLength) * 100));
            const personKey = `${person.workerType}:${person.id}`;
            return <button type="button" className={`station-arrival-marker ${state} ${selectedPersonId === personKey ? "active" : ""}`} style={{ left: `${position}%`, top: `${12 + index % 3 * 13}px` }} key={personKey} onClick={() => { setSelectedPersonId(personKey); setSelectedState(state); }} aria-label={`${person.name}: ${stateLabel(person)}${person.today.inTime ? ` at ${clock(person.today.inTime)}` : ""}`} title={`${person.name} · ${stateLabel(person)}${person.today.inTime ? ` · ${clock(person.today.inTime)}` : ""}`}><span>{initials(person.name)}</span></button>;
          })}
        </div>
        <div className="station-arrival-axis"><span>−15m</span><span style={{ left: `${scheduledPosition}%` }}>Scheduled {shift?.startLabel}</span><span>+{timelineEnd}m</span></div>
        <div className="station-arrival-legend"><span className="on-time">On time</span><span className="late">Late</span><span className="missing">Not reported</span></div>
      </div> : null}
    </> : null}
    {expanded ? <><div className="station-shift-detail-head"><strong>{selectedPersonId ? "Selected person" : selectedState === "all" ? "Shift team" : selectedState === "on-time" ? "On-time arrivals" : selectedState === "late" ? "Late arrivals" : selectedState === "missing" ? "Not reported" : "Leave / roster off"}</strong><span>{selectedPeople.length} {selectedPeople.length === 1 ? "person" : "people"}</span></div>
    <div className="station-shift-people">{selectedPeople.map((person) => <article className={attendanceState(person)} key={`${person.workerType}:${person.id}`}><span className="station-manpower-avatar">{initials(person.name)}</span><div className="station-manpower-person"><strong>{person.name}</strong><small>{person.designation} · {person.code}</small></div><span className={`station-manpower-status ${attendanceState(person)}`}>{stateLabel(person)}</span><div className="station-person-timing"><span><LogIn size={12} />IN <strong>{clock(person.today.inTime)}</strong></span><span>OUT <strong>{clock(person.today.outTime)}</strong></span><small>{duration(person.today.workMinutes)}{person.today.missingPunch ? " · Open punch" : ""}</small></div><a href={person.profileHref} target="_blank" rel="noreferrer">Open in People</a></article>)}</div></> : null}
  </section>;
}

export function OpsStationManpowerBoard({ asOf, locations, people }: { asOf: string; locations: CodLocationRow[]; people: OpsStationManpowerPerson[] }) {
  const expectedPeople = people.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
  const reported = expectedPeople.filter((person) => person.today.reported).length;
  const onTime = expectedPeople.filter((person) => attendanceState(person) === "on-time").length;
  const late = expectedPeople.filter((person) => attendanceState(person) === "late").length;
  const missing = expectedPeople.filter((person) => attendanceState(person) === "missing").length;
  return <div className="station-manpower-workspace">
    <section className="station-manpower-summary">
      <article><Users2 size={17} /><span>Scheduled</span><strong>{expectedPeople.length}</strong><small>{people.length} active people · {locations.length} locations</small></article>
      <article className="good"><UserRoundCheck size={17} /><span>Reported</span><strong>{reported}</strong><small>{expectedPeople.length ? Math.round(reported / expectedPeople.length * 100) : 0}% shift readiness</small></article>
      <article className="good"><CheckCircle2 size={17} /><span>On time</span><strong>{onTime}</strong><small>Within shift grace</small></article>
      <article className={late ? "warn" : "good"}><Clock3 size={17} /><span>Late</span><strong>{late}</strong><small>Red markers need attention</small></article>
      <article className={missing ? "attention" : "good"}><AlertTriangle size={17} /><span>Not reported</span><strong>{missing}</strong><small>Scheduled but no punch</small></article>
      <StationLiveRefresh />
    </section>
    <section className="station-insight-intro"><div><span><Gauge size={14} />Location shift insights</span><h2>Shift readiness and arrival exceptions</h2></div><div className="station-insight-legend"><span className="on-time">On time</span><span className="late">Late</span><span className="missing">Not reported</span><span className="away">Leave / off</span></div></section>
    <div className="station-manpower-grid">{locations.map((location) => {
      const locationPeople = people.filter((person) => person.locationId === location.id).sort((left, right) => tier(left.designation) - tier(right.designation) || left.designation.localeCompare(right.designation) || left.name.localeCompare(right.name));
      const experience = locationExperience(location);
      const leadership = locationPeople.filter((person) => tier(person.designation) === 0);
      const shiftLeadership = locationPeople.filter((person) => tier(person.designation) === 1);
      const shifts = [...new Map(locationPeople.map((person) => [person.today.shiftName ?? "", person.today.shiftName])).entries()].map(([key, name]) => ({ key, name, people: locationPeople.filter((person) => (person.today.shiftName ?? "") === key) })).sort((left, right) => (shiftClock(left.name)?.start ?? 9999) - (shiftClock(right.name)?.start ?? 9999));
      const locationExpected = locationPeople.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
      const locationReported = locationExpected.filter((person) => person.today.reported).length;
      const locationLate = locationExpected.filter((person) => attendanceState(person) === "late").length;
      const locationMissing = locationExpected.filter((person) => attendanceState(person) === "missing").length;
      const readiness = locationExpected.length ? Math.round(locationReported / locationExpected.length * 100) : 0;
      return <section className="station-manpower-card" key={location.id}>
        <header><div><span><MapPin size={14} />{location.station_code} · {experience.noun}{experience.model ? ` · ${experience.model}` : ""}</span><h2>{location.station_name || location.station_code}</h2><p>{locationPeople.length} active people across {shifts.length} {experience.schedules}</p></div><div className="station-readiness-ring" style={{ "--readiness": `${readiness}%` } as CSSProperties}><strong>{readiness}%</strong><span>reported</span></div><div className="station-manpower-card-metrics"><span><strong>{locationExpected.length}</strong> expected</span><span className={locationLate ? "warn" : ""}><strong>{locationLate}</strong> late</span><span className={locationMissing ? "bad" : ""}><strong>{locationMissing}</strong> missing</span></div></header>
        {locationPeople.length ? <><div className="station-command-strip"><div><span>{experience.lead}</span><strong>{leadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{leadership.map((person) => person.designation).join(" · ") || "Leadership gap"}</small></div><div><span>Shift / workstream leads</span><strong>{shiftLeadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{shiftLeadership.map((person) => person.designation).join(" · ") || "No second-level lead mapped"}</small></div></div><div className="station-shifts">{shifts.map((item) => <ShiftInsight key={`${asOf}:${item.key || "unassigned"}`} people={item.people} shiftName={item.name} locationCode={location.station_code} />)}</div></> : <div className="station-manpower-empty"><Users2 size={20} /><strong>No active People manpower is assigned here.</strong><span>The location remains visible because it is inside your OpsPulse scope.</span></div>}
      </section>;
    })}</div>
    <p className="station-manpower-footnote">Live People roster and biometric attendance for {asOf}. Approved daily roster takes priority over the effective shift assignment.</p>
  </div>;
}
