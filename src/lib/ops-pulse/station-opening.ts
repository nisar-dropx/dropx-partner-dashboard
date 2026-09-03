type StationOpeningRosterPerson = {
  locationId: string;
  today: {
    rosterDayType: string | null;
    shiftEndTime: string | null;
    shiftName: string | null;
    shiftSource: string | null;
    shiftStartTime: string | null;
  };
};

export type StationOpeningSchedule = {
  scheduledTime: string | null;
  shiftName: string | null;
  shiftSource: string | null;
};

export function clockMinutes(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : null;
}

function relativeToWindowStart(minutes: number, windowStartMinutes: number) {
  return minutes < windowStartMinutes ? minutes + 1440 : minutes;
}

export function isClockWithinWindow(value: string | null | undefined, start: string, end: string) {
  const minute = clockMinutes(value);
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  if (minute == null || from == null || to == null) return false;
  return from <= to ? minute >= from && minute <= to : minute >= from || minute <= to;
}

export function resolveStationOpeningSchedule(
  people: StationOpeningRosterPerson[],
  locationId: string,
  openingWindowStart: string,
  openingWindowEnd: string
): StationOpeningSchedule {
  const windowStartMinutes = clockMinutes(openingWindowStart);
  if (windowStartMinutes == null) return { scheduledTime: null, shiftName: null, shiftSource: null };

  const candidates = people
    .filter((person) => person.locationId === locationId
      && person.today.rosterDayType === "working"
      && isClockWithinWindow(person.today.shiftStartTime, openingWindowStart, openingWindowEnd))
    .map((person) => ({
      person,
      startMinutes: clockMinutes(person.today.shiftStartTime)!
    }))
    .sort((left, right) => relativeToWindowStart(left.startMinutes, windowStartMinutes) - relativeToWindowStart(right.startMinutes, windowStartMinutes));

  const first = candidates[0];
  if (!first) return { scheduledTime: null, shiftName: null, shiftSource: null };
  const scheduledAtOpening = candidates.filter((candidate) => candidate.startMinutes === first.startMinutes).length;
  return {
    scheduledTime: first.person.today.shiftStartTime,
    shiftName: first.person.today.shiftName,
    shiftSource: `Active approved station roster · ${scheduledAtOpening} scheduled at opening`
  };
}

export function stationOpeningLateMinutes(
  actualClockMinutes: number | null,
  scheduledTime: string | null,
  openingWindowStart: string
) {
  const scheduledMinutes = clockMinutes(scheduledTime);
  const windowStartMinutes = clockMinutes(openingWindowStart);
  if (actualClockMinutes == null || scheduledMinutes == null || windowStartMinutes == null) return null;
  return Math.max(
    0,
    relativeToWindowStart(actualClockMinutes, windowStartMinutes)
      - relativeToWindowStart(scheduledMinutes, windowStartMinutes)
  );
}
