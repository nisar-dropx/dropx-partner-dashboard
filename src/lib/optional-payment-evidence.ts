export const EVIDENCE_UNAVAILABLE = 'Volume evidence is temporarily unavailable. You can continue submitting or reviewing this request.';
export const EVIDENCE_TIMEOUT_MS = 8000;

// Evidence is advisory. Never share this deadline with a payment mutation.
export async function optionalPaymentEvidence<T>(load: () => Promise<T>, timeoutMs = EVIDENCE_TIMEOUT_MS): Promise<{ data: T | null; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      Promise.resolve().then(load),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Evidence deadline')), timeoutMs); })
    ]);
    return { data, error: '' };
  } catch {
    return { data: null, error: EVIDENCE_UNAVAILABLE };
  } finally {
    clearTimeout(timer);
  }
}
