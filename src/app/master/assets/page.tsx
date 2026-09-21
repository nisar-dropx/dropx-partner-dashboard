import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission } from "@/lib/authorization";
import { loadAssetRegister } from "@/lib/assets";
import { financeContext } from "@/lib/finance/data";
import { AssetManager } from "./asset-manager";
import "../../finance/finance.css";

export const dynamic = "force-dynamic";

export default async function AssetRegisterPage() {
  const context = await financeContext("finance_assets");
  const register = await loadAssetRegister(context);
  const locations = context.locations.map((location) => ({ id: location.id, label: `${location.station_code} · ${location.station_name || location.city || "Location"}` }));
  return <AppShell active="Asset Register" pageCode="finance_assets">
    <PageHead eyebrow="Finance · Asset control" title="Asset master register" subtitle="Keep owned, rented and leased physical assets under one code, label and auditable lifecycle." />
    <AssetManager assets={register.assets} locations={locations} canAdd={hasPermission(context.authorization, "finance_assets", "add")} canEdit={hasPermission(context.authorization, "finance_assets", "edit")} />
  </AppShell>;
}
