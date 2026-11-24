import crypto from "crypto";
import { NextResponse } from "next/server";
import { syncCloakDisputeTruth } from "@/lib/ops-pulse/cloak-dispute-truth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function expectedKey() {
  return (process.env.CASH_RECON_ADMIN_KEY || process.env.X_ADMIN_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function keysMatch(presented: string, expected: string) {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * After the NL bulk CSV lands, refresh submitted/filed dispute cases from live
 * Cloak APIs so OpsPulse shows Cloak's revision/stage/remarks — not the stale CSV.
 */
export async function POST(request: Request) {
  const expected = expectedKey();
  const provided = (request.headers.get("x-admin-key") ?? "").trim();
  if (!expected || !provided || !keysMatch(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    month?: string;
    limit?: number;
  };
  try {
    const result = await syncCloakDisputeTruth({
      month:
        typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month)
          ? body.month
          : undefined,
      limit:
        typeof body.limit === "number" && body.limit > 0 && body.limit <= 400
          ? body.limit
          : 200,
    });
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Cloak dispute sync failed.",
      },
      { status: 502 },
    );
  }
}
