import CryptoJS from "crypto-js";
import { getIoclRecaptchaToken } from "./iocl-recaptcha";

const TOKEN = "8080808080808080";
const GUEST_PROVIDER_KEY = "103C594B-19B4-49E1-847C-67FEC502DC87";
const GUEST_USER = "GuestUser";
const LOGIN_BASE = "https://betaapi.iocxtrapower.com/LoginAPI/api/";
const API_BASE = "https://betaapi.iocxtrapower.com/APIGateway/api/";

type IoclSession = {
  username?: string;
  password: string;
  customerId?: string;
};

function encryptJson(obj: unknown): string {
  const plain = JSON.stringify(obj);
  const key = CryptoJS.enc.Utf8.parse(TOKEN);
  const iv = CryptoJS.lib.WordArray.create([0, 0, 0, 0]);
  return CryptoJS.AES.encrypt(plain, key, { iv }).toString();
}

function encryptString(plain: string): string {
  const key = CryptoJS.enc.Utf8.parse(TOKEN);
  const iv = CryptoJS.lib.WordArray.create([0, 0, 0, 0]);
  return CryptoJS.AES.encrypt(plain, key, { iv }).toString();
}

function decryptString(cipherText: string): string {
  const key = CryptoJS.enc.Utf8.parse(TOKEN);
  const iv = CryptoJS.lib.WordArray.create([0, 0, 0, 0]);
  return CryptoJS.AES.decrypt(cipherText, key, { iv }).toString(CryptoJS.enc.Utf8);
}

function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const obj = { ...(payload as Record<string, unknown>) };
  const info = obj.info as { refreshToken?: string } | undefined;

  let chkIsActive = "";
  if (typeof obj.isActive === "string" && obj.isActive.includes(",")) {
    chkIsActive = obj.isActive.split(",")[0];
  } else if (typeof obj.isActive === "string" && obj.isActive.length > 4) {
    const dec = decryptString(obj.isActive);
    if (dec) chkIsActive = dec.split(",")[0];
  }

  const ipRaw = obj.ipAddress;
  let ipParts: string[] = [];
  if (typeof ipRaw === "string" && ipRaw && ipRaw !== "false") {
    const ipDec = decryptString(ipRaw) || ipRaw;
    ipParts = ipDec.split(",");
  } else if (ipRaw === "false" || ipRaw === false) {
    ipParts = ["false"];
  }

  const shouldDecryptData =
    chkIsActive === "true" &&
    ipParts.length === 1 &&
    typeof obj.data === "string" &&
    obj.data.length > 8;

  if (shouldDecryptData || (typeof obj.data === "string" && obj.data.length > 8 && !String(obj.data).startsWith("{"))) {
    const plain = decryptString(String(obj.data));
    if (plain) {
      try {
        obj.data = JSON.parse(plain);
      } catch {
        obj.data = plain;
      }
    }
  } else if (typeof obj.data === "string" && (obj.data.startsWith("{") || obj.data.startsWith("["))) {
    try {
      obj.data = JSON.parse(obj.data);
    } catch {
      /* keep string */
    }
  }

  if (info?.refreshToken && info.refreshToken.length > 20) {
    obj.sessionToken = info.refreshToken;
  }

  return obj;
}

function uniqueKey(userName: string) {
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()).replace(",", "");
  const rand = Math.floor(Math.random() * 900_000) + 100_000;
  return `${userName}|${stamp}|${rand}`;
}

function guestAuthHeaders(userName = GUEST_USER) {
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()).replace(",", "");
  const rand = Math.floor(Math.random() * 900_000) + 100_000;
  return {
    Authorization: `Bearer ${GUEST_PROVIDER_KEY}`,
    UserName: `Bearer ${encryptString(`${userName},${stamp},${rand}`)}`
  };
}

function sessionAuthHeaders(token: string, userName: string) {
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date()).replace(",", "");
  const rand = Math.floor(Math.random() * 900_000) + 100_000;
  return {
    Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    UserName: `Bearer ${encryptString(`${userName},${stamp},${rand}`)}`,
    username: userName
  };
}

