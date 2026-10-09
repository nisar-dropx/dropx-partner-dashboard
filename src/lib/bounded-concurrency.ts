export async function mapWithConcurrency<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  worker: (value: Input, index: number) => Promise<Output>
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrency must be a positive whole number.");
  }
  if (!values.length) return [] as Output[];

  const results = new Array<Output>(values.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await worker(values[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

export function chunkedValues<Value>(values: readonly Value[], size: number) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new Error("Chunk size must be a positive whole number.");
  }
  const chunks: Value[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}
