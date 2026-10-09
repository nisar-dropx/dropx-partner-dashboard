import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getConnectPreviewActor, loadPreviewAccount, previewNoStore, searchConnectPreviewUsers } from "@/lib/connect-preview";
import { connectPreviewCookieName, validPreviewTarget } from "@/lib/connect-preview-policy";
import { signPreview } from "@/lib/connect-preview-cookie";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: previewNoStore });
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: 3600 };
export async function GET(request: NextRequest) {
  try {
    const actor = await getConnectPreviewActor();
    if (request.nextUrl.searchParams.has("capabilities")) return reply({ canPreviewUsers: Boolean(actor?.companyIds.length) });
    if (!actor?.companyIds.length) return reply({ error: "View as user is not available for this account." }, 403);
    return reply({ users: await searchConnectPreviewUsers(actor, request.nextUrl.searchParams.get("q") || "") });
  } catch { return reply({ error: "Unable to load profiles. Please try again." }, 503); }
}
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return reply({ error: "Same-origin request required." }, 403);
  const body = await request.json().catch(() => null);
  if (body?.exit === true) {
    cookies().set(connectPreviewCookieName, "", { ...cookieOptions, maxAge: 0 });
    return reply({ ok: true });
  }
  if (!validPreviewTarget(body)) return reply({ error: "Choose a profile." }, 400);
  try {
    const actor = await getConnectPreviewActor();
    if (!actor?.companyIds.length) return reply({ error: "View as user is not available for this account." }, 403);
    const account = await loadPreviewAccount(body, actor);
    cookies().set(connectPreviewCookieName, signPreview(body, actor.token), cookieOptions);
    console.info("DropX One read-only preview", { sessionId: actor.sessionId, companyId: body.companyId, targetId: body.id, profileType: body.profileType });
    return reply({ ok: true, account });
  } catch { return reply({ error: "This profile is not available in your company. Search again." }, 403); }
}
