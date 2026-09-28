"use client";

import { useState, type CSSProperties } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, Clock3, Gauge, LogIn, MapPin, UserRoundCheck, Users2 } from "lucide-react";
import { ShiftAttendanceTools } from "@/components/shift-attendance-tools";
import { matchesShift, shiftCategory, shiftLabel, shiftPunchMinute, type ShiftFilter } from "@/lib/shift-attendance-view";
import { StationLiveRefresh } from "@/components/station-live-refresh";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { OpsStationManpowerPerson } from "@/lib/ops-pulse/station-manpower";

type AttendanceState = "on-time" | "late" | "missing" | "away";
type AttendanceFilter = ShiftFilter | "on-time";
const WEEK_OFF_FILTER = "__week_off__";
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
      <span>Status <strong>{shiftLabel(person)}</strong></span>
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
  const category = shiftCategory(person);
  if (["wfh", "trip", "leave", "off", "upcoming", "unassigned"].includes(category)) return "away";
  if (person.today.lateMinutes > 0 || (person.today.earlyMinutes ?? 0) > 0 || matchesShift(person, "single")) return "late";
  if (person.today.reported) return "on-time";
  return "missing";
}

function matchesAttendanceFilter(person: OpsStationManpowerPerson, filter: AttendanceFilter) {
  if (filter === "on-time") return attendanceState(person) === "on-time" && (person.today.earlyMinutes ?? 0) === 0;
  return matchesShift(person, filter);
}

function stateLabel(person: OpsStationManpowerPerson) { return shiftLabel(person); }

