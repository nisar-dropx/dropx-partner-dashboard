import { requirePagePermission } from "@/lib/authorization";
import { LossCaseResponse } from "@/components/loss-case-response";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: { month?: string; case?: string } }) {
  await requirePagePermission("ops_losses", "access");
  const params = await searchParams;
  return <LossCaseResponse month={params.month || ""} caseKey={params.case || ""} />;
}
