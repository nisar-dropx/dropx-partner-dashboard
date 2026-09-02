import { AlertTriangle, CalendarClock, Clock3, LogIn, MapPin, UserRoundCheck, Users2 } from "lucide-react";
import { StationLiveRefresh } from "@/components/station-live-refresh";
import type { CodLocationRow } from "@/lib/ops-pulse/cod";
import type { OpsStationManpowerPerson } from "@/lib/ops-pulse/station-manpower";

const tierLabels = ["Station leadership", "Shift leadership", "Station team", "Other roles"];

function tier(designation: string) {
  const value = designation.trim().toLowerCase().replaceAll("-", " ");
  if (/\b(assistant team lead|asst\.? team lead|shift in ?charge|shift lead|shift manager|supervisor)\b/.test(value)) return 1;
  if (/\b(station manager|store manager|team lead|team leader|site lead|location head|location manager)\b/.test(value)) return 0;
  if (/\b(picker|packer|associate|helper|loader|sorter|executive|telecaller)\b/.test(value)) return 2;
  if (/\b(manager|head|lead|in ?charge)\b/.test(value)) return 0;
  return 3;
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function clock(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(date);
}

function duration(minutes: number) {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function stateClass(person: OpsStationManpowerPerson) {
  if (person.today.lateMinutes) return "late";
  if (person.availability === "Working") return "working";
  if (person.availability === "Completed") return "complete";
  if (person.availability === "On leave" || person.availability === "Roster off") return "away";
  return "missing";
}

export function OpsStationManpowerBoard({ asOf, locations, people }: { asOf: string; locations: CodLocationRow[]; people: OpsStationManpowerPerson[] }) {
  const summary = {
    total: people.length,
    reported: people.filter((person) => person.today.reported).length,
    working: people.filter((person) => person.availability === "Working").length,
    late: people.filter((person) => person.today.lateMinutes > 0).length,
    missing: people.filter((person) => person.availability === "Not reported").length,
    leave: people.filter((person) => person.availability === "On leave").length,
    off: people.filter((person) => person.availability === "Roster off").length
  };

  return <div className="station-manpower-workspace">
    <section className="station-manpower-summary">
      <article><Users2 size={17} /><span>Total manpower</span><strong>{summary.total}</strong><small>{locations.length} station{locations.length === 1 ? "" : "s"} in view</small></article>
      <article className="good"><UserRoundCheck size={17} /><span>Reported</span><strong>{summary.reported}</strong><small>{summary.working} currently working</small></article>
      <article className={summary.late ? "warn" : "good"}><Clock3 size={17} /><span>Late</span><strong>{summary.late}</strong><small>Against rostered shift grace</small></article>
      <article className={summary.missing ? "attention" : "good"}><AlertTriangle size={17} /><span>Not reported</span><strong>{summary.missing}</strong><small>{summary.leave} leave · {summary.off} roster off</small></article>
      <StationLiveRefresh />
    </section>
    <div className="station-manpower-grid">{locations.map((location) => {
      const stationPeople = people.filter((person) => person.locationId === location.id).sort((left, right) => tier(left.designation) - tier(right.designation) || left.designation.localeCompare(right.designation) || left.name.localeCompare(right.name));
      const reported = stationPeople.filter((person) => person.today.reported).length;
      const late = stationPeople.filter((person) => person.today.lateMinutes > 0).length;
      const missing = stationPeople.filter((person) => person.availability === "Not reported").length;
      const groups = tierLabels.map((label, index) => ({ label, people: stationPeople.filter((person) => tier(person.designation) === index) })).filter((group) => group.people.length);
      return <section className="station-manpower-card" key={location.id}>
        <header><div><span><MapPin size={14} />{location.station_code}</span><h2>{location.station_name || location.station_code}</h2></div><div className="station-manpower-card-metrics"><span><strong>{reported}</strong>/{stationPeople.length} reported</span><span className={late ? "warn" : ""}><strong>{late}</strong> late</span><span className={missing ? "bad" : ""}><strong>{missing}</strong> missing</span></div></header>
        {groups.length ? <div className="station-manpower-tiers">{groups.map((group) => <section key={group.label}><h3>{group.label}<span>{group.people.length}</span></h3><div className="station-manpower-people">{group.people.map((person) => <article key={`${person.workerType}:${person.id}`}>
          <span className="station-manpower-avatar">{initials(person.name)}</span><div className="station-manpower-person"><strong>{person.name}</strong><small>{person.designation} · {person.code}</small></div>
          <span className={`station-manpower-status ${stateClass(person)}`}>{person.today.lateMinutes ? `Late ${person.today.lateMinutes}m` : person.availability}</span>
          <div className="station-manpower-shift"><span><CalendarClock size={12} />{person.today.shiftName ?? "Shift not assigned"}</span><small>{person.today.shiftSource ?? "No roster or effective assignment"}</small></div>
          <div className="station-manpower-time"><span><LogIn size={12} />IN <strong>{clock(person.today.inTime)}</strong></span><span>OUT <strong>{clock(person.today.outTime)}</strong></span><small>{duration(person.today.workMinutes)}{person.today.missingPunch ? " · Open punch" : ""}</small></div>
          <a href={person.profileHref} target="_blank" rel="noreferrer">People profile</a>
        </article>)}</div></section>)}</div> : <div className="station-manpower-empty"><Users2 size={20} /><strong>No active People manpower is assigned here.</strong><span>The station remains visible because it is inside your OpsPulse scope.</span></div>}
      </section>;
    })}</div>
    <p className="station-manpower-footnote">Live People roster and biometric attendance for {asOf}. Approved daily roster takes priority over the effective shift assignment.</p>
  </div>;
}
