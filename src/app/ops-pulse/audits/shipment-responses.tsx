"use client";
import { useEffect, useMemo, useState } from "react";
import type { AuditEmployee } from "@/lib/ops-pulse/station-audit-reconciliation";
import type {
  AuditOption,
  StationAuditWorkspace,
} from "@/lib/ops-pulse/station-audits";
import { EmployeePicker } from "./shipment-inspection";
import styles from "./audit-workspace.module.css";

type ResponseState = { status: string; remarks: string; employee: string };
const empty: ResponseState = { status: "", remarks: "", employee: "" };
const responseDraftKey = (auditId: string) =>
  `station-audit-response-draft:${auditId}`;
export function clearShipmentResponseDraft(auditId: string) {
  try {
    window.localStorage.removeItem(responseDraftKey(auditId));
  } catch {
    // Storage is unavailable; there is nothing to clear.
  }
}
const PAGE_SIZE = 20;

/**
 * Station answers for each unresolved shipment. Built for long lists: the answers live
 * in one place (a hidden field carries all of them), so the list can be filtered, paged,
 * filled in bulk and resumed later from a draft saved on this device.
 */
export function ShipmentResponses({
  auditId,
  shipments,
  options,
  people,
}: {
  auditId: string;
  shipments: StationAuditWorkspace["shipments"];
  options: AuditOption[];
  people: AuditEmployee[];
}) {
  const open = useMemo(
    () => shipments.filter((s) => !s.is_resolved),
    [shipments],
  );
  const [states, setStates] = useState<Record<string, ResponseState>>(() =>
    Object.fromEntries(
      shipments.map((s) => [
        s.id,
        {
          status: s.station_response?.status || "",
          remarks: s.station_response?.remarks || "",
          employee: s.station_response?.employee?.ref || "",
        },
      ]),
    ),
  );
  // Bumped whenever answers are written from outside a row, so its employee picker reloads.
  const [version, setVersion] = useState(0);
  const [draftNote, setDraftNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulk, setBulk] = useState<ResponseState>(empty);
  const needsEmployee = (code: string) =>
    options.find((o) => o.code === code)?.metadata.requires_employee === true;
  const complete = (state?: ResponseState) =>
    !!state?.status &&
    !!state.remarks.trim() &&
    (!needsEmployee(state.status) || !!state.employee);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(responseDraftKey(auditId));
      const draft = raw ? JSON.parse(raw) : null;
      if (draft?.states && typeof draft.states === "object") {
        setStates((old) => {
          const next = { ...old };
          for (const id of Object.keys(next))
            if (draft.states[id]) next[id] = { ...next[id], ...draft.states[id] };
          return next;
        });
        setVersion((v) => v + 1);
        setDraftNote(
          `Your saved answers from ${new Date(draft.savedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} were restored.`,
        );
      }
    } catch {
      // An unreadable draft is ignored.
    }
    setLoaded(true);
  }, [auditId]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          responseDraftKey(auditId),
          JSON.stringify({ savedAt: new Date().toISOString(), states }),
        );
      } catch {
        // Storage is full or blocked; the answers stay on screen.
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [states, loaded, auditId]);

  const update = (id: string, change: Partial<ResponseState>) =>
    setStates((old) => ({ ...old, [id]: { ...(old[id] || empty), ...change } }));
  const answered = open.filter((s) => complete(states[s.id])).length;
  const visible = open.filter((s) =>
    filter === "all"
      ? true
      : filter === "pending"
        ? !complete(states[s.id])
        : filter === "done"
          ? complete(states[s.id])
          : s.discrepancy_code === filter,
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const shown = visible.slice(
    current * PAGE_SIZE,
    current * PAGE_SIZE + PAGE_SIZE,
  );
  const kinds = [
    ...new Set(open.map((s) => s.discrepancy_code).filter(Boolean)),
  ] as string[];
  const targets = picked.length ? picked : visible.map((s) => s.id);
  const pageSelected =
    shown.length > 0 && shown.every((s) => picked.includes(s.id));
  const applyBulk = () => {
    setStates((old) => {
      const next = { ...old };
      for (const id of targets) {
        const before = next[id] || empty;
        next[id] = {
          status: bulk.status || before.status,
          remarks: bulk.remarks.trim() || before.remarks,
          employee: bulk.employee || before.employee,
        };
      }
      return next;
    });
    setVersion((v) => v + 1);
    setPicked([]);
    setBulk(empty);
  };
  if (!open.length) return null;
  return (
    <div>
      <input
        type="hidden"
        name="shipment_responses_state"
        value={JSON.stringify(
          open.map((s) => ({
            id: s.id,
            tracking_id: s.tracking_id,
            status: states[s.id]?.status || "",
            remarks: states[s.id]?.remarks || "",
            employee_ref: states[s.id]?.employee || "",
            complete: complete(states[s.id]),
          })),
        )}
      />
      <div className={styles.responseSummary} role="status">
        <strong>
          {answered} of {open.length} shipments answered
        </strong>
        <span>
          Answers are saved on this device as you go, so you can stop and come
          back. Nothing is sent until you submit the response.
        </span>
        {draftNote && <span>{draftNote}</span>}
      </div>
      {open.length > 1 && (
        <div className={styles.bulkBar}>
          <strong>
            Answer many at once ·{" "}
            {picked.length
              ? `${picked.length} selected`
              : `all ${visible.length} in this view`}
          </strong>
          <select
            value={bulk.status}
            onChange={(e) => setBulk({ ...bulk, status: e.target.value })}
            aria-label="Status to apply"
          >
            <option value="">Keep each status</option>
            {options.map((o) => (
              <option key={o.id} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            value={bulk.remarks}
            onChange={(e) => setBulk({ ...bulk, remarks: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
            }}
            placeholder="Remarks to apply"
            aria-label="Remarks to apply"
          />
          <EmployeePicker
            key={`bulk:${version}`}
            name="bulk_shipment_employee"
            people={people}
            onChange={(refs) =>
              setBulk((old) => ({ ...old, employee: refs[0] || "" }))
            }
          />
          <button
            type="button"
            className="button secondary compact"
            disabled={
              !targets.length ||
              (!bulk.status && !bulk.remarks.trim() && !bulk.employee)
            }
            onClick={applyBulk}
          >
            Apply to {targets.length}
          </button>
        </div>
      )}
      <div className={styles.responseFilters}>
        <label>
          Show{" "}
          <select
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
              setPicked([]);
            }}
          >
            <option value="all">All ({open.length})</option>
            <option value="pending">
              Not answered ({open.length - answered})
            </option>
            <option value="done">Answered ({answered})</option>
            {kinds.length > 1 &&
              kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind} (
                  {open.filter((s) => s.discrepancy_code === kind).length})
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary compact"
          onClick={() =>
            setPicked(
              pageSelected
                ? picked.filter((id) => !shown.some((s) => s.id === id))
                : [...new Set([...picked, ...shown.map((s) => s.id)])],
            )
          }
        >
          {pageSelected ? "Unselect this page" : "Select this page"}
        </button>
        {pages > 1 && (
          <span className={styles.actions}>
            <button
              type="button"
              disabled={!current}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button
              type="button"
              disabled={current + 1 >= pages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </span>
        )}
      </div>
      {!shown.length && (
        <p className={styles.checkHelp}>No shipments in this view.</p>
      )}
      {shown.map((s) => {
        const state = states[s.id] || empty;
        const employee = people.find((p) => p.ref === state.employee);
        const saved = s.station_response?.employee;
        return (
          <fieldset
            key={s.id}
            className={`${styles.shipmentResponse} ${complete(state) ? styles.shipmentAnswered : ""}`}
          >
            <legend>
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) =>
                  setPicked((old) =>
                    e.target.checked
                      ? [...old, s.id]
                      : old.filter((id) => id !== s.id),
                  )
                }
                aria-label={`Select ${s.tracking_id}`}
              />{" "}
              {s.tracking_id} · {s.discrepancy_code}
              {complete(state) ? " · answered" : ""}
            </legend>
            <p className={styles.checkHelp}>{s.remarks}</p>
            <label className={styles.inputLabel}>
              Station status
              <select
                value={state.status}
                onChange={(e) => update(s.id, { status: e.target.value })}
              >
                <option value="">Select status</option>
                {options.map((o) => (
                  <option key={o.id} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.inputLabel}>
              Remarks
              <textarea
                value={state.remarks}
                onChange={(e) => update(s.id, { remarks: e.target.value })}
                placeholder="Explain current status and follow-up"
              />
            </label>
            <div className={styles.inputLabel}>
              Employee ID{" "}
              {needsEmployee(state.status) ? "(required)" : "(optional)"}
              <EmployeePicker
                key={`${s.id}:${version}`}
                name={`shipment_employee_view_${s.id}`}
                people={people}
                initial={
                  employee
                    ? [employee]
                    : saved && saved.ref === state.employee
                      ? [saved]
                      : []
                }
                onChange={(refs) => update(s.id, { employee: refs[0] || "" })}
              />
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
