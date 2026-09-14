"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { saveReimbursementMaster } from "./actions";

export type MasterRow = { id: string; [key: string]: unknown };
const label = (row?: MasterRow) => String(row?.name ?? row?.full_name ?? "—");
const money = (value: unknown) =>
  `₹${Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export function ReimbursementMaster({
  data,
  canAdd,
  canEdit,
}: {
  data: Record<string, MasterRow[]>;
  canAdd: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("limits");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{
    kind: string;
    row: MasterRow | null;
  } | null>(null);
  const [excessAction, setExcessAction] = useState("cap");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!editor) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
      );
      if (!elements?.length) return;
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [editor]);
  const find = (key: string, id: unknown) =>
    data[key]?.find((row) => row.id === id);
  const sorted = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(data).map(([key, rows]) => [
          key,
          [...rows].sort((a, b) => label(a).localeCompare(label(b))),
        ]),
      ),
    [data],
  );
  const rows = sorted[tab] ?? [];
  const filtered = rows.filter((row) =>
    [
      label(row),
      row.code,
      label(find("heads", row.category_id)),
      label(find("designations", row.designation_id)),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  function open(kind: string, row: MasterRow | null) {
    setEditor({ kind, row });
    setExcessAction(String(row?.excess_action ?? "cap"));
    setError("");
    setNotice("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const form = new FormData(event.currentTarget);
    const input: Record<string, unknown> = Object.fromEntries(form);
    input.id = editor.row?.id ?? null;
    input.expected_updated_at = editor.row?.updated_at ?? null;
    input.is_active = form.get("is_active") === "on";
    input.receipt_required = form.get("receipt_required") === "on";
    setBusy(true);
    setError("");
    try {
      const result = await saveReimbursementMaster(editor.kind, input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditor(null);
      setNotice(
        "Saved. New submissions will use the updated Finance rule. Existing claim snapshots are unchanged.",
      );
      router.refresh();
    } catch {
      setError("Unable to save. Please retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="reimbursement-master">
      <div className="rm-note">
        Limits are not guessed. Add the approved travel-policy rates below.
        Daily limits include other active claims for the same person, head and
        date. For hotel bills covering several nights, enter one dated line per
        night.
      </div>
      <nav aria-label="Reimbursement master views">
        {[
          ["limits", "Designation limits"],
          ["heads", "Expense heads"],
          ["policies", "Payment mapping"],
        ].map(([key, name]) => (
          <button
            type="button"
            key={key}
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setQuery("");
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {notice ? <p role="status">{notice}</p> : null}
      <section className="rm-panel">
        <header>
          <input
            aria-label="Search reimbursement master"
            placeholder="Search head or designation…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {canAdd && tab !== "policies" ? (
            <button
              type="button"
              className="primary"
              onClick={() => open(tab === "heads" ? "head" : "limit", null)}
            >
              + Add {tab === "heads" ? "expense head" : "limit"}
            </button>
          ) : null}
        </header>
        <div className="rm-table">
          <table>
            <thead>
              <tr>
                {(tab === "limits"
                  ? [
                      "Designation",
                      "Expense head",
                      "Permissible amount",
                      "When exceeded",
                      "Effective from",
                      "Status",
                      "Action",
                    ]
                  : tab === "heads"
                    ? ["Expense head", "Receipt", "Status", "Action"]
                    : ["Policy", "Payment head", "Action"]
                ).map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id}>
                  {tab === "limits" ? (
                    <>
                      <td>{label(find("designations", row.designation_id))}</td>
                      <td>{label(find("heads", row.category_id))}</td>
                      <td>
                        <strong>{money(row.permissible_amount)}</strong>
                        <small>
                          {row.limit_basis === "per_day"
                            ? "per day / night"
                            : row.limit_basis === "per_km"
                              ? "per kilometre"
                              : "per expense item"}
                        </small>
                      </td>
                      <td>
                        {row.excess_action === "cap"
                          ? "Pay up to limit"
                          : "Special approval"}
                        {row.excess_action === "special_approval" ? (
                          <small>
                            {label(
                              find("approvers", row.special_approver_user_id),
                            )}
                          </small>
                        ) : null}
                      </td>
                      <td>{String(row.effective_from)}</td>
                      <td>{row.is_active ? "Active" : "Inactive"}</td>
                    </>
                  ) : tab === "heads" ? (
                    <>
                      <td>
                        <strong>{label(row)}</strong>
                        <small>{String(row.code)}</small>
                      </td>
                      <td>
                        {row.receipt_required
                          ? `Required from ${money(row.receipt_threshold)}`
                          : "Optional"}
                      </td>
                      <td>{row.is_active ? "Active" : "Inactive"}</td>
                    </>
                  ) : (
                    <>
                      <td>
                        {label(row)}
                        <small>
                          {row.designation_id
                            ? label(find("designations", row.designation_id))
                            : "All designations"}
                        </small>
                      </td>
                      <td>
                        {label(find("paymentHeads", row.payment_head_id))}
                      </td>
                    </>
                  )}
                  <td>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() =>
                          open(
                            tab === "limits"
                              ? "limit"
                              : tab === "heads"
                                ? "head"
                                : "payment_mapping",
                            row,
                          )
                        }
                      >
                        Edit
                      </button>
                    ) : (
                      "Read only"
                    )}
                  </td>
                </tr>
              ))}
              {!filtered.length ? (
                <tr>
                  <td colSpan={7}>
                    {tab === "limits"
                      ? "No limits configured. Finance can add the approved designation-wise rates."
                      : "No matching records."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <p className="rm-note">
        Payment heads and processing roles are maintained in{" "}
        <a href="/master/payment-heads">Finance → Master → Payment Heads</a>.
        Deactivate an expense head to stop new use; existing claims remain
        readable.
      </p>
      {editor ? (
        <div
          ref={dialogRef}
          className="rm-backdrop"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !busy) setEditor(null);
          }}
        >
          <section
            className="rm-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rm-editor-title"
          >
            <header>
              <h2 id="rm-editor-title">
                {editor.row ? "Edit" : "Add"}{" "}
                {editor.kind === "limit"
                  ? "designation limit"
                  : editor.kind === "head"
                    ? "expense head"
                    : "payment mapping"}
              </h2>
              <button
                type="button"
                aria-label="Close editor"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                × Close
              </button>
            </header>
            <form
              onSubmit={save}
              key={`${editor.kind}:${editor.row?.id ?? "new"}`}
            >
              {editor.kind === "head" ? (
                <>
                  <label>
                    Code
                    <input
                      name="code"
                      pattern="[A-Z][A-Z0-9_]{1,39}"
                      maxLength={40}
                      defaultValue={String(editor.row?.code ?? "")}
                      readOnly={Boolean(editor.row)}
                      required
                      autoFocus
                    />
                  </label>
                  <label>
                    Expense head name
                    <input
                      name="name"
                      defaultValue={String(editor.row?.name ?? "")}
                      required
                      minLength={2}
                      maxLength={120}
                    />
                  </label>
                  <label className="wide">
                    Description
                    <input
                      name="description"
                      defaultValue={String(editor.row?.description ?? "")}
                      maxLength={500}
                    />
                  </label>
                  <label>
                    Receipt required from (₹)
                    <input
                      name="receipt_threshold"
                      type="number"
                      min="0"
                      step="0.01"
                      defaultValue={String(editor.row?.receipt_threshold ?? 0)}
                      required
                    />
                  </label>
                  <label className="rm-check">
                    <input
                      name="receipt_required"
                      type="checkbox"
                      defaultChecked={
                        editor.row ? Boolean(editor.row.receipt_required) : true
                      }
                    />
                    Receipt required
                  </label>
                </>
              ) : editor.kind === "limit" ? (
                <>
                  <label>
                    Designation
                    <select
                      name="designation_id"
                      defaultValue={String(editor.row?.designation_id ?? "")}
                      required
                      autoFocus
                      disabled={Boolean(editor.row)}
                    >
                      <option value="">Select designation</option>
                      {sorted.designations
                        .filter((r) => r.is_active)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {label(r)}
                          </option>
                        ))}
                    </select>
                    {editor.row ? (
                      <input
                        type="hidden"
                        name="designation_id"
                        value={String(editor.row.designation_id)}
                      />
                    ) : null}
                  </label>
                  <label>
                    Expense head
                    <select
                      name="category_id"
                      defaultValue={String(editor.row?.category_id ?? "")}
                      required
                      disabled={Boolean(editor.row)}
                    >
                      <option value="">Select expense head</option>
                      {sorted.heads.map((r) => (
                        <option key={r.id} value={r.id}>
                          {label(r)}
                        </option>
                      ))}
                    </select>
                    {editor.row ? (
                      <input
                        type="hidden"
                        name="category_id"
                        value={String(editor.row.category_id)}
                      />
                    ) : null}
                  </label>
                  <label>
                    Permissible amount (₹)
                    <input
                      name="permissible_amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      max="9999999999"
                      defaultValue={String(
                        editor.row?.permissible_amount ?? "",
                      )}
                      required
                    />
                  </label>
                  <label>
                    Applies per
                    <select
                      name="limit_basis"
                      defaultValue={String(
                        editor.row?.limit_basis ?? "per_day",
                      )}
                    >
                      <option value="per_day">
                        Day / hotel night (expense date)
                      </option>
                      <option value="per_item">Expense item</option>
                      <option value="per_km">
                        Kilometre (distance required)
                      </option>
                    </select>
                  </label>
                  <label className="wide">
                    Policy conditions / source note
                    <textarea
                      name="policy_note"
                      maxLength={1000}
                      defaultValue={String(editor.row?.policy_note ?? "")}
                      rows={2}
                    />
                  </label>
                  <label>
                    When amount exceeds limit
                    <select
                      name="excess_action"
                      value={excessAction}
                      onChange={(e) => setExcessAction(e.target.value)}
                    >
                      <option value="cap">Pay only up to limit</option>
                      <option value="special_approval">
                        Require special approval
                      </option>
                    </select>
                  </label>
                  <label>
                    Effective from
                    <input
                      name="effective_from"
                      type="date"
                      defaultValue={String(
                        editor.row?.effective_from ?? today(),
                      )}
                      readOnly={Boolean(editor.row)}
                      required
                    />
                  </label>
                  {excessAction === "special_approval" ? (
                    <label className="wide">
                      Special approver
                      <select
                        name="special_approver_user_id"
                        defaultValue={String(
                          editor.row?.special_approver_user_id ?? "",
                        )}
                        required
                      >
                        <option value="">Select authorised person</option>
                        {sorted.approvers
                          .filter((r) => r.is_active)
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {label(r)}
                            </option>
                          ))}
                      </select>
                      <small>
                        Finance designates this person to approve excess
                        spending. Self-approval is blocked.
                      </small>
                    </label>
                  ) : null}
                  <p className="wide rm-note">
                    For a future policy revision, add a new rule with its start
                    date. Editing does not change limits saved on submitted
                    claims.
                  </p>
                </>
              ) : (
                <label className="wide">
                  Payment head
                  <select
                    name="payment_head_id"
                    defaultValue={String(editor.row?.payment_head_id ?? "")}
                    required
                    autoFocus
                  >
                    <option value="">Select payment head</option>
                    {sorted.paymentHeads
                      .filter((r) => r.is_active)
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {label(r)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {editor.kind !== "payment_mapping" ? (
                <label className="rm-check wide">
                  <input
                    type="checkbox"
                    name="is_active"
                    defaultChecked={
                      editor.row ? Boolean(editor.row.is_active) : true
                    }
                  />
                  Active
                </label>
              ) : null}
              {error ? (
                <p role="alert" className="rm-error wide">
                  {error}
                </p>
              ) : null}
              <footer className="wide">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="primary" disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
