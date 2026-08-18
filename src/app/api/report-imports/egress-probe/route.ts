import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";

/**
 * IOCL and BPCL reject Cloudflare Browser Run and GitHub Actions egress at the
 * IP layer. This route reports whether Vercel Mumbai is accepted.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "bom1";
export const maxDuration = 60;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

const TARGETS = [
  {
    id: "iocl",
    url: "https://beta.iocxtrapower.com/account/login?returnUrl=%2FTransactions%2FTransactionDetails",
    okMarker: /XTRAPOWER|Log ?In/i,
    blockMarker: /Request Rejected|support ID/i
  },
  {
    id: "bpcl",
    url: "https://hellobpcl.in/login/",
    okMarker: /Sign In|User ID|hellobpcl|__next/i,
    blockMarker: /403 Forbidden|Application-Gateway/i
  }
] as const;

export async function GET(request: Request) {
  const provided = (request.headers.get("x-admin-key") || "").trim();
  const configuredKeys = [
    process.env.REPORT_AUTO_ADMIN_KEY,
    process.env.ADMIN_API_KEY,
    process.env.CASH_RECON_ADMIN_KEY
  ]
    .map((value) => (value || "").trim())
    .filter(Boolean);
  const keyOk = Boolean(provided) && configuredKeys.includes(provided);
  if (!keyOk) {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!hasPermission(authorization, "imports", "view") && !hasPermission(authorization, "imports", "add")) {
      return NextResponse.json({ error: "Permission denied." }, { status: 403 });
    }
  }

  const results = [];
  for (const target of TARGETS) {
    try {
      const response = await fetch(target.url, {
        headers: { "user-agent": UA, "accept-language": "en-IN,en;q=0.9" },
        cache: "no-store"
      });
      const body = await response.text();
      const flat = body.replace(/\s+/g, " ");
      results.push({
        id: target.id,
        status: response.status,
        verdict: target.blockMarker.test(body) ? "blocked" : target.okMarker.test(body) ? "ok" : "unknown",
        snippet: flat.slice(0, 180)
      });
    } catch (error) {
      results.push({
        id: target.id,
        status: null,
        verdict: "error",
        snippet: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180)
      });
    }
  }

  let egressIp: string | null = null;
  try {
    const res = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    egressIp = ((await res.json()) as { ip?: string }).ip ?? null;
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({
    probedAt: new Date().toISOString(),
    environment: "vercel",
    region: process.env.VERCEL_REGION ?? null,
    egressIp,
    results,
    conclusion: results.every((r) => r.verdict === "ok")
      ? "Vercel egress is accepted by both portals — it can host the IOCL/BPCL browser."
      : "At least one portal rejects Vercel egress. See per-target verdicts."
  });
}
