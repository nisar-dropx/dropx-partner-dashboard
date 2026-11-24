/** Publication periods are exact inclusive date ranges. */
export function validPayoutPublicationPeriod(start: string, end: string) {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return valid(start) && valid(end) && start <= end;
}

export function payoutPublicationPeriodLabel(start: string, end: string) {
  return start === end ? start : `${start} to ${end}`;
}

/** Monthly clearance applies to every month touched by a selected bank period. */
export function payoutPeriodMonths(start: string, end: string) {
  if (!validPayoutPublicationPeriod(start, end)) throw new Error("Choose a valid payout date range.");
  const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const months: string[] = [];
  for (let index = monthIndex(start); index <= monthIndex(end); index++) {
    months.push(`${String(Math.floor(index / 12)).padStart(4, "0")}-${String(index % 12 + 1).padStart(2, "0")}`);
  }
  return months;
}
