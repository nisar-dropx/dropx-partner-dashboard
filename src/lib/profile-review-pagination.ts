export const PROFILE_REVIEW_PAGE_SIZE = 50;
export const PROFILE_REVIEW_REASON_BATCH_SIZE = 50;

export function profileReviewIdBatches(values: unknown[], batchSize = PROFILE_REVIEW_REASON_BATCH_SIZE) {
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : PROFILE_REVIEW_REASON_BATCH_SIZE;
  const ids = Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
  const batches: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    batches.push(ids.slice(offset, offset + size));
  }
  return batches;
}

export function paginateProfileReview<T>(
  items: T[],
  requestedPage: unknown,
  pageSize = PROFILE_REVIEW_PAGE_SIZE
) {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : PROFILE_REVIEW_PAGE_SIZE;
  const parsedPage = Number.parseInt(String(requestedPage ?? ""), 10);
  const desiredPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(desiredPage, pageCount);
  const offset = (page - 1) * size;
  const endOffset = Math.min(offset + size, total);

  return {
    items: items.slice(offset, endOffset),
    page,
    pageCount,
    pageSize: size,
    total,
    firstItem: total ? offset + 1 : 0,
    lastItem: endOffset
  };
}
