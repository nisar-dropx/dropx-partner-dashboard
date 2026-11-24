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
