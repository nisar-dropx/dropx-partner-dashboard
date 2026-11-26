import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";

const API_BASE = "https://app.datoms.io/-/api/iot-platform/v1.1.0";
const SESSION_KV_KEY = "datoms:session:v1";
const LOGIN_BACKOFF_KV_KEY = "datoms:login_backoff";
/** KV is a short cache only; durable truth lives in Supabase ds_datoms_session. */
const SESSION_KV_TTL_SEC = 6 * 60 * 60;
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
 *   companyId?: string,
 *   kv?: { get: Function, put: Function, delete: Function } | null,
 *   supabase?: { url: string, serviceKey: string } | null
 * }} cfg
 */
export class DatomsClient {
  constructor(cfg) {
    this.email = cfg.email;
    this.password = cfg.password;
    this.customerId = String(cfg.customerId);
    this.applicationId = String(cfg.applicationId);
    this.companyId = String(cfg.companyId || "").trim() || null;
    this.kv = cfg.kv ?? null;
    this.supabase = cfg.supabase?.url && cfg.supabase?.serviceKey
      ? {
          url: String(cfg.supabase.url).replace(/\/$/, ""),
          serviceKey: String(cfg.supabase.serviceKey)
        }
      : null;
    this.authToken = null;
    this.privateKey = null;
    this.publicJwk = null;
    this.privateKeyJwk = null;
  }

  sbHeaders(extra = {}) {
    if (!this.supabase) return null;
    return {
      apikey: this.supabase.serviceKey,
      Authorization: `Bearer ${this.supabase.serviceKey}`,
      "Content-Type": "application/json",
      ...extra
    };
  }

  sessionFingerprint() {
    return String(this.email || "").trim().toLowerCase();
  }

  async readBackoffUntil() {
    if (this.kv) {
      const raw = await this.kv.get(LOGIN_BACKOFF_KV_KEY, "json");
      const until = Number(raw?.untilMs ?? 0);
      if (Number.isFinite(until) && until > Date.now()) return until;
    }
    const headers = this.sbHeaders();
    if (!headers || !this.companyId) return 0;
    const qs = new URLSearchParams({
      company_id: `eq.${this.companyId}`,
      select: "login_backoff_until",
      limit: "1"
    });
    const res = await fetch(`${this.supabase.url}/rest/v1/ds_datoms_session?${qs}`, { headers });
    if (!res.ok) return 0;
    const rows = await res.json().catch(() => []);
    const iso = rows?.[0]?.login_backoff_until;
    const ms = iso ? Date.parse(iso) : 0;
    return Number.isFinite(ms) ? ms : 0;
  }

