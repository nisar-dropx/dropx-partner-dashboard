import { currentAdminAccessSurface } from "@/lib/access-surface";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { buildWorkforceAdvanceImportTemplate } from "@/lib/workforce-advance-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Sign in to download the template." }, { status: 401 });
  const pageCode = currentAdminAccessSurface() === "ops" ? "ops_workforce_advances" : "workforce_advances";
  if (!hasPermission(authorization, pageCode, "add")) {
    return Response.json({ error: "Add access to Workforce Advance Register is required." }, { status: 403 });
  }
  const bytes = buildWorkforceAdvanceImportTemplate({ exampleDate: new Date().toISOString().slice(0, 10) });
  return new Response(Buffer.from(bytes), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "attachment; filename=workforce-advance-upload-template.xlsx",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
  });
}
