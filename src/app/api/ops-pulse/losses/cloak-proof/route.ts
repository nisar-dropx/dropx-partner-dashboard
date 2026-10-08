import { getAuthorization, hasPermission } from "@/lib/authorization";
import { CloakError, cloakGet } from "@/lib/ops-pulse/cloak-client";
import { nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { supabaseAdmin } from "@/lib/supabase-admin";
export const dynamic = "force-dynamic";
const DEFAULT_BUCKET = "cloak-partner-proof-prod";
const fail = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });

/**
 * Opens the proof that was filed with a dispute in Cloak, without a Cloak login.
 * The file key always comes from our stored copy of the case — never from the request.
 */
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_losses", "access") || !supabaseAdmin)
    return fail("Access denied.", 403);
  const url = new URL(request.url),
    month = url.searchParams.get("month") || "",
    key = url.searchParams.get("case") || "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !key || key.length > 300)
    return fail("Invalid case.", 400);
  try {
    const scope = await nlStationScope(auth);
    const row = await supabaseAdmin
      .from("nl_loss_month_cases")
      .select("station_code,proof:details->extra->>dispute_proof")
      .eq("company_id", scope.company)
      .eq("month", month)
      .eq("case_key", key)
      .maybeSingle();
    const proof = String(row.data?.proof ?? "");
    if (row.error || !row.data || !scope.stations.some((s) => s.source_code === row.data!.station_code))
      return fail("Case is unavailable or outside your station access.", 403);
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(proof) || proof.includes(".."))
      return fail("No proof was filed in Cloak for this case.", 404);
    const bucket = await cloakGet<{ bucket?: string }>("/api/v1/getBucket", { name: "partner_proof" })
      .then((b) => (typeof b.bucket === "string" && /^[a-z0-9.-]{3,63}$/.test(b.bucket) ? b.bucket : DEFAULT_BUCKET));
    const file = await cloakGet<{ url?: string }>("/api/v1/presignedDownload", { bucketName: bucket, fileName: proof });
    const target = file.url ? new URL(file.url) : null;
    // Only ever hand the browser to Cloak's own S3 bucket.
    if (!target || target.protocol !== "https:" || target.hostname !== `${bucket}.s3.amazonaws.com`)
      return fail("Cloak did not return the proof file.", 502);
    return new Response(null, {
      status: 302,
      headers: { Location: target.toString(), "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
    });
  } catch (e) {
    return fail(
      e instanceof CloakError ? e.message : "The proof could not be opened. Please retry.",
      e instanceof CloakError && e.code === "SESSION_EXPIRED" ? 503 : 502,
    );
  }
}
