import "server-only";
import crypto from "node:crypto";

/**
 * Parivahan NextGen e-Challan client (public citizen "Check Status" flow).
 *
 * Verified live flow (no OTP needed to READ outstanding challans):
 *   1. GET  /challan                              warm-up (served HTML, sets up origin)
 *   2. POST /euser/init/captchaGenerating         -> { captchaId, captchaImage(base64 PNG) }
 *   3. POST /ecitizen/initcitz/citzreg            device register (captcha) -> { deviceId, jwk }
 *   4. POST /euser/init/captchaGenerating         fresh captcha
 *   5. POST /ecitizen/initcitz/challan-search     { data:{ vehicleNo, rcDate, purpose:"A" } }
 *                                                  + RSA-wrapped session AES key -> OTP001 + sessionId
 *   6. POST /ecitizen/citizentrans/v1/get-challan-details
 *                                                  { data:{ docNo, rcDate, searchBy:"RC" } }
 *                                                  (session-AES encrypted) -> CTZ001 + challan[]
 *   7. POST /edms/wapidms/viewBulk/ChallanDocs    { challanDocList:[{challanNo}] } (plaintext)
 *                                                  -> image base64 or fileToUpload URL
 *
 * Request rules learnt from the portal bundle:
 *   - Bodies AES-256-GCM encrypted under a static key, wrapped as { payload: base64(iv|ct|tag) }.
 *   - Every API call carries a FULL browser header set (sec-ch-ua / Sec-Fetch-* / Accept-Encoding),
 *     otherwise citzreg is rejected with "Browser request validation failed".
 *   - Signed headers X001 (ms ts), X002 (uuid_deviceId_ts), X003 = sha256hex(method|path|X001|X002|body).
 *   - RC registration date is validated (wrong date => CTZ013); it must come from the vehicle master.
 *
 * This reads only publicly checkable status for the fleet's OWN vehicles. No payment is initiated.
 */

const BASE = "https://echallan.parivahan.nic.in";
const STATIC_KEY = Buffer.from("w7H1ZyG1YvKuj5xM9jA9Z5qUqZVqK6s8l8YjA2zvZ6g=", "base64");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const EVIDENCE_HOST_ALLOW = /^https:\/\/echallan\.parivahan\.(gov|nic)\.in\//i;

export type ParivahanOffence = {
  offenceName: string;
  mva: string;
  offenceId: number | null;
};

export type ParivahanChallan = {
  challanNo: string;
  challanDocNo: string;
  challanDate: string | null;
  amount: number;
  stateCode: string;
  paymentStatus: string;
  accusedName: string;
  challanPlace: string;
  offences: ParivahanOffence[];
  offenceSummary: string;
  challanSource: number | null;
};

export type ParivahanEvidence = {
  challanNo: string;
  /** Either an https URL (stream later) or inline bytes already decoded from base64. */
  sourceUrl: string | null;
  inlineBytes: Uint8Array | null;
  fileExt: string;
};

export type ParivahanPullResult = {
  vehicleNo: string;
  ok: boolean;
  statusCode: string;
  statusDesc: string;
  challans: ParivahanChallan[];
};

export class ParivahanError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ParivahanError";
  }
}

const clean = (v: unknown) => String(v ?? "").trim();

function encryptBody(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}

