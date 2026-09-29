import type { CloakAuthContext, Env } from '../types';
import { cloakBaseUrl, cloakBulkDownloadBody } from '../config';
import { ProviderError } from '../errors';
import { CloakProvider, type CloakBulkDownload } from '../providers/CloakProvider';
import { ensureCloakSession } from '../session/ensureCloakSession';
import { refreshCloakTokens } from '../session/cloakCognitoRefresh';
import { createCloakSessionStore, createDashboardSupabase } from '../store/factory';
import { LossReportStore } from '../store/LossReportStore';
import { buildLossTable, gridToRecords, parseCsv } from './lossTable';

export interface NlLossRunResult {
  ok: boolean;
  runId?: string;
  rows?: number;
  stations?: number;
  sourceTotalCount?: number | null;
  sessionSource?: string;
  error?: string;
  code?: string;
}

/**
 * Cloak bulk download → CSV → station-wise NL loss snapshot.
 *
 * Recovery ladder on the bulkDownload call:
 *   session expired → renew tokens with the refresh token → full browser login
 *   cache error     → full browser login that clears cache/cookies/storage first
 */
export async function runNlLoss(env: Env, triggeredBy: string): Promise<NlLossRunResult> {
  const store = new LossReportStore(createDashboardSupabase(env));
  const provider = new CloakProvider(cloakBaseUrl(env));
  const body = cloakBulkDownloadBody(env);

  try {
    let ensured = await ensureCloakSession(env, { triggeredBy });
    if (!ensured.ok) throw new ProviderError(ensured.error, 401, ensured.code);
    let sessionSource: string = ensured.source;

    let download: CloakBulkDownload | null = null;
    for (let attempt = 0; attempt < 3 && !download; attempt++) {
      try {
        download = await provider.bulkDownload(ensured.auth, body);
      } catch (err) {
        if (!(err instanceof ProviderError) || attempt === 2) throw err;
        if (err.code === 'CLOAK_SESSION_EXPIRED') {
          const renewed = await renewOrRelogin(env, ensured.auth, triggeredBy);
          if (!renewed.ok) throw new ProviderError(renewed.error, 401, renewed.code);
          ensured = renewed;
        } else if (err.code === 'CLOAK_CACHE_ERROR') {
          await createCloakSessionStore(env).markExpired(ensured.sessionId);
          const relogged = await ensureCloakSession(env, { triggeredBy: `${triggeredBy}:cache-reset`, forceRelogin: true });
          if (!relogged.ok) throw new ProviderError(relogged.error, 401, relogged.code);
          ensured = relogged;
        } else {
          throw err;
        }
        sessionSource = ensured.source;
      }
    }
    if (!download) throw new Error('Cloak bulkDownload did not return a file.');

    const csv = await provider.downloadText(download.url);
    const { headers, records } = gridToRecords(parseCsv(csv));
    const table = buildLossTable(headers, records);
    const saved = await store.saveRun(
      'nl',
      {
        fileName: new URL(download.url).pathname.split('/').pop() ?? null,
        sourceTotalCount: download.totalCount,
        triggeredBy,
      },
      table,
    );
    return { ok: true, ...saved, sourceTotalCount: download.totalCount, sessionSource };
  } catch (err) {
    const message = (err as Error).message || 'NL loss run failed';
    const code = err instanceof ProviderError ? err.code : 'NL_RUN_FAILED';
    await store.recordFailure('nl', triggeredBy, `${code}: ${message}`).catch(() => undefined);
    return { ok: false, error: message, code };
  }
}

async function renewOrRelogin(env: Env, auth: CloakAuthContext, triggeredBy: string) {
  const cloakStore = createCloakSessionStore(env);
  const renewed = await refreshCloakTokens(env, auth.cookie);
  if (renewed) {
    const stored = await cloakStore.upload(renewed, 'cognito-refresh');
    return { ok: true as const, auth: { cookie: stored.cookie }, sessionId: stored.id, source: 'token_refresh' as const };
  }
  return ensureCloakSession(env, { triggeredBy, forceRelogin: true });
}
