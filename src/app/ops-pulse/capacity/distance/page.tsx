import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { AttendanceMultiSelect } from "@/components/attendance-multi-select";
import { CapacityDistanceTable } from "@/components/capacity-distance-table";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import {
  distanceMethods,
  distancePeriod,
  selectedDistanceStations,
} from "@/lib/ops-pulse/distance-register";
import { loadDistanceRegister } from "@/lib/ops-pulse/distance-register-data";
import styles from "@/components/capacity-distance.module.css";
export const dynamic = "force-dynamic";
type Params = Record<string, string | string[] | undefined>;
const values = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .flatMap((s) => s.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
export default async function DistancePage({
  searchParams = {},
}: {
  searchParams?: Params;
}) {
  const auth = await requirePagePermission("capacity_associates", "access"),
    companyId = requireCompanyId(auth);
  const scope = await loadCodLocations(
    companyId,
    auth.locationScopeIds,
    auth.hasAllLocationAccess,
  );
  const stations = scope.locations.filter(isAmazonEdspXptLocation),
    filters = {
      stations: values(searchParams.stations),
      regions: values(searchParams.regions),
      clusters: values(searchParams.clusters),
    };
  const selected = selectedDistanceStations(stations, filters),
    statuses = values(searchParams.status),
    methods = values(searchParams.method),
    q = one(searchParams.q) || "";
  let period = { from: todayKolkata().slice(0, 8) + "01", to: todayKolkata() },
    error = scope.error
      ? "Station access could not be loaded. Please retry."
      : "";
  let rows: Awaited<ReturnType<typeof loadDistanceRegister>> = [];
  try {
    period = distancePeriod(
      one(searchParams.from),
      one(searchParams.to),
      todayKolkata(),
    );
    if (!error)
      rows = await loadDistanceRegister(
        companyId,
        selected,
        period.from,
        period.to,
      );
  } catch (e) {
    error =
      e instanceof Error ? e.message : "Distance data could not be loaded.";
  }
  const options = (key: "region" | "cluster") =>
    [...new Set(stations.map((s) => s[key] || "Unassigned"))].sort();
  return (
    <AppShell active="Capacity" pageCode="capacity_associates">
      <div className={`ops-command-center ${styles.workspace}`}>
        <PageHead
          eyebrow="Capacity"
          title="Distance & Fuel"
          subtitle="Distance and fuel by associate. Open an associate for the daily breakdown and route details."
        />
        <CapacityWorkspaceTabs
          active="distance"
          allowed={allowedCapacityWorkspaceTabs(auth)}
        />
        <form
          className={styles.filters}
          method="get"
          aria-label="Distance filters"
        >
          <label>
            From
            <input
              type="date"
              name="from"
              defaultValue={period.from}
              max={todayKolkata()}
            />
          </label>
          <label>
            To
            <input
              type="date"
              name="to"
              defaultValue={period.to}
              max={todayKolkata()}
            />
          </label>
          <div className={styles.filterField}>
            <span>Region</span>
            <AttendanceMultiSelect
              name="regions"
              label="regions"
              allLabel="All regions"
              options={options("region")}
              defaultValues={filters.regions}
            />
          </div>
          <div className={styles.filterField}>
            <span>Cluster</span>
            <AttendanceMultiSelect
              name="clusters"
              label="clusters"
              allLabel="All clusters"
              options={options("cluster")}
              defaultValues={filters.clusters}
            />
          </div>
          <div className={styles.filterField}>
            <span>Station</span>
            <AttendanceMultiSelect
              name="stations"
              label="stations"
              allLabel="All stations"
              options={stations.map((s) => s.station_code)}
              defaultValues={filters.stations}
            />
          </div>
          <div className={styles.filterField}>
            <span>Status</span>
            <AttendanceMultiSelect
              name="status"
              label="statuses"
              allLabel="All statuses"
              options={["Ready", "Pending", "Needs attention"]}
              defaultValues={statuses}
            />
          </div>
          <div className={styles.filterField}>
            <span>Source</span>
            <AttendanceMultiSelect
              name="method"
              label="sources"
              allLabel="All sources"
              options={Object.values(distanceMethods)}
              defaultValues={methods}
            />
          </div>
          <label className={styles.search}>
            Associate / ID
            <input
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Name, Amazon or DropX ID"
            />
          </label>
          <button className="button compact" type="submit">
            Apply
          </button>
          <a className={styles.reset} href="/ops-pulse/capacity/distance">
            Reset
          </a>
        </form>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : (
          <CapacityDistanceTable
            rows={rows}
            filters={{ ...period, ...filters, statuses, methods, query: q }}
            key={JSON.stringify([period, filters, statuses, methods, q])}
          />
        )}
        <p className={styles.note}>
          Amazon EDSP &amp; XPT · associates mapped for kilometre-based fuel ·
          up to 31 days per view. Saved results refresh within a minute; maps
          load when opened. Pending distance is never counted as zero.
        </p>
      </div>
    </AppShell>
  );
}