function ymdToIoclUi(ymd: string) {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

function addDaysYmd(ymd: string, days: number) {
  const dt = new Date(`${ymd}T00:00:00+05:30`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export type PortalProxyFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function postEncrypted(
  proxyFetch: PortalProxyFetch,
  base: string,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const payload = { ...body, Uniquekey: body.Uniquekey || uniqueKey(String(body.UserName || body.userName || "")) };
  const response = await proxyFetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: "https://beta.iocxtrapower.com",
      referer: "https://beta.iocxtrapower.com/account/login",
      ...guestAuthHeaders(String(body.UserName || body.userName || GUEST_USER)),
      ...headers
    },
    body: JSON.stringify({ Request: encryptJson(payload) })
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return path.includes("Login") ? unwrapPayload(json) : unwrapPayload(json);
}

function extractToken(login: Record<string, unknown>): string {
  const info = login.info as { refreshToken?: string; message?: string } | undefined;
  if (info?.refreshToken && info.refreshToken.length > 20) return info.refreshToken;
  const sessionToken = String(login.sessionToken ?? "").trim();
  if (sessionToken.length > 20) return sessionToken;
  const data = login.data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["token", "Token", "accessToken", "userKey"]) {
      const val = String(obj[key] ?? "").trim();
      if (val.length > 20) return val;
    }
  }
  return "";
}

function rowsToCsv(rows: unknown[]): string {
  if (!rows.length) return "";
  const objects = rows.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  if (!objects.length) return "";
  const headers = [...new Set(objects.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const raw = value == null ? "" : String(value);
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return [
    headers.join(","),
    ...objects.map((row) => headers.map((key) => escape(row[key])).join(","))
  ].join("\n");
}

async function loginIocl(
  proxyFetch: PortalProxyFetch,
  username: string,
  password: string
): Promise<{ token: string; login: Record<string, unknown> }> {
  await postEncrypted(proxyFetch, LOGIN_BASE, "Login/FetchedLoginInfo", { UserName: username });

  const captchaToken = await getIoclRecaptchaToken("login");
  const captchaFields: Record<string, string>[] = [
    { Token: captchaToken },
    { CaptchaToken: captchaToken },
    { RecaptchaToken: captchaToken }
  ];

  let lastMessage = "";
  for (const captchaField of captchaFields) {
    const login = await postEncrypted(proxyFetch, LOGIN_BASE, "Login/Login", {
      UserName: username,
      Password: password,
      ...captchaField
    });
    const info = (login.info || {}) as { message?: string; isSuccess?: boolean };
    lastMessage = String(info.message ?? "");
    if (/recaptcha|captcha/i.test(lastMessage)) continue;
    const token = extractToken(login);
    if (token) return { token, login };
    if (info.isSuccess === false && lastMessage) break;
  }

  throw new Error(lastMessage || "IOCL login did not return a token (browser path). Use Manual upload.");
}

export async function runIoclFuelInBrowser(args: {
  session: IoclSession;
  reportDate: string;
  proxyFetch: PortalProxyFetch;
}): Promise<File> {
  const username = String(args.session.username || "").trim();
  const password = String(args.session.password || "").trim();
  if (!username || !password) throw new Error("IOCL credentials are missing.");

  const { token } = await loginIocl(args.proxyFetch, username, password);
  const authHeaders = sessionAuthHeaders(token, username);

  const fromUi = ymdToIoclUi(args.reportDate);
  const toUi = ymdToIoclUi(addDaysYmd(args.reportDate, 1));
  const customerId = String(args.session.customerId || "1002424122").trim();

  const summary = await postEncrypted(
    args.proxyFetch,
    API_BASE,
    "Transaction/GetTransactionSummary",
    {
      CustomerId: customerId,
      FromDate: fromUi,
      ToDate: toUi,
      PageIndex: 1,
      PageSize: 5000
    },
    authHeaders
  );
  const summaryData = summary.data;
  const rows = Array.isArray(summaryData)
    ? summaryData
    : summaryData && typeof summaryData === "object" && Array.isArray((summaryData as { rows?: unknown[] }).rows)
      ? (summaryData as { rows: unknown[] }).rows
      : [];
  let csv = rowsToCsv(rows);

  if (!csv || csv.length < 40) {
    const exp = await postEncrypted(
      args.proxyFetch,
      API_BASE,
      "Transaction/GetTransactionSummaryEXP",
      {
        CustomerId: customerId,
        FromDate: fromUi,
        ToDate: toUi
      },
      authHeaders
    );
    const expData = exp.data;
    if (typeof expData === "string" && expData.includes("SNo")) {
      csv = expData;
    }
  }

  if (!csv || csv.length < 20) {
    throw new Error("IOCL export returned no transaction rows. Use Manual upload.");
  }

  const fileName = `iocl_fuel_${args.reportDate}.csv`;
  return new File([csv], fileName, { type: "text/csv" });
}
