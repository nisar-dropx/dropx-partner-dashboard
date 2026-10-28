import { requireConnectAccount, type ConnectAccount } from "../../../../../../../src/lib/connect-auth";
import { userFacingError } from "@/lib/user-facing-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const accountId = clean(url.searchParams.get("accountId"));
    const profileType = clean(url.searchParams.get("profileType"));
    if (profileType !== "employee" && profileType !== "contractor" && profileType !== "workforce") {
      return Response.json({ error: "Account is invalid." }, { status: 400 });
    }
    await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const base = process.env.WORKFORCE_AMAZON_WORKER_URL?.trim().replace(/\/$/, "") || process.env.WORKFORCE_WORKER_URL?.trim().replace(/\/$/, "");
    const key = process.env.WORKFORCE_AMAZON_WORKER_KEY?.trim() || process.env.WORKFORCE_WORKER_ADMIN_KEY?.trim() || process.env.ADMIN_API_KEY?.trim();
    if (!base || !key) throw new Error("Insurance letterpad service is not configured.");
    const query = new URLSearchParams({ profileType, profileId: accountId });
    const response = await fetch(`${base}/api/admin/marsh/cover-letterpad?${query}`, {
      headers: { "x-admin-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) throw new Error("Unable to open the cover letterpad.");
    return new Response(await response.arrayBuffer(), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": response.headers.get("content-disposition") || 'inline; filename="cover-letterpad.pdf"',
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return Response.json({ error: userFacingError(error, "Unable to open the cover letterpad.") }, { status: 400 });
  }
}
