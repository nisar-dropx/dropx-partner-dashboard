export function betaReportUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    // Observed IDfy report store. Never accept a client-supplied download URL.
    if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com' || url.port || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export async function readBetaPdf(response: Response) {
  const max = 20 * 1024 * 1024;
  if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')
    || Number(response.headers.get('content-length') || 0) > max || !response.body) throw new Error('PDF unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {value,done} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) throw new Error('PDF too large'); chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw new Error('Not a PDF');
  return bytes;
}