function decryptBody(payloadB64: string, key: Buffer): string {
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const rest = buf.subarray(12);
  const tag = rest.subarray(rest.length - 16);
  const ct = rest.subarray(0, rest.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

const sha256Hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Full browser header set — required or the portal rejects with "Browser request validation failed". */
function baseHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "application/json",
    Origin: BASE,
    Referer: `${BASE}/challan`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": UA,
    "sec-ch-ua": '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    ...extra,
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

/** Simple cookie jar across the session. */
class Jar {
  private map = new Map<string, string>();
  absorb(res: Response) {
    const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
    const list =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie") as string]
          : [];
    for (const c of list) {
      const [k, ...r] = String(c).split(";")[0].split("=");
      if (k) this.map.set(k, r.join("="));
    }
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function deviceInfo() {
  const screen = { width: 1536, height: 864, pixelDepth: 24 };
  const reqJson = JSON.stringify({
    userAgent: UA,
    platform: "Win32",
    vendor: "Google Inc.",
    language: "en-IN",
    screen,
    timezone: "Asia/Calcutta",
    deviceMemory: 16,
    hardwareConcurrency: 16,
    timestamp: new Date().toISOString(),
  });
  return {
    fingerprint: "sha256:" + sha256Hex(reqJson).slice(0, 8),
    deviceName: "Win32",
    os: "Windows",
    osVersion: "10.0",
    appVersion: "2.5.1",
    model: "Win32",
    reqJson,
  };
}

function wrapAesKeyRsa(aesRaw: Buffer, jwk: { kty: string; n: string; e: string }): string {
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  return crypto
    .publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesRaw)
    .toString("base64");
}

/** Normalise a stored registration date into the DD/MM/YYYY the portal expects. */
export function toParivahanRcDate(value: string | null | undefined): string | null {
  const raw = clean(value);
  if (!raw) return null;
  // Already DD/MM/YYYY or DD-MM-YYYY
  const dmy = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  // ISO yyyy-mm-dd (optionally with time)
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return null;
}

type CaptchaSolver = (pngBytes: Uint8Array) => Promise<string>;

export class ParivahanChallanClient {
  private jar = new Jar();
  private uRefId = "";
  private solve: CaptchaSolver;
  private maxCaptcha: number;

  constructor(opts: { captchaSolver: CaptchaSolver; maxCaptchaAttempts?: number }) {
    this.solve = opts.captchaSolver;
    this.maxCaptcha = Math.max(1, opts.maxCaptchaAttempts ?? 12);
  }

  private async call<T = any>(
    apiPath: string,
    bodyObj: unknown,
    opts: { key?: Buffer; extraHeaders?: Record<string, string>; plaintext?: boolean } = {}
  ): Promise<T> {
    const key = opts.key ?? STATIC_KEY;
    // Most endpoints encrypt the body; a few (e.g. ChallanDocs) take raw JSON.
    const bodyStr =
      bodyObj == null
        ? ""
        : opts.plaintext
          ? JSON.stringify(bodyObj)
          : JSON.stringify({ payload: encryptBody(JSON.stringify(bodyObj), key) });
    const ts = Date.now().toString();
    const nonce = `${crypto.randomUUID()}_${this.uRefId}_${ts}`;
    const urlPath = new URL(`${BASE}${apiPath}`).pathname;
    const x003 = sha256Hex(["POST", urlPath, ts, nonce, bodyStr].join("|"));
    const encHeaders: Record<string, string> = opts.plaintext
      ? {}
      : { "X-Body-Encrypted": "echallan", "X-Response-Encrypted": "echallan" };
    const headers = baseHeaders(this.jar.header(), {
      X001: ts,
      X002: nonce,
      X003: x003,
      ...encHeaders,
      ...(opts.extraHeaders ?? {}),
    });
    const res = await fetch(`${BASE}${apiPath}`, {
      method: "POST",
      headers,
      body: bodyStr || undefined,
      cache: "no-store",
    });
    this.jar.absorb(res);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ParivahanError("HTTP", `Non-JSON response (${res.status}) from ${apiPath}`);
    }
    if (json && typeof json.payload === "string") {
      try {
        return JSON.parse(decryptBody(json.payload, key)) as T;
      } catch (e) {
        throw new ParivahanError("DECRYPT", `Could not decrypt ${apiPath}: ${(e as Error).message}`);
      }
    }
    return json as T;
  }

  private async warmUp() {
    const res = await fetch(`${BASE}/challan`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Upgrade-Insecure-Requests": "1",
      },
      cache: "no-store",
    });
    this.jar.absorb(res);
    if (!res.ok) throw new ParivahanError("WARMUP", `Portal warm-up failed (${res.status}).`);
  }

  private async captcha(): Promise<{ captchaId: string; input: string }> {
    const cap = await this.call<{ statusCode?: string; result?: { captchaId?: string; captchaImage?: string } }>(
      "/euser/init/captchaGenerating",
      {}
    );
    const id = cap?.result?.captchaId;
    const img = cap?.result?.captchaImage;
    if (!id || !img) throw new ParivahanError("CAPTCHA_GEN", "Captcha could not be generated.");
    const input = await this.solve(Buffer.from(img, "base64"));
    return { captchaId: id, input: String(input || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6) };
  }

  /** Register a device; retries captcha until one is accepted. */
  private async register(): Promise<{ deviceId: number; jwk: { kty: string; n: string; e: string } }> {
    for (let i = 0; i < this.maxCaptcha; i++) {
      const { captchaId, input } = await this.captcha();
      if (input.length < 5) continue;
      const reg = await this.call<{ statusCode?: string; statusDesc?: string; result?: any }>(
        "/ecitizen/initcitz/citzreg",
        { ...deviceInfo(), captchaId, userInput: input }
      );
      if (String(reg.statusCode) === "200" && reg.result?.deviceId) {
        this.uRefId = String(reg.result.deviceId);
        return { deviceId: reg.result.deviceId, jwk: reg.result.jwk };
      }
      if (String(reg.statusCode) === "MA093") continue; // wrong captcha, retry
      throw new ParivahanError(String(reg.statusCode || "CITZREG"), reg.statusDesc || "Device registration failed.");
    }
    throw new ParivahanError("CAPTCHA_EXHAUSTED", "Captcha could not be solved for device registration.");
  }

  /**
   * Pull outstanding challans for one vehicle.
   * rcDate must be DD/MM/YYYY (use toParivahanRcDate on the stored registration_date).
   */
  async pullVehicle(vehicleNoRaw: string, rcDateRaw: string): Promise<ParivahanPullResult> {
    const vehicleNo = clean(vehicleNoRaw).toUpperCase().replace(/\s+/g, "");
    const rcDate = toParivahanRcDate(rcDateRaw);
    if (!vehicleNo) throw new ParivahanError("INPUT", "vehicleNo is required.");
    if (!rcDate) throw new ParivahanError("INPUT_RC_DATE", "A valid RC registration date (DD/MM/YYYY) is required.");

    await this.warmUp();
    const { deviceId, jwk } = await this.register();

    // challan-search with a session AES key wrapped to the portal's RSA key.
    let sessionId = "";
    let sessionAes: Buffer | null = null;
    let searchCode = "";
    let searchDesc = "";
    for (let i = 0; i < this.maxCaptcha; i++) {
      const { captchaId, input } = await this.captcha();
      if (input.length < 5) continue;
      const aes = crypto.randomBytes(32);
      const wrapped = wrapAesKeyRsa(aes, jwk);
      const search = await this.call<{ statusCode?: string; statusDesc?: string; sessionId?: string }>(
        "/ecitizen/initcitz/challan-search",
        {
          data: {
            user_refId: deviceId,
            wrappedKey: wrapped,
            ref_seq: wrapped,
            vehicleNo,
            rcDate,
            purpose: "A",
            captchaId,
            userInput: input,
          },
        }
      );
      searchCode = String(search.statusCode || "");
      searchDesc = String(search.statusDesc || "");
      if (searchCode === "MA093") continue; // wrong captcha, retry
      if (searchCode === "CTZ013") {
        throw new ParivahanError("CTZ013", `RC date mismatch for ${vehicleNo}: ${searchDesc}`);
      }
      // OTP001 (message sent) still allows the REST details fetch; CTZ00x also proceed.
      sessionId = search.sessionId || "";
      sessionAes = aes;
      break;
    }
    if (!sessionAes) {
      throw new ParivahanError(searchCode || "CAPTCHA_EXHAUSTED", searchDesc || "Challan search captcha failed.");
    }

    const details = await this.call<{ statusCode?: string; statusDesc?: string; result?: any[] }>(
      "/ecitizen/citizentrans/v1/get-challan-details",
      { data: { docNo: vehicleNo, rcDate, searchBy: "RC" } },
      { key: sessionAes, extraHeaders: { "X-Session-Id": sessionId, "X-Device-Id": String(deviceId) } }
    );

    const code = String(details.statusCode || "");
    const desc = String(details.statusDesc || "");
    // CTZ001 = success with challans. "No challan" style codes return ok with empty list.
    const challans = Array.isArray(details.result) ? details.result.map(mapParivahanChallan) : [];
    const noChallan =
      /no\s+(?:pending\s+)?(?:challan|record)|not\s+found/i.test(desc) ||
      ["CTZ003", "CTZ096"].includes(code);
    if (code !== "CTZ001" && !noChallan) {
      throw new ParivahanError(code || "DETAILS", desc || "Challan details fetch failed.");
    }
    return { vehicleNo, ok: true, statusCode: code, statusDesc: desc, challans };
  }

  /** Fetch evidence for a challan. Returns an https URL to stream, or inline bytes. */
  async evidence(challanNo: string): Promise<ParivahanEvidence | null> {
    const no = clean(challanNo).toUpperCase();
    if (!no) return null;
    const res = await this.call<{
      statusCode?: string;
      challanDocsMap?: Record<string, Array<{ fileToUpload?: string; fileExt?: string }>>;
    }>("/edms/wapidms/viewBulk/ChallanDocs", { challanDocList: [{ challanNo: no }] }, { plaintext: true });
    const docs = res?.challanDocsMap?.[no];
    if (!docs || !docs.length) return null;
    const first = docs[0];
    const fileExt = clean(first.fileExt).toLowerCase() || "png";
    const file = clean(first.fileToUpload);
    if (!file) return null;
    if (/^https:\/\//i.test(file)) {
      if (!EVIDENCE_HOST_ALLOW.test(file)) return null; // only trust Parivahan hosts
      return { challanNo: no, sourceUrl: file, inlineBytes: null, fileExt };
    }
    // Inline base64 payload (common for KL challans).
    try {
      const bytes = new Uint8Array(Buffer.from(file, "base64"));
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) return null;
      return { challanNo: no, sourceUrl: null, inlineBytes: bytes, fileExt };
    } catch {
      return null;
    }
  }
}

