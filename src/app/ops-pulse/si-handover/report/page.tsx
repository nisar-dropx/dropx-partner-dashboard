import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getAuthorization } from "@/lib/authorization";
import { resolveActivitiesNavAccess } from "@/lib/ops-pulse/activities-nav-access";
import { currentShift } from "@/lib/ops-pulse/si-handover/model";
import {
  enrichChecklistRows as enrichSiRows,
  summarizeReport as summarizeSi,
} from "@/lib/ops-pulse/si-handover/report";
import {
  context as siContext,
  listChecklists as listSi,
} from "@/lib/ops-pulse/si-handover/server";
import {
  enrichChecklistRows as enrichStoreRows,
  summarizeReport as summarizeStore,
} from "@/lib/ops-pulse/store-ops/report";
import {
  context as storeContext,
  listChecklists as listStore,
} from "@/lib/ops-pulse/store-ops/server";
import { todayIst } from "@/lib/ops-pulse/store-ops/model";
import styles from "../si-handover.module.css";
import { ActivitiesReportClient } from "./report-client";

export const dynamic = "force-dynamic";

function priorEqualWindow(from: string, to: string) {
  const fromD = new Date(`${from}T12:00:00+05:30`);
  const toD = new Date(`${to}T12:00:00+05:30`);
  const days =
    Math.max(1, Math.round((toD.getTime() - fromD.getTime()) / 86400000) + 1);
  const priorTo = new Date(fromD);
  priorTo.setDate(priorTo.getDate() - 1);
  const priorFrom = new Date(priorTo);
  priorFrom.setDate(priorFrom.getDate() - (days - 1));
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return { from: fmt(priorFrom), to: fmt(priorTo) };
}

export default async function Page({
  searchParams,
}: {
  searchParams?: { from?: string; to?: string; tab?: string };
}) {
  const auth = await getAuthorization();
  if (!auth?.companyId) redirect("/unauthorized?reason=access");
  const nav = await resolveActivitiesNavAccess(auth);
  if (!nav.showShiftReport && !nav.showStoreReport) {
    redirect("/unauthorized?page=si_handover&reason=access");
  }

  const tabRaw = searchParams?.tab === "store" ? "store" : "shift";
  const tab =
    tabRaw === "store" && nav.showStoreReport
      ? "store"
      : tabRaw === "shift" && nav.showShiftReport
        ? "shift"
        : nav.showShiftReport
          ? "shift"
          : "store";

  const pageCode = nav.showShiftOps ? "si_handover" : "store_ops";

  if (tab === "shift") {
    if (!nav.showShiftReport) {
      redirect("/si-handover/report?tab=store");
    }
    const c = await siContext();
    const cur = currentShift(new Date(), c.master.settings.shiftSlots);
    const today = cur.shiftDate;
    const from = searchParams?.from || today;
    const to = searchParams?.to || today;
    const prior = priorEqualWindow(from, to);
    const [{ locations, rows }, priorList] = await Promise.all([
      listSi(c.auth, c.master, {
        from,
        to,
        status: ["open", "submitted", "rejected", "accepted", "cancelled"],
      }),
      listSi(c.auth, c.master, {
        from: prior.from,
        to: prior.to,
        status: ["open", "submitted", "rejected", "accepted", "cancelled"],
      }),
    ]);
    const enriched = enrichSiRows(rows, locations, c.master.settings);
    const priorEnriched = enrichSiRows(
      priorList.rows,
      locations,
      c.master.settings,
    );
    const summary = summarizeSi(enriched, priorEnriched);

    return (
      <AppShell active="Shift report" pageCode={pageCode}>
        <ActivitiesReportClient
          tab="shift"
          from={from}
          to={to}
          showShift={nav.showShiftOps}
          showStore={nav.showStoreOps}
          showShiftReport={nav.showShiftReport}
          showStoreReport={nav.showStoreReport}
          shift={{ summary, rows: enriched, stores: locations }}
        />
      </AppShell>
    );
  }

  if (!nav.showStoreReport) {
    return (
      <AppShell active="Store report" pageCode={pageCode}>
        <div className={styles.page}>
          <header className={styles.hero}>
            <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
            <h1>Store operations report</h1>
            <p>
              This report is for City Managers and above who oversee Store
              Managers.{" "}
              <Link href="/store-ops?view=start">Open store operations</Link>
            </p>
          </header>
        </div>
      </AppShell>
    );
  }

  const c = await storeContext();
  const today = todayIst();
  const from = searchParams?.from || today;
  const to = searchParams?.to || today;
  const prior = priorEqualWindow(from, to);
  const [{ locations, rows }, priorList] = await Promise.all([
    listStore(c.auth, c.master, {
      from,
      to,
      status: ["open", "submitted", "cancelled"],
    }),
    listStore(c.auth, c.master, {
      from: prior.from,
      to: prior.to,
      status: ["open", "submitted", "cancelled"],
    }),
  ]);
  const enriched = enrichStoreRows(rows, locations, c.master.settings);
  const priorEnriched = enrichStoreRows(
    priorList.rows,
    locations,
    c.master.settings,
  );
  const summary = summarizeStore(enriched, priorEnriched);

  return (
    <AppShell active="Store report" pageCode={pageCode}>
      <ActivitiesReportClient
        tab="store"
        from={from}
        to={to}
        showShift={nav.showShiftOps}
        showStore={nav.showStoreOps}
        showShiftReport={nav.showShiftReport}
        showStoreReport={nav.showStoreReport}
        store={{ summary, rows: enriched, stores: locations }}
      />
    </AppShell>
  );
}
