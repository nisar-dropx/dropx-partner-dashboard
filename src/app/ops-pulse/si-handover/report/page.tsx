import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import {
  getAuthorization,
  hasPermission,
} from "@/lib/authorization";
import {
  currentShift,
  isManager as isSiManager,
} from "@/lib/ops-pulse/si-handover/model";
import {
  enrichChecklistRows as enrichSiRows,
  summarizeReport as summarizeSi,
} from "@/lib/ops-pulse/si-handover/report";
import {
  context as siContext,
  listChecklists as listSi,
} from "@/lib/ops-pulse/si-handover/server";
import { isManager as isStoreManager } from "@/lib/ops-pulse/store-ops/model";
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

export default async function Page({
  searchParams,
}: {
  searchParams?: { from?: string; to?: string; tab?: string };
}) {
  const auth = await getAuthorization();
  if (!auth?.companyId) redirect("/unauthorized?reason=access");
  const canSi = hasPermission(auth, "si_handover", "access");
  const canStore = hasPermission(auth, "store_ops", "access");
  if (!canSi && !canStore) {
    redirect("/unauthorized?page=si_handover&reason=access");
  }

  const tabRaw = searchParams?.tab === "store" ? "store" : "shift";
  const tab =
    tabRaw === "store" && canStore
      ? "store"
      : tabRaw === "shift" && canSi
        ? "shift"
        : canSi
          ? "shift"
          : "store";

  const pageCode = canSi ? "si_handover" : "store_ops";

  if (tab === "shift") {
    const c = await siContext();
    if (!isSiManager(c.actor, c.master.settings)) {
      return (
        <AppShell active="Shift report" pageCode={pageCode}>
          <div className={styles.page}>
            <header className={styles.hero}>
              <p className={styles.eyebrow}>Dark Store · Activities & Handover</p>
              <h1>Shift operations report</h1>
              <p>
                This report is for managers who oversee Shift Incharges.{" "}
                <Link href="/si-handover?view=start">Open shift operations</Link>
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
    const { locations, rows } = await listSi(c.auth, c.master, {
      from,
      to,
      status: ["open", "submitted", "rejected", "accepted", "cancelled"],
    });
    const enriched = enrichSiRows(rows, locations, c.master.settings);
    const summary = summarizeSi(enriched);

    return (
      <AppShell active="Shift report" pageCode={pageCode}>
        <ActivitiesReportClient
          tab="shift"
          from={from}
          to={to}
          showShift={canSi}
          showStore={canStore}
          shift={{ summary, rows: enriched, stores: locations }}
        />
      </AppShell>
    );
  }

  const c = await storeContext();
  if (!isStoreManager(c.actor, c.master.settings) && !c.actor.isMasterOwner) {
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

  const today = todayIst();
  const defaultFrom = (() => {
    const d = new Date(`${today}T12:00:00+05:30`);
    d.setDate(d.getDate() - 13);
    return d.toISOString().slice(0, 10);
  })();
  const from = searchParams?.from || defaultFrom;
  const to = searchParams?.to || today;
  const { locations, rows } = await listStore(c.auth, c.master, {
    from,
    to,
    status: ["open", "submitted", "cancelled"],
  });
  const enriched = enrichStoreRows(rows, locations, c.master.settings);
  const summary = summarizeStore(enriched);

  return (
    <AppShell active="Store report" pageCode={pageCode}>
      <ActivitiesReportClient
        tab="store"
        from={from}
        to={to}
        showShift={canSi}
        showStore={canStore}
        store={{ summary, rows: enriched, stores: locations }}
      />
    </AppShell>
  );
}
