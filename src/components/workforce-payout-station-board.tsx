"use client";

import { useState, type ReactNode } from "react";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";
import { WorkforcePayoutStationReview } from "@/components/workforce-payout-station-review";

/**
 * Owns the station→worksheet location filter so station review and the payout
 * table stay in sync without a second data load.
 */
export function WorkforcePayoutStationBoard({
  rows,
  paymentReleaseHref,
  lifecycleWarning,
  renderWorksheet
}: {
  rows: WorkforcePayoutRow[];
  paymentReleaseHref?: string | null;
  lifecycleWarning?: string | null;
  renderWorksheet: (api: {
    locations: string[];
    onLocationsChange: (locations: string[]) => void;
  }) => ReactNode;
}) {
  const [locations, setLocations] = useState<string[]>([]);

  return <>
    <WorkforcePayoutStationReview
      rows={rows}
      selectedStations={locations}
      onSelectedStationsChange={setLocations}
      paymentReleaseHref={paymentReleaseHref}
    />
    {lifecycleWarning
      ? <section className="panel message-panel warn" role="status">
          <div className="panel-body">
            <strong>Worksheet loaded with limited payment status</strong>
            <p className="subtle">{lifecycleWarning} Station review and calculated rows remain available. Retry after the payment ledger responds, or continue publishing and reviewing stations.</p>
          </div>
        </section>
      : null}
    {renderWorksheet({ locations, onLocationsChange: setLocations })}
  </>;
}
