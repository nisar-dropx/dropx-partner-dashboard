export const MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION = 50;
export const MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES = 3 * 1024 * 1024;
export const WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK = 100;

export function chunkValues<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Chunk size must be a positive whole number.");
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

export function serializedJsonByteLength(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Publication payload must be JSON serializable.");
  return new TextEncoder().encode(serialized).byteLength;
}
