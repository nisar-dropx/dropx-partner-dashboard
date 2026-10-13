import { chunkedValues, mapWithConcurrency } from "./bounded-concurrency.ts";

export const PAYOUT_PAYMENT_PREVIEW_BATCH_SIZE = 50;
export const PAYOUT_PAYMENT_PREVIEW_CONCURRENCY = 3;

type PreviewBatchResult<Preview, ErrorType> = {
  data: Preview[] | null;
  error: ErrorType | null;
};

function payoutPreviewErrorText(error: unknown) {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return String(error ?? "");
  const record = error as Record<string, unknown>;
  return [record.code, record.message, record.details, record.hint]
    .filter((value) => value !== null && value !== undefined)
    .map(String)
    .join(" ");
}

export function isPayoutPaymentPreviewStatementTimeout(error: unknown) {
  return /(?:^|\s)57014(?:\s|$)|statement timeout|canceling statement/i.test(
    payoutPreviewErrorText(error)
  );
}

async function loadPreviewBatchWithTimeoutSplit<Row, Preview, ErrorType>(
  rows: Row[],
  loadBatch: (batch: Row[]) => Promise<PreviewBatchResult<Preview, ErrorType>>,
  maySplit: boolean
): Promise<PreviewBatchResult<Preview, ErrorType>> {
  const result = await loadBatch(rows);
  if (!result.error) return { data: result.data ?? [], error: null };
  if (!maySplit || rows.length < 2 || !isPayoutPaymentPreviewStatementTimeout(result.error)) {
    return result;
  }

  // A timeout indicates database contention, not invalid payout data. Split the
  // failed request once so each retry remains comfortably below PostgREST's
  // statement timeout without concealing a persistent or non-timeout failure.
  const midpoint = Math.ceil(rows.length / 2);
  const left = await loadPreviewBatchWithTimeoutSplit(rows.slice(0, midpoint), loadBatch, false);
  if (left.error) return left;
  const right = await loadPreviewBatchWithTimeoutSplit(rows.slice(midpoint), loadBatch, false);
  if (right.error) return right;
  return { data: [...(left.data ?? []), ...(right.data ?? [])], error: null };
}

export async function loadPayoutPaymentPreviews<Row, Preview, ErrorType>(input: {
  rows: readonly Row[];
  loadBatch: (batch: Row[]) => Promise<PreviewBatchResult<Preview, ErrorType>>;
  batchSize?: number;
  concurrency?: number;
}) {
  const results = await mapWithConcurrency(
    chunkedValues(input.rows, input.batchSize ?? PAYOUT_PAYMENT_PREVIEW_BATCH_SIZE),
    input.concurrency ?? PAYOUT_PAYMENT_PREVIEW_CONCURRENCY,
    (batch) => loadPreviewBatchWithTimeoutSplit(batch, input.loadBatch, true)
  );
  const previews: Preview[] = [];
  for (const result of results) {
    if (result.error) return { data: previews, error: result.error };
    previews.push(...(result.data ?? []));
  }
  return { data: previews, error: null as ErrorType | null };
}
