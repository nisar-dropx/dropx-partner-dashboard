import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH_SIZE = 2000;
/** Roughly two days of superseded uploads, so one missed run is caught up by the next. */
const MAX_STATEMENTS = 80;

/** Removes the stored rows of uploads no reader can reach. Which uploads those
 * are is decided in the database (report_import_prunable_batches). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });
  const prunable = await supabaseAdmin.rpc("report_import_prunable_batches", { p_limit: 500 });
  if (prunable.error) return NextResponse.json({ error: prunable.error.message }, { status: 500 });
  const batches = ((prunable.data ?? []) as unknown[]).map(String);
  const deadline = Date.now() + 240000;
  let deleted = 0, statements = 0, finished = 0;
  const spent = () => statements >= MAX_STATEMENTS || Date.now() > deadline;
  const failed: string[] = [];
  for (const batch of batches) {
    while (!spent()) {
      statements++;
      const { data, error } = await supabaseAdmin.rpc("report_import_prune_batch", { p_batch: batch, p_limit: BATCH_SIZE });
      if (error) { failed.push(batch); break; }
      deleted += Number(data ?? 0);
      if (Number(data ?? 0) < BATCH_SIZE) { finished++; break; }
    }
    if (spent()) break;
  }
  const result = { deleted, uploads: finished, remaining: batches.length - finished - failed.length, failed };
  if (failed.length) console.warn("[report-import-retention] incomplete", result);
  else console.info("[report-import-retention] complete", result);
  return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
}
