import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CapacityWorkspaceTabs } from "@/components/capacity-workspace-tabs";
import { MapAmazonIdForm } from "@/components/map-amazon-id-form";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
import { allowedCapacityWorkspaceTabs } from "@/lib/ops-pulse/capacity-access";
import type { AmazonTransporterAssignment } from "@/lib/ops-pulse/amazon-transporter-assignments";
import { supabaseAdmin } from "@/lib/supabase-admin";
import styles from "@/components/capacity-distance.module.css";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";

function isIsoDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + "T00:00:00Z")) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s
  );
}

function collectStationDriverIds(snapshotDrivers: unknown, routeIds: string[]): string[] {
  const ids = new Set<string>();
  if (Array.isArray(snapshotDrivers)) {
    for (const d of snapshotDrivers) {
      const tid = String((d as { tasId?: string })?.tasId || "").trim().toUpperCase();
      if (/^A[A-Z0-9]{5,31}$/.test(tid)) ids.add(tid);
    }
  }
  for (const id of routeIds) {
    const tid = String(id || "").trim().toUpperCase();
    if (/^A[A-Z0-9]{5,31}$/.test(tid)) ids.add(tid);
  }
  return [...ids].sort();
}

export default async function MapAmazonIdPage({
  searchParams = {},
}: {
  searchParams?: Params;
}) {
  const auth = await requirePagePermission("capacity_associates", "access");
  const companyId = requireCompanyId(auth);
  const workforceId = one(searchParams.workforce);
  const stationId = one(searchParams.station);
  const today = todayKolkata();
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000)
    .toISOString()
    .slice(0, 10);
  const flashError = one(searchParams.error);
  const flashNotice = one(searchParams.notice);

  // Mapper dates are free-form handoff ranges (not the 31-day register window).
  const rawFrom = one(searchParams.from);
  const rawTo = one(searchParams.to);
  let period = {
    from: isIsoDate(rawFrom) ? rawFrom : yesterday.slice(0, 8) + "01",
    to: isIsoDate(rawTo) ? rawTo : yesterday,
  };
  if (period.from > period.to) period = { from: period.to, to: period.from };

  const scope = await loadCodLocations(
    companyId,
    auth.locationScopeIds,
    auth.hasAllLocationAccess,
  );
  const stations = scope.locations.filter(isAmazonEdspXptLocation);
  const station = stations.find((s) => s.id === stationId);

  let person: { id: string; full_name: string | null; dropx_id: string | null } | null = null;
  let driverIds: string[] = [];
  let assignments: AmazonTransporterAssignment[] = [];
  let loadError = scope.error
    ? "Station access could not be loaded. Please retry."
    : !workforceId || !stationId
      ? "Open Map Amazon ID from an unlinked associate row."
      : !station
        ? "Station not found in your scope."
        : !supabaseAdmin
          ? "Database is unavailable."
          : "";

  if (!loadError && supabaseAdmin) {
    const [personRes, snapRes, routeRes, assignRes] = await Promise.all([
      supabaseAdmin
        .from("workforce")
        .select("id,full_name,dropx_id")
        .eq("company_id", companyId)
        .eq("id", workforceId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabaseAdmin
        .from("workforce_route_scc_snapshots")
        .select("drivers")
        .eq("company_id", companyId)
        .eq("station_id", stationId)
        .maybeSingle(),
      supabaseAdmin
        .from("workforce_route_distances")
        .select("transporter_id")
        .eq("company_id", companyId)
        .eq("station_id", stationId)
        .gte("work_date", period.from)
        .lte("work_date", period.to)
        .not("transporter_id", "is", null)
        .limit(2000),
      supabaseAdmin
        .from("workforce_amazon_transporter_assignments")
        .select(
          "id,company_id,station_id,workforce_id,transporter_id,effective_from,effective_to,created_at,updated_at",
        )
        .eq("company_id", companyId)
        .eq("station_id", stationId)
        .eq("workforce_id", workforceId)
        .order("effective_from", { ascending: false }),
    ]);

    if (personRes.error || !personRes.data) {
      loadError = "Associate not found.";
    } else if (assignRes.error) {
      loadError =
        "Amazon ID assignment table is not available yet. Apply the transporter assignments migration.";
    } else {
      person = personRes.data;
      const routeIds = (routeRes.data || []).map((r) => String(r.transporter_id || ""));
      driverIds = collectStationDriverIds(snapRes.data?.drivers, routeIds);
      assignments = (assignRes.data || []) as AmazonTransporterAssignment[];
    }
  }

  const backQs = new URLSearchParams();
  if (period.from) backQs.set("from", period.from);
  if (period.to) backQs.set("to", period.to);
  const backHref = `/ops-pulse/capacity/distance/identity${backQs.toString() ? `?${backQs}` : ""}`;

  return (
    <AppShell active="Capacity" pageCode="capacity_associates">
      <div className={`ops-command-center ${styles.workspace}`}>
        <PageHead
          eyebrow="Capacity"
          title="Map Amazon ID"
          subtitle="Set only the Amazon driver ID and date range for this associate at this station."
        />
        <CapacityWorkspaceTabs
          active="distance"
          allowed={allowedCapacityWorkspaceTabs(auth)}
        />
        <p className={styles.identityBanner}>
          <Link href={backHref} className={styles.identityBack}>
            ← Back to Unlinked Amazon IDs
          </Link>
          {person && station ? (
            <span>
              {person.full_name || "Associate"} · {person.dropx_id || "—"} ·{" "}
              {station.station_code}
            </span>
          ) : null}
        </p>

        {flashError ? (
          <div className={styles.error} role="alert">
            {flashError}
          </div>
        ) : null}
        {flashNotice ? (
          <div className={styles.notice} role="status">
            {flashNotice}
          </div>
        ) : null}
        {loadError ? (
          <div className={styles.error} role="alert">
            {loadError}
          </div>
        ) : person && station ? (
          <MapAmazonIdForm
            workforceId={workforceId}
            stationId={stationId}
            defaultFrom={period.from}
            defaultTo={period.to}
            driverIds={driverIds}
            assignments={assignments}
          />
        ) : null}

        <p className={styles.note}>
          Same Amazon driver ID can move between associates on different dates.
          Two associates cannot share it on the same station-day. After Apply,
          Distance sync runs for days in the last 35 days.
        </p>
      </div>
    </AppShell>
  );
}
