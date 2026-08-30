import { NextResponse } from "next/server";
import { workspaceCredentialsConfigured } from "@/lib/google-workspace-client";
import { syncLocationMailbox } from "@/lib/ops-pulse/location-mail";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });
  if (!workspaceCredentialsConfigured()) return NextResponse.json({ error: "Google Workspace workload identity is not configured." }, { status: 503 });

  const result = await supabaseAdmin.from("ops_location_mailboxes").select("id,company_id")
    .eq("sync_enabled", true).in("status", ["active", "error"]).order("last_synced_at", { ascending: true, nullsFirst: true }).limit(20);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });

  const summary = { mailboxes: 0, messages: 0, errors: [] as string[] };
  for (const mailbox of result.data ?? []) {
    try {
      const sync = await syncLocationMailbox(mailbox.company_id, mailbox.id);
      summary.mailboxes += 1;
      summary.messages += sync.messages;
    } catch (error) {
      summary.errors.push(`${mailbox.id}: ${error instanceof Error ? error.message : "Mailbox sync failed"}`);
    }
  }
  return NextResponse.json(summary, { status: summary.errors.length ? 207 : 200 });
}
