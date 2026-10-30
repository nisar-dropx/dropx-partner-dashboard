import * as XLSX from "xlsx";
import { recurringRosterDays } from "./recurring-roster-import.ts";

export type RosterTemplateStation = {
  id: string;
  station_code: string;
  station_name?: string | null;
};

export type RosterTemplatePerson = {
  id: string;
  workerType: "employee" | "contractor";
  code: string;
  name: string;
  designation: string;
  locationId: string;
};

export type RosterTemplateShift = {
  id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
};

export type RosterTemplateEntry = {
  worker_type: string;
  worker_id: string;
  roster_date: string;
  day_type: string;
  shift_id: string | null;
  location_id: string;
};

export type RosterTemplateStationPeriod = {
  stationId: string;
  periodStart: string;
};

function isoWeekday(value: string) {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function safeRosterFilename(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "roster";
}

/** Build the recurring Mon–Sun workbook used by single-station and all-station downloads. */
export function buildRecurringRosterWorkbook(input: {
  stations: RosterTemplateStation[];
  people: RosterTemplatePerson[];
  shifts: RosterTemplateShift[];
  entries: RosterTemplateEntry[];
  periods: RosterTemplateStationPeriod[];
  today: string;
  fallbackPeriodStart: string;
}) {
  if (!input.stations.length) throw new Error("No stations are available to download.");

  const shiftById = new Map(input.shifts.map((shift) => [shift.id, shift]));
  const periodByStation = new Map(input.periods.map((row) => [row.stationId, row.periodStart]));
  const valueByPersonDay = new Map<string, string>();
  for (const entry of input.entries) {
    const shift = entry.shift_id ? shiftById.get(entry.shift_id) : null;
    valueByPersonDay.set(
      `${entry.location_id}:${entry.worker_type}:${entry.worker_id}:${isoWeekday(entry.roster_date)}`,
      entry.day_type === "weekly_off" ? "WO" : shift?.code ?? ""
    );
  }

  const stationById = new Map(input.stations.map((station) => [station.id, station]));
  const people = [...input.people].sort((left, right) => {
    const leftCode = stationById.get(left.locationId)?.station_code ?? "";
    const rightCode = stationById.get(right.locationId)?.station_code ?? "";
    return leftCode.localeCompare(rightCode) || left.name.localeCompare(right.name) || left.code.localeCompare(right.code);
  });

  const headers = ["LOCATION_CODE", "DROPX_ID", "NAME", "PEOPLE_TYPE", "DESIGNATION", ...recurringRosterDays];
  const rows = people.flatMap((person) => {
    const station = stationById.get(person.locationId);
    if (!station) return [];
    return [{
      LOCATION_CODE: station.station_code,
      DROPX_ID: person.code,
      NAME: person.name,
      PEOPLE_TYPE: person.workerType === "employee" ? "Employee" : "Independent Contractor",
      DESIGNATION: person.designation,
      ...Object.fromEntries(recurringRosterDays.map((day, index) => [
        day,
        valueByPersonDay.get(`${person.locationId}:${person.workerType}:${person.id}:${index + 1}`) ?? ""
      ]))
    }];
  });

  // Stations with nobody assigned still appear so managers see coverage gaps.
  for (const station of input.stations) {
    if (rows.some((row) => row.LOCATION_CODE === station.station_code)) continue;
    rows.push({
      LOCATION_CODE: station.station_code,
      DROPX_ID: "",
      NAME: "(No active people assigned)",
      PEOPLE_TYPE: "",
      DESIGNATION: "",
      ...Object.fromEntries(recurringRosterDays.map((day) => [day, ""]))
    });
  }
  rows.sort((left, right) => left.LOCATION_CODE.localeCompare(right.LOCATION_CODE) || left.NAME.localeCompare(right.NAME));

  const rosterSheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  rosterSheet["!cols"] = [{ wch: 16 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 28 }, ...recurringRosterDays.map(() => ({ wch: 16 }))];

  const shiftSheet = XLSX.utils.json_to_sheet(input.shifts.map((shift) => ({
    SHIFT_CODE: shift.code,
    SHIFT_NAME: shift.name,
    START_TIME: String(shift.start_time).slice(0, 5),
    END_TIME: String(shift.end_time).slice(0, 5)
  })));
  shiftSheet["!cols"] = [{ wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }];

  const multi = input.stations.length > 1;
  const instructions = XLSX.utils.aoa_to_sheet([
    [multi ? "DropX Ops multi-station recurring roster" : "DropX Ops station recurring roster"],
    ["Generated (IST day)", input.today],
    ["Stations", String(input.stations.length)],
    ["People rows", String(rows.filter((row) => row.DROPX_ID).length)],
    [],
    ["Stations included"],
    ...input.stations
      .slice()
      .sort((left, right) => left.station_code.localeCompare(right.station_code))
      .map((station) => [
        station.station_code,
        station.station_name || station.station_code,
        `Template week starts ${periodByStation.get(station.id) || input.fallbackPeriodStart}`
      ]),
    [],
    ["How to read / complete"],
    ["1", "Each person appears once with Monday to Sunday in the same row."],
    ["2", "Enter a SHIFT_CODE from the Shift Master tab for working days."],
    ["3", "Enter WO for a weekly off. Leave a cell blank to clear that day."],
    ["4", "Do not change LOCATION_CODE or DROPX_ID."],
    ["5", multi
      ? "Upload stays single-station: open each station draft in Rostering and import only that station’s rows."
      : "Upload into an editable Ops draft. Import never publishes — submit for approval after import."],
    ["6", "Approval route: station owner → reporting manager → HR."]
  ]);
  instructions["!cols"] = [{ wch: 16 }, { wch: 100 }, { wch: 40 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, rosterSheet, "Recurring Roster");
  XLSX.utils.book_append_sheet(workbook, shiftSheet, "Shift Master");
  XLSX.utils.book_append_sheet(workbook, instructions, "Instructions");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
}
