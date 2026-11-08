import workspace from "@/components/id-mapping-workspace.module.css";
import Link from "next/link";
import { AppShell } from "./app-shell";
import { PageHead } from "./page-head";
import { WorkedIdReview } from "./worked-id-review";
import { requirePagePermission } from "@/lib/authorization";
import {
  canEditProviderMappings,
  currentProviderMappingPageCode,
} from "@/lib/provider-mapping-access";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import { nlPeopleClusters } from "@/lib/ops-pulse/nl-loss-clusters";
import { todayKolkata } from "@/lib/ops-pulse/cod";

export async function DailyIdUsageSection({ month, review = false }: { month?: string; review?: boolean }) {
  const code = currentProviderMappingPageCode(),
    auth = await requirePagePermission(code, "access");
  const company = requireCompanyId(auth);
  const result = await supabaseAdmin!
    .from("stations")
    .select("id,station_code,station_name,region")
    .eq("company_id", company)
    .order("station_code");
  const locations = (result.data || []).filter(
    (s) =>
      auth.hasAllLocationAccess ||
      auth.isMasterOwner ||
      auth.roleCode === "OWNER" ||
      auth.locationScopeIds.includes(s.id),
  );
  const hierarchy = await loadPeopleOperationalHierarchy(
    company,
    locations.map((s) => s.id),
  );
  const owners = hierarchy.error
    ? null
    : nlPeopleClusters(locations, hierarchy.byLocation);
  const today = todayKolkata(),
    previous = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const initialMonth =
    month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
      ? month
      : previous.toISOString().slice(0, 7);
  return (
    <AppShell active="ID Mapping" pageCode={code}>
      <div className={workspace.workspace}>
        <PageHead
          eyebrow="ID & pay mapping"
          title={review ? "Worked ID review" : "Daily ID usage"}
          subtitle={review ? "Review attendance and delivery differences before deciding pay." : "See who owns each ID, who worked on it, and review selected dates before payout."}
        />
        <nav className={workspace.nav} aria-label="ID mapping views">
          <Link href="/provider-id-mapping">ID & pay mapping</Link>
          <Link aria-current={!review ? "page" : undefined} href="/provider-id-mapping?view=days">
            Daily ID usage
          </Link>
          <Link aria-current={review ? "page" : undefined} href="/provider-id-mapping?view=review">Worked ID review</Link>
          <Link href="/provider-mapping/direct-pay">
            Direct pay allocations
          </Link>
        </nav>
        {result.error || hierarchy.error ? (
          <p role="alert">Unable to load permitted stations. Please refresh.</p>
        ) : (
          <WorkedIdReview
            dailyUsage={!review}
            locations={locations.map((s) => ({
              ...s,
              ...owners!.byStation.get(s.id)!,
            }))}
            managerOptions={owners!.options}
            initialMonth={initialMonth}
            canEdit={canEditProviderMappings(auth)}
          />
        )}
      </div>
    </AppShell>
  );
}