export function mapParivahanChallan(row: any): ParivahanChallan {
  const offences: ParivahanOffence[] = Array.isArray(row?.offenceDetails)
    ? row.offenceDetails.map((o: any) => ({
        offenceName: clean(o?.offenceName),
        mva: clean(o?.mva),
        offenceId: Number.isFinite(Number(o?.offenceId)) ? Number(o.offenceId) : null,
      }))
    : [];
  const offenceSummary = offences
    .map((o) => o.offenceName)
    .filter(Boolean)
    .join("; ")
    .slice(0, 400);
  const rawDate = clean(row?.challanDate);
  return {
    challanNo: clean(row?.challanNo).toUpperCase(),
    challanDocNo: clean(row?.challanDocNo).toUpperCase(),
    challanDate: rawDate || null,
    amount: Number(row?.amount) || 0,
    stateCode: clean(row?.stateCd).toUpperCase(),
    paymentStatus: clean(row?.paymentStatus) || "Pending",
    accusedName: clean(row?.accusedName),
    challanPlace: clean(row?.challanPlace),
    offences,
    offenceSummary: offenceSummary || "Traffic challan",
    challanSource: Number.isFinite(Number(row?.challanSource)) ? Number(row.challanSource) : null,
  };
}

/** A payment-status string from the portal counts as "still outstanding" for recovery. */
export function parivahanIsOutstanding(paymentStatus: string): boolean {
  const s = clean(paymentStatus).toLowerCase();
  if (!s) return true;
  return !/paid|disposed|closed|settled|cash/.test(s);
}
