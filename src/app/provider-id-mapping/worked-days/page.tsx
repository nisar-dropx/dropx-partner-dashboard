import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { currentProviderMappingPageCode } from "@/lib/provider-mapping-access";

export const dynamic = "force-dynamic";

export default async function WorkedDaysPage({ searchParams }: { searchParams?: { month?: string } }) {
  await requirePagePermission(currentProviderMappingPageCode(), "access");
  const params = new URLSearchParams({ view: "review" });
  if (searchParams?.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(searchParams.month)) {
    params.set("month", searchParams.month);
  }
  redirect(`/provider-id-mapping?${params}`);
}
