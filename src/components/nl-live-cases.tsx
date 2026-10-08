"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  casePhase,
  disputeGate,
  filedInCloak,
  requestSent,
  DISPUTE_REASONS,
  REQUEST_STATUS,
  type DisputeRequest,
  type LiveWindow,
  type PhaseKey,
} from "@/lib/ops-pulse/nl-dispute-policy";
import { recoveryCsv } from "@/lib/ops-pulse/nl-loss-policy";
import type { LiveCase } from "@/lib/ops-pulse/nl-live";
import styles from "./nl-loss.module.css";

const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(n);
const when = (s: string) =>
  new Date(s).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
const FILTERS = [
  { key: "todo", label: "Needs action", phases: ["action", "respond"] },
  { key: "amazon", label: "With Amazon", phases: ["amazon"] },
  { key: "decided", label: "Decided", phases: ["won", "lost", "accepted", "missed"] },
  { key: "", label: "All", phases: null },
] as const satisfies readonly { key: string; label: string; phases: readonly PhaseKey[] | null }[];
const phaseOf = (c: LiveCase) =>
  casePhase({
    case_status: c.details.case_status,
    nl_status: c.source_status,
    extra: c.details.extra,
  });
const gateOf = (c: LiveCase, window: LiveWindow) =>
  disputeGate(
    {
      case_status: c.details.case_status,
      nl_status: c.source_status,
      extra: c.details.extra,
    },
    window,
  );
const likeOf = (c: LiveCase) => ({
  case_status: c.details.case_status,
  nl_status: c.source_status,
  extra: c.details.extra,
});
const actionLabel: Record<string, string> = {
  save: "Draft saved",
  submit: "Sent to Cloak desk",
  withdraw: "Withdrawn by station",
  return: "Returned by desk",
  file: "Marked filed in Cloak",
};

