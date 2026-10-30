import { requirePagePermission } from "@/lib/authorization";
import { LossCaseResponse } from "@/components/loss-case-response";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: { month?: string; case?: string; action?: string } }) {
  await requirePagePermission("ops_losses", "access");
  const params = await searchParams;
  return <LossCaseResponse key={`${params.month}|${params.case}|${params.action}`} month={params.month || ""} caseKey={params.case || ""} initialAction={params.action === "return" ? "return" : ""} />;
}
