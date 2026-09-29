import type { CloakAuthContext } from '../types';
import { CLOAK_RESOURCES } from '../config';
import { ProviderError } from '../errors';
import { CACHE_ERROR_RE } from '../session/cloakCookies';

export interface CloakBulkDownload {
  url: string;
  dataSource: string | null;
  totalCount: number | null;
}

/** Client for cloak.tech.amazon.dev APIs (cookie auth, same-origin headers). */
export class CloakProvider {
  constructor(private readonly baseUrl: string) {}

  /** POST /api/v1/bulkDownload → presigned S3 CSV URL (valid ~1h). */
  async bulkDownload(auth: CloakAuthContext, body: Record<string, unknown>): Promise<CloakBulkDownload> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${CLOAK_RESOURCES.bulkDownload}`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-IN,en;q=0.9',
          'content-type': 'application/json',
          cookie: auth.cookie,
          origin: this.baseUrl,
          referer: `${this.baseUrl}/`,
          'x-csrf-token': 'required',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
    } catch (err) {
      throw new ProviderError(`Cloak request failed: ${(err as Error).message}`, 502, 'CLOAK_NETWORK');
    }

    const text = await res.text().catch(() => '');
    if (CACHE_ERROR_RE.test(text)) {
      throw new ProviderError('Cloak reported a cache error', 409, 'CLOAK_CACHE_ERROR');
    }
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new ProviderError('Cloak session expired or unauthorized', 401, 'CLOAK_SESSION_EXPIRED');
    }
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      throw new ProviderError('Cloak returned HTML (login page) — session is stale', 401, 'CLOAK_SESSION_EXPIRED');
    }
    if (!res.ok) {
      throw new ProviderError(`Cloak API error ${res.status}: ${text.slice(0, 200)}`, 502, 'CLOAK_HTTP');
    }

    let json: { url?: string; dataSource?: string; totalCount?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('Cloak bulkDownload returned invalid JSON', 502, 'CLOAK_HTTP');
    }
    if (!json.url) throw new ProviderError('Cloak bulkDownload returned no url', 502, 'CLOAK_HTTP');
    return { url: json.url, dataSource: json.dataSource ?? null, totalCount: json.totalCount ?? null };
  }

  /** Presigned S3 — no cookie. */
  async downloadText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new ProviderError(`Cloak CSV download HTTP ${res.status}`, 502, 'CLOAK_DOWNLOAD');
    return res.text();
  }
}
