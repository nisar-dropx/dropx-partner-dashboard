import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import {
  financeContext,
  loadPricing,
  canWritePricing,
} from "@/lib/finance/data";
import { PricingManager } from "./pricing-manager";
import "../../finance/finance.css";
import "../../finance/business.css";
export const dynamic = "force-dynamic";
export default async function PricingPage() {
  const context = await financeContext("finance_pricing");
  let error = "";
  let history: Awaited<ReturnType<typeof loadPricing>> = [];
  try {
    history = await loadPricing(context);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to load pricing.";
  }
  return (
    <AppShell active="Pricing Master" pageCode="finance_pricing">
      <PageHead
        eyebrow="Master"
        title="Pricing Master"
        subtitle="Monthly client rate cards. Changes are versioned, so previous rates and their source remain available."
      />
      {error ? (
        <div className="fin-notice error" role="alert">
          {error}
        </div>
      ) : (
        <PricingManager
          history={history}
          locations={context.locations.map((l) => ({
            code: l.station_code,
            name: l.station_name || l.station_code,
            model: l.pricing_model,
            parent: l.parent_station_code,
          }))}
          canAdd={canWritePricing(context.authorization, 0)}
          canEdit={canWritePricing(context.authorization, 1)}
        />
      )}
    </AppShell>
  );
}
