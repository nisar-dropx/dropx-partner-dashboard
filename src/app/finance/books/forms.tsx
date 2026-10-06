"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { saveBooks, bankCandidates } from "./actions";
import {
  ACCOUNT_TYPES,
  parseJournals,
  type SheetRow,
} from "@/lib/finance360/model";
import type { Account, Candidate } from "@/lib/finance360/types";

export function SaveForm({
  action,
  children,
  label = "Save",
  confirm = "I reviewed these details and confirm they are correct.",
}: {
  action: string;
  children: ReactNode;
  label?: string;
  confirm?: string;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<{ ok: boolean; message: string } | null>(
      null,
    );
  const router = useRouter();
  return (
    <form
      className="books-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setBusy(true);
        setMessage(null);
        try {
          const r = await saveBooks(data);
          setMessage(r);
          if (r.ok) router.refresh();
        } catch {
          setMessage({
            ok: false,
            message:
              "Unable to save. Please check your access or connection and retry.",
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <input type="hidden" name="action" value={action} />
      <fieldset disabled={busy}>
        {children}
        <label className="books-confirm">
          <input type="checkbox" name="confirmed" value="yes" required />
          {confirm}
        </label>
        <button className="books-primary" disabled={busy}>
          {busy ? "Saving…" : label}
        </button>
      </fieldset>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "books-success" : "books-error"}
        >
          {message.message}
        </p>
      )}
    </form>
  );
}
export function Input({
  label,
  name,
  type = "text",
  value,
  required = true,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  value?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={value}
        required={required}
        placeholder={placeholder}
        step={type === "number" ? "0.01" : undefined}
      />
    </label>
  );
}
export function AccountSelect({
  accounts,
  types,
}: {
  accounts: Account[];
  types?: string[];
}) {
  return (
    <label>
      Ledger account
      <select name="account_code" required>
        <option value="">Select ledger</option>
        {accounts
          .filter((a) => !types || types.includes(a.type))
          .map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} · {a.name}
            </option>
          ))}
      </select>
    </label>
  );
}
export function AccountForm() {
  return (
    <SaveForm action="account" label="Create ledger">
      <div className="books-fields">
        <Input label="Account code" name="code" />
        <Input label="Account name" name="name" />
        <label>
          Type
          <select name="type">
            {ACCOUNT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="books-muted">
        Names and classifications are fixed after creation to preserve report
        history. Review the chart with your accountant.
      </p>
    </SaveForm>
  );
}
export function ImportForm({
  kind,
  accounts,
}: {
  kind: "journal" | "bank";
  accounts: Account[];
}) {
  const [rows, setRows] = useState<SheetRow[]>([]),
    [filename, setFilename] = useState(""),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [summary, setSummary] = useState("");
  const generation = useRef(0);
  async function read(file?: File) {
    const id = ++generation.current;
    setRows([]);
    setError("");
    setSummary("");
    setFilename("");
    if (!file) return;
    if (file.size > 500000) {
      setError(
        "Use files under 500 KB; split large exports into batches. No rows are silently truncated.",
      );
      return;
    }
    setLoading(true);
    try {
      if (!/\.(csv|xlsx)$/i.test(file.name))
        throw new Error("Choose a CSV or XLSX file using the template.");
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), {
        type: "array",
        raw: true,
        cellDates: false,
      });
      if (book.SheetNames.length !== 1)
        throw new Error("Upload one data sheet at a time.");
      const sheet = book.Sheets[book.SheetNames[0]];
      for (const cell of Object.values(sheet))
        if (cell && typeof cell === "object" && "f" in cell)
          throw new Error(
            "Replace spreadsheet formulas with values before uploading.",
          );
      const values = XLSX.utils.sheet_to_json<SheetRow>(sheet, {
        raw: false,
        defval: "",
      });
      if (JSON.stringify(values).length > 700000)
        throw new Error(
          "This batch is too large. Split it into smaller files.",
        );
      if (kind === "journal") {
        const vouchers = parseJournals(values);
        setSummary(
          `${vouchers.length} balanced vouchers · ${values.length} lines`,
        );
      } else {
        if (!values.length || values.length > 5000)
          throw new Error("Use 1–5,000 transactions per file.");
        setSummary(
          `${values.length} transactions · balances will be validated when saving`,
        );
      }
      if (id === generation.current) {
        setRows(values);
        setFilename(file.name);
      }
    } catch (e) {
      if (id === generation.current) setError((e as Error).message);
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }
  return (
    <SaveForm
      action={kind}
      label={
        kind === "journal" ? "Post balanced vouchers" : "Import bank statement"
      }
      confirm={
        kind === "journal"
          ? "I reviewed the preview, account classifications and source period. Post these entries to the books."
          : "I checked the statement period and balances. Import for reconciliation."
      }
    >
      <p className="books-muted">
        Use the{" "}
        <a href={`/finance/books/export?template=${kind}`}>CSV template</a>.
        Dates: YYYY-MM-DD. Amounts: INR.{" "}
        {kind === "journal"
          ? "Repeat the same reference, date and narration on every line of one voucher. Use stable unique source references."
          : "Debit is money out; credit is money in. Upload dates not already imported for this ledger."}
      </p>
      {kind === "bank" && (
        <div className="books-fields">
          <AccountSelect accounts={accounts} types={["asset", "liability"]} />
          <Input label="Statement from" name="start" type="date" />
          <Input label="Statement through" name="end" type="date" />
          <Input label="Opening balance (₹)" name="opening" type="number" />
          <Input label="Closing balance (₹)" name="closing" type="number" />
        </div>
      )}
      <label className="books-upload">
        {loading ? "Reading file…" : "Choose CSV or Excel file"}
        <input
          type="file"
          accept=".csv,.xlsx"
          onChange={(e) => void read(e.target.files?.[0])}
        />
      </label>
      <input type="hidden" name="filename" value={filename} />
      <input
        type="hidden"
        name="rows"
        value={rows.length ? JSON.stringify(rows) : ""}
      />
      {error && (
        <p className="books-error" role="alert">
          {error}
        </p>
      )}
      {summary && <p className="books-success">{summary}</p>}
      {rows.length > 0 && (
        <div className="books-scroll">
          <table>
            <thead>
              <tr>
                {Object.keys(rows[0]).map((k) => (
                  <th key={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r, i) => (
                <tr key={i}>
                  {Object.keys(rows[0]).map((k) => (
                    <td key={k}>{String(r[k])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <small>
            Preview of the first {Math.min(rows.length, 8)} rows; all{" "}
            {rows.length} rows will be validated.
          </small>
        </div>
      )}
    </SaveForm>
  );
}
export function JournalForm({
  accounts,
  today,
}: {
  accounts: Account[];
  today: string;
}) {
  const [lines, setLines] = useState([
    { code: "", debit: "", credit: "" },
    { code: "", debit: "", credit: "" },
  ]);
  const [reference, setReference] = useState(""),
    [date, setDate] = useState(today),
    [narration, setNarration] = useState("");
  const rows = lines.map((l) => {
    const a = accounts.find((a) => a.code === l.code);
    return {
      date,
      reference,
      narration,
      account_code: l.code,
      account_name: a?.name ?? "",
      account_type: a?.type ?? "",
      debit: l.debit,
      credit: l.credit,
    };
  });
  return (
    <SaveForm
      action="manual"
      label="Post voucher"
      confirm="I reviewed the accounts and amounts. Post this balanced voucher."
    >
      <input type="hidden" name="rows" value={JSON.stringify(rows)} />
      <div className="books-fields">
        <label>
          Voucher reference
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            required
          />
        </label>
        <label>
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </label>
        <label>
          Narration
          <input
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            required
          />
        </label>
      </div>
      {lines.map((l, i) => (
        <div className="books-journal-line" key={i}>
          <label>
            Ledger
            <select
              required
              value={l.code}
              onChange={(e) =>
                setLines(
                  lines.map((v, j) =>
                    j === i ? { ...v, code: e.target.value } : v,
                  ),
                )
              }
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option value={a.code} key={a.code}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          {(["debit", "credit"] as const).map((k) => (
            <label key={k}>
              {k} (₹)
              <input
                type="number"
                step="0.01"
                min="0"
                value={l[k]}
                onChange={(e) =>
                  setLines(
                    lines.map((v, j) =>
                      j === i ? { ...v, [k]: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
          ))}
          {lines.length > 2 && (
            <button
              type="button"
              aria-label={`Remove line ${i + 1}`}
              onClick={() => setLines(lines.filter((_, j) => j !== i))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setLines([...lines, { code: "", debit: "", credit: "" }])
        }
      >
        + Add line
      </button>
    </SaveForm>
  );
}
export function Reconcile({
  rowId,
  matched,
}: {
  rowId: string;
  matched: boolean;
}) {
  const [open, setOpen] = useState(false),
    [rows, setRows] = useState<Candidate[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (matched)
    return (
      <details>
        <summary>Matched · review</summary>
        <SaveForm action="unmatch" label="Remove match">
          <input name="row_id" type="hidden" value={rowId} />
          <Input name="reason" label="Reason" />
        </SaveForm>
      </details>
    );
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setOpen(true);
          setBusy(true);
          try {
            const r = await bankCandidates(rowId);
            setRows(r.rows);
            setError(r.error);
          } catch {
            setError("Unable to load candidates. Please retry.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Loading…" : "Reconcile"}
      </button>
      {open && (
        <div className="books-match">
          {error ? (
            <p role="alert">{error}</p>
          ) : rows.length ? (
            <SaveForm action="match" label="Confirm match">
              <input type="hidden" name="row_id" value={rowId} />
              <label>
                Same bank ledger and amount
                <select name="line_id" required>
                  {rows.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.date} · {r.reference} · {r.narration}
                    </option>
                  ))}
                </select>
              </label>
            </SaveForm>
          ) : (
            <p>
              No available matching ledger entry in the first 100 candidates.
              Post or check the corresponding voucher first.
            </p>
          )}
          <button type="button" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
export function Refresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60000);
    return () => clearInterval(t);
  }, [router]);
  return (
    <button type="button" onClick={() => router.refresh()}>
      Refresh data
    </button>
  );
}
export function Print() {
  return (
    <button type="button" onClick={() => window.print()}>
      Print / Save PDF
    </button>
  );
}
