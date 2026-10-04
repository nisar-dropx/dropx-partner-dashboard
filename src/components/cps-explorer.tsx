"use client";
import { useState } from "react";
import { CpsCostWorkspace } from "./cps-cost-workspace";
import { SearchableSelect } from "./searchable-select";
import {
  cpsForStation,
  cpsReviewItems,
  groupCps,
  ratio,
  selectedCpsStations,
  type CpsParams,
  type CpsSnapshot,
} from "@/lib/ops-pulse/cps";
const money = (n: number | null) =>
  n == null
    ? "—"
    : `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
type Head = "DA" | "UTR" | "Van" | "Other";
export function CpsExplorer({
  snapshot,
  places,
  params,
  canResolve,
  canEditBilling,
  canExport,
}: {
  snapshot: CpsSnapshot;
  places: { code: string; name: string }[];
  params: CpsParams;
  canResolve: boolean;
  canEditBilling: boolean;
  canExport: boolean;
}) {
  const [station, setStation] = useState(
    () =>
      selectedCpsStations(params.station).find((c) =>
        places.some((p) => p.code === c),
      ) ??
      places[0]?.code ??
      "",
  );
  const [head, setHead] = useState(params.head ?? "DA");
  const [showIssues, setShowIssues] = useState(false);
  const [search, setSearch] = useState("");
  const [comparison, setComparison] = useState(() => places.map((p) => p.code));
  const names = Object.fromEntries(places.map((p) => [p.code, p.name]));
  const rows = groupCps(snapshot.daily, (r) => r.station_code).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const matched = places.filter((p) =>
    `${p.code} ${p.name}`.toLowerCase().includes(search.toLowerCase()),
  );
  const shown = rows.filter((r) => comparison.includes(r.key));
  function selectStation(code: string) {
    setStation(code);
    const q = new URLSearchParams(window.location.search);
    if (code) q.set("station", code);
    else q.delete("station");
    window.history.replaceState(null, "", `/cps?${q}`);
  }
  function open(code: string, cost?: Head) {
    selectStation(code);
    setShowIssues(false);
    if (cost) setHead(cost);
    document
      .getElementById("cps-station-detail")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const report = new URLSearchParams({
    ...params,
    view: "overview",
    station: comparison.join(","),
  });
  return (
    <>
      <section className="panel cps-comparison" aria-label="Station comparison">
        <div className="panel-head">
          <div>
            <h2>Station comparison</h2>
            <p>
              Select stations to compare. Each row uses that station’s delivered
              shipments.
            </p>
          </div>
          {canExport && comparison.length > 0 && (
            <a className="button" href={`/api/ops-pulse/cps/report?${report}`}>
              Download comparison
            </a>
          )}
        </div>
        <details className="cps-compare-picker">
          <summary>
            {comparison.length} of {places.length} stations selected{" "}
            <span>Change stations</span>
          </summary>
          <div className="cps-compare-controls">
            <input
              aria-label="Find comparison stations"
              placeholder="Search station code or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className="button"
              onClick={() => setComparison(places.map((p) => p.code))}
            >
              Select all
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setComparison([])}
            >
              Clear
            </button>
            <button
              type="button"
              className="button"
              onClick={() =>
                setComparison([
                  ...new Set([...comparison, ...matched.map((p) => p.code)]),
                ])
              }
            >
              Select search results
            </button>
          </div>
          <div className="cps-compare-options">
            {matched.map((p) => (
              <label key={p.code}>
                <input
                  type="checkbox"
                  checked={comparison.includes(p.code)}
                  onChange={(e) =>
                    setComparison(
                      e.target.checked
                        ? [...comparison, p.code]
                        : comparison.filter((c) => c !== p.code),
                    )
                  }
                />
                <span>
                  <strong>{p.code}</strong>
                  <small>{p.name}</small>
                </span>
              </label>
            ))}
          </div>
          {!matched.length && (
            <p className="panel-body">No matching stations.</p>
          )}
        </details>
        <div className="cps-table-wrap cps-comparison-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "Station",
                  "Delivered",
                  "DA CPS",
                  "UTR CPS",
                  "Van CPS",
                  "Other CPS",
                  "Total CPS",
                  "Total cost",
                  "Attention",
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const issues = cpsReviewItems({
                  ...snapshot,
                  gaps: snapshot.gaps?.filter((g) => g.station_code === r.key),
                  expense_periods: snapshot.expense_periods?.filter(
                    (b) => b.station_code === r.key,
                  ),
                }).count;
                return (
                  <tr
                    key={r.key}
                    className={station === r.key ? "cps-selected-station" : ""}
                  >
                    <td>
                      <button
                        className="cps-cell-link"
                        onClick={() => open(r.key)}
                      >
                        {r.key}
                      </button>
                      <small>{names[r.key]}</small>
                    </td>
                    <td>{r.deliveries.toLocaleString("en-IN")}</td>
                    {(["DA", "UTR", "Van", "Other"] as Head[]).map((h) => (
                      <td key={h}>
                        <button
                          className="cps-cell-link"
                          aria-label={`${r.key} ${h} cost details`}
                          onClick={() => open(r.key, h)}
                        >
                          {money(
                            ratio(
                              h === "DA"
                                ? r.da
                                : h === "UTR"
                                  ? r.utr
                                  : h === "Van"
                                    ? r.van
                                    : r.other + r.rent + r.overhead,
                              r.deliveries,
                            ),
                          )}
                        </button>
                      </td>
                    ))}
                    <td>
                      <strong>{money(r.cps)}</strong>
                      {(r.provisional || issues > 0) && (
                        <small className="cps-missing">Provisional</small>
                      )}
                    </td>
                    <td>{money(r.total)}</td>
                    <td>
                      <button
                        className="cps-cell-link"
                        onClick={() => {
                          open(r.key);
                          setShowIssues(true);
                        }}
                      >
                        {issues
                          ? `${issues} issues`
                          : r.missingDays
                            ? `${r.missingDays} missing days`
                            : "View details"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!shown.length && (
          <p className="panel-body">
            Select at least one station for this comparison.
          </p>
        )}
      </section>
      <section className="panel cps-detail-selector" id="cps-station-detail">
        <div>
          <span className="cps-eyebrow">SINGLE STATION</span>
          <h2>
            {station ? `${station} · ${names[station]}` : "Station details"}
          </h2>
          <p>
            Choose one station to inspect costs, pending mappings and bills.
          </p>
        </div>
        <label>
          Search and select station
          <SearchableSelect
            name="detail_station"
            options={places.map((p) => ({
              value: p.code,
              label: `${p.code} · ${p.name}`,
              helper: p.code,
            }))}
            placeholder="Search station code or name"
            value={station}
            onValueChange={selectStation}
            maxOptions={150}
          />
        </label>
      </section>
      {station ? (
        <CpsCostWorkspace
          key={`${station}|${head}|${showIssues}`}
          snapshot={cpsForStation(snapshot, station)}
          initialHead={head}
          showAttention={params.view === "unmapped" || showIssues}
          canResolve={canResolve}
          canEditBilling={canEditBilling}
        />
      ) : (
        <p className="panel-body">Select a station to see its details.</p>
      )}
    </>
  );
}
