"use client";

import { useState, type ReactNode } from "react";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { WorkforcePayoutStationReview } from "@/components/workforce-payout-station-review";
import { WorkforcePayoutLocationContext } from "@/components/workforce-payout-location-context";
import type {
  WorkforceStationFinanceRequest,
  WorkforceStationReleaseState
} from "@/lib/workforce-payout-station-finance-types";

/**
 * Owns the station→worksheet location filter so station review and the payout
 * table stay in sync without a second data load.
 */
export function WorkforcePayoutStationBoard({
  rows,
  paymentReleaseHref,
  lifecycleWarning,
  audience,
  periodStart,
  periodEnd,
  canConfirmStations,
  canSubmitFinance,
  canDecideFinance,
  releases,
  financeRequests,
  children
}: {
  rows: WorkforcePayoutRow[];
  paymentReleaseHref?: string | null;
  lifecycleWarning?: string | null;
  audience: "workforce" | "helpers";
  periodStart: string;
  periodEnd: string;
  canConfirmStations: boolean;
  canSubmitFinance: boolean;
  canDecideFinance: boolean;
  releases: WorkforceStationReleaseState[];
  financeRequests: WorkforceStationFinanceRequest[];
  children: ReactNode;
}) {
  const [locations, setLocations] = useState<string[]>([]);

  return <WorkforcePayoutLocationContext.Provider value={{ locations, onLocationsChange: setLocations }}>
    <WorkforcePayoutStationReview
      rows={rows}
      selectedStations={locations}
      onSelectedStationsChange={setLocations}
      paymentReleaseHref={paymentReleaseHref}
      audience={audience}
      periodStart={periodStart}
      periodEnd={periodEnd}
      canConfirmStations={canConfirmStations}
      canSubmitFinance={canSubmitFinance}
      canDecideFinance={canDecideFinance}
      releases={releases}
      financeRequests={financeRequests}
    />
    {lifecycleWarning
      ? <section className="panel message-panel warn" role="status">
          <div className="panel-body">
            <strong>Worksheet loaded with limited payment status</strong>
            <p className="subtle">{lifecycleWarning} Station review and calculated rows remain available. Retry after the payment ledger responds, or continue publishing and reviewing stations.</p>
          </div>
        </section>
      : null}
    {children}
  </WorkforcePayoutLocationContext.Provider>;
}
