import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import type { AuthorizationContext } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { requireStationEddAccess } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { loadStationEddNetworkSummary, type StationEddNetworkSummary } from "@/lib/ops-pulse/station-edd-summary";
import { StationEddNetworkClient } from "../../station-edd/station-edd-network-client";
import { StationEddNetworkSkeleton } from "../../station-edd/station-edd-network-skeleton";
import { EddSectionTabs } from "../edd-section-tabs";
import styles from "../../station-edd/station-edd.module.css";
import { eddQueryFromRecord, type EddQuery } from "@/lib/ops-pulse/edd-table-controls";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** The first paint waits this long for cached counts; anything slower is finished by the open tab. */
const FIRST_PAINT_BUDGET_MS = 4000;

async function StationEddNetwork({ authorization, query }: { authorization: AuthorizationContext; query: EddQuery }) {
  const stations = await loadEddStations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess);
  let network: StationEddNetworkSummary | null = null;
  let error: string | null = null;
  try { network = await loadStationEddNetworkSummary(stations.map(s => s.code), FIRST_PAINT_BUDGET_MS); }
  catch (cause) { error = cause instanceof Error ? cause.message : "Unable to load EDD backlog."; }
  return <StationEddNetworkClient stations={stations} initialNetwork={network} initialError={error} initialQuery={query} />;
}

export default async function StationEddPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const authorization = await requireStationEddAccess();
  return (
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead eyebrow="Ops Pulse · Delivery Performance" title="EDDs · All locations"
          subtitle="First-dispatch pending, delivery outcomes and HFR—across every location you manage."
          action={<TrackingIdSearch />} />
        <div className={styles.sectionNav}><EddSectionTabs active="edds" /></div>
        <Suspense fallback={<StationEddNetworkSkeleton />}>
          <StationEddNetwork authorization={authorization} query={eddQueryFromRecord(searchParams)} />
        </Suspense>
      </div>
    </AppShell>
  );
}
