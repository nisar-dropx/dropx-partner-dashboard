import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!supabaseAdmin) {
    return NextResponse.json(
      { error: "Supabase service role key is not configured." },
      { status: 500 }
    );
  }

  const cleanup = await supabaseAdmin.rpc("connect_redact_expired_profile_edits");
  if (cleanup.error) {
    return NextResponse.json({ error: cleanup.error.message }, { status: 500 });
  }
  return NextResponse.json(
    { redacted: Number(cleanup.data ?? 0) },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
