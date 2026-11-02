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

export async function GET(request: NextRequest) {
  const loginUrl = new URL("/login", request.url);
  const nextPath = safeNextPath(request.nextUrl.searchParams.get("next"));
  // Carrier response: PKCE verifier cookies are written here, then Location is
  // swapped to Google so the browser stores the verifier on the same hop.
  const response = NextResponse.redirect(loginUrl);
  const supabase = createServerSupabaseClient(response);

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
    loginUrl.searchParams.set("error", unreachable);
    return NextResponse.redirect(loginUrl);
  }

  response.headers.set("Location", data.url);
  return response;
}
