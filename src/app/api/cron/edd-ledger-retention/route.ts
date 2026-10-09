import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isEddCronHost } from "@/lib/ops-pulse/edd-cron-scope";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BATCH_SIZE = 2000;
/** A day adds well under one batch per station; the extra batches only catch up after missed runs. */
const MAX_BATCHES_PER_STATION = 3;

/** Removes ledger rows not seen for 14 days (the window lives in edd_prune_ledger). Readers use 7. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isEddCronHost(new URL(request.url).hostname)) return NextResponse.json({ skipped: "EDD ledger retention runs only on OpsPulse." });
  if (!supabaseAdmin) return NextResponse.json({ error: "EDD database is not configured." }, { status: 500 });
  // Stations as the ledger has them: one that left the live feeds still has rows to remove.
  const stations = await supabaseAdmin.rpc("edd_ledger_stations");
  if (stations.error) return NextResponse.json({ error: "EDD stations could not be read." }, { status: 500 });
  const codes = ((stations.data ?? []) as unknown[]).map(String);
  let deleted = 0;
  const failed: string[] = [];
  for (const code of codes) {
    for (let batch = 0; batch < MAX_BATCHES_PER_STATION; batch++) {
      const { data, error } = await supabaseAdmin.rpc("edd_prune_ledger", { p_station: code, p_limit: BATCH_SIZE });
      if (error) { failed.push(code); break; }
      deleted += Number(data ?? 0);
      if (Number(data ?? 0) < BATCH_SIZE) break;
    }
  }
  if (failed.length) console.warn("[edd-ledger-retention] incomplete", { deleted, failed });
  else console.info("[edd-ledger-retention] complete", { deleted, stations: codes.length });
  return NextResponse.json({ deleted, stations: codes.length, failed }, { headers: { "Cache-Control": "private, no-store" } });
}
