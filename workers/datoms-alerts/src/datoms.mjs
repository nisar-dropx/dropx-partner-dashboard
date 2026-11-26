import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";

const API_BASE = "https://app.datoms.io/-/api/iot-platform/v1.1.0";
const SESSION_KV_KEY = "datoms:session:v1";
const LOGIN_BACKOFF_KV_KEY = "datoms:login_backoff";
/** Keep session across cron ticks; Datoms tokens typically last hours. */
const SESSION_TTL_SEC = 6 * 60 * 60;
/** After TOO_MANY_REQUESTS / 429, do not hit /accounts/login again for this long. */
const LOGIN_BACKOFF_SEC = 20 * 60;

/** Datoms rejects bare Worker fetches with LOGIN_CLIENT_NOT_ALLOWED without browser-like headers. */
const BROWSER_HEADERS = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "accept-language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
  "content-type": "application/json",
  origin: "https://app.datoms.io",
  referer: "https://app.datoms.io/accounts/login?rd=https://app.datoms.io/",
  "sec-ch-ua": '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
  "x-requested-with": "XMLHttpRequest"
};

function pickToken(body) {
  return (
    body?.auth_token
    ?? body?.session_id
    ?? body?.token
    ?? body?.data?.auth_token
    ?? body?.data?.session_id
    ?? null
  );
}

function isRateLimited(error) {
  const msg = String(error?.message ?? error ?? "");
  return /\b429\b|too\s*many\s*requests|rate\s*limit|TOO_MANY/i.test(msg);
}

function isAuthFailure(error) {
  const msg = String(error?.message ?? error ?? "");
  return /\b401\b|\b403\b|unauthorized|auth[_ ]?token|session\s*(expired|invalid)|LOGIN_/i.test(msg)
    && !isRateLimited(error);
}

async function jsonFetch(url, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...BROWSER_HEADERS, ...headers },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.message ?? data?.error ?? data?.code ?? text?.slice(0, 200) ?? res.statusText;
    throw new Error(`Datoms ${method} ${url}: ${res.status} ${msg}`);
  }
  return data;
}

async function mintDpop(privateKey, method, url) {
  const u = new URL(url);
  const htu = `${u.origin}${u.pathname}`;
  return new SignJWT({ htm: method.toUpperCase(), htu })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: await exportJWK(privateKey) })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

/**
 * @param {{
 *   email: string,
 *   password: string,
 *   customerId: string,
 *   applicationId: string,
 *   kv?: { get: Function, put: Function, delete: Function } | null
 * }} cfg
 */
export class DatomsClient {
  constructor(cfg) {
    this.email = cfg.email;
    this.password = cfg.password;
    this.customerId = String(cfg.customerId);
    this.applicationId = String(cfg.applicationId);
    this.kv = cfg.kv ?? null;
    this.authToken = null;
    this.privateKey = null;
    this.publicJwk = null;
    this.privateKeyJwk = null;
  }

  sessionFingerprint() {
    return String(this.email || "").trim().toLowerCase();
  }

  async readBackoffUntil() {
    if (!this.kv) return 0;
    const raw = await this.kv.get(LOGIN_BACKOFF_KV_KEY, "json");
    const until = Number(raw?.untilMs ?? 0);
    return Number.isFinite(until) ? until : 0;
  }

  async writeLoginBackoff(reason) {
    if (!this.kv) return;
    const untilMs = Date.now() + LOGIN_BACKOFF_SEC * 1000;
    await this.kv.put(
      LOGIN_BACKOFF_KV_KEY,
      JSON.stringify({ untilMs, reason: String(reason ?? "").slice(0, 200), at: new Date().toISOString() }),
      { expirationTtl: LOGIN_BACKOFF_SEC + 60 }
    );
  }

  async clearLoginBackoff() {
    if (!this.kv) return;
    try {
      await this.kv.delete(LOGIN_BACKOFF_KV_KEY);
    } catch {
      /* ignore */
    }
  }

  async loadPersistedSession() {
    const cached = globalThis.__datomsCache;
    if (cached?.authToken && cached?.privateKeyJwk && cached?.email === this.sessionFingerprint()) {
      return cached;
    }
    if (!this.kv) return null;
    const row = await this.kv.get(SESSION_KV_KEY, "json");
    if (!row?.authToken || !row?.privateKeyJwk) return null;
    if (row.email && row.email !== this.sessionFingerprint()) return null;
    return row;
  }

  async applySession(row) {
    this.authToken = row.authToken;
    this.privateKeyJwk = row.privateKeyJwk;
    this.publicJwk = row.publicJwk ?? null;
    this.privateKey = await importJWK(row.privateKeyJwk, "ES256");
    globalThis.__datomsCache = {
      email: this.sessionFingerprint(),
      authToken: this.authToken,
      privateKeyJwk: this.privateKeyJwk,
      publicJwk: this.publicJwk
    };
  }

  async persistSession() {
    const row = {
      email: this.sessionFingerprint(),
      authToken: this.authToken,
      privateKeyJwk: this.privateKeyJwk,
      publicJwk: this.publicJwk,
      savedAt: new Date().toISOString()
    };
    globalThis.__datomsCache = row;
    if (this.kv) {
      await this.kv.put(SESSION_KV_KEY, JSON.stringify(row), { expirationTtl: SESSION_TTL_SEC });
    }
  }

