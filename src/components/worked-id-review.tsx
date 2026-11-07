"use client";
import { useEffect, useRef, useState } from "react";
import { SearchableSelect } from "@/components/searchable-select";
import {
  workedIdCounts,
  workedIdMetrics,
  workedIdShareError,
} from "@/lib/worked-id-review";
type Location = { id: string; station_code: string; station_name: string };
const labels: Record<string, string> = {
  total_delivery: "Deliveries",
  amazon_delivery: "Amazon deliveries",
  swa_delivery: "SWA deliveries",
  c_return: "Customer returns",
  mfn: "Pickups",
  mfn_return: "Seller returns",
  assigned_count: "All assigned shipments",
  delivery_assigned_count: "Assigned deliveries",
  pickup_assigned_count: "Assigned pickups",
};
export function WorkedIdReview({
  locations,
  initialMonth,
  canEdit,
}: {
  locations: Location[];
  initialMonth: string;
  canEdit: boolean;
}) {
  const requestId = useRef(0),
    dialogRef = useRef<HTMLElement>(null);
  const [station, setStation] = useState(""),
    [month, setMonth] = useState(initialMonth),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [q, setQ] = useState(""),
    [filter, setFilter] = useState("pending"),
    [selected, setSelected] = useState<any>(null),
    [decision, setDecision] = useState("worked"),
    [reason, setReason] = useState(""),
    [shares, setShares] = useState<any[]>([]),
    [saving, setSaving] = useState(false);
  async function load() {
    const request = ++requestId.current;
    if (!station) {
      setData(null);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
          `/api/provider-mapping/worked-id-review?${new URLSearchParams({ station, month })}`,
          { cache: "no-store" },
        ),
        body = await res.json();
      if (request !== requestId.current) return;
      if (!res.ok) throw Error(body.error);
      setData(body);
    } catch (e) {
      if (request !== requestId.current) return;
      setError(e instanceof Error ? e.message : "Could not load.");
      setData(null);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }
  useEffect(() => {
    setData(null);
    setSelected(null);
    void load();
  }, [station, month]);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) {
        setSelected(null);
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
      );
      if (!nodes?.length) return;
      const first = nodes[0],
        last = nodes[nodes.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialogRef.current)
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
  }, [selected, saving]);
  const pending = (r: any) => ["pending", "reopened"].includes(r.decision);
  const rows = (data?.rows || []).filter(
    (r: any) =>
      (filter === "all" || (filter === "pending" ? pending(r) : !pending(r))) &&
      `${r.name} ${r.dropxId} ${r.providerIds.join(" ")}`
        .toLowerCase()
        .includes(q.toLowerCase()),
  );
  const sources = (data?.sources || []).filter(
    (s: any) =>
      s.work_date === selected?.date && s.ownerId !== selected?.workerId,
  );
  function open(r: any) {
    setSelected(r);
    setDecision(pending(r) ? "worked" : r.decision);
    setReason(r.reason || "");
    setShares((r.shares || []).map((x: any) => ({ ...x })));
    setError("");
  }
  function available(s: any) {
    const own = (selected?.shares || []).find(
      (a: any) => a.source_shipment_id === s.id,
    );
    return Object.fromEntries(
      workedIdMetrics.map((k) => [
        k,
        s.counts[k] - s.allocated[k] + Number(own?.quantities[k] || 0),
      ]),
    ) as ReturnType<typeof workedIdCounts>;
  }
  function add(id: string) {
    const source = sources.find((s: any) => s.id === id);
    if (!source || shares.some((s) => s.source_shipment_id === id)) return;
    setShares([
      ...shares,
      {
        source_shipment_id: id,
        owner_worked: null,
        source_counts: source.counts,
        quantities: workedIdCounts({}),
      },
    ]);
  }
  function update(i: number, value: any) {
    setShares((current) =>
      current.map((s, j) => (j === i ? { ...s, ...value } : s)),
    );
  }
  async function save() {
    setError("");
    if (reason.trim().length < 3) {
      setError("Add a short reason for the review.");
      return;
    }
    if (decision === "worked") {
      if (!shares.length) {
        setError("Select the provider ID used.");
        return;
      }
      for (const a of shares) {
        const source = sources.find((s: any) => s.id === a.source_shipment_id);
        if (!source) {
          setError("The source report changed. Reload this review.");
          return;
        }
        const e = workedIdShareError(
          available(source),
          a.quantities,
          a.owner_worked,
        );
        if (e) {
          setError(e);
          return;
        }
      }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/provider-mapping/worked-id-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            stationId: station,
            workerId: selected.workerId,
            date: selected.date,
            version: selected.version,
            decision,
            reason,
            shares: decision === "worked" ? shares : [],
          }),
        }),
        body = await res.json();
      if (!res.ok) throw Error(body.error);
      setNotice(body.message);
      setSelected(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Review was not saved.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <section className="panel">
        <div
          className="panel-body"
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "end",
          }}
        >
          <label>
            Location
            <select
              value={station}
              onChange={(e) => setStation(e.target.value)}
            >
              <option value="">Choose a location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.station_code} — {l.station_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Month
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
          </label>
          <label>
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="pending">Needs review</option>
              <option value="reviewed">Reviewed</option>
              <option value="all">All</option>
            </select>
          </label>
          <label>
            Find associate or ID
            <input
              placeholder="Name, DropX ID or provider ID"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <button
            className="button secondary"
            onClick={() => void load()}
            disabled={!station || loading}
          >
            Refresh
          </button>
        </div>
      </section>
      {notice && !selected ? (
        <p role="status" className="panel" style={{ padding: 16 }}>
          {notice}
        </p>
      ) : null}
      {error && !selected ? (
        <p
          role="alert"
          className="panel"
          style={{ padding: 16, color: "#b42318" }}
        >
          {error}
        </p>
      ) : null}
      {data ? (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{data.rows.filter(pending).length} days need review</h2>
              <p className="subtle">
                {data.rows.filter((r: any) => !pending(r)).length} reviewed ·
                One decision per associate and day
              </p>
            </div>
            <a href="/provider-id-mapping">ID &amp; pay setup</a>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Associate</th>
                  <th>Mapped ID</th>
                  <th>Punches</th>
                  <th>Review</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.key}>
                    <td>{r.date}</td>
                    <td>
                      <strong>{r.name}</strong>
                      <br />
                      <small>
                        {r.dropxId} · {r.role}
                      </small>
                    </td>
                    <td>
                      {r.providerIds.join(", ") || "No own provider ID"}
                      {!r.hasPaySetup ? (
                        <small style={{ display: "block", color: "#a15c00" }}>
                          Payment terms needed
                        </small>
                      ) : null}
                    </td>
                    <td>{r.punches}</td>
                    <td>
                      {pending(r)
                        ? "Needs review"
                        : r.decision.replaceAll("_", " ")}
                      {r.shares.length ? (
                        <small style={{ display: "block" }}>
                          {r.shares.length} worked ID(s)
                        </small>
                      ) : null}
                    </td>
                    <td>
                      <button
                        className="button secondary compact"
                        onClick={() => open(r)}
                      >
                        {canEdit ? "Review day" : "View"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 24 }}>
                      {loading ? "Loading…" : "No days match these filters."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <p className="subtle">
          {loading
            ? "Loading attendance and delivery evidence…"
            : "Choose a location to review biometric days without deliveries."}
        </p>
      )}
      {selected ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#14243588",
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            padding: 20,
          }}
        >
          <section
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="worked-review-title"
            className="panel"
            style={{
              width: "min(850px,100%)",
              maxHeight: "92vh",
              overflow: "auto",
            }}
          >
            <div className="panel-head">
              <div>
                <h2 id="worked-review-title">{selected.name}</h2>
                <p className="subtle">
                  {selected.dropxId} · {selected.date} · {selected.punches}{" "}
                  biometric punches
                </p>
              </div>
              <button
                aria-label="Close review"
                className="button secondary"
                disabled={saving}
                onClick={() => setSelected(null)}
              >
                Close
              </button>
            </div>
            <div className="panel-body">
              <label>
                What happened?
                <select
                  disabled={!canEdit || saving}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                >
                  <option value="worked">Worked using another ID</option>
                  <option value="not_worked">
                    Not worked — exclude attendance
                  </option>
                  <option value="other_work">
                    Worked on pickup / other duty
                  </option>
                  {selected.version > 0 ? (
                    <option value="reopened">Reopen — undo this review</option>
                  ) : null}
                </select>
              </label>
              {decision === "worked" ? (
                <>
                  {!selected.hasPaySetup ? (
                    <p style={{ color: "#a15c00" }}>
                      This associate needs their own fixed payment terms before
                      saving.{" "}
                      <a
                        href="/provider-id-mapping"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open ID &amp; pay setup
                      </a>
                    </p>
                  ) : null}
                  <label>
                    Provider ID used
                    <SearchableSelect
                      key={shares.length}
                      name="worked-provider-id"
                      disabled={!canEdit || saving}
                      value=""
                      placeholder="Search provider ID or mapped name"
                      onValueChange={add}
                      options={sources
                        .filter(
                          (s: any) =>
                            !s.mappingIssue &&
                            !shares.some((x) => x.source_shipment_id === s.id),
                        )
                        .map((s: any) => ({
                          value: s.id,
                          label: `${s.provider_employee_id} · ${s.provider_employee_name || s.ownerName}`,
                          helper: `${s.ownerName} · ${s.ownerDropxId} · ${s.counts.total_delivery} deliveries · ${s.payMethod}`,
                        }))}
                    />
                  </label>
                  {sources.some((s: any) => s.mappingIssue) ? (
                    <small>
                      IDs with unresolved ownership must be corrected in ID
                      Mapping before use.
                    </small>
                  ) : null}
                  {shares.map((a, i) => {
                    const s = sources.find(
                      (s: any) => s.id === a.source_shipment_id,
                    );
                    if (!s)
                      return (
                        <p key={i}>Source unavailable. Reload before saving.</p>
                      );
                    const remain = available(s);
                    return (
                      <section
                        className="panel"
                        key={a.source_shipment_id}
                        style={{ marginTop: 14 }}
                      >
                        <div className="panel-body">
                          <strong>
                            {s.provider_employee_id} ·{" "}
                            {s.provider_employee_name}
                          </strong>
                          <p className="subtle">
                            Mapped to {s.ownerName} ({s.ownerDropxId}) ·{" "}
                            {s.payMethod}
                          </p>
                          {s.counts.total_delivery !== remain.total_delivery ? (
                            <small>
                              {s.counts.total_delivery - remain.total_delivery}{" "}
                              deliveries already assigned in other reviews.
                            </small>
                          ) : null}
                          <label>
                            Did the mapped associate also work on this ID?
                            <select
                              disabled={!canEdit || saving}
                              value={
                                a.owner_worked === null
                                  ? ""
                                  : a.owner_worked
                                    ? "yes"
                                    : "no"
                              }
                              onChange={(e) =>
                                update(i, {
                                  owner_worked: e.target.value === "yes",
                                  source_counts: s.counts,
                                  quantities:
                                    e.target.value === "no"
                                      ? remain
                                      : workedIdCounts({}),
                                })
                              }
                            >
                              <option value="" disabled>
                                Choose yes or no
                              </option>
                              <option value="yes">Yes — split the work</option>
                              <option value="no">
                                No — this associate did the remaining work
                              </option>
                            </select>
                          </label>
                          <div className="table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Work</th>
                                  <th>Available</th>
                                  <th>{selected.name}</th>
                                  <th>Mapped associate keeps</th>
                                </tr>
                              </thead>
                              <tbody>
                                {workedIdMetrics
                                  .filter(
                                    (k) =>
                                      k === "total_delivery" || s.counts[k] > 0,
                                  )
                                  .map((k) => (
                                    <tr key={k}>
                                      <td>{labels[k]}</td>
                                      <td>{remain[k]}</td>
                                      <td>
                                        <input
                                          aria-label={labels[k] + " performed"}
                                          type="number"
                                          min={0}
                                          max={remain[k]}
                                          step={1}
                                          disabled={
                                            !canEdit ||
                                            saving ||
                                            a.owner_worked === false
                                          }
                                          value={a.quantities[k]}
                                          onChange={(e) => {
                                            const n = Number(e.target.value),
                                              values = {
                                                ...a.quantities,
                                                [k]: n,
                                              };
                                            if (k === "total_delivery") {
                                              if (
                                                s.counts.swa_delivery === 0 &&
                                                s.counts.amazon_delivery ===
                                                  s.counts.total_delivery
                                              )
                                                values.amazon_delivery = n;
                                              if (
                                                s.counts.amazon_delivery ===
                                                  0 &&
                                                s.counts.swa_delivery ===
                                                  s.counts.total_delivery
                                              )
                                                values.swa_delivery = n;
                                            }
                                            update(i, { quantities: values });
                                          }}
                                        />
                                      </td>
                                      <td>{remain[k] - a.quantities[k]}</td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="subtle">
                            Fixed MG / salary stays unchanged. Variable
                            components follow the confirmed split and each
                            associate’s own rates.
                          </p>
                          <button
                            className="button secondary compact"
                            disabled={!canEdit || saving}
                            onClick={() =>
                              setShares(shares.filter((_, j) => j !== i))
                            }
                          >
                            Remove ID
                          </button>
                        </div>
                      </section>
                    );
                  })}
                </>
              ) : decision === "not_worked" ? (
                <p>
                  This excludes the day from payout attendance. The original
                  biometric punches remain available as evidence.
                </p>
              ) : decision === "reopened" ? (
                <p>
                  This restores the calculation before this review. The review
                  history is retained.
                </p>
              ) : (
                <p>
                  Keep attendance credit and record the actual duty below. No
                  delivery counts are reassigned.
                </p>
              )}
              <label style={{ display: "block", marginTop: 16 }}>
                Reason / work confirmed
                <textarea
                  disabled={!canEdit || saving}
                  value={reason}
                  maxLength={2000}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Record what was checked with the station team."
                  rows={2}
                />
              </label>
              {selected.updatedAt ? (
                <small>
                  Last reviewed by {selected.updatedBy} ·{" "}
                  {new Date(selected.updatedAt).toLocaleString("en-IN", {
                    timeZone: "Asia/Kolkata",
                  })}
                </small>
              ) : null}
              {error ? (
                <p role="alert" style={{ color: "#b42318" }}>
                  {error}
                </p>
              ) : null}
              {canEdit ? (
                <button
                  className="button"
                  disabled={
                    saving || (decision === "worked" && !selected.hasPaySetup)
                  }
                  onClick={() => void save()}
                >
                  {saving
                    ? "Saving and refreshing payouts…"
                    : "Save review & update payouts"}
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
