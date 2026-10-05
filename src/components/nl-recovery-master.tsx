"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type {
  RecoveryOutcome,
  LossSettings,
  DeductionTiming,
} from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";
export function NlRecoveryMaster({
  outcomes,
  settings,
  canEdit,
}: {
  outcomes: RecoveryOutcome[];
  settings: LossSettings | null;
  canEdit: boolean;
}) {
  const router = useRouter(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Partial<RecoveryOutcome> | null>(null);
  async function save(body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/ops-pulse/losses/master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error);
      setMessage("Master updated. Past recovery records are preserved.");
      setEditing(null);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>Ops Masters · Losses</span>
          <h1>Loss Recovery Master</h1>
          <p>
            Configure the source decisions, recovery actions and allocation
            experience.
          </p>
        </div>
        <Link href="/attendance/losses/nl" className={styles.button}>
          Open NL loss →
        </Link>
      </header>
      {message ? (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      ) : null}
      {settings ? (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>Cloak source & allocation rules</h2>
          </div>
          <form
            className={styles.detail}
            key={settings.updated_at}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void save({
                kind: "settings",
                updated_at: settings.updated_at,
                recoverable_statuses: String(f.get("statuses")).split("\n"),
                allow_equal_split: f.has("equal"),
                allow_custom_split: f.has("custom"),
                include_inactive_people: !f.has("active_only"),
                recovery_policy: {
                  ...settings.recovery_policy,
                  ...Object.fromEntries(
                    [
                      "active_only",
                      "previous_month_active_only",
                      "salary_cap_enabled",
                      "reserve_other_recoveries",
                      "cctv_public_confirmation",
                    ].map((k) => [k, f.has(k)]),
                  ),
                  ...Object.fromEntries(
                    [
                      "salary_month_offset",
                      "salary_cap_percent",
                      "attachment_max_count",
                      "attachment_max_mb",
                    ].map((k) => [k, Number(f.get(k))]),
                  ),
                  ...Object.fromEntries(
                    [
                      "people_run_statuses",
                      "people_calculation_statuses",
                      "workforce_payout_statuses",
                      "eligible_designations",
                      "attachment_types",
                    ].map((k) => [
                      k,
                      String(f.get(k) || "")
                        .split("\n")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ]),
                  ),
                },
                history_months: Number(f.get("history_months")),
              });
            }}
          >
            <fieldset className={styles.fieldset} disabled={!canEdit || busy}>
              <label>
                Final recoverable source statuses
                <textarea
                  name="statuses"
                  rows={3}
                  defaultValue={settings.recoverable_statuses.join("\n")}
                  required
                />
              </label>
              <p className={styles.hint}>
                One exact Cloak decision per line. Only matching source cases
                enter the NL recovery list and totals. Do not add unresolved or
                non-recoverable decisions.
              </p>
              <label>
                Historical months to refresh
                <input
                  name="history_months"
                  type="number"
                  min="1"
                  max="36"
                  defaultValue={settings.history_months}
                  required
                />
              </label>
              <p className={styles.hint}>
                Refresh the latest available Cloak months on each sync. Older
                imported months remain available.
              </p>
              <label className={styles.check}>
                <input
                  name="equal"
                  type="checkbox"
                  defaultChecked={settings.allow_equal_split}
                />
                Enable equal split
              </label>
              <label className={styles.check}>
                <input
                  name="custom"
                  type="checkbox"
                  defaultChecked={settings.allow_custom_split}
                />
                Enable individual amounts
              </label>
              <h3>Employee eligibility & salary cap</h3>
              {(
                [
                  ["active_only", "Show only currently active employees"],
                  [
                    "previous_month_active_only",
                    "Require employment during the reference salary month",
                  ],
                  ["salary_cap_enabled", "Cap recovery at salary payable"],
                  [
                    "reserve_other_recoveries",
                    "Subtract recovery already allocated to other cases",
                  ],
                  [
                    "cctv_public_confirmation",
                    "Require anyone-with-link viewing confirmation for CCTV",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label className={styles.check} key={key}>
                  <input
                    type="checkbox"
                    name={key}
                    defaultChecked={settings.recovery_policy[key]}
                  />
                  {label}
                </label>
              ))}
              <div className={styles.formGrid}>
                {(
                  [
                    [
                      "salary_month_offset",
                      "Salary reference: months before current month",
                      1,
                      12,
                    ],
                    [
                      "salary_cap_percent",
                      "Maximum recovery as % of payable salary",
                      1,
                      100,
                    ],
                    [
                      "attachment_max_count",
                      "Maximum optional attachments",
                      1,
                      10,
                    ],
                    [
                      "attachment_max_mb",
                      "Maximum size per attachment (MB)",
                      1,
                      20,
                    ],
                  ] as const
                ).map(([key, label, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      name={key}
                      min={min}
                      max={max}
                      required
                      defaultValue={settings.recovery_policy[key]}
                    />
                  </label>
                ))}
              </div>
              <details>
                <summary>
                  Pay sources, eligible designations & file types
                </summary>
                <p className={styles.hint}>
                  One exact value per line. An empty designation list allows all
                  station-linked roles. Missing payable salary blocks allocation
                  while the cap is enabled.
                </p>
                {(
                  [
                    [
                      "people_run_statuses",
                      "Accepted People payroll run statuses",
                    ],
                    [
                      "people_calculation_statuses",
                      "Accepted People payroll calculation statuses",
                    ],
                    [
                      "workforce_payout_statuses",
                      "Accepted DA payout worksheet statuses",
                    ],
                    [
                      "eligible_designations",
                      "Eligible designation names (optional restriction)",
                    ],
                    ["attachment_types", "Allowed attachment MIME types"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <textarea
                      name={key}
                      rows={3}
                      defaultValue={settings.recovery_policy[key].join("\n")}
                    />
                  </label>
                ))}
              </details>
              <button className={styles.primary}>Save rules</button>
            </fieldset>
          </form>
        </section>
      ) : (
        <p className={styles.notice}>
          No Cloak source is connected to this company.
        </p>
      )}
      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div>
            <h2>Recovery outcomes</h2>
            <p>
              Removal hides an option from new plans. Historical selections stay
              readable.
            </p>
          </div>
          {canEdit ? (
            <button
              className={styles.primary}
              onClick={() =>
                setEditing({
                  code: "",
                  label: "",
                  dispute_fields_enabled: false,
                  reason_required: false,
                  details_required: false,
                  attachments_enabled: false,
                  cctv_enabled: false,
                  allocation_required: false,
                  deduction_timing: "none",
                  remarks_required: true,
                  is_active: true,
                  sort_order: (outcomes.length + 1) * 10,
                })
              }
            >
              + Add outcome
            </button>
          ) : null}
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th>Deduction period</th>
                <th>Employee allocation</th>
                <th>Remarks</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <tr key={o.code}>
                  <td>
                    <strong>{o.label}</strong>
                    <small>{o.code}</small>
                  </td>
                  <td>
                    {o.deduction_timing === "next_month"
                      ? "Next month · exception"
                      : o.deduction_timing === "current_month"
                        ? "Current month"
                        : "Not applicable"}
                  </td>
                  <td>{o.allocation_required ? "Required" : "Not required"}</td>
                  <td>{o.remarks_required ? "Required" : "Optional"}</td>
                  <td>{o.is_active ? "Active" : "Removed"}</td>
                  <td>
                    <div className={styles.toolbar}>
                      {canEdit ? (
                        <>
                          <button
                            className={styles.button}
                            onClick={() => setEditing(o)}
                          >
                            Edit
                          </button>
                          <button
                            className={styles.button}
                            disabled={busy}
                            onClick={() =>
                              void save({ ...o, is_active: !o.is_active })
                            }
                          >
                            {o.is_active ? "Remove" : "Restore"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editing ? (
          <form
            className={styles.detail}
            onSubmit={(e) => {
              e.preventDefault();
              void save(editing);
            }}
          >
            <fieldset disabled={busy} className={styles.fieldset}>
              <h3>{editing.updated_at ? "Edit outcome" : "Add outcome"}</h3>
              <div className={styles.formGrid}>
                <label>
                  Code
                  <input
                    pattern="[a-z][a-z0-9_]{1,49}"
                    required
                    disabled={!!editing.updated_at}
                    value={editing.code || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, code: e.target.value })
                    }
                  />
                </label>
                <label>
                  Display label
                  <input
                    required
                    maxLength={80}
                    minLength={2}
                    value={editing.label || ""}
                    onChange={(e) =>
                      setEditing({ ...editing, label: e.target.value })
                    }
                  />
                </label>
                <label>
                  Display order
                  <input
                    type="number"
                    value={editing.sort_order}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        sort_order: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Deduction period
                <select
                  value={editing.deduction_timing || "none"}
                  onChange={(e) => {
                    const timing = e.target.value as DeductionTiming;
                    setEditing({
                      ...editing,
                      deduction_timing: timing,
                      allocation_required: timing !== "none",
                      remarks_required:
                        timing === "next_month"
                          ? true
                          : editing.remarks_required,
                    });
                  }}
                >
                  <option value="none">
                    Not applicable — no employee deduction
                  </option>
                  <option value="current_month">Current month</option>
                  <option value="next_month">
                    Next month — exception with reason
                  </option>
                </select>
              </label>
              <p className={styles.hint}>
                Both deduction periods require the full loss amount and employee
                IDs now. Partial allocation is never allowed.
              </p>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  disabled
                  checked={editing.allocation_required}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      allocation_required: e.target.checked,
                    })
                  }
                />
                Require employee allocation and full amount split
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  disabled={editing.deduction_timing === "next_month"}
                  checked={editing.remarks_required}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      remarks_required: e.target.checked,
                    })
                  }
                />
                Require remarks
              </label>
              <div className={styles.toolbar}>
                <h3>Re-dispute fields</h3>
                {(
                  [
                    [
                      "dispute_fields_enabled",
                      "Show structured re-dispute form",
                    ],
                    ["reason_required", "Require reason for re-dispute"],
                    ["details_required", "Require detailing"],
                    ["attachments_enabled", "Allow optional attachments"],
                    ["cctv_enabled", "Allow optional CCTV link"],
                  ] as const
                ).map(([key, label]) => (
                  <label className={styles.check} key={key}>
                    <input
                      type="checkbox"
                      checked={!!editing[key]}
                      onChange={(e) =>
                        setEditing({ ...editing, [key]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
                <button className={styles.primary}>Save outcome</button>
                <button
                  className={styles.button}
                  type="button"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </div>
            </fieldset>
          </form>
        ) : null}
      </section>
    </main>
  );
}
