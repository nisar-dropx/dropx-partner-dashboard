"use client";

import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

type FuelPortalSource = "iocl_fuel" | "bpcl_fuel";

type PortalSession = {
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
  const reg = await navigator.serviceWorker.register("/portal-fuel-proxy/sw.js", {
    scope: "/portal-fuel-proxy/"
  });
  await navigator.serviceWorker.ready;
  return reg;
}

async function loadPortalSession(sourceType: FuelPortalSource): Promise<PortalSession> {
  const portal = sourceType === "iocl_fuel" ? "iocl" : "bpcl";
  const response = await fetch(`/api/report-imports/portal-session?portal=${portal}`, { cache: "no-store" });
  const payload = (await response.json().catch(() => ({}))) as PortalSession;
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

/** Hidden popup runner — uses SW proxy + operator ISP for IOCL portal APIs. */
function FuelPortalRunnerInner() {
  const params = useSearchParams();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const portal = (params.get("portal") || "").trim() as FuelPortalSource;
    const reportDate = (params.get("reportDate") || "").trim();
    const targetOrigin = window.location.origin;
    const notifyParent = (payload: Record<string, unknown>, transfer?: Transferable[]) => {
      const target = window.opener || window.parent;
      if (!target || target === window) return;
      target.postMessage(payload, targetOrigin, transfer || []);
    };

    void (async () => {
      try {
        if (portal !== "iocl_fuel" && portal !== "bpcl_fuel") {
          throw new Error("Unsupported fuel portal.");
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
          throw new Error("reportDate must be YYYY-MM-DD.");
        }

        await ensureFuelServiceWorker();
        const session = await loadPortalSession(portal);
        const probe = await probePortalFromBrowser(session.loginUrl);
        if (!probe.ok) {
          throw new Error(`Portal login page blocked from your browser (HTTP ${probe.status}).`);
        }

        if (portal === "iocl_fuel") {
          const { runIoclFuelInBrowser } = await import("@/lib/portal-client/iocl-browser");
          const file = await runIoclFuelInBrowser({
            session,
            reportDate,
            proxyFetch: (url: string, init?: RequestInit) => fetch(proxyUrl(url), init)
          });
          const buffer = await file.arrayBuffer();
          notifyParent(
            {
              type: "fuel-portal-done",
              ok: true,
              portal,
              reportDate,
              fileName: file.name,
              mime: file.type,
              buffer
            },
            [buffer]
          );
          if (window.opener) window.close();
          return;
        }

        throw new Error("BPCL browser auto-upload is not available yet — use Manual upload.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notifyParent({ type: "fuel-portal-done", ok: false, portal, reportDate, error: message });
        if (window.opener) window.close();
      }
    })();
  }, [params]);

  return null;
}

export default function FuelPortalRunnerPage() {
  return (
    <Suspense fallback={null}>
      <FuelPortalRunnerInner />
    </Suspense>
  );
}
