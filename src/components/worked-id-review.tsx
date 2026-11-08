"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { facetRows } from "@/lib/dependent-filters";
import { DailyIdUsageTable } from "./daily-id-usage-table";
import { SearchableSelect } from "./searchable-select";
import { FleetMultiSelect } from "./fleet-multi-select";
import { PeopleOwnershipRefresh } from "./people-ownership-refresh";
import { WorkedIdBulkPeriods } from "./worked-id-bulk-periods";
import {
  workedIdCounts,
  workedIdMetrics,
  workedIdPaymentMetrics,
  workedIdPaymentLabels,
  updateWorkedIdPaymentShare,
  workedIdShareError,
} from "@/lib/worked-id-review";
import styles from "./worked-id-review.module.css";
type Location = {
  id: string;
  station_code: string;
  station_name: string;
  region?: string | null;
  cluster: string;
  clusterKeys: string[];
};
type Draft = {
  row: any;
  enabled: boolean;
  decision: string;
  reason: string;
  shares: any[];
  buddySourceId: string;
};
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
const pending = (r: any) =>
  ["pending", "reopened"].includes(r.decision) ||
  r.training?.status === "pending" ||
  r.ownerAbsenceNeedsReview;
const category = (r: any) =>
  !r.hasStationDeliveryData
    ? "report"
    : !r.providerIds.length
      ? "unmapped"
      : "zero";
const reasons: Record<string, string> = {
  report: "Station delivery report missing",
  unmapped: "No own ID mapped",
  zero: "No deliveries on own ID",
};
const status = (r: any) =>
  r.training && r.training.status !== "cancelled"
    ? `Training · ${r.training.status}`
    : pending(r)
      ? "Needs review"
      : r.decision === "worked"
        ? "Worked using another ID"
        : r.decision === "not_worked"
          ? "Marked absent"
          : "Reviewed";
const sourceKey = (s: any) => `${s.client}|${s.provider_employee_id}`;
const choices = (a: string[]) =>
  [...new Set(a)].sort().map((value) => ({ value, label: value }));
