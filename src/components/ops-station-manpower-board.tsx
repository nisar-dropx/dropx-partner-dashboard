"use client";

import { useState, type CSSProperties } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, Clock3, Gauge, LogIn, MapPin, UserRoundCheck, Users2 } from "lucide-react";
import { StationLiveRefresh } from "@/components/station-live-refresh";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { OpsStationManpowerPerson } from "@/lib/ops-pulse/station-manpower";

type AttendanceState = "on-time" | "late" | "missing" | "away";
const WEEK_OFF_FILTER = "__week_off__";
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

function clock(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : displayClockFormatter.format(date);
}

function duration(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function rosterDate(value: string) {
  const date = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(date);
}

function attendanceInterval(person: OpsStationManpowerPerson) {
  if (!person.today.reported) return "—";
  return `${clock(person.today.inTime)}–${person.today.outTime ? clock(person.today.outTime) : "OUT pending"}`;
}

function workedOffLabel(person: OpsStationManpowerPerson) {
  if (!person.today.reported) return "Roster off";
  return person.today.outTime
    ? `Worked on week off · ${duration(person.today.workMinutes)}`
    : "Working on week off · OUT pending";
}

function locationLabel(location: OpsStationManpowerPerson["today"]["inLocation"]) {
  if (!location) return "Not recorded";
  return location.name && location.name !== location.code ? `${location.code} · ${location.name}` : location.code;
}

function PunchLocationBadge({ person }: { person: OpsStationManpowerPerson }) {
  if (!person.today.hasLocationMismatch) return null;
  return <em className="station-punch-location-alert" title={`Expected ${locationLabel(person.today.expectedLocation)}; IN ${locationLabel(person.today.inLocation)}; OUT ${locationLabel(person.today.outLocation)}`}><MapPin size={9} />Punch location</em>;
}

function AttendanceDetail({ person }: { person: OpsStationManpowerPerson }) {
  const rosterStatus = person.today.rosterDayType === "weekly_off" ? "Week off" : person.today.shiftName?.split(" · ")[0] ?? "Approved roster";
  return <div className="station-timetable-detail">
    <span><LogIn size={12} />In <strong>{clock(person.today.inTime)}</strong></span>
    <span>Out <strong>{person.today.outTime ? clock(person.today.outTime) : person.today.reported ? "No OUT punch" : "—"}</strong></span>
    <span>Worked <strong>{duration(person.today.workMinutes)}</strong></span>
    <span>Roster <strong>{rosterStatus}</strong></span>
    {person.today.reported ? <><span className={person.today.inLocation?.id && person.today.inLocation.id !== person.locationId ? "punch-location-mismatch" : ""}>IN location <strong>{locationLabel(person.today.inLocation)}</strong></span><span className={person.today.outLocation?.id && person.today.outLocation.id !== person.locationId ? "punch-location-mismatch" : ""}>OUT location <strong>{person.today.outTime ? locationLabel(person.today.outLocation) : "OUT pending"}</strong></span>{person.today.hasLocationMismatch ? <span className="punch-location-expected">Expected <strong>{locationLabel(person.today.expectedLocation)}</strong></span> : null}</> : null}
  </div>;
}

function rosterRoleGroups(members: OpsStationManpowerPerson[]) {
  const grouped = new Map<string, string[]>();
  for (const person of members) {
    const names = grouped.get(person.designationCode) ?? [];
    names.push(person.name);
    grouped.set(person.designationCode, names);
  }
  return [...grouped].map(([code, names]) => ({ code, names }));
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
  const start = Number(match[1]) * 60 + Number(match[2]);
  const rawEnd = Number(match[3]) * 60 + Number(match[4]);
  return { start, end: rawEnd <= start ? rawEnd + 1440 : rawEnd, startLabel: `${match[1]}:${match[2]}`, endLabel: `${match[3]}:${match[4]}` };
}

function arrivalMinutes(value: string | null, shiftStart: number) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = arrivalClockFormatter.formatToParts(date);
  const local = Number(parts.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return shiftStart >= 18 * 60 && local < 8 * 60 ? local + 1440 : local;
}

function locationExperience(location: CodLocationRow) {
  const relatedModel = Array.isArray(location.location_models) ? location.location_models[0] : location.location_models;
  const model = String(relatedModel?.name ?? relatedModel?.code ?? "").trim();
  const value = `${model} ${location.station_code} ${location.station_name ?? ""}`.toLowerCase();
  if (/amazon now|q[ -]?commerce|quick commerce|dark store/.test(value)) return { noun: "store", lead: "Store leadership", schedules: "store shifts", model };
  if (/\bho\b|head office|corporate office/.test(value)) return { noun: "office", lead: "Team leadership", schedules: "work schedules", model };
  return { noun: "station", lead: "Station leadership", schedules: "station shifts", model };
}

function timetableWindow(people: OpsStationManpowerPerson[]) {
  const clocks = people.map((person) => shiftClock(person.today.shiftName)).filter((value): value is NonNullable<ReturnType<typeof shiftClock>> => Boolean(value));
  if (!clocks.length) return null;
  const starts = [...new Set(clocks.map((value) => value.start))].sort((left, right) => left - right);
  let cut = starts[0];
  let largestGap = -1;
  starts.forEach((start, index) => {
    const next = index === starts.length - 1 ? starts[0] + 1440 : starts[index + 1];
    if (next - start > largestGap) {
      largestGap = next - start;
      cut = next % 1440;
    }
  });
  const normalized = clocks.map((value) => {
    const start = value.start < cut ? value.start + 1440 : value.start;
    return { start, end: start + (value.end - value.start) };
  });
  const start = Math.min(...normalized.map((value) => value.start));
  const end = Math.max(...normalized.map((value) => value.end));
  return { start, end, length: Math.max(60, end - start) };
}

function timetableMinute(value: string | null, windowStart: number) {
  const minute = arrivalMinutes(value, windowStart % 1440);
  if (minute === null) return null;
  return minute < windowStart ? minute + 1440 : minute;
}

function minuteLabel(value: number) {
  const minute = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function ActiveRosterView({ asOf, people, locationCode }: { asOf: string; people: OpsStationManpowerPerson[]; locationCode: string }) {
  const rostered = people.filter((person) => Boolean(shiftClock(person.today.shiftName)) || Boolean(person.today.rosterDayType));
  const working = rostered.filter((person) => Boolean(shiftClock(person.today.shiftName)) && person.today.rosterDayType !== "weekly_off");
  const off = rostered.filter((person) => person.today.rosterDayType === "weekly_off");
  const groups = [...new Map(rostered.map((person) => {
    const shift = shiftClock(person.today.shiftName);
    const label = person.today.rosterDayType === "weekly_off" ? "Week off" : shift ? `${shift.startLabel}–${shift.endLabel}` : "Rostered";
    return [label, label];
  })).values()];

  return <details className="station-active-roster">
    <summary aria-label={`View day roster for ${locationCode} on ${asOf}`}>
      <span className="station-active-roster-title"><CalendarDays size={14} /><span><b>View day roster</b><small>{rosterDate(asOf)} · approved · read-only</small></span></span>
      <span className="station-active-roster-counts"><b>{working.length}</b> working <i /> <b>{off.length}</b> off</span>
      <span className="station-active-roster-action">View roster <ChevronDown size={13} /></span>
    </summary>
    <div>{groups.length ? groups.map((label) => {
      const members = rostered.filter((person) => {
        const shift = shiftClock(person.today.shiftName);
        return (person.today.rosterDayType === "weekly_off" ? "Week off" : shift ? `${shift.startLabel}–${shift.endLabel}` : "Rostered") === label;
      });
      return <section key={label}><strong>{label}</strong><div className="station-active-roster-roles">{rosterRoleGroups(members).map((group) => <span key={group.code}><b>{group.code}</b>{group.names.join(", ")}</span>)}</div></section>;
    }) : <p>No active approved roster is published for {locationCode} on this date.</p>}</div>
  </details>;
}

function StationTimetable({ people, locationCode }: { people: OpsStationManpowerPerson[]; locationCode: string }) {
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [selectedShift, setSelectedShift] = useState<string | null>(null);
  const window = timetableWindow(people);
  const offDuty = people
    .filter((person) => person.today.rosterDayType === "weekly_off")
    .sort((left, right) => tier(left.designation) - tier(right.designation) || left.name.localeCompare(right.name));
  const scheduled = people.filter((person) => Boolean(shiftClock(person.today.shiftName))).sort((left, right) => {
    const leftClock = shiftClock(left.today.shiftName);
    const rightClock = shiftClock(right.today.shiftName);
    const leftStart = leftClock && leftClock.start < window!.start ? leftClock.start + 1440 : leftClock?.start ?? 9999;
    const rightStart = rightClock && rightClock.start < window!.start ? rightClock.start + 1440 : rightClock?.start ?? 9999;
    return tier(left.designation) - tier(right.designation) || leftStart - rightStart || left.name.localeCompare(right.name);
  });
  const withoutRoster = people.filter((person) => !shiftClock(person.today.shiftName) && !person.today.rosterDayType);
  if (!window) return offDuty.length ? <section className="station-timetable" aria-label={`${locationCode} roster and attendance timetable`}>
    <header><div><strong>Roster timetable</strong><span>No operating shift</span></div><small>Approved roster state for this date.</small></header>
    <div className="station-timetable-off-only">{offDuty.map((person) => {
      const personKey = `${person.workerType}:${person.id}`;
      const open = selectedPersonId === personKey;
      return <article className={open ? "open" : ""} key={personKey}>
        <button type="button" aria-expanded={open} onClick={() => setSelectedPersonId(open ? null : personKey)}>
          <span><span className="station-timetable-person-name"><b>{person.name}</b><PunchLocationBadge person={person} /></span><small>{person.designation} · Week off</small></span>
          <span><b>{attendanceInterval(person)}</b><small>{workedOffLabel(person)}</small></span>
        </button>
        {open ? <AttendanceDetail person={person} /> : null}
      </article>;
    })}</div>
  </section> : <div className="station-manpower-empty"><Users2 size={20} /><strong>No approved roster is active for this date.</strong><span>Approve the station roster to show its timetable and attendance gaps.</span></div>;
  const ticks = Array.from({ length: 7 }, (_, index) => window.start + window.length * index / 6);
  const position = (value: number) => Math.max(0, Math.min(100, (value - window.start) / window.length * 100));
  const shiftSummary = [...new Map(scheduled.map((person) => [person.today.shiftName, person.today.shiftName])).values()]
    .filter((name): name is string => Boolean(name))
    .map((name) => {
      const members = scheduled.filter((person) => person.today.shiftName === name && attendanceState(person) !== "away");
      return { name, clock: shiftClock(name)!, expected: members.length, reported: members.filter((person) => person.today.reported).length };
    })
    .sort((left, right) => (left.clock.start < window.start ? left.clock.start + 1440 : left.clock.start) - (right.clock.start < window.start ? right.clock.start + 1440 : right.clock.start));
  const validSelectedShift = selectedShift === WEEK_OFF_FILTER
    ? (offDuty.length ? selectedShift : null)
    : shiftSummary.some((shift) => shift.name === selectedShift) ? selectedShift : null;
  const visibleScheduled = validSelectedShift && validSelectedShift !== WEEK_OFF_FILTER
    ? scheduled.filter((person) => person.today.shiftName === validSelectedShift)
    : validSelectedShift === WEEK_OFF_FILTER ? [] : scheduled;
  const visibleOffDuty = validSelectedShift === WEEK_OFF_FILTER ? offDuty : validSelectedShift ? [] : offDuty;
  const selectShift = (shift: string | null) => {
    setSelectedShift((current) => current === shift ? null : shift);
    setSelectedPersonId(null);
  };

  return <section className="station-timetable" aria-label={`${locationCode} roster and attendance timetable`}>
    <header><div><strong>Roster timetable</strong><span>{minuteLabel(window.start)}–{minuteLabel(window.end)} operating window</span></div><small>Expected time, actual report time and attendance gap in one view.</small></header>
    <div className="station-timetable-shift-strip" aria-label="Filter timetable by shift">
      <button type="button" className={validSelectedShift === null ? "active" : ""} aria-pressed={validSelectedShift === null} onClick={() => selectShift(null)}><b>All shifts</b><small>{scheduled.length + offDuty.length} people</small></button>
      {shiftSummary.map((shift) => <button type="button" className={validSelectedShift === shift.name ? "active" : ""} aria-pressed={validSelectedShift === shift.name} key={shift.name} onClick={() => selectShift(shift.name)}><b>{shift.clock.startLabel}–{shift.clock.endLabel}</b><small>{shift.reported}/{shift.expected} reported</small></button>)}
      {offDuty.length ? <button type="button" className={`week-off ${validSelectedShift === WEEK_OFF_FILTER ? "active" : ""}`} aria-pressed={validSelectedShift === WEEK_OFF_FILTER} onClick={() => selectShift(WEEK_OFF_FILTER)}><b>Week off</b><small>{offDuty.filter((person) => person.today.reported).length}/{offDuty.length} present</small></button> : null}
    </div>
    <div className="station-timetable-scroll">
      <div className="station-timetable-axis" aria-hidden="true"><span>Team member</span><span>Shift</span><div>{ticks.map((tick, index) => <time key={`${tick}:${index}`} style={{ left: `${index / 6 * 100}%` }}>{minuteLabel(tick)}</time>)}</div><span>Reported</span></div>
      <div className="station-timetable-rows">
        {visibleScheduled.map((person) => {
          const shift = shiftClock(person.today.shiftName)!;
          const shiftStart = shift.start < window.start ? shift.start + 1440 : shift.start;
          const shiftEnd = shiftStart + (shift.end - shift.start);
          const state = attendanceState(person);
          const arrival = timetableMinute(person.today.inTime, window.start);
          const recordedOut = timetableMinute(person.today.outTime, window.start);
          const actualEnd = arrival === null ? null : recordedOut ?? arrival + Math.max(5, person.today.workMinutes);
          const personKey = `${person.workerType}:${person.id}`;
          const open = selectedPersonId === personKey;
          const plannedLeft = position(shiftStart);
          const plannedWidth = Math.max(1, position(shiftEnd) - plannedLeft);
          const actualLeft = arrival === null ? plannedLeft : position(Math.max(window.start, arrival));
          const actualWidth = actualEnd === null ? 0 : Math.max(.7, position(Math.min(window.end, actualEnd)) - actualLeft);
          return <div className={`station-timetable-person-row ${state} ${open ? "open" : ""}`} key={personKey}>
            <button type="button" className="station-timetable-row" aria-expanded={open} onClick={() => setSelectedPersonId(open ? null : personKey)}>
              <span className="station-timetable-person"><span className="station-timetable-person-name"><b>{person.name}</b><PunchLocationBadge person={person} /></span><small>{person.designation}</small></span>
              <span className="station-timetable-shift"><b>{shift.startLabel}–{shift.endLabel}</b><small>{person.today.shiftName?.split(" · ")[0]}</small></span>
              <span className="station-timetable-lane">
                <span className={`station-timetable-plan ${state}`} style={{ left: `${plannedLeft}%`, width: `${plannedWidth}%` }} />
                {arrival !== null && actualEnd !== null ? <span className={`station-timetable-actual ${state}`} style={{ left: `${actualLeft}%`, width: `${actualWidth}%` }} /> : null}
                {arrival !== null ? <span className={`station-timetable-arrival ${state}`} style={{ left: `${actualLeft}%` }} title={`Reported ${clock(person.today.inTime)}`} /> : null}
              </span>
              <span className={`station-timetable-status ${state}`}><b>{clock(person.today.inTime)}</b><small>{stateLabel(person)}</small></span>
            </button>
            {open ? <AttendanceDetail person={person} /> : null}
          </div>;
        })}
        {visibleOffDuty.map((person) => {
          const personKey = `${person.workerType}:${person.id}`;
          const open = selectedPersonId === personKey;
          const arrival = timetableMinute(person.today.inTime, window.start);
          const recordedOut = timetableMinute(person.today.outTime, window.start);
          const actualEnd = arrival === null ? null : recordedOut ?? arrival + Math.max(5, person.today.workMinutes);
          const actualLeft = arrival === null ? 0 : position(Math.max(window.start, arrival));
          const actualWidth = actualEnd === null ? 0 : Math.max(.7, position(Math.min(window.end, actualEnd)) - actualLeft);
          return <div className={`station-timetable-person-row away ${person.today.reported ? "off-worked" : ""} ${open ? "open" : ""}`} key={personKey}>
            <button type="button" className="station-timetable-row" aria-expanded={open} onClick={() => setSelectedPersonId(open ? null : personKey)}>
              <span className="station-timetable-person"><span className="station-timetable-person-name"><b>{person.name}</b><PunchLocationBadge person={person} /></span><small>{person.designation}</small></span>
              <span className="station-timetable-shift"><b>Week off</b><small>Approved roster</small></span>
              <span className="station-timetable-lane">
                <span className="station-timetable-off-label">Not scheduled</span>
                {arrival !== null && actualEnd !== null ? <span className="station-timetable-actual off-worked" style={{ left: `${actualLeft}%`, width: `${actualWidth}%` }} /> : null}
                {arrival !== null ? <span className="station-timetable-arrival away" style={{ left: `${actualLeft}%` }} title={`Reported ${clock(person.today.inTime)} on week off`} /> : null}
              </span>
              <span className="station-timetable-status away"><b>{attendanceInterval(person)}</b><small>{workedOffLabel(person)}</small></span>
            </button>
            {open ? <AttendanceDetail person={person} /> : null}
          </div>;
        })}
      </div>
    </div>
    {withoutRoster.length ? <div className="station-timetable-unassigned"><strong>{withoutRoster.length} active {withoutRoster.length === 1 ? "person has" : "people have"} no approved roster entry for this date.</strong><span>They are not counted as expected manpower.</span></div> : null}
  </section>;
}

export function OpsStationManpowerBoard({ asOf, locations, people }: { asOf: string; locations: CodLocationRow[]; people: OpsStationManpowerPerson[] }) {
  const expectedPeople = people.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
  const scheduledReported = expectedPeople.filter((person) => person.today.reported).length;
  const present = people.filter((person) => person.today.reported).length;
  const offDayWorked = people.filter((person) => person.today.rosterDayType === "weekly_off" && person.today.reported).length;
  const onTime = expectedPeople.filter((person) => attendanceState(person) === "on-time").length;
  const late = expectedPeople.filter((person) => attendanceState(person) === "late").length;
  const missing = expectedPeople.filter((person) => attendanceState(person) === "missing").length;
  return <div className="station-manpower-workspace">
    <section className="station-manpower-summary">
      <article><Users2 size={17} /><span>Scheduled</span><strong>{expectedPeople.length}</strong><small>{people.length} active people · {locations.length} locations</small></article>
      <article className="good"><UserRoundCheck size={17} /><span>Present</span><strong>{present}</strong><small>{scheduledReported} scheduled{offDayWorked ? ` · ${offDayWorked} off-day` : ""}</small></article>
      <article className="good"><CheckCircle2 size={17} /><span>On time</span><strong>{onTime}</strong><small>Within shift grace</small></article>
      <article className={late ? "warn" : "good"}><Clock3 size={17} /><span>Late</span><strong>{late}</strong><small>Red markers need attention</small></article>
      <article className={missing ? "attention" : "good"}><AlertTriangle size={17} /><span>Not reported</span><strong>{missing}</strong><small>Scheduled but no punch</small></article>
      <StationLiveRefresh />
    </section>
    <section className="station-insight-intro"><div><span><Gauge size={14} />Shift attendance insights</span><h2>Roster timetable and attendance gaps</h2></div><div className="station-insight-legend"><span className="on-time">On time / present</span><span className="late">Late / delayed start</span><span className="missing">Empty = not reported</span><span className="away">Leave / off</span></div></section>
    <div className="station-manpower-grid">{locations.map((location) => {
      const locationPeople = people.filter((person) => person.locationId === location.id).sort((left, right) => tier(left.designation) - tier(right.designation) || left.designation.localeCompare(right.designation) || left.name.localeCompare(right.name));
      const experience = locationExperience(location);
      const leadership = locationPeople.filter((person) => tier(person.designation) === 0);
      const shiftLeadership = locationPeople.filter((person) => tier(person.designation) === 1);
      const shifts = new Set(locationPeople.map((person) => person.today.shiftName).filter(Boolean));
      const locationExpected = locationPeople.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
      const locationReported = locationExpected.filter((person) => person.today.reported).length;
      const locationOffDayWorked = locationPeople.filter((person) => person.today.rosterDayType === "weekly_off" && person.today.reported).length;
      const locationLate = locationExpected.filter((person) => attendanceState(person) === "late").length;
      const locationMissing = locationExpected.filter((person) => attendanceState(person) === "missing").length;
      const readiness = locationExpected.length ? Math.round(locationReported / locationExpected.length * 100) : 0;
      return <section className="station-manpower-card" key={location.id}>
        <header><div><span><MapPin size={14} />{location.station_code} · {experience.noun}{experience.model ? ` · ${experience.model}` : ""}</span><h2>{location.station_name || location.station_code}</h2><p>{locationPeople.length} active people across {shifts.size} {experience.schedules}</p></div><div className="station-readiness-ring" style={{ "--readiness": `${readiness}%` } as CSSProperties}><strong>{readiness}%</strong><span>reported</span></div><div className="station-manpower-card-metrics"><span><strong>{locationExpected.length}</strong> expected</span><span className={locationLate ? "warn" : ""}><strong>{locationLate}</strong> late</span><span className={locationMissing ? "bad" : ""}><strong>{locationMissing}</strong> missing</span>{locationOffDayWorked ? <span className="off-worked"><strong>{locationOffDayWorked}</strong> off-day worked</span> : null}</div></header>
        {locationPeople.length ? <><div className="station-command-strip"><div><span>{experience.lead}</span><strong>{leadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{leadership.map((person) => person.designation).join(" · ") || "Leadership gap"}</small></div><div><span>Shift / workstream leads</span><strong>{shiftLeadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{shiftLeadership.map((person) => person.designation).join(" · ") || "No second-level lead mapped"}</small></div></div><ActiveRosterView asOf={asOf} people={locationPeople} locationCode={location.station_code} /><StationTimetable key={`${asOf}:${location.id}`} people={locationPeople} locationCode={location.station_code} /></> : <div className="station-manpower-empty"><Users2 size={20} /><strong>No active People manpower is assigned here.</strong><span>The location remains visible because it is inside your OpsPulse scope.</span></div>}
      </section>;
    })}</div>
    <p className="station-manpower-footnote">Live biometric attendance for {asOf} is compared only with the active approved People roster version. Profile shift assignments do not create expected rows here.</p>
  </div>;
}
