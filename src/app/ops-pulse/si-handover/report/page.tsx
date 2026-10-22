import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { requirePagePermission } from "@/lib/authorization";
import {
  currentShift,
  isManager,
} from "@/lib/ops-pulse/si-handover/model";
import {
  enrichChecklistRows,
  summarizeReport,
} from "@/lib/ops-pulse/si-handover/report";
import { context, listChecklists } from "@/lib/ops-pulse/si-handover/server";
import styles from "../si-handover.module.css";
import { SiHandoverReportClient } from "./report-client";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams?: { from?: string; to?: string };
}) {
  await requirePagePermission("si_handover", "access");
  const c = await context();
  if (!isManager(c.actor, c.master.settings)) {
    return (
      <AppShell active="Activities & Handover" pageCode="si_handover">
        <div className={styles.page}>
          <header className={styles.hero}>
            <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
            <h1>Manager report</h1>
            <p>
              This report is for Store Managers and above who oversee Shift
              Incharges.{" "}
              <Link href="/si-handover?view=start">Open workspace</Link>
            </p>
          </header>
        </div>
      </AppShell>
    );
  }

  const cur = currentShift(new Date(), c.master.settings.shiftSlots);
  const defaultFrom = (() => {
    const d = new Date(`${cur.shiftDate}T12:00:00+05:30`);
    d.setDate(d.getDate() - 13);
    return d.toISOString().slice(0, 10);
  })();
  const from = searchParams?.from || defaultFrom;
  const to = searchParams?.to || cur.shiftDate;
  const { locations, rows } = await listChecklists(c.auth, c.master, {
    from,
    to,
    status: ["open", "submitted", "rejected", "accepted", "cancelled"],
  });
  const enriched = enrichChecklistRows(rows, locations, c.master.settings);
  const summary = summarizeReport(enriched);

  return (
    <AppShell active="Manager report" pageCode="si_handover">
      <SiHandoverReportClient
        from={from}
        to={to}
        summary={summary}
        rows={enriched}
        stores={locations}
      />
    </AppShell>
  );
}
