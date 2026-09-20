import { CpsLink as Link } from "@/components/cps-link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { CpsFilters } from "@/components/cps-filters";
import { CpsInputs } from "@/components/cps-inputs";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import {
  cpsView,
  cpsViews,
  cpsIssues,
  groupCps,
  ratio,
  summarizeCps,
  type CpsParams,
} from "@/lib/ops-pulse/cps";
import {
  cpsScope,
  loadCpsAssociates,
  loadCpsInputs,
  loadCpsSnapshot,
} from "@/lib/ops-pulse/cps-data";
import { adHocClusterLabel } from "@/lib/ops-pulse/adhoc-activity";
import { todayKolkata } from "@/lib/ops-pulse/cod";
import "./cps.css";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const money = (n: number | null, digits = 0) =>
  n == null
    ? "—"
    : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
const count = (n: number) =>
  Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
type Summary = ReturnType<typeof summarizeCps>;
function Status({ value }: { value: Summary }) {
  return (
    <span className={`cps-status ${value.provisional ? "pending" : "ready"}`}>
      {value.provisional ? "Provisional" : "Recorded"}
    </span>
  );
}
function CostCells({ row }: { row: Summary }) {
  return <><td>{count(row.deliveries)}</td><td>{money(row.total)}</td><td><strong>{money(row.cps,2)}</strong></td><td>{money(ratio(row.salary,row.deliveries),2)}</td><td>{count(row.exposedDeliveries)}</td><td><Status value={row}/></td></>;
}
function CostHeaders({ first }: { first: string }) {
  return <thead><tr>{[first,"Delivered","Total cost","CPS","DA salary CPS","Uncosted deliveries","Status"].map(h=><th key={h}>{h}</th>)}</tr></thead>;
}

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
    const { period, all, selected, companyId } = await cpsScope(auth, params);
    const page = Math.max(
      1,
      Math.min(10000, Math.floor(Number(params.page) || 1)),
    );
    const [snapshot, associates, inputs] = await Promise.all([
      view === "inputs"
        ? null
        : loadCpsSnapshot(companyId, period.from, period.to, selected),
      view === "associates"
        ? loadCpsAssociates(
            companyId,
            period.from,
            period.to,
            selected.map((l) => l.station_code),
            page,
          )
        : null,
      view === "inputs"
        ? loadCpsInputs(
            companyId,
            all.map((l) => l.station_code),
            auth.hasAllLocationAccess,
          )
        : null,
    ]);
    const days = snapshot?.daily ?? [],
      totals = summarizeCps(days);
    const stations = groupCps(days, (r) => r.station_code).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    const daily = groupCps(days, (r) => r.work_date).sort((a, b) =>
      b.key.localeCompare(a.key),
    );
    const places = new Map(all.map((l) => [l.station_code, l]));
    const reportParams = new URLSearchParams({
      ...params,
      view,
      period: period.mode,
      date: period.date,
      month: period.month,
    });
    const download = `/api/ops-pulse/cps/report?${reportParams}`;
    const canExport = hasPermission(auth, "cps_reports", "access");
    const detail = new Map<
      string,
      { head: string; sub: string; source: string; value: number }
    >();
    for (const l of snapshot?.breakup ?? []) {
      const key = `${l.head}|${l.sub_head}|${l.source}`;
      const r = detail.get(key) ?? {
        head: l.head,
        sub: l.sub_head,
        source: l.source,
        value: 0,
      };
      r.value += Number(l.amount);
      detail.set(key, r);
    }
    return (
      <AppShell active="CPS" pageCode={cpsViews[view].permission}>
        <div className="ops-command-center cps-workspace">
          <PageHead
            eyebrow="OPS PULSE · COST PER SHIPMENT"
            title={
              view === "overview" ? "CPS Performance" : cpsViews[view].label
            }
            subtitle="Every operating cost, divided by delivered shipments. Follow the cost; close the gaps."
            action={
              canExport && view !== "inputs" ? (
                <a className="button primary" href={download}>
                  Download Excel
                </a>
              ) : undefined
            }
          />
          <nav className="cps-tabs" aria-label="CPS views">
            {Object.entries(cpsViews)
              .filter(([key, v]) => (["overview","associates","unmapped","breakup","inputs"].includes(key) || key===view) && hasPermission(auth, v.permission, "access"))
              .map(([key, v]) => (
                <Link
                  prefetch={false}
                  key={key}
                  className={view === key ? "active" : ""}
                  href={query({ view: key })}
                >
                  {v.label}
                </Link>
              ))}
            {hasPermission(auth, "cps_overview", "access") && (
              <Link prefetch={false} href="/cps/adhoc-activity">
                Adhoc Van &amp; DA
              </Link>
            )}
          </nav>
          {view !== "inputs" && (
            <CpsFilters
              key={JSON.stringify(params)}
              params={{ ...params, view }}
              period={period}
              today={todayKolkata()}
              places={all.map((l) => ({
                code: l.station_code,
                name: l.station_name || l.city || l.station_code,
                cluster: adHocClusterLabel(l),
                region: l.region || "Unassigned",
              }))}
            />
          )}
          {inputs ? (
            <CpsInputs
              employees={inputs.employees}
              costs={inputs.costs}
              targets={inputs.targets}
              stations={all.map((l) => l.station_code)}
              today={todayKolkata()}
              canAdd={hasPermission(auth, "cps_inputs", "add")}
              canEdit={hasPermission(auth, "cps_inputs", "edit")}
            />
          ) : (
            <>
              <div className="cps-period">
                <strong>
                  {period.mode.toUpperCase()}: {period.from} – {period.to}
                </strong>
                <span>
                  {selected.length}{" "}
                  {selected.length === 1 ? "location" : "locations"} ·{" "}
                  {period.days} {period.days === 1 ? "day" : "days"}
                </span>
                <small>
                  Snapshot{" "}
                  {snapshot?.generated_at
                    ? new Date(snapshot.generated_at).toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}{" "}
                  IST
                </small>
              </div>
              {!selected.length ? (
                <section className="panel">
                  <div className="panel-body">
                    No permitted locations match these filters.
                  </div>
                </section>
              ) : (
                <>
                  <section className="cps-kpis">
                    <article>
                      <span>Delivered shipments</span>
                      <strong>{count(totals.deliveries)}</strong>
                      <small>
                        {period.from} – {period.to}
                      </small>
                    </article>
                    <article>
                      <span>Recorded cost</span>
                      <strong>{money(totals.total)}</strong>
                      <small>Accrued fixed + variable costs</small>
                    </article>
                    <article className="primary">
                      <span>
                        {totals.provisional
                          ? "Provisional CPS"
                          : "Recorded CPS"}
                      </span>
                      <strong>{money(totals.cps, 2)}</strong>
                      <small>Total cost ÷ delivered shipments</small>
                    </article>
                    <article className={totals.exposedDeliveries ? "cps-exposure" : ""}>
                      <span>Deliveries awaiting cost</span><strong>{count(totals.exposedDeliveries)}</strong>
                      <small>{snapshot?.gaps?.length ?? 0} issues to resolve</small>
                    </article>
                  </section>
                  {totals.provisional && (
                    <section className="cps-readiness">
                      <div>
                        <strong>
                          {totals.provisional
                            ? "CPS is provisional"
                            : "Target setup pending"}
                        </strong>
                        <p>
                          {cpsIssues(totals).filter(t=>!t.startsWith("Target")).join(" · ")}. Unknown costs are excluded from this provisional amount.
                        </p>
                      </div>
                      {hasPermission(auth, "cps_unmapped", "access") && (
                        <Link
                          prefetch={false}
                          href={query({ view: "unmapped" })}
                          className="button"
                        >
                          Resolve gaps
                        </Link>
                      )}
                    </section>
                  )}
                  {!["unmapped","associates"].includes(view) && <section className="cps-head-grid" aria-label="Cost heads">
                    {[
                      {head:"UTR",value:totals.utr,note:"People CTC · station staff"},
                      {head:"DA",value:totals.da,note:"Salary, variable and fuel"},
                      {head:"Van",value:totals.van,note:"Rent, dock van, driver, fuel and upkeep"},
                      {head:"Rent",value:totals.rent,note:"Facility rent and maintenance"},
                      {head:"Overhead",value:totals.overhead,note:"Shared People CTC and configured costs"},
                      {head:"Other",value:totals.other,note:"Electricity, supplies and miscellaneous"},
                    ].map(item=><article key={item.head}><div><h2>{item.head} CPS</h2><strong>{money(ratio(item.value,totals.deliveries),2)}</strong></div><p>{money(item.value)} <span>total</span></p><small>{item.note}</small>{item.head==='DA' && <dl><div><dt>Salary</dt><dd>{money(ratio(totals.salary,totals.deliveries),2)}</dd></div><div><dt>Variable</dt><dd>{money(ratio(totals.variable,totals.deliveries),2)}</dd></div><div><dt>Fuel</dt><dd>{money(ratio(totals.fuel,totals.deliveries),2)}</dd></div></dl>}</article>)}
                  </section>}
                  {view === "unmapped" && <section className="panel"><div className="panel-head"><div><h2>Close the gaps</h2><p className="subtle">One issue per ID and station. Shipments remain included while payment setup is pending. Correct the source, then refresh CPS.</p></div></div>
                    <div className="cps-table-wrap"><table><thead><tr>{['Issue / owner','Person / provider ID','Station','First seen','Through','Days','Affected deliveries','Action'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
                      {(snapshot?.gaps??[]).map(g=><tr key={g.key}><td><strong>{g.kind}</strong><small>{g.owner}</small></td><td>{g.name || 'Unidentified'}<small>{g.dropx_id || 'DropX ID pending'} · {g.provider_id}</small></td><td>{g.station_code}</td><td>{g.first_date}</td><td>{g.last_date}</td><td>{g.days}</td><td>{count(g.deliveries)}</td><td><a className="button" href={g.href}>{g.owner==='People / Finance'?'Cost setup':g.owner==='Operations uploads'?'Open uploads':'Open mapping'}</a></td></tr>)}
                    </tbody></table></div>{!(snapshot?.gaps??[]).length && <p className="panel-body">No workforce mapping or cost-allocation issues in this selection.</p>}
                    <div className="panel-body"><a className="button" href="https://dashboard.dropxlogistics.com/provider-mapping/provider-first">Workforce ID mapping</a> <Link className="button" href={query({view:'inputs'})}>People allocations &amp; cost setup</Link></div>
                  </section>}
                  {view === "associates" && <section className="panel"><div className="panel-head"><div><h2>Fixed-pay DA productivity</h2><p className="subtle">Fixed salaries accrue even with no delivery row. Salary CPS rises when a fixed-pay associate handles fewer shipments.</p></div></div><div className="cps-table-wrap"><table><thead><tr>{['DropX person','Station','Delivered','Fixed pay','Variable pay','DA fuel','Salary CPS','Shipments / paid day','Zero-delivery paid days'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{(snapshot?.people??[]).map(p=><tr key={`${p.id}|${p.station_code}`}><td>{p.name}<small>{p.dropx_id}</small></td><td>{p.station_code}</td><td>{count(p.deliveries)}</td><td>{money(p.salary)}</td><td>{money(p.variable)}</td><td>{money(p.fuel)}</td><td><strong>{money(ratio(p.salary,p.deliveries),2)}</strong></td><td>{p.paid_days?(p.deliveries/p.paid_days).toFixed(1):'—'}</td><td>{p.zero_delivery_days}</td></tr>)}</tbody></table></div></section>}
                  {view === "shipments" && (
                    <section className="panel">
                      <div className="panel-head">
                        <div>
                          <h2>Shipment activity by location</h2>
                          <p className="subtle">
                            CPS uses deliveries only. Returns and other
                            activities are shown separately. Associate-days are
                            daily records, not unique people across the period.
                          </p>
                        </div>
                      </div>
                      <div className="cps-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "Location",
                                "Amazon deliveries",
                                "SWA deliveries",
                                "Total deliveries",
                                "C-return",
                                "MFN",
                                "MFN return",
                                "Total activity",
                                "Associate-days",
                                "Deliveries / associate-day",
                              ].map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {stations.map((s) => (
                              <tr key={s.key}>
                                <td>
                                  <Link
                                    prefetch={false}
                                    href={query({ station: s.key })}
                                  >
                                    {s.key}
                                  </Link>
                                </td>
                                {[
                                  s.amazon,
                                  s.swa,
                                  s.deliveries,
                                  s.returns,
                                  s.mfn,
                                  s.mfnReturn,
                                  s.activity,
                                  s.associateDays,
                                ].map((n, i) => (
                                  <td key={i}>{count(n)}</td>
                                ))}
                                <td>
                                  {s.associateDays
                                    ? (s.deliveries / s.associateDays).toFixed(
                                        1,
                                      )
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                  {!associates &&
                    view !== "breakup" &&
                    view !== "reports" &&
                    view !== "shipments" && view !== "unmapped" && (
                      <section className="panel">
                        <div className="panel-head">
                          <div>
                            <h2>Station CPS</h2>
                            <p className="subtle">
                              Select a station for its cost heads and daily detail.
                            </p>
                          </div>
                        </div>
                        <div className="cps-table-wrap">
                          <table>
                            <CostHeaders first="Location" />
                            <tbody>
                              {stations.map((s) => (
                                <tr key={s.key}>
                                  <td>
                                    <Link
                                      prefetch={false}
                                      href={query({ station: s.key })}
                                    >
                                      <strong>{s.key}</strong>
                                    </Link>
                                    <small>
                                      {places.get(s.key)?.station_name}
                                    </small>
                                  </td>
                                  <CostCells row={s} />
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                  {!associates &&
                    ["breakup", "reports"].includes(view) && (
                      <section className="panel">
                        <div className="panel-head">
                          <h2>Cost breakup</h2>
                          <span>Same period and locations</span>
                        </div>
                        <div className="cps-table-wrap">
                          <table>
                            <thead>
                              <tr>
                                {[
                                  "Head",
                                  "Cost",
                                  "Source",
                                  "Amount",
                                  "CPS contribution",
                                  "Share of cost",
                                ].map((h) => (
                                  <th key={h}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {[...detail.values()]
                                .sort(
                                  (a, b) =>
                                    a.head.localeCompare(b.head) ||
                                    b.value - a.value,
                                )
                                .map((l, i) => (
                                  <tr key={i}>
                                    <td>{l.head}</td>
                                    <td>{l.sub}</td>
                                    <td>{l.source}</td>
                                    <td>{money(l.value, 2)}</td>
                                    <td>
                                      {money(
                                        ratio(l.value, totals.deliveries),
                                        2,
                                      )}
                                    </td>
                                    <td>
                                      {totals.total
                                        ? `${((l.value / totals.total) * 100).toFixed(1)}%`
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}
                  {!associates && (params.station || ["daily","monthly","mtd","reports"].includes(view)) && view !== "unmapped" && (
                    <section className="panel">
                      <div className="panel-head">
                        <h2>
                          {params.station
                            ? `${params.station} · Daily detail`
                            : "Daily totals"}
                        </h2>
                        <span>Weighted totals, never averaged CPS</span>
                      </div>
                      <div className="cps-table-wrap">
                        <table>
                          <CostHeaders first="Date" />
                          <tbody>
                            {daily.map((d) => (
                              <tr key={d.key}>
                                <td>
                                  <Link
                                    prefetch={false}
                                    href={query({
                                      view: hasPermission(
                                        auth,
                                        "cps_daily",
                                        "access",
                                      )
                                        ? "daily"
                                        : view,
                                      date: d.key,
                                      period: "daily",
                                    })}
                                  >
                                    {d.key}
                                  </Link>
                                </td>
                                <CostCells row={d} />
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                  {associates && (
                    <section className="panel">
                      <div className="panel-head">
                        <div>
                          <h2>
                            {view === "unmapped"
                              ? "Payment setup required"
                              : "Associate payout detail"}
                          </h2>
                          <p className="subtle">
                            Day-level shipment and payout records. Missing setup
                            is not a zero-cost worker.
                          </p>
                        </div>
                        <span>Page {page} · 50 rows</span>
                      </div>
                      <div className="cps-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "Date",
                                "Associate",
                                "Location",
                                "Pay scheme",
                                "Delivery",
                                "C-return",
                                "MFN / return",
                                "Variable",
                                "MG / salary",
                                "Fuel",
                                "Total pay",
                                "Setup",
                              ].map((h) => (
                                <th key={h}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {associates.rows.map((r) => (
                              <tr key={r.id}>
                                <td>{r.work_date}</td>
                                <td>
                                  {r.dropx_name ||
                                    r.provider_employee_name ||
                                    "Unknown"}
                                  <small>{r.dropx_emp_code || "DropX ID pending"} · {r.provider_employee_id}</small>
                                </td>
                                <td>{r.station_code}</td>
                                <td>{r.pay_type || "Not configured"}</td>
                                <td>{count(r.total_delivery)}</td>
                                <td>{count(r.c_return)}</td>
                                <td>
                                  {count(r.mfn)} / {count(r.mfn_return)}
                                </td>
                                {[
                                  r.variable_pay,
                                  r.mg_pay,
                                  r.fuel_pay,
                                  r.da_total_pay,
                                ].map((v, i) => (
                                  <td key={i}>
                                    {r.mapping_status === "Mapped"
                                      ? money(v, 2)
                                      : "—"}
                                  </td>
                                ))}
                                <td>{r.mapping_status}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {!associates.rows.length && (
                        <p className="panel-body">
                          No matching associate records.
                        </p>
                      )}
                      <footer className="cps-pagination">
                        {page > 1 && (
                          <Link
                            prefetch={false}
                            href={`${query({ view })}&page=${page - 1}`}
                            className="button"
                          >
                            Previous
                          </Link>
                        )}
                        {associates.more && (
                          <Link
                            prefetch={false}
                            href={`${query({ view })}&page=${page + 1}`}
                            className="button"
                          >
                            Next 50
                          </Link>
                        )}
                      </footer>
                    </section>
                  )}
                  {view === "reports" && canExport && (
                    <section className="panel">
                      <div className="panel-body">
                        <h2>Export this selection</h2>
                        <p>
                          Excel includes summary, station totals, daily CPS,
                          source breakup and data-gap flags. Filters and
                          permissions are applied again when downloading.
                        </p>
                        <a className="button primary" href={download}>
                          Download Excel
                        </a>
                      </div>
                    </section>
                  )}
                  <footer className="cps-source-note">
                    Live portal calculation. Approved Adhoc requests and linked
                    Cashbook payments are counted once. Finance rent replaces
                    explicitly identified station/office-rent Cashbook entries.
                    Shared costs use the allocation group’s daily delivered volume,
                    independent of the viewing filter. Figures stay provisional
                    while payment setup, shipment days or People CTC are
                    missing. Earlier dates can change when source data is
                    corrected.
                  </footer>
                </>
              )}
            </>
          )}
        </div>
      </AppShell>
    );
  } catch (error) {
    return (
      <AppShell active="CPS" pageCode={cpsViews[view].permission}>
        <PageHead
          title="CPS Performance"
          subtitle="Live daily, monthly and MTD cost review"
        />
        <section className="panel message-panel error">
          <div className="panel-body">
            <h2>CPS could not be loaded</h2>
            <p>
              {error instanceof Error ? error.message : "Please retry shortly."}
            </p>
            <Link href="/cps" className="button">
              Retry
            </Link>
          </div>
        </section>
      </AppShell>
    );
  }
}
