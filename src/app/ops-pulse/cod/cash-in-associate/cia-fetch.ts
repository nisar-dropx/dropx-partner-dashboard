export function friendlyCiaWorkerError(raw: string, status: number) {
  if (/Worker exceeded resource limits/i.test(raw) || /<!DOCTYPE html/i.test(raw) || /^\s*</.test(raw)) {
    return "Cash recon worker hit resource limits. Try a shorter date range, or refresh again in a minute.";
  }
  const trimmed = raw.trim();
  if (!trimmed) return `Unable to load live range (${status}).`;
  if (trimmed.length > 280) return `Unable to load live range (${status}).`;
  return trimmed;
}

export async function readCiaJson(response: Response) {
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text && !/^\s*</.test(text)) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  return { payload, text };
}
