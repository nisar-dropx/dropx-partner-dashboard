import { NextResponse } from "next/server";
import { workspaceCredentialsConfigured } from "@/lib/google-workspace-client";
import { processWorkspaceJobs, syncWorkspaceDirectory } from "@/lib/google-workspace-service";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SettingRow = {
  company_id: string;
  directory_sync_enabled: boolean;
  provisioning_enabled: boolean;
  last_sync_at: string | null;
};

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) return unauthorized();
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });
  if (!workspaceCredentialsConfigured()) return NextResponse.json({ error: "Google Workspace workload identity is not configured." }, { status: 503 });

  const settings = await supabaseAdmin.from("google_workspace_settings")
    .select("company_id,directory_sync_enabled,provisioning_enabled,last_sync_at")
    .or("directory_sync_enabled.eq.true,provisioning_enabled.eq.true");
  if (settings.error) return NextResponse.json({ error: settings.error.message }, { status: 500 });

  const now = new Date();
  const summary = { companies: 0, synced: 0, users: 0, processed: 0, completed: 0, failed: 0, blocked: 0, errors: [] as string[] };
  await supabaseAdmin.from("google_workspace_deletion_requests").update({ status: "eligible", updated_at: now.toISOString() })
    .eq("status", "retention").lte("eligible_at", now.toISOString()).eq("legal_hold", false);

  for (const setting of (settings.data ?? []) as SettingRow[]) {
    summary.companies += 1;
    try {
      const lastSyncAt = setting.last_sync_at ? new Date(setting.last_sync_at).getTime() : 0;
      if (setting.directory_sync_enabled && now.getTime() - lastSyncAt >= 30 * 60 * 1000) {
        const sync = await syncWorkspaceDirectory(setting.company_id);
        summary.synced += 1;
        summary.users += sync.users;
      }
      if (setting.provisioning_enabled) {
        const jobs = await processWorkspaceJobs(25, setting.company_id);
        summary.processed += jobs.processed;
        summary.completed += jobs.completed;
        summary.failed += jobs.failed;
        summary.blocked += jobs.blocked;
      }
    } catch (error) {
      summary.errors.push(`${setting.company_id}: ${error instanceof Error ? error.message : "Workspace processing failed"}`);
    }
  }

  return NextResponse.json(summary, { status: summary.errors.length ? 207 : 200 });
}