  async clearSession() {
    this.authToken = null;
    this.privateKey = null;
    this.publicJwk = null;
    this.privateKeyJwk = null;
    globalThis.__datomsCache = null;
    if (this.kv) {
      try {
        await this.kv.delete(SESSION_KV_KEY);
      } catch {
        /* ignore */
      }
    }
  }

  async loginAndBind() {
    const backoffUntil = await this.readBackoffUntil();
    if (backoffUntil > Date.now()) {
      const waitMin = Math.ceil((backoffUntil - Date.now()) / 60000);
      throw new Error(
        `Datoms login backed off for ~${waitMin}m after rate limiting. Wait, then retry. Do not hammer /accounts/login.`
      );
    }

    const loginBody = {
      email_id: this.email,
      // Datoms expects the account password in plaintext — not a local hash.
      password: this.password,
      source: "website",
      source_id: 1,
      target: "https://app.datoms.io/"
    };

    let login;
    try {
      login = await jsonFetch(`${API_BASE}/accounts/login`, {
        method: "POST",
        body: loginBody
      });
    } catch (error) {
      if (isRateLimited(error)) {
        await this.writeLoginBackoff(error.message);
      }
      throw error;
    }

    this.authToken = pickToken(login);
    if (!this.authToken) throw new Error("Datoms login returned no auth token");

    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    this.privateKey = privateKey;
    const rawPublic = await exportJWK(publicKey);
    this.publicJwk = {
      crv: rawPublic.crv,
      ext: true,
      key_ops: [],
      kty: rawPublic.kty,
      x: rawPublic.x,
      y: rawPublic.y
    };
    this.privateKeyJwk = await exportJWK(privateKey);

    const challengeUrl = `${API_BASE}/accounts/bind/challenge`;
    const challengeDpop = await mintDpop(privateKey, "GET", challengeUrl);
    const challenge = await jsonFetch(challengeUrl, {
      headers: { auth_token: this.authToken, dpop: challengeDpop }
    });
    const bindNonce =
      challenge?.bindNonce
      ?? challenge?.bind_nonce
      ?? challenge?.nonce
      ?? challenge?.data?.bindNonce;
    if (!bindNonce) throw new Error("Datoms bind challenge returned no bindNonce");

    const bindUrl = `${API_BASE}/accounts/bind`;
    const bindDpop = await mintDpop(privateKey, "POST", bindUrl);
    await jsonFetch(bindUrl, {
      method: "POST",
      headers: { auth_token: this.authToken, dpop: bindDpop },
      body: { jwk: this.publicJwk, bindNonce }
    });

    await this.clearLoginBackoff();
    await this.persistSession();
  }

  async ensureSession({ forceLogin = false } = {}) {
    if (!forceLogin && this.authToken && this.privateKey) return;

    if (!forceLogin) {
      const row = await this.loadPersistedSession();
      if (row) {
        await this.applySession(row);
        return;
      }
    }

    await this.loginAndBind();
  }

  async authedFetch(path, { method = "GET", query = {} } = {}) {
    await this.ensureSession();
    const run = async () => {
      const u = new URL(`${API_BASE}${path}`);
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== "") u.searchParams.set(k, String(v));
      }
      const dpop = await mintDpop(this.privateKey, method, u.toString());
      return jsonFetch(u.toString(), {
        method,
        headers: { auth_token: this.authToken, dpop }
      });
    };

    try {
      return await run();
    } catch (error) {
      if (!isAuthFailure(error)) throw error;
      // Stale KV session — clear and login once.
      await this.clearSession();
      await this.ensureSession({ forceLogin: true });
      return run();
    }
  }

  async fetchEvents({ generatedAfter, generatedBefore } = {}) {
    const path = `/customers/${this.customerId}/applications/${this.applicationId}/events`;
    const data = await this.authedFetch(path, {
      query: {
        get_details: "true",
        generated_after: generatedAfter ?? "",
        generated_before: generatedBefore ?? ""
      }
    });
    const list =
      data?.events
      ?? data?.data?.events
      ?? data?.data
      ?? (Array.isArray(data) ? data : []);
    return Array.isArray(list) ? list : [];
  }

  /** Health / debug helpers for operators. */
  async sessionStatus() {
    const row = await this.loadPersistedSession();
    const backoffUntil = await this.readBackoffUntil();
    return {
      has_memory_session: Boolean(globalThis.__datomsCache?.authToken),
      has_kv_session: Boolean(row?.authToken),
      session_email: row?.email ?? globalThis.__datomsCache?.email ?? null,
      saved_at: row?.savedAt ?? null,
      login_backoff_until: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null
    };
  }
}

export const datomsAuthInternals = {
  SESSION_KV_KEY,
  LOGIN_BACKOFF_KV_KEY,
  SESSION_TTL_SEC,
  LOGIN_BACKOFF_SEC,
  isRateLimited,
  isAuthFailure,
  pickToken
};
