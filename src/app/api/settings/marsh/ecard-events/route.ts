import { getAuthorization, hasPermission } from "@/lib/authorization";
import { workforceAmazonWorkerConfig } from "@/lib/workforce-amazon-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "app_settings", "access")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const { baseUrl, adminKey, configured } = workforceAmazonWorkerConfig();
  if (!configured) {
    return new Response(JSON.stringify({ error: "Workforce worker is not configured." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const upstream = await fetch(`${baseUrl}/api/admin/marsh/ecards/events`, {
    headers: {
      accept: "text/event-stream",
      "x-admin-key": adminKey,
    },
    cache: "no-store",
    signal: request.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(JSON.stringify({ error: text || `Worker HTTP ${upstream.status}` }), {
      status: upstream.status || 502,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
