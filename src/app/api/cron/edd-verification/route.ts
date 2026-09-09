import { NextResponse } from "next/server";
import { verifyEddBatch } from "@/lib/ops-pulse/edd-ledger";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error:"Unauthorized" },{status:401});
  try { return NextResponse.json(await verifyEddBatch()); }
  catch (error) { return NextResponse.json({ error:error instanceof Error ? error.message : "EDD verification failed." },{status:500}); }
}
