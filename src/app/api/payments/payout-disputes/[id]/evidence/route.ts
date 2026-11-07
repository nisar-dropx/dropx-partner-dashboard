import { NextResponse } from "next/server";
import { requirePagePermissionOrThrow } from "@/lib/authorization";
import { currentAdminAccessSurface } from "@/lib/access-surface";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadDisputeEvidence } from "@/lib/payout-dispute-evidence";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const auth = await requirePagePermissionOrThrow(currentAdminAccessSurface() === "ops" ? "ops_workforce_payout_disputes" : "workforce_payout_disputes", "access");
    const company = requireCompanyId(auth);
    let q = supabaseAdmin!.from("workforce_payout_disputes").select("*").eq("company_id", company).eq("id", params.id);
    if (!auth.hasAllLocationAccess) q = q.in("station_id", auth.locationScopeIds);
    const dispute = await q.single();
    if (dispute.error) throw new Error("This dispute is unavailable in your scope.");
    const pub = await supabaseAdmin!.from("workforce_payout_publications").select("*").eq("company_id", company).eq("id", dispute.data.publication_id).single();
    if (pub.error) throw new Error("Published payout is unavailable.");
    const result = await loadDisputeEvidence(company, dispute.data, pub.data, auth);
    let attachmentUrl: string | null = null;
    const path = dispute.data.details?.attachment?.path;
    if (path?.startsWith(`${company}/payout-disputes/${dispute.data.workforce_id}/`)) attachmentUrl = (await supabaseAdmin!.storage.from("employee-profile-documents").createSignedUrl(path, 300)).data?.signedUrl ?? null;
    return NextResponse.json({ ...result, attachmentUrl }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : "Evidence unavailable." }, { status: 400 }); }
}
