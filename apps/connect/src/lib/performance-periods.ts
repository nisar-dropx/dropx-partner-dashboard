export type PerformanceWeekPeriod = {
  key: number;
  week: number;
  year: number;
  startDate: string;
  endDate: string;
};

/** Matches the Sunday-Saturday week convention used by OpsPulse uploads. */
export function amazonWeekPeriod(key: number): PerformanceWeekPeriod {
  const year = Math.floor(key / 100);
  const week = key % 100;
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const firstSunday = new Date(yearStart);
  firstSunday.setUTCDate(firstSunday.getUTCDate() - firstSunday.getUTCDay());
  const start = new Date(firstSunday);
  start.setUTCDate(firstSunday.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    key,
    week,
    year,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}
