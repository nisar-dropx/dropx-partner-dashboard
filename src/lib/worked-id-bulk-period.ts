export function compareBulkAttendancePeriod(input: {
  from: string;
  to: string;
  quantity: number;
  basis: string;
  today: string;
  deliveries: {
    date: string;
    count: number;
    providerId: string;
    name?: string;
  }[];
  biometricDates: string[];
  reportDates: string[];
  mappingConflict?: boolean;
}) {
  const inPeriod = (date: string) =>
    date >= input.from && date <= input.to && date <= input.today;
  const deliveryDates = [
    ...new Set(
      input.deliveries
        .filter((d) => inPeriod(d.date) && d.count > 0)
        .map((d) => d.date),
    ),
  ].sort();
  const biometricDates = [
    ...new Set(input.biometricDates.filter(inPeriod)),
  ].sort();
  const reportDates = new Set(input.reportDates.filter(inPeriod));
  const elapsedDates: string[] = [];
  for (
    let d = new Date(`${input.from}T00:00:00Z`);
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) <= input.to &&
    d.toISOString().slice(0, 10) <= input.today;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    elapsedDates.push(d.toISOString().slice(0, 10));
  }
  const missingReportDates = elapsedDates.filter((d) => !reportDates.has(d));
  const ongoing = input.to > input.today;
  const comparable =
    input.basis === "days" &&
    Number.isFinite(input.quantity) &&
    input.quantity >= 0;
  const gap = comparable
    ? Math.max(0, input.quantity - deliveryDates.length)
    : null;
  const needsReview =
    !comparable ||
    (gap ?? 0) > 0 ||
    ongoing ||
    !!input.mappingConflict ||
    missingReportDates.length > 0;
  return {
    deliveryDates,
    biometricDates,
    missingReportDates,
    ongoing,
    comparable,
    gap,
    needsReview,
    status: !comparable
      ? "Hours require separate review"
      : input.mappingConflict
        ? "ID mapping needs review"
        : ongoing
          ? "Period in progress"
          : gap! > 0
            ? `${gap} days to review`
            : missingReportDates.length
              ? "Delivery report gaps"
              : "No day-count shortfall",
  };
}
