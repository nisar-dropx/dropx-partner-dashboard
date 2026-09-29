import type { CloakAuthContext, Env } from '../types';
import { cloakCognitoClientId, DEFAULT_PORTAL_ACCOUNT } from '../config';
import { createCloakSessionStore } from '../store/factory';
import { jwtExpiryMs, readCloakTokens } from './cloakCookies';
import { refreshCloakTokens } from './cloakCognitoRefresh';
import { loginAndCaptureCloakSession } from './CloakPortalLogin';

export type EnsureCloakSessionResult =
  | { ok: true; auth: CloakAuthContext; sessionId: string; source: 'cached' | 'token_refresh' | 'browser_login' }
  | { ok: false; code: string; error: string };

/** Refresh a little early so a long run never straddles token expiry. */
const EXPIRY_SKEW_MS = 5 * 60_000;
const SHARED_LOGIN_DEADLINE_MS = 120_000;
const SHARED_LOGIN_POLL_MS = 1_500;

/**
 * Stored session → Cognito refresh-token renewal → browser login.
 * `forceRelogin` skips the first two (used after a cache error, where the
 * stored state itself is suspect).
 */
export async function ensureCloakSession(
  env: Env,
  opts: { triggeredBy?: string; forceRelogin?: boolean; accountKey?: string } = {},
): Promise<EnsureCloakSessionResult> {
  const accountKey = opts.accountKey?.trim() || DEFAULT_PORTAL_ACCOUNT;
  const store = createCloakSessionStore(env);
  const clientId = cloakCognitoClientId(env);

  if (!opts.forceRelogin) {
    const active = await store.getActive(accountKey);
    if (active?.cookie) {
      const tokens = readCloakTokens(active.cookie, clientId);
      if (jwtExpiryMs(tokens?.accessToken ?? null) > Date.now() + EXPIRY_SKEW_MS) {
        return { ok: true, auth: { cookie: active.cookie }, sessionId: active.id, source: 'cached' };
      }
      const renewed = await refreshCloakTokens(env, active.cookie);
      if (renewed) {
        const stored = await store.upload(renewed, 'cognito-refresh', accountKey);
        return { ok: true, auth: { cookie: stored.cookie }, sessionId: stored.id, source: 'token_refresh' };
      }
      await store.markExpired(active.id);
    }
  }

  const email = env.CLOAK_EMAIL?.trim();
  const password = env.CLOAK_PASSWORD?.trim();
  if (!email || !password) {
    return {
      ok: false,
      code: 'NO_CREDENTIALS',
      error: 'Cloak session missing/expired and CLOAK_EMAIL / CLOAK_PASSWORD are not set. Upload cookies via PUT /api/admin/cloak/session.',
    };
  }

  const startedAt = Date.now();
  const deadline = startedAt + SHARED_LOGIN_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await store.tryAcquireLoginLock(accountKey, 150)) {
      const result = await loginAndCaptureCloakSession(env, { email, password });
      if (!result.ok) {
        await store.releaseLoginLock({ ok: false, error: `${result.code}: ${result.error}` }, accountKey);
        return { ok: false, code: result.code, error: result.error };
      }
      const stored = await store.upload(result.auth.cookie, opts.triggeredBy || email, accountKey);
      await store.releaseLoginLock({ ok: true }, accountKey);
      return { ok: true, auth: { cookie: stored.cookie }, sessionId: stored.id, source: 'browser_login' };
    }
    // Someone else is logging in — adopt their session once it lands.
    await new Promise((r) => setTimeout(r, SHARED_LOGIN_POLL_MS));
    const adopted = await store.getActive(accountKey);
    if (adopted?.cookie && Date.parse(adopted.uploadedAt) >= startedAt) {
      return { ok: true, auth: { cookie: adopted.cookie }, sessionId: adopted.id, source: 'cached' };
    }
  }
  return { ok: false, code: 'SESSION_UNAVAILABLE', error: 'Cloak login is still in progress elsewhere. Retry shortly.' };
}
