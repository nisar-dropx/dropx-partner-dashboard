// Parivahan NextGen e-Challan client (public "Check Status" read flow).
// Standalone ESM module for the challan worker. Mirrors src/lib/fleet/challan-parivahan.ts.
//
// Verified live flow (reads outstanding challans, no OTP, no payment):
//   warm-up -> captcha -> citzreg -> captcha -> challan-search -> get-challan-details -> ChallanDocs
import crypto from "node:crypto";
import { portalAgent } from "./tls.mjs";

const BASE = "https://echallan.parivahan.nic.in";
const STATIC_KEY = Buffer.from("w7H1ZyG1YvKuj5xM9jA9Z5qUqZVqK6s8l8YjA2zvZ6g=", "base64");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const EVIDENCE_HOST_ALLOW = /^https:\/\/echallan\.parivahan\.(gov|nic)\.in\//i;

const clean = (v) => String(v ?? "").trim();
const sha256Hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

export class ParivahanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ParivahanError";
  }
}

function encryptBody(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, enc, cipher.getAuthTag()]).toString("base64");
}
function decryptBody(payloadB64, key) {
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const rest = buf.subarray(12);
  const tag = rest.subarray(rest.length - 16);
  const ct = rest.subarray(0, rest.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function baseHeaders(cookie, extra = {}) {
  const h = {
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

class Jar {
  constructor() {
    this.map = new Map();
  }
  absorb(res) {
    const list =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
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
  const reqJson = JSON.stringify({
    userAgent: UA,
    platform: "Win32",
    vendor: "Google Inc.",
    language: "en-IN",
    screen: { width: 1536, height: 864, pixelDepth: 24 },
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

function wrapAesKeyRsa(aesRaw, jwk) {
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" });
  return crypto
    .publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, aesRaw)
    .toString("base64");
}

export function toParivahanRcDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const dmy = raw.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return null;
}

export function parivahanIsOutstanding(paymentStatus) {
  const s = clean(paymentStatus).toLowerCase();
  if (!s) return true;
  return !/paid|disposed|closed|settled|cash/.test(s);
}

export function mapParivahanChallan(row) {
  const offences = Array.isArray(row?.offenceDetails)
    ? row.offenceDetails.map((o) => ({
        offenceName: clean(o?.offenceName),
        mva: clean(o?.mva),
        offenceId: Number.isFinite(Number(o?.offenceId)) ? Number(o.offenceId) : null,
      }))
    : [];
  const offenceSummary = offences.map((o) => o.offenceName).filter(Boolean).join("; ").slice(0, 400);
  return {
    challanNo: clean(row?.challanNo).toUpperCase(),
    challanDocNo: clean(row?.challanDocNo).toUpperCase(),
    challanDate: clean(row?.challanDate) || null,
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

export class ParivahanChallanClient {
  constructor({ captchaSolver, maxCaptchaAttempts = 12 }) {
    this.jar = new Jar();
    this.uRefId = "";
    this.solve = captchaSolver;
    this.maxCaptcha = Math.max(1, maxCaptchaAttempts);
  }

  async call(apiPath, bodyObj, { key = STATIC_KEY, extraHeaders = {}, plaintext = false } = {}) {
    // Most endpoints encrypt the body; a few (e.g. ChallanDocs) take raw JSON.
    const bodyStr =
      bodyObj == null
        ? ""
        : plaintext
          ? JSON.stringify(bodyObj)
          : JSON.stringify({ payload: encryptBody(JSON.stringify(bodyObj), key) });
    const ts = Date.now().toString();
    const nonce = `${crypto.randomUUID()}_${this.uRefId}_${ts}`;
    const urlPath = new URL(`${BASE}${apiPath}`).pathname;
    const x003 = sha256Hex(["POST", urlPath, ts, nonce, bodyStr].join("|"));
    const encHeaders = plaintext ? {} : { "X-Body-Encrypted": "echallan", "X-Response-Encrypted": "echallan" };
    const headers = baseHeaders(this.jar.header(), { X001: ts, X002: nonce, X003: x003, ...encHeaders, ...extraHeaders });
    const res = await fetch(`${BASE}${apiPath}`, {
      method: "POST",
      headers,
      body: bodyStr || undefined,
      dispatcher: portalAgent,
    });
    this.jar.absorb(res);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ParivahanError("HTTP", `Non-JSON response (${res.status}) from ${apiPath}`);
    }
    if (json && typeof json.payload === "string") {
      try {
        return JSON.parse(decryptBody(json.payload, key));
      } catch (e) {
        throw new ParivahanError("DECRYPT", `Could not decrypt ${apiPath}: ${e.message}`);
      }
    }
    return json;
  }

  async warmUp() {
    const res = await fetch(`${BASE}/challan`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-IN,en;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Upgrade-Insecure-Requests": "1",
      },
      dispatcher: portalAgent,
    });
    this.jar.absorb(res);
    if (!res.ok) throw new ParivahanError("WARMUP", `Portal warm-up failed (${res.status}).`);
  }

  async captcha() {
    const cap = await this.call("/euser/init/captchaGenerating", {});
    const id = cap?.result?.captchaId;
    const img = cap?.result?.captchaImage;
    if (!id || !img) throw new ParivahanError("CAPTCHA_GEN", "Captcha could not be generated.");
    const input = await this.solve(Buffer.from(img, "base64"));
    return { captchaId: id, input: String(input || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 6) };
  }

  async register() {
    for (let i = 0; i < this.maxCaptcha; i++) {
      const { captchaId, input } = await this.captcha();
      if (input.length < 5) continue;
      const reg = await this.call("/ecitizen/initcitz/citzreg", { ...deviceInfo(), captchaId, userInput: input });
      if (String(reg.statusCode) === "200" && reg.result?.deviceId) {
        this.uRefId = String(reg.result.deviceId);
        return { deviceId: reg.result.deviceId, jwk: reg.result.jwk };
      }
      if (String(reg.statusCode) === "MA093") continue;
      throw new ParivahanError(String(reg.statusCode || "CITZREG"), reg.statusDesc || "Device registration failed.");
    }
    throw new ParivahanError("CAPTCHA_EXHAUSTED", "Captcha could not be solved for device registration.");
  }

  async pullVehicle(vehicleNoRaw, rcDateRaw) {
    const vehicleNo = clean(vehicleNoRaw).toUpperCase().replace(/\s+/g, "");
    const rcDate = toParivahanRcDate(rcDateRaw);
    if (!vehicleNo) throw new ParivahanError("INPUT", "vehicleNo is required.");
    if (!rcDate) throw new ParivahanError("INPUT_RC_DATE", "A valid RC registration date (DD/MM/YYYY) is required.");

    await this.warmUp();
    const { deviceId, jwk } = await this.register();

    let sessionId = "";
    let sessionAes = null;
    let searchCode = "";
    let searchDesc = "";
    for (let i = 0; i < this.maxCaptcha; i++) {
      const { captchaId, input } = await this.captcha();
      if (input.length < 5) continue;
      const aes = crypto.randomBytes(32);
      const wrapped = wrapAesKeyRsa(aes, jwk);
      const search = await this.call("/ecitizen/initcitz/challan-search", {
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
      });
      searchCode = String(search.statusCode || "");
      searchDesc = String(search.statusDesc || "");
      if (searchCode === "MA093") continue;
      if (searchCode === "CTZ013") {
        throw new ParivahanError("CTZ013", `RC date mismatch for ${vehicleNo}: ${searchDesc}`);
      }
      sessionId = search.sessionId || "";
      sessionAes = aes;
      break;
    }
    if (!sessionAes) {
      throw new ParivahanError(searchCode || "CAPTCHA_EXHAUSTED", searchDesc || "Challan search captcha failed.");
    }

    const details = await this.call(
      "/ecitizen/citizentrans/v1/get-challan-details",
      { data: { docNo: vehicleNo, rcDate, searchBy: "RC" } },
      { key: sessionAes, extraHeaders: { "X-Session-Id": sessionId, "X-Device-Id": String(deviceId) } }
    );
    const code = String(details.statusCode || "");
    const desc = String(details.statusDesc || "");
    const challans = Array.isArray(details.result) ? details.result.map(mapParivahanChallan) : [];
    const noChallan = /no\s+challan|not\s+found|no\s+record/i.test(desc) || code === "CTZ003";
    if (code !== "CTZ001" && !noChallan) {
      throw new ParivahanError(code || "DETAILS", desc || "Challan details fetch failed.");
    }
    return { vehicleNo, ok: true, statusCode: code, statusDesc: desc, challans };
  }

  async evidence(challanNo) {
    const no = clean(challanNo).toUpperCase();
    if (!no) return null;
    const res = await this.call(
      "/edms/wapidms/viewBulk/ChallanDocs",
      { challanDocList: [{ challanNo: no }] },
      { plaintext: true }
    );
    const docs = res?.challanDocsMap?.[no];
    if (!docs || !docs.length) return null;
    const first = docs[0];
    const fileExt = clean(first.fileExt).toLowerCase() || "png";
    const file = clean(first.fileToUpload);
    if (!file) return null;
    if (/^https:\/\//i.test(file)) {
      if (!EVIDENCE_HOST_ALLOW.test(file)) return null;
      return { challanNo: no, sourceUrl: file, inlineBase64: null, fileExt };
    }
    return { challanNo: no, sourceUrl: null, inlineBase64: file, fileExt };
  }
}