export function WorkedIdReview({
  locations,
  initialMonth,
  managerOptions,
  canEdit,
  dailyUsage = false,
}: {
  locations: Location[];
  initialMonth: string;
  managerOptions: { value: string; label: string }[];
  canEdit: boolean;
  dailyUsage?: boolean;
}) {
  const request = useRef(0),
    payRequest = useRef(0),
    dialog = useRef<HTMLElement>(null);
  const [month, setMonth] = useState(initialMonth),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [regions, setRegions] = useState<string[]>([]),
    [clusters, setClusters] = useState<string[]>([]),
    [stations, setStations] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [show, setShow] = useState(dailyUsage ? "all" : "pending"),
    [caseType, setCaseType] = useState("all"),
    [view, setView] = useState("associate");
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [saving, setSaving] = useState(false),
    [pay, setPay] = useState<any>(null),
    [payError, setPayError] = useState(""),
    [bulkDecision, setBulkDecision] = useState("worked"),
    [bulkReason, setBulkReason] = useState("");
  const [evidence, setEvidence] = useState<any[]>([]),
    [evidenceReady, setEvidenceReady] = useState(false);
  const [validatedSignature, setValidatedSignature] = useState("");
  const [affectedCount, setAffectedCount] = useState(0);
  const allIds = locations.map((l) => l.id).join(",");
  async function load() {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      if (!allIds) {
        setData({ rows: [], sources: [] });
        return;
      }
      const res = await fetch(
          `/api/provider-mapping/worked-id-review?${new URLSearchParams({ stations: allIds, month, scope: dailyUsage ? "daily" : "exceptions" })}`,
          { cache: "no-store" },
        ),
        body = await res.json();
      if (id !== request.current) return;
      if (!res.ok) throw Error(body.error);
      setData(body);
    } catch (e) {
      if (id === request.current) {
        setError(e instanceof Error ? e.message : "Could not load cases.");
        setData(null);
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    setData(null);
    setDrafts([]);
    void load();
  }, [month, allIds]);
  const currentLocations = new Map(
    locations.map((location) => [location.id, location]),
  );
  const currentRow = (row: any) => ({
    ...row,
    cluster:
      currentLocations.get(row.stationId)?.cluster ?? "Not mapped in People",
  });
  const statusOptions = dailyUsage
    ? [
        { value: "gaps", label: "Attendance / delivery gaps" },
        { value: "locked", label: "Payment locked" },
        { value: "readonly", label: "Non-delivery roles · view only" },
        { value: "reviewed", label: "Work reviewed" },
        { value: "evidence", label: "Daily evidence available" },
        { value: "none", label: "No daily evidence" },
      ]
    : [
        {
          value: "pending",
          label:
            view === "bulk" ? "Needs period review" : "Needs review / approval",
        },
        {
          value: "reviewed",
          label: view === "bulk" ? "No day-count shortfall" : "Reviewed",
        },
      ];
  const reviewFacets = useMemo(() => {
    const locationById = new Map(locations.map((l) => [l.id, l]));
    const items: any[] =
      view === "bulk" ? data?.bulkPeriods || [] : data?.rows || [];
    return facetRows<any, "region" | "cluster" | "station" | "status">(
      items,
      {
        region: {
          selected: regions,
          values: (r) => locationById.get(r.stationId)?.region || "Unassigned",
        },
        cluster: {
          selected: clusters,
          values: (r) => locationById.get(r.stationId)?.clusterKeys || [],
        },
        station: { selected: stations, values: (r) => r.stationId },
        status: {
          selected: show === "all" ? [] : [show],
          values: (r) =>
            view === "bulk"
              ? r.needsReview
                ? "pending"
                : "reviewed"
              : !dailyUsage
                ? pending(r)
                  ? "pending"
                  : "reviewed"
                : [
                    ...(r.paymentLocked ? ["locked"] : []),
                    ...(r.canAllocate === false ? ["readonly"] : []),
                    ...(["worked", "not_worked"].includes(r.decision)
                      ? ["reviewed"]
                      : []),
                    ...(r.punches || r.ownDeliveries ? ["evidence"] : ["none"]),
                    ...(!r.lockReason &&
                    !["worked", "not_worked"].includes(r.decision) &&
                    r.hasStationDeliveryData &&
                    ((r.punches > 0 && !r.ownDeliveries) ||
                      (!r.punches && r.ownDeliveries > 0))
                      ? ["gaps"]
                      : []),
                  ],
        },
      },
      (r) =>
        `${r.name} ${r.dropxId} ${(r.providerIds || []).join(" ")} ${(r.usages || []).map((u: any) => `${u.providerId} ${u.providerName} ${u.ownerName}`).join(" ")} ${r.stationCode} ${r.date || ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );
  }, [
    locations,
    data,
    view,
    dailyUsage,
    regions,
    clusters,
    stations,
    show,
    query,
  ]);
  const scope = new Set(
    locations
      .filter(
        (l) =>
          (!regions.length || regions.includes(l.region || "Unassigned")) &&
          (!clusters.length ||
            l.clusterKeys.some((k) => clusters.includes(k))) &&
          (!stations.length || stations.includes(l.id)),
      )
      .map((l) => l.id),
  );
  const statusRows = useMemo(
    () => reviewFacets.rows.map(currentRow),
    [reviewFacets],
  );
  const rows = useMemo(
    () =>
      statusRows.filter(
        (r: any) =>
          caseType === "all" ||
          (caseType === "training"
            ? r.training?.status === "pending"
            : category(r) === caseType),
      ),
    [statusRows, caseType],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, any[]>();
    for (const r of rows) {
      const list = grouped.get(r.workerId) || [];
      list.push(r);
      grouped.set(r.workerId, list);
    }
    return [...grouped]
      .map(([id, rows]) => ({ id, rows }))
      .sort((a, b) => a.rows[0].name.localeCompare(b.rows[0].name));
  }, [rows]);
  const bulkScoped = (data?.bulkPeriods || [])
    .map(currentRow)
    .filter(
      (p: any) =>
        scope.has(p.stationId) &&
        `${p.name} ${p.dropxId} ${p.providerIds.join(" ")} ${p.stationCode} ${p.effective_from} ${p.effective_to}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const bulkRows = reviewFacets.rows.filter(
    (p: any) =>
      show === "all" || (show === "pending" ? p.needsReview : !p.needsReview),
  );
  const current = drafts[0]?.row;
  function patch(index: number, value: Partial<Draft>) {
    setDrafts((a) => a.map((d, i) => (i === index ? { ...d, ...value } : d)));
  }
  function daySources(r: any) {
    return evidence.filter(
      (s: any) =>
        s.stationId === r.stationId &&
        s.work_date === r.date &&
        s.ownerId !== r.workerId &&
        !s.mappingIssue,
    );
  }
  function available(d: Draft, s: any) {
    const own = (d.row.shares || []).find(
      (a: any) => a.source_shipment_id === s.id,
    );
    return Object.fromEntries(
      workedIdMetrics.map((k) => [
        k,
        s.counts[k] - s.allocated[k] + Number(own?.quantities[k] || 0),
      ]),
    ) as ReturnType<typeof workedIdCounts>;
  }
  function makeShare(s: any) {
    return {
      source_shipment_id: s.id,
      owner_worked: null,
      source_counts: s.counts,
      quantities: workedIdCounts({}),
    };
  }
  function updateShare(i: number, j: number, value: any) {
    patch(i, {
      shares: drafts[i].shares.map((s, k) =>
        k === j ? { ...s, ...value } : s,
      ),
    });
  }
  async function open(list: any[]) {
    setValidatedSignature("");
    setError("");
    setBulkReason("");
    setBulkDecision("worked");
    setPay(null);
    setPayError("");
    setEvidence([]);
    setEvidenceReady(false);
    setDrafts(
      list.map((r) => ({
        row: r,
        enabled:
          canEdit &&
          !r.reviewElsewhere &&
          !r.lockReason &&
          r.hasPaySetup &&
          list.filter((x) => x.date === r.date).length === 1 &&
          (!r.training || r.training.status === "cancelled"),
        decision:
          r.training && r.training.status !== "cancelled"
            ? `training_${r.training.status}`
            : pending(r)
              ? "worked"
              : r.decision,
        reason: r.reason || "",
        shares: (r.shares || []).map((x: any) => ({
          ...x,
          owner_worked:
            x.owner_worked === false && !x.owner_absence_confirmed
              ? null
              : x.owner_worked,
          quantities: { ...x.quantities },
        })),
        buddySourceId: r.training?.buddy_source_id || "",
      })),
    );
    const id = ++payRequest.current,
      params = new URLSearchParams({
        stations: [...new Set(list.map((r) => r.stationId))].join(","),
        month,
        worker: list[0].workerId,
        scope: dailyUsage ? "daily" : "exceptions",
      });
    await Promise.all([
      (async () => {
        try {
          const res = await fetch(
              `/api/provider-mapping/worked-id-review?${params}`,
              { cache: "no-store" },
            ),
            body = await res.json();
          if (id !== payRequest.current) return;
          if (!res.ok) throw Error(body.error);
          setPay(body.pay);
        } catch (e) {
          if (id === payRequest.current)
            setPayError(e instanceof Error ? e.message : "Pay unavailable.");
        }
      })(),
      (async () => {
        try {
          const res = await fetch(
              `/api/provider-mapping/worked-id-review?${params}&mode=evidence`,
              { cache: "no-store" },
            ),
            body = await res.json();
          if (id !== payRequest.current) return;
          if (!res.ok) throw Error(body.error);
          if (
            list.some(
              (r) =>
                !body.rows.some(
                  (n: any) => n.key === r.key && n.version === r.version,
                ),
            )
          )
            throw Error(
              "A day changed since the list loaded. Close and refresh before reviewing.",
            );
          setEvidence(body.sources);
          setDrafts((ds) =>
            ds.map((d) => ({
              ...d,
              row: body.rows.find((r: any) => r.key === d.row.key),
            })),
          );
          setEvidenceReady(true);
        } catch (e) {
          if (id === payRequest.current)
            setError(
              e instanceof Error
                ? e.message
                : "Evidence unavailable. Close and refresh.",
            );
        }
      })(),
    ]);
  }
  function close() {
    payRequest.current++;
    setDrafts([]);
    setError("");
  }
  useEffect(() => {
    if (!current) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
      );
      if (!nodes?.length) return;
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current)
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [current?.workerId, saving]);
  const selected = drafts.filter((d) => d.enabled);
  const commonOptions = [
    ...new Map(
      selected
        .flatMap((d) => daySources(d.row))
        .map((s: any) => [
          sourceKey(s),
          {
            value: sourceKey(s),
            label: `${s.provider_employee_id} · ${s.provider_employee_name || s.ownerName}`,
            helper: s.ownerName,
          },
        ]),
    ).values(),
  ] as { value: string; label: string; helper: string }[];
  function applyId(key: string) {
    const next = drafts.map((d) => {
      if (!d.enabled) return d;
      const source = daySources(d.row).find((s: any) => sourceKey(s) === key);
      return {
        ...d,
        decision: "worked",
        shares: source ? [makeShare(source)] : [],
      };
    });
    setDrafts(next);
    setError(
      next.some((d) => d.enabled && !d.shares.length)
        ? "That ID has no usable report on some selected dates. Choose an ID for those days below."
        : "",
    );
  }
  async function save() {
    setError("");
    if (!selected.length) {
      setError("Select at least one day.");
      return;
    }
    for (const d of selected) {
      if (
        ![
          "worked",
          "not_worked",
          "training",
          "approve_training",
          "reject_training",
          "reopened",
        ].includes(d.decision)
      ) {
        setError(`${d.row.date}: choose a decision.`);
        return;
      }
      if (d.reason.trim().length < 3) {
        setError(`${d.row.date}: add a short reason.`);
        return;
      }
      if (d.decision === "worked") {
        if (!d.shares.length) {
          setError(`${d.row.date}: select the ID used.`);
          return;
        }
        for (const s of d.shares) {
          const source = daySources(d.row).find(
            (x: any) => x.id === s.source_shipment_id,
          );
          const problem = source
            ? workedIdShareError(
                available(d, source),
                s.quantities,
                s.owner_worked,
              )
            : "Source report changed. Reload.";
          if (problem) {
            setError(`${d.row.date}: ${problem}`);
            return;
          }
        }
      }
      if (d.decision === "training" && !d.buddySourceId) {
        setError(`${d.row.date}: select the buddy’s worked ID.`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/provider-mapping/worked-id-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: dailyUsage ? "daily" : "exceptions",
            preview:
              dailyUsage && validatedSignature !== JSON.stringify(selected),
            entries: selected.map((d) => ({
              stationId: d.row.stationId,
              workerId: d.row.workerId,
              date: d.row.date,
              version: d.row.version,
              decision: d.decision,
              reason: d.reason,
              shares: d.decision === "worked" ? d.shares : [],
              buddySourceId: d.buddySourceId,
            })),
          }),
        }),
        body = await res.json();
      if (!res.ok) throw Error(body.error);
      if (body.validated) {
        setValidatedSignature(JSON.stringify(selected));
        setAffectedCount(body.affectedCount);
        return;
      }
      setNotice(body.message);
      close();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className={`${styles.review} ${dailyUsage ? styles.daily : ""}`}>
      <PeopleOwnershipRefresh paused={saving || drafts.length > 0} />
      <section className={`panel ${styles.filters}`}>
        <FleetMultiSelect
          alwaysSearch
          label="Regions"
          allLabel="All permitted regions"
          values={regions}
          options={reviewFacets.options(
            "region",
            choices([
              ...locations.map((l) => l.region || "Unassigned"),
              ...regions,
            ]),
          )}
          onChange={setRegions}
        />
        <FleetMultiSelect
          alwaysSearch
          label="Cluster / AOM"
          allLabel="All clusters"
          values={clusters}
          options={reviewFacets.options("cluster", managerOptions)}
          onChange={setClusters}
        />
        <FleetMultiSelect
          alwaysSearch
          label="Stations"
          allLabel="All permitted stations"
          values={stations}
          options={reviewFacets.options(
            "station",
            locations.map((l) => ({
              value: l.id,
              label: `${l.station_code} · ${l.station_name}`,
              helper: [l.cluster, l.region].filter(Boolean).join(" · "),
            })),
          )}
          onChange={setStations}
        />
        <label>
          Month
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <label>
          Find associate, ID or date
          <input
            placeholder="Name, DropX ID, provider ID, date"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Status
          <select value={show} onChange={(e) => setShow(e.target.value)}>
            <option value="all">All statuses</option>
            {reviewFacets.options("status", statusOptions).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.filterActions}>
          <button
            className="button secondary compact"
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh
          </button>
          {(regions.length > 0 ||
            clusters.length > 0 ||
            stations.length > 0 ||
            query ||
            show !== "all") && (
            <button
              className="button secondary compact"
              onClick={() => {
                setRegions([]);
                setClusters([]);
                setStations([]);
                setQuery("");
                setShow("all");
                setCaseType("all");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
      </section>
      {!dailyUsage && (
        <details className={styles.scope}>
          <summary>What is included?</summary>
          <p>
            Biometric-punched days with no deliveries recorded on the
            associate’s own mapped IDs, only for DA, DCD, ODCD and Wish Master
            with positive fixed salary/MG for that date. Fixed salary plus fuel,
            kilometres or variable components is included. A missing station
            report is shown separately. This is a mismatch to investigate, not
            proof of absence.
          </p>
          <p>
            Sorters, other roles, purely variable pay, and fuel/van rent or ODCD
            incentives without fixed salary/MG are excluded. Deliveries without
            biometric attendance are not included. Reviewed days remain in
            history. Buddy training is restricted to the DropX registration
            month, at most two days in total, and needs separate CM/AOM
            approval.
          </p>
          <p>
            Bulk periods compare uploaded attendance totals against distinct
            delivery dates on mapped IDs. Bulk and biometric attendance are not
            added together. A period shortfall flags a discrepancy; it does not
            mark particular dates absent or reduce pay.
          </p>
        </details>
      )}
      {notice && !current && <p role="status">{notice}</p>}
      {error && !current && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!dailyUsage && view !== "bulk" && (
        <div className={styles.tabs} aria-label="Review reasons">
          {[
            ["all", "All cases"],
            ["zero", "No own-ID deliveries"],
            ["unmapped", "No own ID"],
            ["report", "Report missing"],
            ["training", "Training approval"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={caseType === key}
              onClick={() => setCaseType(key)}
            >
              {label}{" "}
              <strong>
                {
                  statusRows.filter(
                    (r: any) =>
                      key === "all" ||
                      (key === "training"
                        ? r.training?.status === "pending"
                        : category(r) === key),
                  ).length
                }
              </strong>
            </button>
          ))}
        </div>
      )}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>
              {error
                ? "Cases unavailable"
                : loading
                  ? "Loading daily evidence…"
                  : dailyUsage
                    ? "Daily activity"
                    : view === "bulk"
                      ? `${new Set(bulkRows.map((p: any) => p.workerId)).size} associates · ${bulkRows.length} bulk periods`
                      : `${groups.length} associates · ${rows.length} day cases`}
            </h2>
            <p className="subtle">
              {scope.size} permitted stations ·{" "}
              {view === "bulk"
                ? "Bulk attendance days compared with mapped-ID delivery days"
                : dailyUsage
                  ? "ID ownership and actual daily usage · expand for dates"
                  : "Punch found, delivery evidence needs review"}
            </p>
          </div>
          {!dailyUsage && (
            <div className={styles.tabs}>
              <button
                aria-pressed={view === "associate"}
                onClick={() => setView("associate")}
              >
                Associate view
              </button>
              <button
                aria-pressed={view === "day"}
                onClick={() => setView("day")}
              >
                Day view
              </button>
              <button
                aria-pressed={view === "bulk"}
                onClick={() => setView("bulk")}
              >
                Bulk periods ·{" "}
                {bulkScoped.filter((p: any) => p.needsReview).length} flagged
              </button>
            </div>
          )}
        </div>
        {loading ? (
          <p className="panel-body">Loading all permitted stations…</p>
        ) : error ? (
          <p className="panel-body">
            Refresh to load the cases before reviewing.
          </p>
        ) : dailyUsage ? (
          <DailyIdUsageTable rows={rows} onReview={(list) => void open(list)} />
        ) : view === "bulk" ? (
          <WorkedIdBulkPeriods periods={bulkRows} month={month} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    {view === "associate"
                      ? "Associate / days"
                      : "Date / associate"}
                  </th>
                  <th>Station</th>
                  <th>Biometric attendance</th>
                  <th>Own-ID deliveries</th>
                  <th>Reason / status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {view === "associate"
                  ? groups.map((g) => (
                      <tr key={String(g.id)}>
                        <td>
                          <strong>{g.rows[0].name}</strong>
                          <small className={styles.sub}>
                            {g.rows[0].dropxId} · {g.rows.length} days
                          </small>
                        </td>
                        <td>
                          {[
                            ...new Set(g.rows.map((r: any) => r.stationCode)),
                          ].join(", ")}
                        </td>
                        <td>
                          <span className={styles.punch}>Punch recorded</span>
                          <small className={styles.sub}>
                            {g.rows.length} flagged days
                          </small>
                        </td>
                        <td>
                          <strong>
                            {g.rows.every((r: any) => r.hasStationDeliveryData)
                              ? "0 recorded"
                              : "Report gaps"}
                          </strong>
                          <small className={styles.sub}>
                            On own mapped IDs
                          </small>
                        </td>
                        <td>
                          {[
                            ...new Set(
                              g.rows.map((r: any) => reasons[category(r)]),
                            ),
                          ].join(" · ")}
                          <small className={styles.sub}>
                            {g.rows.filter(pending).length} to review / approve
                          </small>
                        </td>
                        <td>
                          <button
                            className="button secondary compact"
                            onClick={() => void open(g.rows)}
                          >
                            Review {g.rows.length} days
                          </button>
                        </td>
                      </tr>
                    ))
                  : rows.map((r: any) => (
                      <tr key={r.key}>
                        <td>
                          {r.date}
                          <strong className={styles.sub}>{r.name}</strong>
                          <small>{r.dropxId}</small>
                        </td>
                        <td>{r.stationCode}</td>
                        <td>
                          <span className={styles.punch}>
                            {r.punches} biometric punches
                          </span>
                        </td>
                        <td>
                          <strong>
                            {r.hasStationDeliveryData
                              ? `${r.ownDeliveries} recorded`
                              : "Report unavailable"}
                          </strong>
                          <small className={styles.sub}>
                            {r.providerIds.join(", ") || "No own ID mapped"}
                          </small>
                        </td>
                        <td>
                          {reasons[category(r)]}
                          <small className={styles.sub}>{status(r)}</small>
                        </td>
                        <td>
                          <button
                            className="button secondary compact"
                            onClick={() => void open([r])}
                          >
                            Review day
                          </button>
                        </td>
                      </tr>
                    ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6}>No cases match these filters.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {current && (
        <div className={styles.overlay}>
          <section
            ref={dialog}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="worked-review-title"
            className={`panel ${styles.dialog}`}
          >
            <header className="panel-head">
              <div>
                <h2 id="worked-review-title">{current.name}</h2>
                <p>
                  {current.dropxId} · {current.role} · {drafts.length} days
                </p>
              </div>
              <button
                aria-label="Close review"
                className="button secondary"
                disabled={saving}
                onClick={close}
              >
                Close
              </button>
            </header>
            <div className={styles.dialogBody}>
              {!evidenceReady && (
                <p role="status">
                  {error
                    ? "Close and refresh to reload day evidence before saving."
                    : "Loading current day evidence and payment terms…"}
                </p>
              )}
              {drafts.some((d) => d.row.ownerAbsenceNeedsReview) && (
                <p className={styles.warning}>
                  Confirm whether the ID owner also worked. Earlier reviews did
                  not exclude the owner’s fixed attendance pay.
                </p>
              )}
              {drafts.length > 1 && (
                <section className={styles.bulk}>
                  <strong>Apply to selected days</strong>
                  <p className="subtle">
                    Choose dates below. Each day stays editable; all selected
                    days save together.
                  </p>
                  <div className={styles.bulkFields}>
                    <label>
                      Decision
                      <select
                        value={bulkDecision}
                        onChange={(e) => setBulkDecision(e.target.value)}
                      >
                        <option value="worked">Worked using another ID</option>
                        <option value="not_worked">
                          Not worked — mark absent
                        </option>
                      </select>
                    </label>
                    <button
                      className="button secondary"
                      disabled={!canEdit || saving || !evidenceReady}
                      onClick={() =>
                        setDrafts((ds) =>
                          ds.map((d) =>
                            d.enabled ? { ...d, decision: bulkDecision } : d,
                          ),
                        )
                      }
                    >
                      Apply decision
                    </button>
                    <label>
                      Same worked ID
                      <SearchableSelect
                        name="bulk-worked-id"
                        value=""
                        placeholder="Find ID or mapped name"
                        options={commonOptions}
                        onValueChange={applyId}
                        disabled={!canEdit || saving || !evidenceReady}
                      />
                    </label>
                    <label>
                      Did the ID owner also work?
                      <select
                        defaultValue=""
                        disabled={!canEdit || saving || !evidenceReady}
                        onChange={(e) => {
                          const yes = e.target.value === "yes";
                          setDrafts((ds) =>
                            ds.map((d) =>
                              !d.enabled
                                ? d
                                : {
                                    ...d,
                                    shares: d.shares.map((s) => {
                                      const source = daySources(d.row).find(
                                        (x: any) =>
                                          x.id === s.source_shipment_id,
                                      );
                                      return {
                                        ...s,
                                        owner_worked: yes,
                                        quantities: yes
                                          ? workedIdCounts({})
                                          : source
                                            ? available(d, source)
                                            : s.quantities,
                                      };
                                    }),
                                  },
                            ),
                          );
                        }}
                      >
                        <option value="" disabled>
                          Choose for selected days
                        </option>
                        <option value="yes">
                          Yes — both worked; split counts
                        </option>
                        <option value="no">
                          No — owner did not work; mark absent
                        </option>
                      </select>
                    </label>
                    <label>
                      Common review note
                      <input
                        value={bulkReason}
                        onChange={(e) => setBulkReason(e.target.value)}
                      />
                    </label>
                    <button
                      className="button secondary"
                      disabled={!canEdit || saving || !evidenceReady}
                      onClick={() =>
                        setDrafts((ds) =>
                          ds.map((d) =>
                            d.enabled ? { ...d, reason: bulkReason } : d,
                          ),
                        )
                      }
                    >
                      Apply note
                    </button>
                  </div>
                </section>
              )}
              {drafts.map((d, i) => {
                const r = d.row,
                  dayPay = (pay || []).filter(
                    (p: any) => p.stationId === r.stationId,
                  ),
                  calculated = dayPay.flatMap((p: any) =>
                    p.days.filter((x: any) => x.date === r.date),
                  ),
                  payAvailable =
                    dayPay.length &&
                    dayPay.every((p: any) => p.available) &&
                    calculated.length;
                return (
                  <details
                    key={r.key}
                    className={styles.dayCard}
                    open={drafts.length === 1 ? true : undefined}
                  >
                    <summary>
                      <label
                        className={styles.check}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          disabled={
                            saving ||
                            !!r.reviewElsewhere ||
                            !!r.lockReason ||
                            (!canEdit && !r.training?.canApprove)
                          }
                          onChange={(e) =>
                            patch(i, { enabled: e.target.checked })
                          }
                        />
                        <strong>
                          {r.date} · {r.stationCode}
                        </strong>
                      </label>
                      <span>
                        {r.punches} punches ·{" "}
                        {r.hasStationDeliveryData
                          ? `${r.ownDeliveries} own-ID deliveries`
                          : "report missing"}{" "}
                        · {status(r)}
                      </span>
                    </summary>
                    <div className={styles.dayBody}>
                      {r.lockReason && (
                        <p role="alert">
                          {r.lockReason} View only. Finance must resolve this
                          before changing the day.
                        </p>
                      )}
                      <div className={styles.evidence}>
                        <div>
                          <small>Biometric attendance</small>
                          <strong>{r.punches} punches recorded</strong>
                          <span>
                            {(r.punchTimes || [])
                              .map((t: string) =>
                                t
                                  ? new Date(t).toLocaleTimeString("en-IN", {
                                      timeZone: "Asia/Kolkata",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : "",
                              )
                              .filter(Boolean)
                              .join(", ")}
                          </span>
                        </div>
                        <div>
                          <small>Own mapped ID / deliveries</small>
                          <strong>
                            {r.hasStationDeliveryData
                              ? `${r.ownDeliveries} recorded`
                              : "Report unavailable"}
                          </strong>
                          <span>
                            {r.providerIds.join(", ") ||
                              "No own provider ID mapped"}
                          </span>
                        </div>
                        <div>
                          <small>Current calculated earning</small>
                          <strong>
                            {r.bulkPeriods?.some(
                              (p: any) =>
                                p.effective_from !== p.effective_to &&
                                r.date !== p.effective_to,
                            ) &&
                            payAvailable &&
                            calculated.every((x: any) => x.baseAmount === 0)
                              ? "Included in bulk period"
                              : payAvailable
                                ? money(
                                    calculated.reduce(
                                      (n: number, x: any) => n + x.baseAmount,
                                      0,
                                    ),
                                  )
                                : payError
                                  ? "Unavailable"
                                  : pay === null
                                    ? "Loading…"
                                    : "Unavailable"}
                          </strong>
                          <span>
                            {r.bulkPeriods?.length
                              ? "Bulk attendance applies; see period details below"
                              : "For this date, before deductions"}
                          </span>
                        </div>
                      </div>
                      {!!r.bulkPeriods?.length && (
                        <div className={styles.warning}>
                          {r.bulkPeriods.map((p: any) => (
                            <p key={p.id}>
                              <strong>
                                Bulk upload · {p.quantity} {p.attendance_basis}
                              </strong>{" "}
                              · {p.effective_from} – {p.effective_to}. Period
                              salary is posted on {p.effective_to}; ₹0 on
                              another date does not mean this punch was missed.
                            </p>
                          ))}
                          <button
                            className="button secondary compact"
                            onClick={() => {
                              setQuery(r.dropxId);
                              setShow("all");
                              setView("bulk");
                              close();
                            }}
                          >
                            View bulk period comparison
                          </button>
                        </div>
                      )}
                      {r.reviewElsewhere && (
                        <p className={styles.error}>
                          This day was already reviewed at {r.reviewElsewhere}.
                          Open that station to amend it.
                        </p>
                      )}
                      {!r.hasStationDeliveryData && (
                        <p className={styles.warning}>
                          No station delivery report is loaded for this date.
                          Verify the import before deciding absence.
                        </p>
                      )}
                      <details className={styles.payDetails}>
                        <summary>
                          Payment structure effective on {r.date}
                        </summary>
                        {(r.payPlans || []).map((p: any, j: number) => (
                          <div key={j}>
                            <strong>
                              {p.name}
                              {p.providerId ? ` · ${p.providerId}` : ""}
                            </strong>
                            <small className={styles.sub}>
                              Effective {p.from} – {p.to || "ongoing"}
                            </small>
                            <ul>
                              {p.components.map((c: any) => (
                                <li key={c.code}>
                                  {c.label || c.code}:{" "}
                                  <strong>
                                    {p.values[c.code] === undefined
                                      ? "Not configured"
                                      : money(Number(p.values[c.code]))}
                                  </strong>{" "}
                                  /{" "}
                                  {(c.schedule || "unit")
                                    .replace("per_", "")
                                    .replaceAll("_", " ")}
                                </li>
                              ))}
                            </ul>
                            {p.threshold?.enabled && (
                              <p>
                                Production thresholds apply; see calculated
                                lines below.
                              </p>
                            )}
                          </div>
                        ))}
                        {calculated
                          .flatMap((x: any) => x.lines || [])
                          .map((line: any, j: number) => (
                            <p key={j}>
                              {line.label}: {line.count} × {money(line.rate)} ={" "}
                              <strong>{money(line.amount)}</strong>
                            </p>
                          ))}
                        {payError && (
                          <p className={styles.error}>
                            Calculated pay could not load: {payError}
                          </p>
                        )}
                        <a
                          href={`/payments/workforce-payouts?month=${month}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open workforce payouts
                        </a>
                      </details>
                      {r.training && r.training.status !== "cancelled" && (
                        <div className={styles.warning}>
                          <strong>Buddy training · {r.training.status}</strong>
                          <p>
                            {r.trainingUsed}/2 days used or pending · DropX
                            registered {r.registeredDate}
                          </p>
                          <p>
                            Buddy: {r.training.buddyName || "Loading evidence…"}{" "}
                            · {r.training.buddyDropxId} ·{" "}
                            {r.training.buddyProviderId}
                          </p>
                          <p>
                            {r.training.buddyPunches ?? "—"} biometric punches ·{" "}
                            {r.training.buddyDeliveries ?? "—"} recorded
                            deliveries
                          </p>
                          <p>
                            Approver:{" "}
                            {r.training.approver_names.join(", ") ||
                              "Not configured"}
                          </p>
                          {r.training.status === "pending" && (
                            <p>Not payable until CM/AOM approval.</p>
                          )}
                          {r.training.canApprove && (
                            <div className={styles.tabs}>
                              <button
                                disabled={saving}
                                onClick={() =>
                                  patch(i, {
                                    enabled: true,
                                    decision: "approve_training",
                                    reason: "",
                                  })
                                }
                              >
                                Approve training
                              </button>
                              <button
                                disabled={saving}
                                onClick={() =>
                                  patch(i, {
                                    enabled: true,
                                    decision: "reject_training",
                                    reason: "",
                                  })
                                }
                              >
                                Reject training
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      <label>
                        Decision
                        <select
                          value={d.decision}
                          disabled={!canEdit || saving || !!r.reviewElsewhere}
                          onChange={(e) =>
                            patch(i, { decision: e.target.value })
                          }
                        >
                          <option value="worked">
                            Worked using another ID
                          </option>
                          <option value="not_worked">
                            Not worked — mark absent
                          </option>
                          {r.trainingEligible && (
                            <option value="training">
                              Buddy training — request CM/AOM approval
                            </option>
                          )}
                          {!["worked", "not_worked", "training"].includes(
                            d.decision,
                          ) && (
                            <option value={d.decision} disabled>
                              {d.decision.replaceAll("_", " ")}
                            </option>
                          )}
                        </select>
                      </label>
                      {d.decision === "worked" && (
                        <>
                          <label>
                            Actual provider ID used
                            <SearchableSelect
                              key={d.shares.length}
                              name={`worked-id-${i}`}
                              value=""
                              placeholder="Search ID or mapped name"
                              disabled={!canEdit || saving || !evidenceReady}
                              options={daySources(r)
                                .filter(
                                  (s: any) =>
                                    !s.lockReason &&
                                    !d.shares.some(
                                      (x) => x.source_shipment_id === s.id,
                                    ),
                                )
                                .map((s: any) => ({
                                  value: s.id,
                                  label: `${s.provider_employee_id} · ${s.provider_employee_name || s.ownerName}`,
                                  helper: `${s.ownerName} · ${s.ownerDropxId} · ${s.counts.total_delivery} deliveries · ${s.payMethod}`,
                                }))}
                              onValueChange={(id) => {
                                const s = daySources(r).find(
                                  (x: any) => x.id === id,
                                );
                                if (s)
                                  patch(i, {
                                    shares: [...d.shares, makeShare(s)],
                                  });
                              }}
                            />
                          </label>
                          {d.shares.map((s, j) => {
                            const source = daySources(r).find(
                              (x: any) => x.id === s.source_shipment_id,
                            );
                            if (!source)
                              return <p key={j}>Source changed. Reload.</p>;
                            const remaining = available(d, source);
                            return (
                              <section
                                key={s.source_shipment_id}
                                className={styles.share}
                              >
                                <strong>
                                  {source.provider_employee_id} ·{" "}
                                  {source.ownerName}
                                </strong>
                                <p className="subtle">
                                  {source.ownerDropxId} · {source.payMethod}
                                </p>
                                <label>
                                  Did {source.ownerName} also work that day?
                                  <select
                                    value={
                                      s.owner_worked === null
                                        ? ""
                                        : s.owner_worked
                                          ? "yes"
                                          : "no"
                                    }
                                    disabled={
                                      !canEdit || saving || !evidenceReady
                                    }
                                    onChange={(e) =>
                                      updateShare(i, j, {
                                        owner_worked: e.target.value === "yes",
                                        quantities:
                                          e.target.value === "no"
                                            ? remaining
                                            : workedIdCounts({}),
                                      })
                                    }
                                  >
                                    <option value="" disabled>
                                      Choose yes or no
                                    </option>
                                    <option value="yes">
                                      Yes — both worked; split the work
                                    </option>
                                    <option value="no">
                                      No — did not work; mark owner absent
                                    </option>
                                  </select>
                                </label>
                                {s.owner_worked === false && (
                                  <p className={styles.warning}>
                                    {source.ownerName} will be marked absent for
                                    payout on {r.date}. Their attendance pay is
                                    excluded, including fixed MG/salary. The
                                    remaining work goes to {r.name} under their
                                    own rates.
                                  </p>
                                )}
                                <div className={`table-wrap ${styles.split}`}>
                                  <table>
                                    <thead>
                                      <tr>
                                        <th>Work</th>
                                        <th>Available</th>
                                        <th>{r.name}</th>
                                        <th>ID owner keeps</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {workedIdPaymentMetrics.map((k) => (
                                        <tr key={k}>
                                          <td>{workedIdPaymentLabels[k]}</td>
                                          <td>{remaining[k]}</td>
                                          <td>
                                            <input
                                              type="number"
                                              min={0}
                                              max={remaining[k]}
                                              step={1}
                                              aria-label={`${r.date} ${workedIdPaymentLabels[k]} performed`}
                                              value={s.quantities[k]}
                                              disabled={
                                                !canEdit ||
                                                saving ||
                                                s.owner_worked !== true
                                              }
                                              onChange={(e) => {
                                                updateShare(i, j, {
                                                  quantities:
                                                    updateWorkedIdPaymentShare(
                                                      remaining,
                                                      s.quantities,
                                                      k,
                                                      Number(e.target.value),
                                                    ),
                                                });
                                              }}
                                            />
                                          </td>
                                          <td>
                                            {remaining[k] - s.quantities[k]}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                <button
                                  className="button secondary compact"
                                  disabled={
                                    !canEdit || saving || !evidenceReady
                                  }
                                  onClick={() =>
                                    patch(i, {
                                      shares: d.shares.filter(
                                        (_, k) => k !== j,
                                      ),
                                    })
                                  }
                                >
                                  Remove ID
                                </button>
                              </section>
                            );
                          })}
                        </>
                      )}
                      {d.decision === "not_worked" && (
                        <p className={styles.warning}>
                          Exclude this day’s attendance pay for {r.name}.
                          Original biometric punches remain unchanged.
                        </p>
                      )}
                      {d.decision === "training" && (
                        <div className={styles.share}>
                          <p>
                            <strong>
                              {r.trainingUsed}/2 training days used or pending
                            </strong>{" "}
                            · DropX registered {r.registeredDate}
                          </p>
                          <p>
                            Approval:{" "}
                            {r.trainingRoute.join(", ") ||
                              "No CM/AOM configured"}
                            . This day is not payable while approval is pending.
                          </p>
                          <label>
                            Buddy’s worked ID
                            <SearchableSelect
                              name={`buddy-${i}`}
                              value={d.buddySourceId}
                              placeholder="Select buddy with delivery evidence"
                              options={daySources(r)
                                .filter((s: any) => s.ownerPunches > 0)
                                .map((s: any) => ({
                                  value: s.id,
                                  label: `${s.ownerName} · ${s.provider_employee_id}`,
                                  helper: `${s.ownerDropxId} · ${s.counts.total_delivery} deliveries`,
                                }))}
                              onValueChange={(v) =>
                                patch(i, { buddySourceId: v })
                              }
                              disabled={!canEdit || saving || !evidenceReady}
                            />
                          </label>
                          <small>
                            The backend also verifies the buddy’s biometric
                            punch, the registration month, and the two-day
                            limit.
                          </small>
                        </div>
                      )}
                      <label>
                        {["approve_training", "reject_training"].includes(
                          d.decision,
                        )
                          ? "Manager decision note"
                          : "Review reason / evidence"}
                        <textarea
                          rows={2}
                          maxLength={1800}
                          value={d.reason}
                          disabled={
                            saving || (!canEdit && !r.training?.canApprove)
                          }
                          onChange={(e) => patch(i, { reason: e.target.value })}
                          placeholder="Record what was confirmed with the station team."
                        />
                      </label>
                      {r.updatedAt && (
                        <small>
                          Last reviewed by {r.updatedBy} ·{" "}
                          {new Date(r.updatedAt).toLocaleString("en-IN", {
                            timeZone: "Asia/Kolkata",
                          })}
                        </small>
                      )}
                      {r.version > 0 && !r.training && (
                        <button
                          className="button secondary compact"
                          disabled={!canEdit || saving || !evidenceReady}
                          onClick={() =>
                            patch(i, {
                              enabled: true,
                              decision: "reopened",
                              reason: "",
                            })
                          }
                        >
                          Reopen review
                        </button>
                      )}
                      {d.decision === "reopened" && (
                        <p className={styles.warning}>
                          This restores the calculation before this review,
                          including the ID owner’s attendance.
                        </p>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
            <footer className={styles.footer}>
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              <span>
                {dailyUsage && validatedSignature === JSON.stringify(selected)
                  ? `Validated · ${selected.length} days · ${affectedCount} associates affected. Both payouts recalculate using their own terms.`
                  : `${selected.length} days selected · Each day is checked before saving`}
              </span>
              <button
                className="button"
                disabled={saving || !selected.length || !evidenceReady}
                onClick={() => void save()}
              >
                {saving
                  ? "Checking and updating…"
                  : dailyUsage &&
                      validatedSignature !== JSON.stringify(selected)
                    ? "Validate selected changes"
                    : `Confirm ${selected.length} day${selected.length === 1 ? "" : "s"} & update payouts`}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
