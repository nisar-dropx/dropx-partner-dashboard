import { compareReportValues } from "../report-table-values.ts";
import { regionForStation } from "./station-board-regions.ts";
import type { StationBoardStation } from "./station-board.ts";
import type { BoardShareTable } from "./station-board-share.ts";

export type BoardReportSort = { header: string; direction: "asc" | "desc" };
export type BoardFilters = { stations: string[]; clusters: string[]; regions: string[] };
export type BoardCluster = { value: string; label: string; stations: string[] };

/** Presentation filters only narrow the already-authorised server payload. */
export function filterBoardStations(stations: StationBoardStation[], filters: BoardFilters, clusters: BoardCluster[]) {
  const clusterCodes = new Set(clusters.filter(c => filters.clusters.includes(c.value)).flatMap(c => c.stations));
  return stations.filter(s => (!filters.stations.length || filters.stations.includes(s.stationCode))
    && (!filters.clusters.length || clusterCodes.has(s.stationCode))
    && (!filters.regions.length || filters.regions.includes(regionForStation(s.stationCode))));
}

export function boardDeliverySummary(stations: StationBoardStation[], zeroOnly = false) {
  const all = stations.flatMap(s => s.board.daDsr).filter(d => d.total > 0);
  const rows = zeroOnly ? all.filter(d => d.delivered === 0) : all;
  const sums = rows.reduce((a, d) => ({ total: a.total + d.total, delivered: a.delivered + d.delivered,
    failed: a.failed + d.failed, rejected: a.rejected + d.rejected, oor: a.oor + d.oor }),
  { total: 0, delivered: 0, failed: 0, rejected: 0, oor: 0 });
  const attempted = sums.delivered + sums.failed + sums.rejected;
  const pct = (n: number) => sums.total ? Math.round(n / sums.total * 1000) / 10 : null;
  return { ...sums, attempted, dsrPct: pct(sums.delivered), attemptPct: pct(attempted), rejectPct: pct(sums.rejected),
    roadPct: pct(sums.oor), daCount: rows.length, zeroCount: rows.filter(d => d.delivered === 0).length };
}

/** One ordering and column projection for screen, Excel and share images. */
export function prepareBoardReport(table: BoardShareTable, sort: BoardReportSort, options: { dsr: boolean; singleStation: boolean; groupByStation?: boolean }) {
  const grouped = options.groupByStation ?? options.dsr;
  let headers = [...table.headers];
  let rows = table.rows.map(row => row.map(cell => ({ ...cell })));
  if (options.dsr) {
    const order = ["Station", "DA's Name", "Total", "Delivered", "Out on Road", "Delivery Failed", "Delivery Rejected", "Other / pending", "DSR%"];
    const indexes = order.map(h => headers.indexOf(h)).filter(i => i >= 0);
    headers = indexes.map(i => headers[i]);
    rows = rows.map(row => indexes.map(i => row[i]));
  }
  const stationIndex = headers.indexOf("Station");
  const column = headers.indexOf(sort.header);
  const totals = rows.filter(r => /^grand total$|^total$/i.test(r[0]?.text || ""));
  let data = rows.filter(r => !totals.includes(r));
  const compare = (a: typeof rows[number], b: typeof rows[number]) => column < 0 ? 0 : compareReportValues(a[column]?.text || "", b[column]?.text || "", sort.direction);
  if (grouped && stationIndex >= 0) {
    const groups = new Map<string, typeof rows>();
    data.forEach(row => { const code = row[stationIndex].text; const group = groups.get(code) || []; group.push(row); groups.set(code, group); });
    data = [...groups].sort(([a], [b]) => compareReportValues(a, b, sort.header === "Station" ? sort.direction : "asc"))
      .flatMap(([, group]) => group.sort(compare));
  } else data.sort(compare);
  rows = [...data, ...totals];
  const rowStations = rows.map(row => stationIndex >= 0 && !totals.includes(row) ? row[stationIndex].text : "");
  const groupStarts = rows.map((row, i) => grouped && !!rowStations[i] && (i === 0 || rowStations[i - 1] !== rowStations[i]));
  if (stationIndex >= 0 && options.singleStation) {
    headers.splice(stationIndex, 1);
    rows = rows.map(row => row.filter((_, i) => i !== stationIndex));
    if (headers.includes("DA's Name") && totals.length) rows[rows.length - 1][0] = { text: "Grand Total", bold: true, align: "left" };
  } else if (grouped && stationIndex >= 0) {
    rows.forEach((row, i) => { if (rowStations[i] && !groupStarts[i]) row[stationIndex] = { ...row[stationIndex], text: "" }; });
  }
  return { ...table, headers, rows, rowStations, groupStarts, totalRows: totals.length };
}
