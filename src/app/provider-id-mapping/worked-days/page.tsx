import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { requirePagePermission } from "@/lib/authorization";
import {
  currentProviderMappingPageCode,
  canEditProviderMappings,
} from "@/lib/provider-mapping-access";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { WorkedIdReview } from "@/components/worked-id-review";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { nlPeopleClusters } from "@/lib/ops-pulse/nl-loss-clusters";

export const dynamic = "force-dynamic";

export default async function WorkedDaysPage() {
  const code = currentProviderMappingPageCode(),
    a = await requirePagePermission(code, "access"),
    company = requireCompanyId(a);
  const result = await supabaseAdmin!
    .from("stations")
    .select("id,station_code,station_name,region")
    .eq("company_id", company)
    .order("station_code");
  const locations = (result.data || []).filter(
    (s) =>
      a.hasAllLocationAccess ||
      a.isMasterOwner ||
      a.roleCode === "OWNER" ||
      a.locationScopeIds.includes(s.id),
  );
  const hierarchy = await loadPeopleOperationalHierarchy(company, locations.map(s => s.id));
  const owners = hierarchy.error ? null : nlPeopleClusters(locations, hierarchy.byLocation);
  const today = todayKolkata();
  const lastMonth = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(5, 7)) - 2,
    15,
  );
  const month = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
  return (
    <AppShell active="Worked ID review" pageCode={code}>
      <PageHead
        eyebrow="Workforce"
        title="Worked ID review"
        subtitle="Check biometric days and bulk attendance periods against deliveries on mapped IDs. Review differences before deciding pay."
      />
      {result.error || hierarchy.error ? (
        <p role="alert">Locations or current People ownership could not be loaded. Please retry.</p>
      ) : (
        <WorkedIdReview
          locations={locations.map(s => ({ ...s, ...owners!.byStation.get(s.id)! }))}
          managerOptions={owners!.options}
          initialMonth={month}
          canEdit={canEditProviderMappings(a)}
        />
      )}
    </AppShell>
  );
}
