import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function POST(request: Request) {
  const auth = await getAuthorization();
  if (!auth || auth.readOnly || !hasPermission(auth, "ops_loss_master", "edit"))
    return Response.json(
      { error: "Loss Recovery Master edit access required." },
      { status: 403 },
    );
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(request.url).origin
  )
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const source = await supabaseAdmin
    ?.from("nl_loss_sources")
    .select("account_key")
    .eq("company_id", requireCompanyId(auth))
    .maybeSingle();
  if (!source?.data || source.error)
    return Response.json(
      { error: "No Cloak source is connected to this company." },
      { status: 400 },
    );
  const key = (
    process.env.CASH_RECON_ADMIN_KEY ||
    process.env.X_ADMIN_KEY ||
    ""
  )
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!key)
    return Response.json(
      { error: "Worker connection is unavailable." },
      { status: 503 },
    );
  // The fixed integration host cannot be redirected by a request or Master form.
  const worker =
    process.env.NL_LOSS_WORKER_URL ||
    "https://nl-loss-cloak-worker.withered-voice-1c40.workers.dev";
  try {
    const result = await fetch(
      `${worker.replace(/\/$/, "")}/api/admin/nl-loss/run`,
      {
        method: "POST",
        redirect: "error",
        headers: { "x-admin-key": key },
        signal: AbortSignal.timeout(260_000),
        cache: "no-store",
      },
    );
    const data = await result.json();
    if (!result.ok || !data.ok)
      return Response.json(
        {
          error:
            "Cloak refresh did not complete. The previous successful data is preserved; check refresh details.",
        },
        { status: 502 },
      );
    return Response.json(
      { ok: true, rows: data.rows },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return Response.json(
      {
        error:
          "Refresh is taking longer than expected. Previous data is preserved. Reload to check its status.",
      },
      { status: 502 },
    );
  }
}
