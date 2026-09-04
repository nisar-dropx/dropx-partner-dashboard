/** Every review belongs to its performance day, not the day someone opened it. */
export const REVIEW_PENDING_PAGE_SIZE = 15;

export function reviewPendingPage(value: string | undefined) {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10000) : 1;
}

export function reviewsForPerformanceDay<T extends { source_date: string; review_type: string }>(rows: T[], date: string) {
  return rows.filter(row => row.source_date === date && row.review_type === "daily_operations");
}

export function earlierPendingReviews<T extends { source_date: string; review_type: string; status: string }>(rows: T[], date: string) {
  return rows.filter(row => row.source_date < date && row.review_type === "daily_operations" && row.status !== "closed")
    .sort((left, right) => left.source_date.localeCompare(right.source_date));
}

export function reviewLink(date: string, stationCode: string, pendingPage?: number) {
  const params = new URLSearchParams({ view: "reviews", date, review: stationCode });
  if (pendingPage) params.set("pendingPage", String(pendingPage));
  return `/performance?${params.toString()}`;
}
