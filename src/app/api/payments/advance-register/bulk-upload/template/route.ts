import { getAuthorization, hasPermission } from "@/lib/authorization";
import { buildWorkforceAdvanceImportTemplate } from "@/lib/workforce-advance-import";

export async function GET() {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: "Sign in to download the template." }, { status: 401 });
  if (!hasPermission(auth, "payment_process", "add")) return Response.json({ error: "Add access is required." }, { status: 403 });
  return new Response(Buffer.from(buildWorkforceAdvanceImportTemplate({ registeredPeopleOnly: true })), {
    headers: { "Cache-Control": "private, no-store", "Content-Disposition": "attachment; filename=manually-paid-advances.xlsx",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
  });
}