export function NlLiveCases({
  month,
  cases,
  window,
  initialPhase,
  canDispute,
  canDesk,
}: {
  month: string;
  cases: LiveCase[];
  window: LiveWindow;
  initialPhase: string;
  canDispute: boolean;
  canDesk: boolean;
}) {
  const [filter, setFilter] = useState(
    FILTERS.some((f) => f.key === initialPhase) ? initialPhase : "",
  );
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [active, setActive] = useState<string | null>(null);
  const withPhase = useMemo(
    () => cases.map((c) => ({ c, phase: phaseOf(c) })),
    [cases],
  );
  const counts = (phases: readonly PhaseKey[] | null) =>
    withPhase.filter((x) => !phases || phases.includes(x.phase.key)).length;
  const shown = useMemo(() => {
    const phases = FILTERS.find((f) => f.key === filter)?.phases ?? null;
    const q = query.trim().toLowerCase();
    return withPhase.filter(
      ({ c, phase }) =>
        (!phases || (phases as readonly PhaseKey[]).includes(phase.key)) &&
        (!q ||
          [
            c.details.tid,
            c.details.category,
            c.details.sub_category,
            c.details.extra?.shipment_type,
            c.request?.reason,
          ]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
  }, [withPhase, filter, query]);
  const pages = Math.ceil(shown.length / 15);
  const current = shown.slice(page * 15, page * 15 + 15);
  function download() {
    const columns = [
      "Month", "Station", "TID", "Loss reason", "Sub reason", "Shipment type", "Value",
      "Cloak status", "Cloak stage", "Amazon decision", "Dispute filed in Cloak",
      "Cloak dispute reason", "Our remarks in Cloak", "Amazon remarks",
      "OpsPulse request", "Request decision", "Request reason", "Request remarks",
      "CCTV link", "Updated by", "Updated at",
    ];
    const rows = shown.map(({ c }) => {
      const x = c.details.extra ?? {};
      return [
        c.month, c.station_code, c.details.tid, c.details.category, c.details.sub_category,
        x.shipment_type, c.amount, c.details.case_status, x.current_sla_stage, c.source_status,
        x.dispute_selected, x.dispute_reason, x.partner_remarks, x.nl_remarks,
        c.request ? REQUEST_STATUS[c.request.status].label : "",
        c.request?.decision, c.request?.reason, c.request?.remarks, c.request?.cctv_url,
        c.request?.updated_by_name, c.request?.updated_at,
      ];
    });
    const url = URL.createObjectURL(
      new Blob(
        ["﻿" + [columns, ...rows].map((r) => r.map(recoveryCsv).join(",")).join("\r\n")],
        { type: "text/csv;charset=utf-8" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `nl-live-${month}-${cases[0]?.station_code ?? "station"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>Live cases</h2>
          <p>
            {shown.length} of {cases.length} cases ·{" "}
            {money(shown.reduce((v, x) => v + Number(x.c.amount || 0), 0))}
          </p>
        </div>
        <div className={styles.toolbar}>
          <input
            aria-label="Search live cases"
            placeholder="Search TID or reason"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
          <button className={styles.button} onClick={download}>
            Download CSV
          </button>
        </div>
      </div>
      <div className={styles.chips} role="tablist" aria-label="Case status">
        {FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            role="tab"
            aria-selected={filter === f.key}
            className={`${styles.chip} ${filter === f.key ? styles.activeChip : ""}`}
            onClick={() => {
              setFilter(f.key);
              setPage(0);
              setActive(null);
            }}
          >
            {f.label} <b>{counts(f.phases)}</b>
          </button>
        ))}
      </div>
      <div className={styles.cases}>
        {current.map(({ c, phase }) => {
          return (
            <article key={c.case_key} className={styles.case}>
              <button
                className={styles.caseSummary}
                aria-expanded={active === c.case_key}
                onClick={() => setActive(active === c.case_key ? null : c.case_key)}
              >
                <div>
                  <strong>{c.details.tid || c.case_key}</strong>
                  <span>
                    {c.details.category || "Unspecified reason"}
                    {c.details.sub_category && c.details.sub_category !== c.details.category
                      ? ` · ${c.details.sub_category}`
                      : ""}
                  </span>
                </div>
                <div>
                  <strong>{money(c.amount)}</strong>
                  <span className={styles.badges}>
                    <span className={`${styles.badge} ${styles[phase.tone]}`}>
                      {phase.label}
                    </span>
                    {c.request &&
                    !filedInCloak(c.request, likeOf(c)) &&
                    (requestSent(c.request, c.details.extra?.current_sla_stage) ||
                      c.request.status === "draft" ||
                      c.request.status === "returned") ? (
                      <span className={`${styles.badge} ${styles[REQUEST_STATUS[c.request.status].tone]}`}>
                        {REQUEST_STATUS[c.request.status].label}
                      </span>
                    ) : null}
                  </span>
                </div>
                <span aria-hidden>{active === c.case_key ? "−" : "+"}</span>
              </button>
              {active === c.case_key ? (
                <LiveDetail
                  row={c}
                  window={window}
                  canDispute={canDispute}
                  canDesk={canDesk}
                />
              ) : null}
            </article>
          );
        })}
      </div>
      {!shown.length ? (
        <p className={styles.empty}>
          {cases.length
            ? "No cases match this filter."
            : "No live cases for this station."}
        </p>
      ) : null}
      {pages > 1 ? (
        <div className={styles.pagination}>
          <button
            className={styles.button}
            disabled={!page}
            onClick={() => {
              setPage(page - 1);
              setActive(null);
            }}
          >
            Previous
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            className={styles.button}
            disabled={page >= pages - 1}
            onClick={() => {
              setPage(page + 1);
              setActive(null);
            }}
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

type History = {
  id: string;
  action: string;
  actor_name: string;
  created_at: string;
  snapshot: DisputeRequest;
};

function LiveDetail({
  row,
  window,
  canDispute,
  canDesk,
}: {
  row: LiveCase;
  window: LiveWindow;
  canDispute: boolean;
  canDesk: boolean;
}) {
  const router = useRouter();
  const x = row.details.extra ?? {};
  const gate = gateOf(row, window);
  const [request, setRequest] = useState<DisputeRequest | null>(row.request);
  const [history, setHistory] = useState<History[]>([]);
  const [decision, setDecision] = useState<"dispute" | "accept">(
    row.request?.decision ?? "dispute",
  );
  const [reason, setReason] = useState(row.request?.reason ?? "");
  const [remarks, setRemarks] = useState(row.request?.remarks ?? "");
  const [cctv, setCctv] = useState(row.request?.cctv_url ?? "");
  const [files, setFiles] = useState(row.request?.attachments ?? []);
  const [deskNote, setDeskNote] = useState("");
  const [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/ops-pulse/losses/disputes?month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(row.case_key)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const j = await res.json();
        if (!res.ok) throw Error(j.error);
        setHistory(j.history);
        // Someone may have updated the request since the list was loaded.
        if (j.request && j.request.version !== (row.request?.version ?? 0)) {
          setRequest(j.request);
          setDecision(j.request.decision);
          setReason(j.request.reason);
          setRemarks(j.request.remarks);
          setCctv(j.request.cctv_url ?? "");
          setFiles(j.request.attachments ?? []);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load the dispute.");
      }
    })();
    return () => controller.abort();
  }, [row.month, row.case_key, row.request?.version]);

  const status = request?.status ?? null;
  const sent = requestSent(request, x.current_sla_stage);
  // Sent in an earlier stage and Amazon has handed the case back: this round starts from that text.
  const earlierRound =
    gate.open && !sent && (status === "submitted" || status === "filed");
  const editable = canDispute && gate.open && !sent;
  // Cloak already holds a dispute decision (YES or NO) from this or an earlier revision.
  const inCloak = !!x.dispute_selected;
  const shownStatus =
    request && status && !earlierRound
      ? filedInCloak(request, likeOf(row))
        ? "filed"
        : status
      : null;
  const reasons = reason && !DISPUTE_REASONS.includes(reason)
    ? [reason, ...DISPUTE_REASONS]
    : DISPUTE_REASONS;
  const submitError =
    decision === "accept"
      ? ""
      : !reason
        ? "Choose the dispute reason."
        : remarks.trim().length < 10
          ? "Explain the dispute for Amazon (at least 10 characters)."
          : cctv && !/^https:\/\/\S+$/.test(cctv)
            ? "Enter a valid HTTPS CCTV link."
            : "";

  async function send(action: string, values: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/ops-pulse/losses/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month: row.month,
          case_key: row.case_key,
          version: request?.version ?? 0,
          action,
          values,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.error);
      setRequest(j.request);
      setHistory((h) => [
        {
          id: String(Date.now()),
          action,
          actor_name: j.request.updated_by_name,
          created_at: j.request.updated_at,
          snapshot: j.request,
        },
        ...h,
      ]);
      setDeskNote("");
      setSuccess(`${actionLabel[action]}.`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  const stationValues = () => ({
    decision,
    reason,
    remarks,
    cctv_url: cctv.trim(),
    attachments: files,
  });
  async function upload(list: FileList | null) {
    if (!list) return;
    if (files.length + list.length > 5) {
      setError("Attach up to 5 files.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.set("file", file);
        form.set("month", row.month);
        form.set("case", row.case_key);
        form.set("purpose", "dispute");
        const res = await fetch("/api/ops-pulse/losses/recovery/attachments", {
          method: "POST",
          body: form,
        });
        const j = await res.json();
        if (!res.ok) throw Error(j.error);
        setFiles((f) => [...f, j.attachment]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Attachment upload failed.");
    } finally {
      setUploading(false);
    }
  }
  const fileUrl = (id: string) =>
    `/api/ops-pulse/losses/recovery/attachments?purpose=dispute&month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(row.case_key)}&id=${encodeURIComponent(id)}`;

  return (
    <div className={styles.detail}>
      <div className={styles.sourceGrid}>
        <div>
          <small>Cloak status</small>
          <strong>{(row.details.case_status || "—").replaceAll("_", " ")}</strong>
        </div>
        <div>
          <small>Cloak stage</small>
          <strong>{x.current_sla_stage || "—"}</strong>
        </div>
        <div>
          <small>Shipment · impact date</small>
          <strong>
            {x.shipment_type || "—"}
            {row.details.impact_date ? ` · ${row.details.impact_date}` : ""}
          </strong>
        </div>
        <div>
          <small>Amazon decision</small>
          <strong>{row.source_status || "Pending"}</strong>
        </div>
      </div>
      {inCloak ? (
        <section className={styles.allocation}>
          <h3>
            {x.dispute_selected === "YES" ? "Dispute filed in Cloak" : "Accepted in Cloak (not disputed)"}
          </h3>
          <p className={styles.hint}>
            {x.disputed_time_ist ? `${x.disputed_time_ist} IST` : ""}
            {x.disputed_by ? ` · ${x.disputed_by}` : ""}
            {x.revision ? ` · revision ${x.revision}` : ""}
          </p>
          {x.dispute_reason ? (
            <p>
              <strong>Reason:</strong> {x.dispute_reason}
            </p>
          ) : null}
          {x.partner_remarks ? <p className={styles.sourceNote}>{x.partner_remarks}</p> : null}
          {x.dispute_proof ? (
            <p>
              <a
                href={`/api/ops-pulse/losses/cloak-proof?month=${encodeURIComponent(row.month)}&case=${encodeURIComponent(row.case_key)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open the proof filed in Cloak ↗
              </a>
            </p>
          ) : null}
          {x.nl_remarks || x.nl_res ? (
            <>
              <h3>Amazon’s response</h3>
              <p className={styles.hint}>
                {x.nl_remarks_time_ist ? `${x.nl_remarks_time_ist} IST` : ""}
                {x.nl_remarks_by ? ` · ${x.nl_remarks_by}` : ""}
              </p>
              <p className={styles.sourceNote}>{x.nl_remarks || x.nl_res}</p>
            </>
          ) : null}
        </section>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {success ? (
        <p role="status" className={styles.done}>
          {success}
        </p>
      ) : null}
      {!gate.open && !request ? (
        <p className={styles.hint}>{gate.reason}</p>
      ) : (
        <section className={styles.allocation}>
          <div className={styles.toolbar}>
            <h3>
              {gate.kind === "respond" ? "Respond to Amazon" : "Dispute request"}
            </h3>
            {shownStatus ? (
              <span className={`${styles.badge} ${styles[REQUEST_STATUS[shownStatus].tone]}`}>
                {REQUEST_STATUS[shownStatus].label}
              </span>
            ) : null}
          </div>
          {gate.open ? (
            <p className={styles.hint}>
              {gate.deadline
                ? `Open until the end of ${gate.deadline}. `
                : ""}
              The Cloak desk files what you send here — you do not need a Cloak
              login.
            </p>
          ) : (
            <p className={styles.notice}>{gate.reason}</p>
          )}
          {earlierRound ? (
            <p className={styles.notice}>
              Amazon sent this case back for more details. Your earlier dispute
              is filled in below — update it and send your response.
            </p>
          ) : null}
          {status === "returned" && request?.desk_note ? (
            <p className={styles.notice}>
              <strong>Returned by the Cloak desk:</strong> {request.desk_note}
            </p>
          ) : null}
          <fieldset className={styles.fieldset} disabled={!editable || busy || uploading}>
            <div className={styles.choice} role="radiogroup" aria-label="Decision">
              <label className={styles.check}>
                <input
                  type="radio"
                  name={`decision-${row.case_key}`}
                  checked={decision === "dispute"}
                  onChange={() => setDecision("dispute")}
                />
                Dispute this loss
              </label>
              <label className={styles.check}>
                <input
                  type="radio"
                  name={`decision-${row.case_key}`}
                  checked={decision === "accept"}
                  onChange={() => setDecision("accept")}
                />
                Accept the loss (no dispute)
              </label>
            </div>
            {decision === "dispute" ? (
              <>
                <label>
                  Dispute reason
                  <select value={reason} onChange={(e) => setReason(e.target.value)}>
                    <option value="">Select a reason</option>
                    {reasons.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Remarks for Amazon
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    placeholder="What happened, and why this loss is not the station’s. This text is filed with the dispute."
                  />
                </label>
                <label>
                  CCTV link (optional)
                  <input
                    type="url"
                    value={cctv}
                    onChange={(e) => setCctv(e.target.value)}
                    placeholder="https://drive.google.com/…"
                  />
                  <small>
                    Set sharing to “Anyone with the link can view” — Amazon
                    cannot open restricted links.
                  </small>
                </label>
                <label>
                  Proof (optional)
                  <input
                    type="file"
                    multiple
                    accept="application/pdf,image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      void upload(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <small>PDF or image, up to 5 files.</small>
                </label>
                {uploading ? <p role="status">Uploading proof…</p> : null}
              </>
            ) : (
              <label>
                Note (optional)
                <textarea
                  rows={2}
                  maxLength={4000}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Why the station accepts this loss."
                />
              </label>
            )}
          </fieldset>
          {decision === "dispute"
            ? files.map((a) => (
                <div className={styles.toolbar} key={a.id}>
                  <a href={fileUrl(a.id)} target="_blank" rel="noreferrer">
                    {a.file_name}
                  </a>
                  {editable ? (
                    <button
                      type="button"
                      className={styles.button}
                      onClick={() => setFiles(files.filter((f) => f.id !== a.id))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))
            : null}
          {editable ? (
            <div className={styles.toolbar}>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || uploading || !!submitError}
                title={submitError || undefined}
                onClick={() => void send("submit", stationValues())}
              >
                {busy ? "Saving…" : "Send to Cloak desk"}
              </button>
              <button
                type="button"
                className={styles.button}
                disabled={busy || uploading}
                onClick={() => void send("save", stationValues())}
              >
                Save draft
              </button>
              {submitError ? <span className={styles.hint}>{submitError}</span> : null}
            </div>
          ) : null}
          {canDispute && sent && shownStatus === "submitted" ? (
            <div className={styles.toolbar}>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => void send("withdraw", {})}
              >
                Withdraw to edit
              </button>
              <span className={styles.hint}>
                Waiting for the Cloak desk to file it.
                {gate.open ? "" : " The window is closed, so a withdrawn request cannot be sent again."}
              </span>
            </div>
          ) : null}
          {!canDispute && !sent && gate.open ? (
            <p className={styles.hint}>
              Read-only access. A cluster or station manager with Losses edit
              access can raise this dispute.
            </p>
          ) : null}
          {canDesk && sent && shownStatus ? (
            <div className={styles.desk}>
              <label>
                Cloak desk note
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={deskNote}
                  onChange={(e) => setDeskNote(e.target.value)}
                  placeholder="What the station should correct (required to return)."
                />
              </label>
              <div className={styles.toolbar}>
                {shownStatus === "submitted" ? (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => void send("file", { desk_note: deskNote })}
                  >
                    Mark filed in Cloak
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy || deskNote.trim().length < 5}
                  onClick={() => void send("return", { desk_note: deskNote })}
                >
                  Return to station
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}
      {history.length ? (
        <details className={styles.history}>
          <summary>
            Request history · {history.length} update
            {history.length === 1 ? "" : "s"}
          </summary>
          {history.map((h) => (
            <div key={h.id}>
              <strong>
                {actionLabel[h.action] ?? h.action} · {h.actor_name}
              </strong>
              <small>{when(h.created_at)}</small>
              {h.snapshot.decision === "dispute" && h.snapshot.reason ? (
                <p>
                  <strong>Reason:</strong> {h.snapshot.reason}
                </p>
              ) : null}
              {h.snapshot.remarks ? <p>{h.snapshot.remarks}</p> : null}
              {h.action === "return" && h.snapshot.desk_note ? (
                <p>
                  <strong>Desk:</strong> {h.snapshot.desk_note}
                </p>
              ) : null}
            </div>
          ))}
        </details>
      ) : null}
    </div>
  );
}
