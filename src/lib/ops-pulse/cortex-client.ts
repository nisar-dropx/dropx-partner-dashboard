import { createHmac } from "node:crypto";

const AMAZON = "https://logistics.amazon.in";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export type CortexSession = { sessionKey: string; sessionId: string };
export type CortexAuth = { cookie: string; session: CortexSession };

function indiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function historicalDay(date: string) {
  return date < indiaToday();
}

function sortedQuery(params: Record<string, string>) {
  const q = new URLSearchParams();
  for (const key of Object.keys(params).sort()) q.append(key, params[key]);
  return q.toString();
}

function signCortex(
  method: string,
  path: string,
  query: string,
  session: CortexSession,
  timestamp: string,
) {
  const canonical = [
    method.toUpperCase(),
    path,
    query,
    `x-cortex-session:${session.sessionId}`,
    `x-cortex-timestamp:${timestamp}`,
    "",
    "x-cortex-session;x-cortex-timestamp",
  ].join("\n");
  return createHmac("sha256", session.sessionKey).update(canonical).digest("base64");
}

export async function readCortexSession(cookie: string): Promise<CortexSession | "expired"> {
  const res = await fetch(`${AMAZON}/operations/execution/itineraries?navMenuVariant=external`, {
    redirect: "manual",
    headers: {
      accept: "text/html",
      cookie,
      referer: `${AMAZON}/`,
      "user-agent": UA,
    },
    cache: "no-store",
  });
  if (res.status >= 300 && res.status < 400) return "expired";
  const html = await res.text();
  const start = html.indexOf('{"hmacSession":');
  const end = html.indexOf("}</script>", start);
  if (start < 0 || end < 0) return "expired";
  try {
    const parsed = JSON.parse(html.slice(start, end + 1));
    const session = parsed.hmacSession;
    if (!session?.enabled || !session.sessionKey || !session.sessionId) return "expired";
    return { sessionKey: session.sessionKey, sessionId: session.sessionId };
  } catch {
    return "expired";
  }
}

async function executionJson(auth: CortexAuth, path: string, query: string) {
  const timestamp = String(Date.now());
  const signature = signCortex("GET", path, query, auth.session, timestamp);
  const res = await fetch(`${AMAZON}${path}?${query}`, {
    redirect: "manual",
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: auth.cookie,
      "user-agent": UA,
      "user-ref": "cortex-webapp-user",
      "x-cortex-hmac-signature": signature,
      "x-cortex-session": auth.session.sessionId,
      "x-cortex-timestamp": timestamp,
      referer: `${AMAZON}/operations/execution/itineraries`,
    },
    cache: "no-store",
  });
  if (res.status >= 300 && res.status < 400) return { expired: true as const, data: null };
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || /^\s*</.test(text)) {
    return { expired: true as const, data: null };
  }
  if (!res.ok) throw new Error(`Amazon ${res.status}: ${text.slice(0, 160)}`);
  try {
    return { expired: false as const, data: JSON.parse(text) };
  } catch {
    throw new Error(`Amazon response was not JSON (${res.status})`);
  }
}

export async function fetchCortexSummaries(
  auth: CortexAuth,
  date: string,
  serviceAreaId: string,
) {
  const query = sortedQuery({
    historicalDay: String(historicalDay(date)),
    localDate: date,
    serviceAreaId,
  });
  return executionJson(auth, "/operations/execution/api/summaries", query);
}

export async function fetchCortexItinerary(
  auth: CortexAuth,
  itineraryId: string,
  serviceAreaId: string,
  date: string,
) {
  const query = sortedQuery({
    documentType: "Itinerary",
    historicalDay: String(historicalDay(date)),
    itineraryId,
    serviceAreaId,
  });
  return executionJson(auth, `/operations/execution/api/itineraries/${itineraryId}`, query);
}

export function transporterDisplayName(t: any, id: string) {
  if (!t) return id;
  return [t.firstName, t.lastName].filter(Boolean).join(" ").trim() || id;
}

export function packageCounts(summary: any) {
  const s = summary || {};
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    delivered: num(s.DELIVERED ?? s.delivered),
    attempted: num(s.ATTEMPTED ?? s.attempted),
    remaining: num(s.REMAINING ?? s.remaining),
    rejected: num(s.REJECTED ?? s.rejected),
    total:
      num(s.TOTAL ?? s.total) ||
      num(s.DELIVERED ?? s.delivered) +
        num(s.ATTEMPTED ?? s.attempted) +
        num(s.REMAINING ?? s.remaining) +
        num(s.REJECTED ?? s.rejected),
  };
}
