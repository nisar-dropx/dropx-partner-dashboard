import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    accessToken?: unknown;
    refreshToken?: unknown;
  };
  const accessToken = String(body.accessToken ?? "").trim();
  const refreshToken = String(body.refreshToken ?? "").trim();
  if (!accessToken || !refreshToken) {
    return NextResponse.json({ error: "A valid mobile session is required." }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true });
  const supabase = createServerSupabaseClient(response);
  if (!supabase) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }
  const { data, error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken
  });
  if (error || !data.user) {
    return NextResponse.json({ error: error?.message ?? "Unable to create the Fleet mobile session." }, { status: 401 });
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  const supabase = createServerSupabaseClient(response);
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
