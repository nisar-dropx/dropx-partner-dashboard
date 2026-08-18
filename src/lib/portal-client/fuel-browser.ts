export type FuelPortalSource = "iocl_fuel" | "bpcl_fuel";

export type FuelPortalSession = {
  ok: boolean;
  portal: FuelPortalSource;
  username?: string;
  userId?: string;
  password: string;
  customerId?: string;
  loginUrl: string;
  txnUrl?: string;
  error?: string;
};

function proxyUrl(target: string) {
  return `/portal-fuel-proxy/?url=${encodeURIComponent(target)}`;
}

async function ensureFuelServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service workers are unavailable in this browser.");
  }
  await navigator.serviceWorker.register("/portal-fuel-proxy/sw.js", {
    scope: "/portal-fuel-proxy/"
  });
  await navigator.serviceWorker.ready;
}

async function loadPortalSession(sourceType: FuelPortalSource): Promise<FuelPortalSession> {
  const portal = sourceType === "iocl_fuel" ? "iocl" : "bpcl";
  const response = await fetch(`/api/report-imports/portal-session?portal=${portal}`, { cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as FuelPortalSession;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Unable to load ${sourceType} portal session (${response.status}).`);
  }
  return payload;
}

async function probePortalFromBrowser(loginUrl: string) {
  const response = await fetch(loginUrl, {
    headers: { "accept-language": "en-IN,en;q=0.9" },
    credentials: "omit",
    cache: "no-store"
  });
  const body = await response.text();
  const blocked = response.status === 403
    || /Request Rejected|support ID|403 Forbidden|Application-Gateway/i.test(body);
  return { ok: !blocked && response.ok, status: response.status };
}

/** Runs IOCL/BPCL download inline on the current page (no popup/iframe). */
export async function runFuelPortalInline(args: {
  sourceType: FuelPortalSource;
  reportDate: string;
}): Promise<{ file: File; fileName: string }> {
  await ensureFuelServiceWorker();
  const session = await loadPortalSession(args.sourceType);
  const probe = await probePortalFromBrowser(session.loginUrl);
  if (!probe.ok) {
    throw new Error(`Portal login page blocked from your browser (HTTP ${probe.status}).`);
  }

  if (args.sourceType === "iocl_fuel") {
    const { runIoclFuelInBrowser } = await import("@/lib/portal-client/iocl-browser");
    const file = await runIoclFuelInBrowser({
      session,
      reportDate: args.reportDate,
      proxyFetch: (url: string, init?: RequestInit) => fetch(proxyUrl(url), init)
    });
    return { file, fileName: file.name };
  }

  throw new Error("BPCL browser auto-upload is not available yet — use Manual upload.");
}

/** @deprecated Use runFuelPortalInline — iframe/postMessage was timing out in production. */
export async function runFuelPortalInBrowser(args: {
  sourceType: FuelPortalSource;
  reportDate: string;
}): Promise<{ file: File; fileName: string }> {
  return runFuelPortalInline(args);
}

export function isFuelPortalSource(value: string): value is FuelPortalSource {
  return value === "iocl_fuel" || value === "bpcl_fuel";
}
