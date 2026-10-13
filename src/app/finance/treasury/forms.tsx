"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveBooks } from "../books/actions";
import { enrolBank, recordReview } from "./actions";
import { mappedRows, type Mapping } from "@/lib/finance/treasury/model";
import { parseBank } from "@/lib/finance360/model";
type Result = {
  ok: boolean;
  message: string;
};
function ResultMessage({ result }: { result: Result | null }) {
  return result ? (
    <p
      role={result.ok ? "status" : "alert"}
      className={result.ok ? "books-success" : "books-error"}
    >
      {result.message}
    </p>
  ) : null;
}
export function Enrol({ id }: { id: string }) {
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  return (
    <>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await enrolBank(id);
            setResult(r);
            if (r.ok) router.refresh();
          } catch {
            setResult({
              ok: false,
              message: "Unable to enrol. Check your access and retry.",
            });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Enrolling…" : "Enable statement imports"}
      </button>
      <ResultMessage result={result} />
    </>
  );
}
export function Review({ rowId }: { rowId: string }) {
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result | null>(null);
  const router = useRouter();
  return (
    <details>
      <summary>Add review note</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          setBusy(true);
          try {
            const r = await recordReview(d);
            setResult(r);
            if (r.ok) router.refresh();
          } catch {
            setResult({ ok: false, message: "Unable to save review." });
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="hidden" name="row_id" value={rowId} />
        <label>
          Evidence or investigation note
          <input name="note" minLength={5} maxLength={1000} required />
        </label>
        <button disabled={busy}>{busy ? "Saving…" : "Save review"}</button>
        <ResultMessage result={result} />
      </form>
    </details>
  );
}
const keys: (keyof Mapping)[] = [
  "date",
  "description",
  "reference",
  "debit",
  "credit",
  "balance",
];
const labels: Record<keyof Mapping, string> = {
  date: "Transaction date",
  description: "Narration",
  reference: "Bank UTR / reference",
  debit: "Debit / money out",
  credit: "Credit / money in",
  balance: "Running balance",
};
const defaults: Mapping = {
  date: -1,
  description: -1,
  reference: -1,
  debit: -1,
  credit: -1,
  balance: -1,
};
export function StatementImport({
  accounts,
}: {
  accounts: {
    code: string;
    name: string;
  }[];
}) {
  const [sheets, setSheets] = useState<Record<string, unknown[][]>>({}),
    [sheet, setSheet] = useState(""),
    [header, setHeader] = useState(0),
    [mapping, setMapping] = useState<Mapping>(defaults),
    [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result | null>(null),
    [preview, setPreview] = useState<{
      data: FormData;
      rows: ReturnType<typeof parseBank>;
    } | null>(null);
  const router = useRouter();
  const matrix = sheets[sheet] ?? [],
    headings = matrix[header] ?? [];
  const reset = () => {
    setPreview(null);
    setResult(null);
  };
  return (
    <form
      className="books-form"
      onChange={reset}
      onSubmit={async (e) => {
        e.preventDefault();
        setResult(null);
        setPreview(null);
        try {
          const d = new FormData(e.currentTarget);
          const rows = parseBank(
            mappedRows(matrix, header, mapping),
            d.get("opening"),
            d.get("closing"),
            String(d.get("start")),
            String(d.get("end")),
          );
          d.set("rows", JSON.stringify(rows));
          d.set("filename", filename);
          d.set("action", "bank");
          d.set("confirmed", "yes");
          setPreview({ data: d, rows });
        } catch (err) {
          setResult({
            ok: false,
            message:
              err instanceof Error
                ? err.message
                : "Check the statement columns.",
          });
        }
      }}
    >
      <fieldset disabled={busy}>
        <div className="books-fields">
          <label>
            Statement account
            <select name="account_code" required defaultValue="">
              <option value="">Choose bank ledger</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Statement file
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              required
              onChange={async (e) => {
                reset();
                setSheets({});
                setSheet("");
                setMapping(defaults);
                setFilename("");
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 5000000)
                    throw new Error("Use a statement smaller than 5 MB.");
                  const XLSX = await import("xlsx");
                  const workbook = XLSX.read(await file.arrayBuffer(), {
                    type: "array",
                    raw: true,
                  });
                  const s: Record<string, unknown[][]> = {};
                  for (const name of workbook.SheetNames)
                    s[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
                      header: 1,
                      defval: "",
                      raw: true,
                    });
                  setSheets(s);
                  setSheet(workbook.SheetNames[0] ?? "");
                  setHeader(0);
                  setFilename(file.name);
                } catch (err) {
                  setResult({
                    ok: false,
                    message:
                      err instanceof Error
                        ? err.message
                        : "Cannot read this statement.",
                  });
                }
              }}
            />
          </label>
          <label>
            Period from
            <input name="start" type="date" required />
          </label>
          <label>
            Period through
            <input name="end" type="date" required />
          </label>
          <label>
            Opening balance
            <input name="opening" inputMode="decimal" required />
          </label>
          <label>
            Closing balance
            <input name="closing" inputMode="decimal" required />
          </label>
        </div>
        {sheet && (
          <>
            <div className="books-fields">
              <label>
                Worksheet
                <select
                  value={sheet}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    setMapping(defaults);
                    setHeader(0);
                  }}
                >
                  {Object.keys(sheets).map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                Column heading row
                <input
                  type="number"
                  min={1}
                  max={Math.min(matrix.length, 100)}
                  value={header + 1}
                  onChange={(e) => {
                    setHeader(Math.max(0, Number(e.target.value) - 1));
                    setMapping(defaults);
                  }}
                />
              </label>
            </div>
            <p>
              Choose the original bank columns. Dates use day/month/year. Remove
              totals and footer rows before uploading. The reference column must
              contain the bank UTR; amount-only matching is never used.
            </p>
            <div className="books-fields">
              {keys.map((k) => (
                <label key={k}>
                  {labels[k]}
                  <select
                    value={mapping[k]}
                    onChange={(e) =>
                      setMapping((m) => ({ ...m, [k]: Number(e.target.value) }))
                    }
                    required
                  >
                    <option value={-1}>Choose column</option>
                    {headings.map((v, i) => (
                      <option key={i} value={i}>
                        {i + 1}. {String(v || "(blank)").slice(0, 70)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="books-scroll">
              <table>
                <thead>
                  <tr>
                    {headings.map((h, i) => (
                      <th key={i}>{String(h).slice(0, 80)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.slice(header + 1, header + 4).map((r, i) => (
                    <tr key={i}>
                      {headings.map((_, j) => (
                        <td key={j}>{String(r[j] ?? "").slice(0, 120)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <button disabled={!sheet || !accounts.length}>
          Validate & preview
        </button>
        {preview && (
          <div className="books-notice">
            <strong>{preview.rows.length} transactions validated</strong>
            <p>
              Every running balance and the closing balance reconcile. Importing
              saves statement evidence and recomputes payout matches; it does
              not approve payouts or post accounting journals.
            </p>
            <button
              type="button"
              className="books-primary"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await saveBooks(preview.data);
                  setResult(r);
                  if (r.ok) {
                    setPreview(null);
                    router.refresh();
                  }
                } catch {
                  setResult({
                    ok: false,
                    message:
                      "Statement could not be saved. Check your access and retry.",
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Importing…" : "Confirm statement import"}
            </button>
          </div>
        )}
      </fieldset>
      <ResultMessage result={result} />
    </form>
  );
}
