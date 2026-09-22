import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { canWriteRent, financeContext, loadRent } from "@/lib/finance/data";
import { RentManager } from "./rent-manager";
import "../../finance/finance.css";
import "../../finance/business.css";

export const dynamic = "force-dynamic";

export default async function RentPage() {
  const context = await financeContext("finance_rent");
  let error = "";
  let records: Awaited<ReturnType<typeof loadRent>> = [];
  try {
    records = await loadRent(context);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Unable to load rent.";
  }
  return (
    <AppShell active="Rent Master" pageCode="finance_rent">
      <PageHead
        eyebrow="Master · Operating costs"
        title="Rent Master"
        subtitle="Maintain each active premise agreement and its Finance allocation. Monthly rent and maintenance accrue by the selected month’s actual calendar days."
      />
      {error ? (
        <div className="fin-notice error" role="alert">
          {error}
        </div>
      ) : (
        <RentManager
          records={records}
          locations={context.locations.map((location) => ({
            code: location.station_code,
            name: location.station_name || location.station_code,
            region: location.region || "Unassigned",
            parent: location.parent_station_code,
          }))}
          canAdd={canWriteRent(context.authorization, false)}
          canEdit={canWriteRent(context.authorization, true)}
        />
      )}
    </AppShell>
  );
}
