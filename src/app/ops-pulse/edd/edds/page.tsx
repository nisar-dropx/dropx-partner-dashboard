import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrackingIdSearch } from "@/components/tracking-id-search";
import { requireCompanyId } from "@/lib/company-scope";
import { requireStationEddAccess } from "@/lib/ops-pulse/station-edd-access";
import { loadEddStations } from "@/lib/ops-pulse/edd-stations";
import { loadStationEddNetwork } from "@/lib/ops-pulse/station-edd-data";
import { type StationEddSummary } from "@/lib/ops-pulse/station-edd";
import { StationEddNetworkClient } from "../../station-edd/station-edd-network-client";
import { EddSectionTabs } from "../edd-section-tabs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function StationEddPage() {
  const authorization = await requireStationEddAccess();
  const stations = await loadEddStations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess);
  let network: StationEddSummary[] = [];
  let error: string | null = null;
  try { network = await loadStationEddNetwork(stations.map(s => s.code)); }
  catch (cause) { error = cause instanceof Error ? cause.message : "Unable to load EDD backlog."; }
  return (
    <AppShell active="Delivery Performance" pageCode="edd_dashboard">
      <div className="ops-command-center">
        <PageHead eyebrow="Ops Pulse · Delivery Performance" title="EDDs · All locations"
          subtitle="Station-wise pending expected deliveries. Open any location for tracking IDs, live history and detailed downloads."
          action={<TrackingIdSearch />} />
        <EddSectionTabs active="edds" />
        <StationEddNetworkClient stations={stations} initialNetwork={network} initialError={error} />
      </div>
    </AppShell>
  );
}
