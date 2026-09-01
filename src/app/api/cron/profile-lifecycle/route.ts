import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) return unauthorized();
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

  const result = await supabaseAdmin.rpc("reactivate_expired_profile_suspensions");
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });

  return NextResponse.json({ reactivated: Number(result.data ?? 0) });
}
