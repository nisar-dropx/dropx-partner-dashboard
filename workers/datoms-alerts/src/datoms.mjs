import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";

const API_BASE = "https://app.datoms.io/-/api/iot-platform/v1.1.0";

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
    const msg = data?.message ?? data?.error ?? text?.slice(0, 200) ?? res.statusText;
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

export class DatomsClient {
  /** @param {{ email: string, password: string, customerId: string, applicationId: string }} cfg */
  constructor(cfg) {
    this.email = cfg.email;
    this.password = cfg.password;
    this.customerId = String(cfg.customerId);
    this.applicationId = String(cfg.applicationId);
    this.authToken = null;
    this.privateKey = null;
    this.publicJwk = null;
  }

  async ensureSession() {
    if (this.authToken && this.privateKey) return;
    const cached = globalThis.__datomsCache;
    if (cached?.authToken && cached?.privateKeyJwk) {
      this.authToken = cached.authToken;
      this.privateKey = await importJWK(cached.privateKeyJwk, "ES256");
      this.publicJwk = cached.publicJwk;
      return;
    }

    // HAR-captured website login (source_id is numeric 1, not "web").
    const loginBody = {
      email_id: this.email,
      password: this.password,
      source: "website",
      source_id: 1,
      target: "https://app.datoms.io/"
    };
    const login = await jsonFetch(`${API_BASE}/accounts/login`, {
      method: "POST",
      body: loginBody
    });
    this.authToken = pickToken(login);
    if (!this.authToken) throw new Error("Datoms login returned no auth token");

    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    this.privateKey = privateKey;
    const rawPublic = await exportJWK(publicKey);
    // HAR shape: { crv, ext, key_ops: [], kty, x, y } — no alg; field name is `jwk` not `key`.
    this.publicJwk = {
      crv: rawPublic.crv,
      ext: true,
      key_ops: [],
      kty: rawPublic.kty,
      x: rawPublic.x,
      y: rawPublic.y
    };
    const privateJwk = await exportJWK(privateKey);

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
    const bindBody = {
      jwk: this.publicJwk,
      bindNonce
    };
    const bindDpop = await mintDpop(privateKey, "POST", bindUrl);
    await jsonFetch(bindUrl, {
      method: "POST",
      headers: { auth_token: this.authToken, dpop: bindDpop },
      body: bindBody
    });

    globalThis.__datomsCache = {
      authToken: this.authToken,
      privateKeyJwk: privateJwk,
      publicJwk: this.publicJwk
    };
  }

  async authedFetch(path, { method = "GET", query = {} } = {}) {
    await this.ensureSession();
    const u = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== "") u.searchParams.set(k, String(v));
    }
    const dpop = await mintDpop(this.privateKey, method, u.toString());
    return jsonFetch(u.toString(), {
      method,
      headers: { auth_token: this.authToken, dpop }
    });
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
}