function shiftClock(shiftName: string | null) {
  const match = String(shiftName ?? "").match(/·\s*(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const rawEnd = Number(match[3]) * 60 + Number(match[4]);
  return { start, end: rawEnd <= start ? rawEnd + 1440 : rawEnd, startLabel: `${match[1]}:${match[2]}`, endLabel: `${match[3]}:${match[4]}` };
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
  const start = Math.min(...clocks.map(value => value.start));
  const end = Math.max(...clocks.map(value => value.end));
  return { start, end, length: Math.max(60, end - start) };
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

function StationTimetable({ people, locationCode, asOf, exportUrl }: { people: OpsStationManpowerPerson[]; locationCode: string; asOf: string; exportUrl?: string }) {
  const [filter, setFilter] = useState<ShiftFilter>("all"), [search, setSearch] = useState("");
  const visible = people.filter(p => matchesShift(p, filter, search));
  return <div><ShiftAttendanceTools people={people} filter={filter} search={search} onFilter={setFilter} onSearch={setSearch} exportUrl={exportUrl} />
    {visible.length ? <StationTimetableContent key={filter + search} people={visible} locationCode={locationCode} asOf={asOf} /> : <p className="station-manpower-empty">No people match these filters.</p>}
  </div>;
}

function StationTimetableContent({ people, locationCode, asOf }: { people: OpsStationManpowerPerson[]; locationCode: string; asOf: string }) {
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [selectedShift, setSelectedShift] = useState<string | null>(null);
  const selectedAttendance: AttendanceFilter = "all";
  const window = timetableWindow(people);
  const offDuty = people
    .filter((person) => !shiftClock(person.today.shiftName))
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
          <span><span className="station-timetable-person-name"><b>{person.name}</b><PunchLocationBadge person={person} /></span><small>{person.designation} · {stateLabel(person)}</small></span>
          <span><b>{attendanceInterval(person)}</b><small style={{ whiteSpace: "normal", fontSize: 9 }} title={stateLabel(person)}>{stateLabel(person)}</small></span>
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
  const shiftFilteredScheduled = validSelectedShift && validSelectedShift !== WEEK_OFF_FILTER
    ? scheduled.filter((person) => person.today.shiftName === validSelectedShift)
    : validSelectedShift === WEEK_OFF_FILTER ? [] : scheduled;
  const shiftFilteredOffDuty = validSelectedShift === WEEK_OFF_FILTER ? offDuty : validSelectedShift ? [] : offDuty;
  const visibleScheduled = shiftFilteredScheduled.filter((person) => matchesAttendanceFilter(person, selectedAttendance));
  const visibleOffDuty = shiftFilteredOffDuty.filter((person) => matchesAttendanceFilter(person, selectedAttendance));
  const selectShift = (shift: string | null) => {
    setSelectedShift((current) => current === shift ? null : shift);
    setSelectedPersonId(null);
  };

  return <section className="station-timetable" aria-label={`${locationCode} roster and attendance timetable`}>
    <header><div><strong>Roster timetable</strong><span>{minuteLabel(window.start)}–{minuteLabel(window.end)} operating window</span></div><small>Expected time, actual report time and attendance gap in one view.</small></header>
    <div className="station-timetable-shift-strip" aria-label="Filter timetable by shift">
      <button type="button" className={validSelectedShift === null ? "active" : ""} aria-pressed={validSelectedShift === null} onClick={() => selectShift(null)}><b>All shifts</b><small>{scheduled.length + offDuty.length} people</small></button>
      {shiftSummary.map((shift) => <button type="button" className={validSelectedShift === shift.name ? "active" : ""} aria-pressed={validSelectedShift === shift.name} key={shift.name} onClick={() => selectShift(shift.name)}><b>{shift.clock.startLabel}–{shift.clock.endLabel}</b><small>{shift.reported}/{shift.expected} reported</small></button>)}
      {offDuty.length ? <button type="button" className={`week-off ${validSelectedShift === WEEK_OFF_FILTER ? "active" : ""}`} aria-pressed={validSelectedShift === WEEK_OFF_FILTER} onClick={() => selectShift(WEEK_OFF_FILTER)}><b>Off / other</b><small>{offDuty.filter((person) => person.today.reported).length}/{offDuty.length} present</small></button> : null}

    </div>
    <div className="station-timetable-scroll">
      <div className="station-timetable-axis" aria-hidden="true"><span>Team member</span><span>Shift</span><div>{ticks.map((tick, index) => <time key={`${tick}:${index}`} style={{ left: `${index / 6 * 100}%` }}>{minuteLabel(tick)}</time>)}</div><span>Reported</span></div>
      <div className="station-timetable-rows">
        {visibleScheduled.map((person) => {
          const shift = shiftClock(person.today.shiftName)!;
          const shiftStart = shift.start < window.start ? shift.start + 1440 : shift.start;
          const shiftEnd = shiftStart + (shift.end - shift.start);
          const state = attendanceState(person);
          const arrival = shiftPunchMinute(person.today.inTime, asOf);
          const recordedOut = shiftPunchMinute(person.today.outTime, asOf);
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
              <span className={`station-timetable-status ${state}`}><b>{clock(person.today.inTime)}</b><small style={{ whiteSpace: "normal", fontSize: 9 }} title={stateLabel(person)}>{stateLabel(person)}</small></span>
            </button>
            {open ? <AttendanceDetail person={person} /> : null}
          </div>;
        })}
        {visibleOffDuty.map((person) => {
          const personKey = `${person.workerType}:${person.id}`;
          const open = selectedPersonId === personKey;
          const arrival = shiftPunchMinute(person.today.inTime, asOf);
          const recordedOut = shiftPunchMinute(person.today.outTime, asOf);
          const actualEnd = arrival === null ? null : recordedOut ?? arrival + Math.max(5, person.today.workMinutes);
          const actualLeft = arrival === null ? 0 : position(Math.max(window.start, arrival));
          const actualWidth = actualEnd === null ? 0 : Math.max(.7, position(Math.min(window.end, actualEnd)) - actualLeft);
          return <div className={`station-timetable-person-row away ${person.today.reported ? "off-worked" : ""} ${open ? "open" : ""}`} key={personKey}>
            <button type="button" className="station-timetable-row" aria-expanded={open} onClick={() => setSelectedPersonId(open ? null : personKey)}>
              <span className="station-timetable-person"><span className="station-timetable-person-name"><b>{person.name}</b><PunchLocationBadge person={person} /></span><small>{person.designation}</small></span>
              <span className="station-timetable-shift"><b>Off / other</b><small>Approved roster</small></span>
              <span className="station-timetable-lane">
                <span className="station-timetable-off-label">{stateLabel(person)}</span>
                {arrival !== null && actualEnd !== null ? <span className="station-timetable-actual off-worked" style={{ left: `${actualLeft}%`, width: `${actualWidth}%` }} /> : null}
                {arrival !== null ? <span className="station-timetable-arrival away" style={{ left: `${actualLeft}%` }} title={`Reported ${clock(person.today.inTime)} on week off`} /> : null}
              </span>
              <span className="station-timetable-status away"><b>{attendanceInterval(person)}</b><small style={{ whiteSpace: "normal", fontSize: 9 }} title={stateLabel(person)}>{stateLabel(person)}</small></span>
            </button>
            {open ? <AttendanceDetail person={person} /> : null}
          </div>;
        })}
        {!visibleScheduled.length && !visibleOffDuty.length ? <div className="station-timetable-no-match"><strong>No people match these filters.</strong><span>Choose another shift or attendance status.</span></div> : null}
      </div>
    </div>
    {withoutRoster.length ? <div className="station-timetable-unassigned"><strong>{withoutRoster.length} active {withoutRoster.length === 1 ? "person has" : "people have"} no approved roster entry for this date.</strong><span>They are not counted as expected manpower.</span></div> : null}
  </section>;
}

export function OpsStationManpowerBoard({ asOf, locations, people, canExport = false }: { asOf: string; locations: CodLocationRow[]; people: OpsStationManpowerPerson[]; canExport?: boolean }) {
  const expectedPeople = people.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
  const scheduledReported = expectedPeople.filter((person) => person.today.reported).length;
  const present = people.filter((person) => person.today.reported).length;
  const offDayWorked = people.filter((person) => person.today.rosterDayType === "weekly_off" && person.today.reported).length;
  const onTime = expectedPeople.filter((person) => attendanceState(person) === "on-time").length;
  const late = expectedPeople.filter((person) => matchesShift(person, "late")).length;
  const early = expectedPeople.filter((person) => matchesShift(person, "early")).length;
  const missing = expectedPeople.filter((person) => attendanceState(person) === "missing").length;
  return <div className="station-manpower-workspace">
    <section className="station-manpower-summary">
      <article><Users2 size={17} /><span>Scheduled</span><strong>{expectedPeople.length}</strong><small>{people.length} active people · {locations.length} locations</small></article>
      <article className="good"><UserRoundCheck size={17} /><span>Punched</span><strong>{present}</strong><small>{scheduledReported} scheduled{offDayWorked ? ` · ${offDayWorked} off-day` : ""}</small></article>
      <article className="good"><CheckCircle2 size={17} /><span>No exceptions</span><strong>{onTime}</strong><small>No late in or early out</small></article>
      <article className={late ? "warn" : "good"}><Clock3 size={17} /><span>Late in</span><strong>{late}</strong><small>{early} early out · see filters</small></article>
      <article className={missing ? "attention" : "good"}><AlertTriangle size={17} /><span>Not reported</span><strong>{missing}</strong><small>Scheduled but no punch</small></article>
      <StationLiveRefresh />
    </section>
    <section className="station-insight-intro"><div><span><Gauge size={14} />Shift attendance insights</span><h2>Roster timetable and attendance gaps</h2></div><div className="station-insight-legend"><span className="on-time">On time / present</span><span className="late">Late in / early out</span><span className="missing">Empty = not reported</span><span className="away">WFH / leave / off</span></div></section>
    <div className="station-manpower-grid">{locations.map((location) => {
      const locationPeople = people.filter((person) => person.locationId === location.id).sort((left, right) => tier(left.designation) - tier(right.designation) || left.designation.localeCompare(right.designation) || left.name.localeCompare(right.name));
      const experience = locationExperience(location);
      const leadership = locationPeople.filter((person) => tier(person.designation) === 0);
      const shiftLeadership = locationPeople.filter((person) => tier(person.designation) === 1);
      const shifts = new Set(locationPeople.map((person) => person.today.shiftName).filter(Boolean));
      const locationExpected = locationPeople.filter((person) => Boolean(shiftClock(person.today.shiftName)) && attendanceState(person) !== "away");
      const locationReported = locationExpected.filter((person) => person.today.reported).length;
      const locationOffDayWorked = locationPeople.filter((person) => person.today.rosterDayType === "weekly_off" && person.today.reported).length;
      const locationLate = locationExpected.filter((person) => matchesShift(person, "late")).length;
      const locationMissing = locationExpected.filter((person) => attendanceState(person) === "missing").length;
      const readiness = locationExpected.length ? Math.round(locationReported / locationExpected.length * 100) : 0;
      return <section className="station-manpower-card" key={location.id}>
        <header><div><span><MapPin size={14} />{location.station_code} · {experience.noun}{experience.model ? ` · ${experience.model}` : ""}</span><h2>{location.station_name || location.station_code}</h2><p>{locationPeople.length} active people across {shifts.size} {experience.schedules}</p></div><div className="station-readiness-ring" style={{ "--readiness": `${readiness}%` } as CSSProperties}><strong>{readiness}%</strong><span>reported</span></div><div className="station-manpower-card-metrics"><span><strong>{locationExpected.length}</strong> expected</span><span className={locationLate ? "warn" : ""}><strong>{locationLate}</strong> late</span><span className={locationMissing ? "bad" : ""}><strong>{locationMissing}</strong> missing</span>{locationOffDayWorked ? <span className="off-worked"><strong>{locationOffDayWorked}</strong> off-day worked</span> : null}</div></header>
        {locationPeople.length ? <><div className="station-command-strip"><div><span>{experience.lead}</span><strong>{leadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{leadership.map((person) => person.designation).join(" · ") || "Leadership gap"}</small></div><div><span>Shift / workstream leads</span><strong>{shiftLeadership.map((person) => person.name).join(", ") || "Not assigned"}</strong><small>{shiftLeadership.map((person) => person.designation).join(" · ") || "No second-level lead mapped"}</small></div></div><ActiveRosterView asOf={asOf} people={locationPeople} locationCode={location.station_code} /><StationTimetable asOf={asOf} exportUrl={canExport ? `/api/ops-pulse/shift-attendance/export?date=${asOf}&location=${location.id}` : undefined} key={`${asOf}:${location.id}`} people={locationPeople} locationCode={location.station_code} /></> : <div className="station-manpower-empty"><Users2 size={20} /><strong>No active People manpower is assigned here.</strong><span>The location remains visible because it is inside your OpsPulse scope.</span></div>}
      </section>;
    })}</div>
    <p className="station-manpower-footnote">Live biometric attendance for {asOf} is compared only with the active approved People roster version. Profile shift assignments do not create expected rows here.</p>
  </div>;
}
