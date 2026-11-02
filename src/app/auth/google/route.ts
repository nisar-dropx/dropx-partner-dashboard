import { NextRequest, NextResponse } from "next/server";
import { authUnreachableMessage } from "@/lib/auth-reachable";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

function safeNextPath(value: string | null) {
  const text = String(value ?? "").trim();
  if (!text || !text.startsWith("/") || text.startsWith("//")) return "";

  try {
    const parsed = new URL(text, "https://dashboard.dropxlogistics.com");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Mobile Chrome often drops Set-Cookie on a 302 that immediately leaves the
 * site for accounts.google.com, which then fails PKCE on return. Serve a tiny
 * same-origin HTML page that already has the verifier cookie, then navigate
 * client-side to Google.
 */
function googleHandoffPage(googleUrl: string) {
  const safeUrl = escapeHtmlAttribute(googleUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${safeUrl}" />
  <title>Continuing to Google</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
    p { margin: 0; opacity: 0.85; }
    a { color: #fbbf24; }
  </style>
</head>
<body>
  <p>Continuing to Google… <a href="${safeUrl}">Tap here if nothing happens</a></p>
  <script>window.location.replace(${JSON.stringify(googleUrl)});</script>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  const loginUrl = new URL("/login", request.url);
  const nextPath = safeNextPath(request.nextUrl.searchParams.get("next"));
  // Cookie carrier: Supabase writes the PKCE verifier onto this response object.
  const cookieCarrier = NextResponse.redirect(loginUrl);
  const supabase = createServerSupabaseClient(cookieCarrier);

  if (!supabase) {
    loginUrl.searchParams.set("error", "Authentication is not configured.");
    return NextResponse.redirect(loginUrl);
  }

  const callbackUrl = new URL("/auth/callback", request.nextUrl.origin);
  if (nextPath) callbackUrl.searchParams.set("next", nextPath);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: callbackUrl.toString(),
      queryParams: {
        prompt: "select_account"
      }
    }
  });

  if (error || !data.url) {
    loginUrl.searchParams.set("error", error?.message ?? "Unable to start Google login.");
    return NextResponse.redirect(loginUrl);
  }

  const unreachable = await authUnreachableMessage();
  if (unreachable) {
    // Abort before Google handoff and drop any verifier cookies written above
    // so a later successful attempt cannot pair with a stale code.
    loginUrl.searchParams.set("error", unreachable);
    const failed = NextResponse.redirect(loginUrl);
    for (const cookie of cookieCarrier.cookies.getAll()) {
      failed.cookies.set({ ...cookie, value: "", maxAge: 0 });
    }
    return failed;
  }

  const response = new NextResponse(googleHandoffPage(data.url), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
  for (const cookie of cookieCarrier.cookies.getAll()) {
    response.cookies.set(cookie);
  }
  return response;
}