  async writeLoginBackoff(reason) {
    const untilMs = Date.now() + LOGIN_BACKOFF_SEC * 1000;
    const reasonText = String(reason ?? "").slice(0, 200);
    if (this.kv) {
      await this.kv.put(
        LOGIN_BACKOFF_KV_KEY,
        JSON.stringify({ untilMs, reason: reasonText, at: new Date().toISOString() }),
        { expirationTtl: LOGIN_BACKOFF_SEC + 60 }
      );
    }
    // Patch backoff only — never overwrite a good token with placeholders.
    const headers = this.sbHeaders({ Prefer: "return=minimal" });
    if (!headers || !this.companyId) return;
    await fetch(
      `${this.supabase.url}/rest/v1/ds_datoms_session?company_id=eq.${this.companyId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          login_backoff_until: new Date(untilMs).toISOString(),
          login_backoff_reason: reasonText,
          updated_at: new Date().toISOString()
        })
      }
    ).catch(() => null);
  }

  async clearLoginBackoff() {
    if (this.kv) {
      try {
        await this.kv.delete(LOGIN_BACKOFF_KV_KEY);
      } catch {
        /* ignore */
      }
    }
    const headers = this.sbHeaders({ Prefer: "return=minimal" });
    if (!headers || !this.companyId) return;
    await fetch(
      `${this.supabase.url}/rest/v1/ds_datoms_session?company_id=eq.${this.companyId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          login_backoff_until: null,
          login_backoff_reason: null,
          updated_at: new Date().toISOString()
        })
      }
    ).catch(() => null);
  }

  async loadSessionFromSupabase() {
    const headers = this.sbHeaders();
    if (!headers || !this.companyId) return null;
    const qs = new URLSearchParams({
      company_id: `eq.${this.companyId}`,
      select: "email,auth_token,private_key_jwk,public_jwk,saved_at,login_backoff_until",
      limit: "1"
    });
    const res = await fetch(`${this.supabase.url}/rest/v1/ds_datoms_session?${qs}`, { headers });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const row = rows?.[0];
    if (!row?.auth_token || !row?.private_key_jwk || row.auth_token === "backoff") return null;
    if (row.email && String(row.email).toLowerCase() !== this.sessionFingerprint()) return null;
    return {
      email: String(row.email || this.sessionFingerprint()),
      authToken: row.auth_token,
      privateKeyJwk: row.private_key_jwk,
      publicJwk: row.public_jwk ?? null,
      savedAt: row.saved_at ?? null
    };
  }

  async loadPersistedSession() {
    const cached = globalThis.__datomsCache;
    if (cached?.authToken && cached?.privateKeyJwk && cached?.email === this.sessionFingerprint()) {
      return cached;
    }
    if (this.kv) {
      const row = await this.kv.get(SESSION_KV_KEY, "json");
      if (row?.authToken && row?.privateKeyJwk && (!row.email || row.email === this.sessionFingerprint())) {
        return row;
      }
    }
    return this.loadSessionFromSupabase();
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
      publicJwk: this.publicJwk,
      savedAt: row.savedAt ?? null
    };
  }

  async persistSession() {
    const savedAt = new Date().toISOString();
    const row = {
      email: this.sessionFingerprint(),
      authToken: this.authToken,
      privateKeyJwk: this.privateKeyJwk,
      publicJwk: this.publicJwk,
      savedAt
    };
    globalThis.__datomsCache = row;
    if (this.kv) {
      await this.kv.put(SESSION_KV_KEY, JSON.stringify(row), { expirationTtl: SESSION_KV_TTL_SEC });
    }
    const headers = this.sbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" });
    if (!headers || !this.companyId) return;
    const res = await fetch(`${this.supabase.url}/rest/v1/ds_datoms_session?on_conflict=company_id`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        company_id: this.companyId,
        email: row.email,
        auth_token: row.authToken,
        private_key_jwk: row.privateKeyJwk,
        public_jwk: row.publicJwk,
        login_backoff_until: null,
        login_backoff_reason: null,
        saved_at: savedAt,
        updated_at: savedAt
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[datoms] supabase session upsert failed:", res.status, body.slice(0, 200));
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
    const headers = this.sbHeaders({ Prefer: "return=minimal" });
    if (!headers || !this.companyId) return;
    await fetch(
      `${this.supabase.url}/rest/v1/ds_datoms_session?company_id=eq.${this.companyId}`,
      { method: "DELETE", headers }
    ).catch(() => null);
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
    const memory = globalThis.__datomsCache;
    let kv = null;
    if (this.kv) kv = await this.kv.get(SESSION_KV_KEY, "json");
    const sb = await this.loadSessionFromSupabase();
    const backoffUntil = await this.readBackoffUntil();
    const row = memory?.authToken ? memory : kv?.authToken ? kv : sb;
    return {
      has_memory_session: Boolean(memory?.authToken),
      has_kv_session: Boolean(kv?.authToken),
      has_supabase_session: Boolean(sb?.authToken),
      session_email: row?.email ?? null,
      saved_at: row?.savedAt ?? sb?.savedAt ?? null,
      login_backoff_until: backoffUntil > Date.now() ? new Date(backoffUntil).toISOString() : null
    };
  }
}

export const datomsAuthInternals = {
  SESSION_KV_KEY,
  LOGIN_BACKOFF_KV_KEY,
  SESSION_KV_TTL_SEC,
  LOGIN_BACKOFF_SEC,
  isRateLimited,
  isAuthFailure,
  pickToken
};
