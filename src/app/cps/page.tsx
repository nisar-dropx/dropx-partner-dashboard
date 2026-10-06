import { CpsLink as Link } from "@/components/cps-link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CpsFilters } from "@/components/cps-filters";
import { CpsAllocationSettings } from "@/components/cps-allocation-settings";
import { CpsInputs } from "@/components/cps-inputs";
import { CpsExplorer } from "@/components/cps-explorer";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import {
  cpsView,
  cpsViews,
  cpsPeriod,
  type CpsParams,
} from "@/lib/ops-pulse/cps";
import {
  cpsScope,
  loadCpsInputs,
  loadCpsSnapshot,
} from "@/lib/ops-pulse/cps-data";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import "./cps.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export default async function CpsPage({
  searchParams = {},
}: {
  searchParams?: CpsParams;
}) {
  const params = Object.fromEntries(
    Object.entries(searchParams).filter(([, v]) => typeof v === "string"),
  ) as CpsParams;
  const view = cpsView(params.view);
  const auth = await requirePagePermission(cpsViews[view].permission, "access");
  const query = (changes: Record<string, string>) => {
    const q = new URLSearchParams(params as Record<string, string>);
    Object.entries(changes).forEach(([k, v]) =>
      v ? q.set(k, v) : q.delete(k),
    );
    q.delete("page");
    return `/cps?${q}`;
  };
  try {
    const scope = await cpsScope(
      auth,
      view === "inputs" ? params : { ...params, station: undefined },
      view !== "inputs",
    );
    const { period, all, selected, companyId } = scope;
    let loadError = "";
    const [snapshot, inputs] = await Promise.all([
      view === "inputs"
        ? null
        : loadCpsSnapshot(companyId, period.from, period.to, selected).catch(
            (error) => {
              console.error(
                "CPS data load",
                error instanceof Error ? error.message : "Unknown error",
              );
              loadError =
                error instanceof Error
                  ? error.message
                  : "Costs could not be loaded.";
              return null;
            },
          ),
      view === "inputs"
        ? loadCpsInputs(
            companyId,
            all.map((l) => l.station_code),
            auth.hasAllLocationAccess,
          )
        : null,
    ]);
    const canExport = hasPermission(auth, "cps_reports", "access");
    return (
      <AppShell active="CPS" pageCode={cpsViews[view].permission}>
        <div className="ops-command-center cps-workspace">
          <PageHead
            eyebrow="OPS PULSE · COST PER SHIPMENT"
            title={inputs ? "CPS cost setup" : "Cost per shipment"}
            subtitle="One view of station costs, with the detail behind every rupee."
          />
          <nav className="cps-tabs" aria-label="CPS views">
            <Link
              prefetch={false}
              className={!inputs ? "active" : ""}
              href={query({ view: "overview" })}
            >
              Cost overview
            </Link>
            {hasPermission(auth, "cps_overview", "access") && (
              <Link prefetch={false} href="/cps/adhoc-activity">
                Adhoc Van &amp; DA
              </Link>
            )}
            {hasPermission(auth, "cps_inputs", "access") && (
              <Link
                prefetch={false}
                className={inputs ? "active" : "cps-setup-link"}
                href={query({ view: "inputs" })}
              >
                Cost setup
              </Link>
            )}
          </nav>
          {inputs ? (
            <>
              <section className="cps-source-guide">
                <h2>Costs flow from their original masters</h2>
                <p>
                  People CTC, Dashboard DA payments, Finance station rent, Fleet
                  vehicle rent, fuel imports, approved payments and cashbook
                  and actual Meta advertising spend feed CPS automatically. Use the forms below only for
                  additional costs or allocation overrides.
                </p>
                <div>
                  <a href="/master/advertising">Advertising master</a>
                  <a href="https://finance.dropxlogistics.com/master/rent">
                    Station rent master
                  </a>
                  <a href="https://fleet.dropxlogistics.com/fleet-control?section=masters&master=vehicle_master">
                    Vehicle master
                  </a>
                  <a href="https://dashboard.dropxlogistics.com/provider-id-mapping">
                    DA payment mappings
                  </a>
                </div>
              </section>
              <CpsAllocationSettings />
              <CpsInputs
                employees={inputs.employees}
                costs={inputs.costs}
                targets={inputs.targets}
                targetStations={all.filter(l => !l.is_xpt).map(l => l.station_code)}
                stations={all.map((l) => l.station_code)}
                today={todayKolkata()}
                canAdd={
                  !auth.readOnly && hasPermission(auth, "cps_inputs", "add")
                }
                canEdit={
                  !auth.readOnly && hasPermission(auth, "cps_inputs", "edit")
                }
              />
            </>
          ) : (
            <>
              <CpsFilters
                key={JSON.stringify(params)}
                params={{ ...params, view }}
                period={period}
                today={todayKolkata()}
              />
              <div className="cps-period">
                <strong>
                  {period.from} – {period.to}
                </strong>
                <span>
                  {selected.length} stations · {period.days} days
                </span>
                <small>Calendar-day accrual for monthly costs</small>
              </div>
              {snapshot && selected.length > 0 ? (
                <>
                  <CpsExplorer
                    key={JSON.stringify({
                      scope: selected.map((l) => l.station_code),
                    })}
                    snapshot={{ ...snapshot, associates: undefined }}
                    places={selected.map((l) => ({
                      code: l.station_code,
                      name: l.station_name || l.city || l.station_code,
                      parent: l.parent_station_code,
                      isXpt: l.is_xpt,
                    }))}
                    params={params}
                    canExport={canExport}
                    canEditBilling={
                      !auth.readOnly &&
                      hasPermission(auth, "cps_inputs", "edit")
                    }
                    canResolve={hasPermission(auth, "cps_unmapped", "access")}
                  />
                  <section className="cps-source-freshness">
                    <strong>Latest source dates</strong>
                    <span>
                      Shipments: {snapshot.source_dates?.shipments || "No data"}
                    </span>
                    <span>
                      Fuel: {snapshot.source_dates?.fuel || "No data"}
                    </span>
                    <span>
                      Cashbook: {snapshot.source_dates?.cashbook || "No data"}
                    </span>
                    <small>
                      Dates show the latest records within your selected scope,
                      up to the report end date.
                    </small>
                  </section>
                </>
              ) : (
                <section className="panel">
                  <p
                    className="panel-body"
                    role={loadError ? "alert" : undefined}
                  >
                    {loadError || "No permitted locations match these filters."}
                  </p>
                  {loadError && (
                    <p className="panel-body">
                      Your date controls are still available. Choose another
                      period or use Refresh data to retry.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </AppShell>
    );
  } catch (error) {
    console.error(
      "CPS workspace",
      error instanceof Error ? error.message : "Unknown error",
    );
    return (
      <AppShell active="CPS" pageCode={cpsViews[view].permission}>
        <div className="ops-command-center cps-workspace">
          <PageHead
            title="Cost per shipment"
            subtitle="CPS could not be loaded."
          />
          <CpsFilters
            params={{ view: "overview" }}
            period={cpsPeriod({}, todayKolkata())}
            today={todayKolkata()}
          />
          <section className="panel">
            <p className="panel-body" role="alert">
              {error instanceof Error
                ? error.message
                : "Please refresh and try again."}
            </p>
            <Link className="button" href={query({})}>
              Try again
            </Link>
          </section>
        </div>
      </AppShell>
    );
  }
}
