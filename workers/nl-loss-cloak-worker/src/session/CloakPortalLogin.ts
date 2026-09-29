import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer';
import type { CloakAuthContext, Env } from '../types';
import { cloakBaseUrl, cloakCognitoClientId } from '../config';
import { CACHE_ERROR_RE, isCloakCookieComplete } from './cloakCookies';

const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_CACHE_RESETS = 2;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export type CloakLoginResult =
  | { ok: true; auth: CloakAuthContext; cacheResets: number }
  | {
      ok: false;
      error: string;
      code: 'LOGIN_FAILED' | 'MFA_REQUIRED' | 'CAPTURE_TIMEOUT' | 'BROWSER_ERROR' | 'CACHE_ERROR';
    };

/**
 * Headless login to cloak.tech.amazon.dev (Cognito hosted UI) via Cloudflare
 * Browser Rendering.
 *
 * 1. Open Cloak → redirected to the Cognito login page.
 * 2. Fill email + password (single-page or two-step form), submit.
 * 3. Back on Cloak with ?code=… — the app exchanges it and sets Cognito cookies.
 * 4. If Cloak shows a cache error at any point: clear browser cache, cookies,
 *    and all origin storage, reload, and log in again (max 2 resets).
 */
export async function loginAndCaptureCloakSession(
  env: Env,
  input: { email: string; password: string },
): Promise<CloakLoginResult> {
  if (!env.BROWSER) {
    return {
      ok: false,
      code: 'BROWSER_ERROR',
      error: 'BROWSER binding unavailable. Use `npm run dev` (remote browser) or deploy, or upload cookies via PUT /api/admin/cloak/session.',
    };
  }

  const baseUrl = cloakBaseUrl(env);
  const clientId = cloakCognitoClientId(env);
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1440, height: 900 });

    for (let resets = 0; resets <= MAX_CACHE_RESETS; resets++) {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2', timeout: 60_000 });

      if (await hasCacheError(page)) {
        await clearAllSiteData(page, baseUrl);
        continue;
      }

      if (!isOnCloak(page, baseUrl) || (await findVisible(page, USERNAME_SEL))) {
        await openLoginIfNeeded(page);
        const signedIn = await fillCognitoLogin(page, input.email, input.password);
        if (!signedIn.ok) return signedIn;
      }

      const captured = await waitForCookies(page, baseUrl, clientId);
      if (captured === 'cache_error') {
        await clearAllSiteData(page, baseUrl);
        continue;
      }
      if (captured) return { ok: true, auth: { cookie: captured }, cacheResets: resets };
      return {
        ok: false,
        code: 'CAPTURE_TIMEOUT',
        error: 'Logged in but Cloak never set Cognito access/id token cookies.',
      };
    }

    return {
      ok: false,
      code: 'CACHE_ERROR',
      error: `Cloak kept showing a cache error after ${MAX_CACHE_RESETS} full clear + refresh attempts.`,
    };
  } catch (err) {
    return { ok: false, code: 'BROWSER_ERROR', error: `Cloak browser automation failed: ${(err as Error).message}` };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

const USERNAME_SEL = 'input[name="username"], input[name="email"], input[type="email"], input#signInFormUsername';
const PASSWORD_SEL = 'input[name="password"], input[type="password"], input#signInFormPassword';
const SUBMIT_SEL =
  'input[name="signInSubmitButton"], button[name="signInSubmitButton"], button[type="submit"], input[type="submit"]';

function isOnCloak(page: Page, baseUrl: string): boolean {
  return page.url().startsWith(baseUrl);
}

async function hasCacheError(page: Page): Promise<boolean> {
  const text = await page
    .evaluate(() => (globalThis as unknown as { document: { body?: { innerText?: string } } }).document.body?.innerText ?? '')
    .catch(() => '');
  return CACHE_ERROR_RE.test(text);
}

/** "Clear all cached data": HTTP cache, cookies, and every storage type for the origins. */
async function clearAllSiteData(page: Page, baseUrl: string): Promise<void> {
  console.warn('cloak: cache error detected — clearing all site data and refreshing');
  const client = await page.createCDPSession();
  await client.send('Network.clearBrowserCache').catch(() => undefined);
  await client.send('Network.clearBrowserCookies').catch(() => undefined);
  const origins = new Set([baseUrl, new URL(page.url()).origin]);
  for (const origin of origins) {
    await client
      .send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
      .catch(() => undefined);
  }
  await page
    .evaluate(() => {
      const g = globalThis as unknown as {
        localStorage?: { clear(): void };
        sessionStorage?: { clear(): void };
        caches?: { keys(): Promise<string[]>; delete(k: string): Promise<boolean> };
      };
      try { g.localStorage?.clear(); } catch { /* ignore */ }
      try { g.sessionStorage?.clear(); } catch { /* ignore */ }
      return g.caches?.keys().then((keys) => Promise.all(keys.map((k) => g.caches!.delete(k))));
    })
    .catch(() => undefined);
}

async function findVisible(page: Page, selector: string) {
  for (const el of await page.$$(selector)) {
    const visible = await page
      .evaluate((node) => {
        const n = node as unknown as { offsetParent: unknown; getClientRects(): { length: number } };
        return n.offsetParent !== null && n.getClientRects().length > 0;
      }, el)
      .catch(() => false);
    if (visible) return el;
  }
  return null;
}

/** Some landing pages show a "Sign in" / partner button before the Cognito form. */
async function openLoginIfNeeded(page: Page): Promise<void> {
  if (await findVisible(page, USERNAME_SEL)) return;
  const clicked = await page
    .evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(s: string): ArrayLike<{ innerText?: string; click(): void }> } }).document;
      const nodes = Array.from(doc.querySelectorAll('button, a'));
      const target = nodes.find((n) => /sign\s*in|log\s*in|partner|external|email/i.test(n.innerText ?? ''));
      if (target) target.click();
      return Boolean(target);
    })
    .catch(() => false);
  if (clicked) await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 }).catch(() => null);
}

