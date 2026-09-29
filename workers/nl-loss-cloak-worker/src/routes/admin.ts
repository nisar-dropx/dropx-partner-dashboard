import type { Context } from 'hono';
import type { Env } from '../types';
import { ValidationInputError } from '../errors';
import { cloakCognitoClientId, DEFAULT_PORTAL_ACCOUNT } from '../config';
import { createCloakSessionStore, createDashboardSupabase, createWorkforceSessionStore } from '../store/factory';
import { LossReportStore } from '../store/LossReportStore';
import { ensureCloakSession } from '../session/ensureCloakSession';
import { isCloakCookieComplete, jwtExpiryMs, readCloakTokens } from '../session/cloakCookies';
import { runNlLoss } from '../services/nlLossRunner';
import { runSlpLoss } from '../services/slpLossRunner';

type Ctx = Context<{ Bindings: Env }>;

export async function healthHandler(c: Ctx) {
  return c.json({ ok: true, service: 'nl-loss-cloak-worker' });
}

/** Session health for both portals. Never returns cookie values. */
export async function statusHandler(c: Ctx) {
  const cloakStore = createCloakSessionStore(c.env);
  const [cloak, cloakLogin, workforce] = await Promise.all([
    cloakStore.getActive(),
    cloakStore.getLoginState(),
    createWorkforceSessionStore(c.env).getActive(DEFAULT_PORTAL_ACCOUNT),
  ]);
  const tokens = cloak ? readCloakTokens(cloak.cookie, cloakCognitoClientId(c.env)) : null;
  const reports = new LossReportStore(createDashboardSupabase(c.env));
  const [nl, slpInitial, slpFinal] = await Promise.all([
    reports.latest('nl'),
    reports.latest('slp_initial'),
    reports.latest('slp_final'),
  ]);
  return c.json({
    cloak: {
      hasSession: Boolean(cloak),
      uploadedAt: cloak?.uploadedAt ?? null,
      uploadedBy: cloak?.uploadedBy ?? null,
      accessTokenExpiresAt: tokens?.accessToken ? new Date(jwtExpiryMs(tokens.accessToken)).toISOString() : null,
      hasRefreshToken: Boolean(tokens?.refreshToken),
      credentialsConfigured: Boolean(c.env.CLOAK_EMAIL && c.env.CLOAK_PASSWORD),
      ...cloakLogin,
    },
    workforce: { sharedSession: Boolean(workforce), uploadedAt: workforce?.uploadedAt ?? null, uploadedBy: workforce?.uploadedBy ?? null },
    latestRuns: { nl, slpInitial, slpFinal },
  });
}

/** Manual cookie upload (e.g. when Cloak asks for OTP). Body: { cookie, uploadedBy? }. */
export async function uploadCloakSessionHandler(c: Ctx) {
  const body = (await c.req.json().catch(() => ({}))) as { cookie?: string; uploadedBy?: string };
  const cookie = String(body.cookie ?? '').trim().replace(/^cookie:\s*/i, '');
  if (!isCloakCookieComplete(cookie, cloakCognitoClientId(c.env))) {
    throw new ValidationInputError('Cookie must include the CognitoIdentityServiceProvider accessToken and idToken.', 'INVALID_COOKIE');
  }
  const stored = await createCloakSessionStore(c.env).upload(cookie, String(body.uploadedBy ?? 'admin-upload').slice(0, 120));
  return c.json({ ok: true, sessionId: stored.id, uploadedAt: stored.uploadedAt });
}

export async function ensureCloakSessionHandler(c: Ctx) {
  const force = c.req.query('force') === '1';
  const result = await ensureCloakSession(c.env, { triggeredBy: 'admin-ensure', forceRelogin: force });
  if (!result.ok) return c.json(result, 502);
  return c.json({ ok: true, sessionId: result.sessionId, source: result.source });
}

export async function runNlHandler(c: Ctx) {
  const result = await runNlLoss(c.env, 'admin');
  return c.json(result, result.ok ? 200 : 502);
}

export async function runSlpHandler(c: Ctx) {
  const result = await runSlpLoss(c.env, 'admin');
  return c.json(result, result.ok ? 200 : 502);
}
