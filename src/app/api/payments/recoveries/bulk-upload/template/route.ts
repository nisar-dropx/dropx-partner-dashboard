import { getAuthorization, hasPermission } from "@/lib/authorization";
import { buildPaymentRecoveryImportTemplate } from "@/lib/payment-recovery-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET() {
  const authorization = await getAuthorization();
  if (!authorization) {
    return Response.json({ error: "Sign in to download the template." }, { status: 401, headers: noStore });
  }
  if (!hasPermission(authorization, "payment_recoveries", "add")) {
    return Response.json({ error: "Add access to Payment Recovery is required." }, { status: 403, headers: noStore });
  }

  const bytes = buildPaymentRecoveryImportTemplate({ exampleDate: new Date().toISOString().slice(0, 10) });
  return new Response(Buffer.from(bytes), {
    headers: {
      ...noStore,
      "Content-Disposition": "attachment; filename=payment-recovery-upload-template.xlsx",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }
  });
}