async function fillCognitoLogin(
  page: Page,
  email: string,
  password: string,
): Promise<{ ok: true } | CloakLoginResult> {
  await page.waitForSelector(USERNAME_SEL, { timeout: 30_000 }).catch(() => null);
  const user = await findVisible(page, USERNAME_SEL);
  if (!user) {
    return { ok: false, code: 'LOGIN_FAILED', error: `Cloak login form not found (url=${page.url().slice(0, 120)}).` };
  }
  await user.click({ clickCount: 3 });
  await user.type(email, { delay: 25 });

  // Two-step (managed login): username → Next → password.
  let pass = await findVisible(page, PASSWORD_SEL);
  if (!pass) {
    const next = await findVisible(page, SUBMIT_SEL);
    if (next) await next.click();
    else await page.keyboard.press('Enter');
    await page.waitForSelector(PASSWORD_SEL, { visible: true, timeout: 30_000 }).catch(() => null);
    pass = await findVisible(page, PASSWORD_SEL);
  }
  if (!pass) return { ok: false, code: 'LOGIN_FAILED', error: 'Cloak password field did not appear.' };
  await pass.click({ clickCount: 3 });
  await pass.type(password, { delay: 25 });

  const submit = await findVisible(page, SUBMIT_SEL);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => null),
    submit ? submit.click() : page.keyboard.press('Enter'),
  ]);
  await sleep(1500);

  if (await findVisible(page, 'input[name="code"], input[name="otp"], input[autocomplete="one-time-code"]')) {
    return {
      ok: false,
      code: 'MFA_REQUIRED',
      error: 'Cloak asked for an OTP/MFA code. Upload cookies via PUT /api/admin/cloak/session; the worker will keep them alive with the refresh token.',
    };
  }
  if (await findVisible(page, PASSWORD_SEL)) {
    const msg = await page
      .$eval('#loginErrorMessage, .error, [role="alert"]', (el) => (el as unknown as { textContent?: string }).textContent?.trim() ?? '')
      .catch(() => '');
    return { ok: false, code: 'LOGIN_FAILED', error: msg ? `Cloak rejected login: ${msg}` : 'Still on Cloak login page after submit. Check CLOAK_EMAIL / CLOAK_PASSWORD.' };
  }
  return { ok: true };
}

async function waitForCookies(page: Page, baseUrl: string, clientId: string): Promise<string | 'cache_error' | null> {
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await hasCacheError(page)) return 'cache_error';
    const cookie = await collectCookieHeader(page, baseUrl);
    if (isCloakCookieComplete(cookie, clientId)) return cookie;
    await sleep(1500);
  }
  return null;
}

async function collectCookieHeader(page: Page, baseUrl: string): Promise<string> {
  const host = new URL(baseUrl).hostname;
  try {
    const client = await page.createCDPSession();
    const result = (await client.send('Network.getAllCookies')) as {
      cookies: Array<{ name: string; value: string; domain: string }>;
    };
    return result.cookies
      .filter((c) => host.endsWith(c.domain.replace(/^\./, '')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    const cookies = await page.cookies(baseUrl);
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
