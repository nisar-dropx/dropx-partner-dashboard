import { redirect } from "next/navigation";
import { hasPermission, requirePagePermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

export default async function CodPage() {
  const authorization = await requirePagePermission("cod", "access");

  if (hasPermission(authorization, "cod_executive_reconciliation", "access")) {
    redirect("/ops-pulse/cod/executive-reconciliation");
  }
  if (hasPermission(authorization, "cod_submission", "access")) {
    redirect("/ops-pulse/cod/submission");
  }
  if (hasPermission(authorization, "cod_reports", "access")) {
    redirect("/ops-pulse/cod/reports");
  }
  if (hasPermission(authorization, "cod_cash_in_associate", "access")) {
    redirect("/ops-pulse/cod/cash-in-associate");
  }

  redirect("/dashboard");
}
