import crypto from "crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Fixed origin: this relay only ever calls Cloak's bulk download, never a caller-supplied URL.
const CLOAK_ORIGIN = "https://cloak.tech.amazon.dev";
const CACHE_ERROR_RE = /(cache[ds]?|cached data)[^.]{0,80}(error|fail|stale|corrupt|invalid|clear)|(clear|error)[^.]{0,80}(cache|cached data)/i;

function expectedKey() {
  return (process.env.CASH_RECON_ADMIN_KEY || process.env.X_ADMIN_KEY || "").trim().replace(/^["']|["']$/g, "");
}

function keysMatch(presented: string, expected: string) {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Relay for nl-loss-cloak-worker. Cloak's CloudFront blocks Cloudflare egress,
 * so the worker asks this route (Vercel, AWS) to make the one Cloak API call.
 * The Cloak cookie is read here from cloak_sessions — it never travels in the request.
 * Returns Cloak's status + JSON (presigned CSV URL); the worker downloads the CSV itself.
 */
export async function POST(request: Request) {
  const expected = expectedKey();
  const provided = (request.headers.get("x-admin-key") ?? "").trim();
  if (!expected || !provided || !keysMatch(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Database is unavailable." }, { status: 503 });

  const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : fallback);
  const body = {
    page: 1,
    country: str(input.country, "IN"),
    partner_shortcode: str(input.partner_shortcode, "DROP"),
    case_with: str(input.case_with, "eDSP"),
    userEmail: str(input.userEmail, ""),
    dataSource: "live"
  };

  const { data: session } = await supabaseAdmin.from("cloak_sessions").select("cookie")
    .eq("status", "active").eq("account_key", str(input.accountKey, "default"))
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!session?.cookie) return NextResponse.json({ status: 401, code: "CLOAK_NO_SESSION" });

  let res: Response;
  try {
    res = await fetch(`${CLOAK_ORIGIN}/api/v1/bulkDownload`, {
      method: "POST", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(45_000),
      headers: {
        accept: "application/json, text/plain, */*", "content-type": "application/json", cookie: session.cookie,
        origin: CLOAK_ORIGIN, referer: `${CLOAK_ORIGIN}/`, "x-csrf-token": "required",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return NextResponse.json({ status: 502, code: "CLOAK_NETWORK", error: (error as Error).message });
  }
  const text = await res.text().catch(() => "");
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* HTML / empty */ }
  // Never echo upstream HTML or cookies back — status + a short marker is enough to act on.
  return NextResponse.json({
    status: res.status,
    html: isHtml,
    cacheError: CACHE_ERROR_RE.test(text),
    blocked: res.status === 403 && /Request blocked/i.test(text),
    json
  });
}
