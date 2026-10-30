import Link from "next/link";
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
  distancePeriod,
  filterDistanceScope,
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

/** Associates with Amazon ID not linked — once mapped, distance sync can settle. */
export default async function DistanceIdentityPage({
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
    q = one(searchParams.q) || "";
  const today = todayKolkata(),
    yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
      .toISOString()
      .slice(0, 10),
    requestedFrom = one(searchParams.from),
    defaultTo = requestedFrom && requestedFrom > yesterday ? today : yesterday;
  let period = { from: defaultTo.slice(0, 8) + "01", to: defaultTo },
    error = scope.error
      ? "Station access could not be loaded. Please retry."
      : "";
  let rows: Awaited<ReturnType<typeof loadDistanceRegister>> = [];
  try {
    period = distancePeriod(
      requestedFrom,
      one(searchParams.to) || defaultTo,
      today,
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
  const identityRows = filterDistanceScope(rows, {
    ...period,
    ...filters,
    methods: [],
    query: q,
  }).filter((r) => r.reason === "amazon_identity_missing");
  const options = (key: "region" | "cluster") =>
    [...new Set(stations.map((s) => s[key] || "Unassigned"))].sort();
  const backQs = new URLSearchParams();
  if (period.from) backQs.set("from", period.from);
  if (period.to) backQs.set("to", period.to);
  for (const s of filters.stations) backQs.append("stations", s);
  for (const s of filters.regions) backQs.append("regions", s);
  for (const s of filters.clusters) backQs.append("clusters", s);
  if (q) backQs.set("q", q);
  const backHref = `/ops-pulse/capacity/distance${backQs.toString() ? `?${backQs}` : ""}`;

  return (
    <AppShell active="Capacity" pageCode="capacity_associates">
      <div className={`ops-command-center ${styles.workspace}`}>
        <PageHead
          eyebrow="Capacity"
          title="Unlinked Amazon IDs"
          subtitle="Associates without an SCC / Flex transporter link. Link them in the workforce portal, then Sync — distance settles once the Amazon ID is mapped."
        />
        <CapacityWorkspaceTabs
          active="distance"
          allowed={allowedCapacityWorkspaceTabs(auth)}
        />
        <p className={styles.identityBanner}>
          <Link href={backHref} className={styles.identityBack}>
            ← Back to Distance &amp; Fuel
          </Link>
          <span>
            {identityRows.length} associate-
            {identityRows.length === 1 ? "day" : "days"} waiting for Amazon ID
            mapping in this selection.
          </span>
        </p>
        <form
          className={styles.filters}
          method="get"
          aria-label="Identity filters"
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
          <a
            className={styles.reset}
            href="/ops-pulse/capacity/distance/identity"
          >
            Reset
          </a>
        </form>
        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : (
          <CapacityDistanceTable
            rows={identityRows}
            filters={{
              ...period,
              ...filters,
              statuses: ["Needs attention"],
              methods: [],
              query: q,
            }}
            mode="identity"
            key={JSON.stringify([period, filters, q, identityRows.length])}
          />
        )}
        <p className={styles.note}>
          These days are not payable until the associate is linked to an Amazon
          transporter ID. After linking, use Sync on Distance &amp; Fuel (or wait
          for the 5:00 IST job) so the day can settle from GPS / road evidence.
        </p>
      </div>
    </AppShell>
  );
}
