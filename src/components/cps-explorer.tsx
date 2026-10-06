"use client";
import { useState } from "react";
import { CpsCostWorkspace } from "./cps-cost-workspace";
import { CpsAttention } from "./cps-attention";
import { SearchableSelect } from "./searchable-select";
import {
  cpsForStations,
  cpsStationGroups,
  type CpsPlace,
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
  places: CpsPlace[];
  params: CpsParams;
  canResolve: boolean;
  canEditBilling: boolean;
  canExport: boolean;
}) {
  const groups = cpsStationGroups(places);
  const byGroup = new Map(groups.map(g => [g.code, g]));
  const groupByMember = new Map(groups.flatMap(g => g.members.map(code => [code, g.code] as const)));
  const [station, setStation] = useState(() => {
    const requested = selectedCpsStations(params.station).map(code => groupByMember.get(code) || code);
    return requested.find(code => byGroup.has(code)) || groups[0]?.code || "";
  });
  const [head, setHead] = useState(params.head ?? "DA");
  const [showIssues, setShowIssues] = useState(false);
  const [search, setSearch] = useState("");
  const [comparison, setComparison] = useState(() => groups.map(p => p.code));
  const [view,setView] = useState(params.view === "unmapped" ? "attention" : "costs");
  const [attentionStation,setAttentionStation] = useState("");
  const names = Object.fromEntries(groups.map(p => [p.code, p.name]));
  const rows = groupCps(snapshot.daily, r => groupByMember.get(r.station_code) || r.station_code).sort((a, b) => a.key.localeCompare(b.key));
  const matched = groups.filter(p => p.search.toLowerCase().includes(search.toLowerCase()));
  const shown = rows.filter((r) => comparison.includes(r.key));
  function selectStation(code: string) {
    setStation(code);
    const q = new URLSearchParams(window.location.search);
    if (code) q.set("station", code);
    else q.delete("station");
    window.history.replaceState(null, "", `/cps?${q}`);
  }
  function open(code: string, cost?: Head) {
    setView("costs");
    selectStation(code);
    setShowIssues(false);
    if (cost) setHead(cost);
    requestAnimationFrame(()=>document.getElementById("cps-station-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  const report = new URLSearchParams({
    ...params,
    view: "overview",
    station: comparison.join(","),
  });
  return (
    <>
      <nav className="cps-local-tabs" aria-label="CPS workspace"><button className="button" aria-pressed={view==="costs"} onClick={()=>setView("costs")}>Station CPS</button><button className="button" aria-pressed={view==="attention"} onClick={()=>{setAttentionStation("");setView("attention");}}>Needs attention ({cpsReviewItems(snapshot).count})</button></nav>
      {view==="attention" ? <CpsAttention key={attentionStation} snapshot={snapshot} places={places} initialStation={attentionStation} canResolve={canResolve} onOpen={(code,cost)=>open(groupByMember.get(code)||code,cost)}/> : <>
      <section className="panel cps-comparison" aria-label="Station comparison">
        <div className="panel-head">
          <div>
            <h2>Station comparison</h2>
            <p>
              Each parent row combines its authorized EDSP and XPT costs and delivered shipments. CPS is combined cost ÷ combined deliveries.
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
            {comparison.length} of {groups.length} station groups selected{" "}
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
              onClick={() => setComparison(groups.map((p) => p.code))}
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
                  <small>{p.subtitle || p.name}</small>
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
                  "Attention",
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const issues = cpsReviewItems(cpsForStations(snapshot, byGroup.get(r.key)?.members || [])).count;
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
                      <small>{byGroup.get(r.key)?.subtitle || names[r.key]}</small>
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
                    <td>
                      <button
                        className="cps-cell-link"
                        onClick={() => {
                          setAttentionStation(r.key);
                          setView("attention");
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
          <span className="cps-eyebrow">PARENT STATION GROUP</span>
          <h2>
            {station ? `${station} · ${names[station]}` : "Station details"}
          </h2>
          <p>
            {byGroup.get(station)?.subtitle || "Choose one station to inspect costs, pending mappings and bills."}
          </p>
        </div>
        <label>
          Search and select station
          <SearchableSelect
            name="detail_station"
            options={groups.map((p) => ({
              value: p.code,
              label: `${p.code} · ${p.name}`,
              helper: `${p.subtitle} ${p.search}`,
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
          snapshot={cpsForStations(snapshot, byGroup.get(station)?.members || [])}
          initialHead={head}
          showAttention={params.view === "unmapped" || showIssues}
          canResolve={canResolve}
          canEditBilling={canEditBilling}
        />
      ) : (
        <p className="panel-body">Select a station to see its details.</p>
      )}
      </>}
    </>
  );
}
