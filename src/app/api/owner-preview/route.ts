import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getPreviewViewer, getSignedInPreviewProfile, listPreviewUsers, portalPreviewCookieName, previewNoStoreHeaders, selectedPreviewUserId } from "@/lib/portal-preview";

const options = { httpOnly: true, sameSite: "strict" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: previewNoStoreHeaders });

export async function GET() {
  const viewer = await getPreviewViewer();
  if (!viewer) return reply({ error: "User preview is not permitted for this account." }, 403);
  try {
    return reply({ users: await listPreviewUsers(viewer), selectedUserId: selectedPreviewUserId(viewer.id) });
  } catch {
    return reply({ error: "Unable to load portal users. Please try again." }, 503);
  }
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try { sameOrigin = Boolean(origin && new URL(origin).host === request.headers.get("host")); } catch { /* Reject malformed origins. */ }
  if (!sameOrigin) return reply({ error: "Same-origin request required." }, 403);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.userId !== "string") return reply({ error: "Choose a portal user." }, 400);
  const userId = body.userId.trim();
  const signedInProfile = await getSignedInPreviewProfile();
  if (!signedInProfile) return reply({ error: "Sign in to manage your preview." }, 401);
  if (!userId || userId === signedInProfile.id) {
    cookies().set(portalPreviewCookieName, "", { ...options, maxAge: 0 });
    return reply({ ok: true, preview: false });
  }
  const viewer = await getPreviewViewer();
  if (!viewer) return reply({ error: "User preview is not permitted for this account." }, 403);
  try {
    const users = await listPreviewUsers(viewer);
    if (!users.some(user => user.id === userId)) return reply({ error: "Choose an active user with access to this portal in your company." }, 400);
    cookies().set(portalPreviewCookieName, `${viewer.id}:${userId}`, options);
    console.info("Portal user preview started", { actorUserId: viewer.id, targetUserId: userId, companyId: viewer.company_id });
    return reply({ ok: true, preview: true });
  } catch {
    return reply({ error: "Unable to verify portal access. Please try again." }, 503);
  }
}
