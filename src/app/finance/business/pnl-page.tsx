import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { loadPnl } from "@/lib/finance/pnl-data";
import type { FinanceContext, Query } from "@/lib/finance/data";
import { PnlWorkspace } from "./pnl-workspace";
import { LiveRefresh } from "./refresh";
import "./pnl.css";

export async function PnlPage({
  context,
  query,
}: {
  context: FinanceContext;
  query: Query;
}) {
  let report;
  try {
    report = await loadPnl(context, query);
  } catch (error) {
    console.error(
      "Finance P&L load failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return (
      <AppShell active="Profit & Loss" pageCode="finance_pnl">
        <div className="live-pnl">
          <h1>Profit & loss</h1>
          <div className="pnl-notice" role="alert">
            <p>
              {error instanceof Error
                ? error.message
                : "P&L could not be loaded."}
            </p>
            <LiveRefresh />{" "}
            <Link href="/finance/business?tab=pnl">Reset filters</Link>
          </div>
        </div>
      </AppShell>
    );
  }
  return (
    <AppShell active="Profit & Loss" pageCode="finance_pnl">
      <PnlWorkspace key={JSON.stringify(report.filters)} report={report} />
    </AppShell>
  );
}
