import { chunkedValues, mapWithConcurrency } from "./bounded-concurrency.ts";

export const POSTGREST_IN_FILTER_BATCH_SIZE = 100;
export const POSTGREST_IN_FILTER_CONCURRENCY = 4;

type BatchResult<Row, ErrorType> = {
  data: Row[] | null;
  error: ErrorType | null;
};

/**
 * Keeps PostgREST `.in(...)` request URLs below the gateway limit while
 * preserving the input order of each batch and the first database error.
 */
export async function loadPostgrestInFilterBatches<Value, Row, ErrorType>(input: {
  values: readonly Value[];
  loadBatch: (values: Value[]) => PromiseLike<BatchResult<Row, ErrorType>>;
  batchSize?: number;
  concurrency?: number;
}) {
  const results = await mapWithConcurrency(
    chunkedValues(input.values, input.batchSize ?? POSTGREST_IN_FILTER_BATCH_SIZE),
    input.concurrency ?? POSTGREST_IN_FILTER_CONCURRENCY,
    async (batch) => input.loadBatch(batch)
  );
  const rows: Row[] = [];
  for (const result of results) {
    if (result.error) return { data: rows, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null as ErrorType | null };
}
