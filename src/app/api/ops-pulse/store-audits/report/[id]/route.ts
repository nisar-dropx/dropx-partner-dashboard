import { readAudit, proofs } from "@/lib/ops-pulse/store-audits/server";
import { storeAuditPdf } from "@/lib/ops-pulse/store-audits/report";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const c = await readAudit(params.id);
    if (!c.audit.completed_at)
      throw Error("Report available after completion.");
    return new Response(
      await storeAuditPdf(c.audit, await proofs(c, c.audit.id)),
      {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${c.audit.number}.pdf"`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch {
    return Response.json({ error: "Report unavailable." }, { status: 404 });
  }
}
