import { context, db, readChecklist } from "@/lib/ops-pulse/si-handover/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const c = await context();
    const r = await db()
      .from("ops_si_checklist_evidence")
      .select("checklist_id,path")
      .eq("company_id", c.companyId)
      .eq("id", params.id)
      .eq("ready", true)
      .maybeSingle();
    if (!r.data) throw Error("Evidence unavailable.");
    await readChecklist(r.data.checklist_id, c);
    const signed = await db()
      .storage.from("ops-pulse-documents")
      .createSignedUrl(r.data.path, 60);
    if (signed.error) throw Error(signed.error.message);
    return new Response(null, {
      status: 302,
      headers: {
        Location: signed.data.signedUrl,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return Response.json(
      { error: "Evidence unavailable." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
