import { NextResponse } from "next/server";
import { canSeeGroup, reportBotApiAuthorization } from "@/lib/report-bot/access";
import { reportBotDb } from "@/lib/report-bot/settings";

export const dynamic = "force-dynamic";

/** Short-lived signed link to a stored report image, after the same scope check as the page. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const authorization = await reportBotApiAuthorization("access");
  if (!authorization) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const db = reportBotDb();
  const submission = await db.from("report_bot_submissions")
    .select("storage_bucket,storage_path, group:report_bot_groups(location_id)")
    .eq("company_id", authorization.companyId!)
    .eq("id", params.id)
    .maybeSingle();
  const row = submission.data as { storage_bucket: string | null; storage_path: string | null; group: { location_id: string | null } | null } | null;
  if (!row?.storage_path || !row.storage_bucket || !canSeeGroup(authorization, { location_id: row.group?.location_id ?? null })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const signed = await db.storage.from(row.storage_bucket).createSignedUrl(row.storage_path, 120);
  if (signed.error || !signed.data?.signedUrl) return NextResponse.json({ error: "Image unavailable" }, { status: 502 });
  return NextResponse.redirect(signed.data.signedUrl, { status: 302, headers: { "cache-control": "private, no-store" } });
}
