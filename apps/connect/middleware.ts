import { NextResponse, type NextRequest } from "next/server";
import { blocksPreviewMutation, connectPreviewCookieName, previewReadOnlyMessage } from "./src/lib/connect-preview-policy";

// The original Flutter build of DropX One (same package, com.dropxlogistics.one) calls these same
// APIs and sends Dart's default "Dart/x.y (dart:io)" user agent; the current app and browsers
// never do. Turning DROPX_ONE_BLOCK_LEGACY_APP on makes every request from it fail with a message
// its API client shows to the user (it reads `notice`/`error`). 426, not 401: on 401 the old app
// clears its session and just loops back to the login screen without showing the message.
// Only enable once the current app is fully rolled out on Play, or users have nothing to update to.
const UPDATE_MESSAGE =
  "DropX One has a new version. Please update the app from the Play Store to continue.";

export function middleware(request: NextRequest) {
  const preview = Boolean(request.cookies.get(connectPreviewCookieName)?.value);
  if (blocksPreviewMutation(request.method, request.nextUrl.pathname, preview)) {
    return NextResponse.json({ error: previewReadOnlyMessage, code: "read_only_preview" }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Vary", "Cookie");
  if (process.env.DROPX_ONE_BLOCK_LEGACY_APP !== "true") return response;
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent.startsWith("Dart/")) return response;
  return NextResponse.json(
    { ok: false, notice: UPDATE_MESSAGE, error: UPDATE_MESSAGE, code: "app_update_required" },
    { status: 426 }
  );
}

export const config = {
  matcher: "/api/connect/:path*"
};
