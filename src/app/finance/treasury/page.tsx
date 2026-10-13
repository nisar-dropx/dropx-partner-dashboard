import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission } from "@/lib/authorization";
import { booksContext, period } from "@/lib/finance360/server";
import { loadTreasury, type Treasury } from "@/lib/finance/treasury/data";
import { outcomes, paid, referenceKey } from "@/lib/finance/treasury/model";
import { money, paise } from "@/lib/finance360/model";
import { Refresh, Input } from "../books/forms";
import { Enrol, Review, StatementImport } from "./forms";
import "../books/workspace.css";
import "./treasury.css";
export const dynamic = "force-dynamic";
const views = [
  ["overview", "Cash & coverage"],
  ["exceptions", "Bank reconciliation"],
  ["payouts", "Payout lifecycle"],
  ["cashbook", "Cashbook feed"],
  ["import", "Import statement"],
];
const sourceNames = {
  requests: "Payment requests",
  payroll: "Employee payroll",
  workforce: "Workforce payouts",
  helpers: "Helper payouts",
};
export default async function TreasuryPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const ctx = await booksContext();
  const { start, end } = period(searchParams);
  const tab = views.some(([id]) => id === searchParams.tab)
    ? searchParams.tab!
    : "overview";
  let data: Treasury | null = null,
    error = "";
  try {
    data = await loadTreasury(ctx);
  } catch (e) {
    error = e instanceof Error ? e.message : "Unable to load treasury data.";
  }
  const canAdd = hasPermission(ctx.authorization, "finance_books", "add"),
    canEdit = hasPermission(ctx.authorization, "finance_books", "edit");
  const href = (values: Record<string, string>) =>
    `/finance/treasury?${new URLSearchParams({ start, end, tab, ...values })}`;
  const importAccounts =
    data?.accounts.filter((a) => data.banks.some((b) => b.code === a.code)) ??
    [];
  const findings =
    data?.findings.filter((f) => f.bank.date >= start && f.bank.date <= end) ??
    [];
  const shown = findings
    .filter((f) => !searchParams.outcome || f.outcome === searchParams.outcome)
    .sort(
      (a, b) =>
        b.bank.date.localeCompare(a.bank.date) ||
        a.bank.id.localeCompare(b.bank.id),
    );
  const page = Math.max(
    1,
    Math.min(
      Math.floor(Number(searchParams.page)) || 1,
      Math.max(1, Math.ceil(shown.length / 50)),
    ),
  );
  const matchedKeys = new Set(
    data?.findings
      .filter((f) => f.outcome === "matched")
      .map((f) => f.payout?.key),
  );
  const missing =
    data?.payouts.filter((p) => paid(p.status) && !matchedKeys.has(p.key)) ??
    [];
  return (
    <AppShell active="Cash & Reconciliation" pageCode="finance_books">
      <div className="books-workspace treasury-workspace">
        <PageHead
          eyebrow="DROPX FINANCE"
          title="Cash & reconciliation"
          subtitle="Follow bank evidence back to the payout and the books."
          action={<Refresh />}
        />
        <nav className="books-tabs" aria-label="Treasury views">
          {views.map(([id, label]) => (
            <Link
              key={id}
              href={href({ tab: id })}
              aria-current={tab === id ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="books-period">
          <input type="hidden" name="tab" value={tab} />
          <Input
            label="Statement dates from"
            name="start"
            type="date"
            value={start}
          />
          <Input label="Through" name="end" type="date" value={end} />
          <button>Apply dates</button>
          <Link href="/finance/books">Accounting & journals →</Link>
        </form>
        {!data ? (
          <div role="alert" className="books-error">
            <strong>Reconciliation unavailable</strong>
            <p>
              {error} No partial totals or zero balances have been substituted.
            </p>
          </div>
        ) : (
          <>
            <div className="books-notice">
              <strong>
                {data.statements.length
                  ? "Statement coverage is limited to imported periods."
                  : "Federal statements have not been imported yet."}
              </strong>
              <p>
                Cashbook activity uses the existing automatic feed. Automatic
                Federal statement fetching is not connected. A settlement match
                confirms the bank debit against a payout record; approval
                completeness and accounting reconciliation are separate checks.
              </p>
            </div>
            {tab === "overview" && (
              <>
                <div className="treasury-metrics">
                  <section>
                    <small>Statement transactions in period</small>
                    <strong>{findings.length}</strong>
                  </section>
                  <section>
                    <small>Settlements matched</small>
                    <strong>
                      {findings.filter((f) => f.outcome === "matched").length}
                    </strong>
                  </section>
                  <section>
                    <small>Debits requiring review</small>
                    <strong>
                      {
                        findings.filter(
                          (f) =>
                            f.outcome !== "matched" && f.outcome !== "incoming",
                        ).length
                      }
                    </strong>
                  </section>
                  <section>
                    <small>
                      Paid records awaiting bank evidence · all dates
                    </small>
                    <strong>{missing.length}</strong>
                  </section>
                </div>
                <div className="books-two">
                  {data.banks.map((bank) => {
                    const statements = data!.statements
                      .filter(
                        (s) =>
                          s.account_code === bank.code && s.period_end <= end,
                      )
                      .sort((a, b) => b.period_end.localeCompare(a.period_end));
                    const latest = statements[0];
                    return (
                      <section className="books-card" key={bank.id}>
                        <small>
                          {bank.active ? "Active bank" : "Inactive bank"} · ••••{" "}
                          {bank.last4}
                        </small>
                        <h2>{bank.name}</h2>
                        <strong className="treasury-balance">
                          {latest
                            ? money(latest.closing)
                            : "Balance unavailable"}
                        </strong>
                        <p>
                          {latest
                            ? `Statement closing balance at ${latest.period_end}. ${statements.length} imported period(s); continuity across missing dates is not assumed.`
                            : "Import a bank statement to establish the balance and review its transactions."}
                        </p>
                        <small>Portal feed: not connected</small>
                        {!bank.enrolled && canAdd ? (
                          <Enrol id={bank.id} />
                        ) : (
                          <Link href={href({ tab: "import" })}>
                            Import statement →
                          </Link>
                        )}
                      </section>
                    );
                  })}
                  <section className="books-card">
                    <small>Existing automatic feed</small>
                    <h2>Cashbook feed</h2>
                    <strong className="treasury-balance">
                      {data.cashbook.length.toLocaleString()} imported entries
                    </strong>
                    <p>
                      Latest transaction:{" "}
                      {[...data.cashbook].sort((a, b) =>
                        b.date.localeCompare(a.date),
                      )[0]?.date ?? "No data"}
                      . The current Fin import keeps successful expense entries.
                      Opening balances and complete credit coverage are not
                      present in this dataset.
                    </p>
                    <Link href={href({ tab: "cashbook" })}>
                      Review Cashbook activity →
                    </Link>
                  </section>
                </div>
                <section className="books-card">
                  <h2>What each stage means</h2>
                  <div className="treasury-stages">
                    <p>
                      <b>Requested → Approved</b>
                      <br />
                      Existing request and approval workflows remain the
                      authority.
                    </p>
                    <p>
                      <b>Processing → Recorded as paid</b>
                      <br />
                      Bank response or operator entry exists; a statement is
                      still needed.
                    </p>
                    <p>
                      <b>Settlement matched</b>
                      <br />
                      Unique UTR, exact amount, debit account and payment date
                      agree.
                    </p>
                    <p>
                      <b>Books reconciled</b>
                      <br />
                      The statement entry is separately matched to its bank
                      ledger posting.
                    </p>
                  </div>
                </section>
              </>
            )}
            {tab === "exceptions" && (
              <section className="books-card">
                <h2>Transaction review</h2>
                <form className="books-period">
                  <input type="hidden" name="tab" value="exceptions" />
                  <input type="hidden" name="start" value={start} />
                  <input type="hidden" name="end" value={end} />
                  <label>
                    Outcome
                    <select
                      name="outcome"
                      defaultValue={searchParams.outcome ?? ""}
                    >
                      <option value="">All outcomes</option>
                      {Object.entries(outcomes).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button>Filter</button>
                  <Link
                    href={`/finance/treasury/export?start=${start}&end=${end}`}
                  >
                    Download reconciliation CSV
                  </Link>
                </form>
                {!shown.length ? (
                  <p>
                    No statement transactions for this selection. This does not
                    establish that there are no unexplained payments.
                  </p>
                ) : (
                  <div className="books-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Date / bank</th>
                          <th>Bank evidence</th>
                          <th>Amount</th>
                          <th>Payout</th>
                          <th>Outcome</th>
                          <th>Books / review</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.slice((page - 1) * 50, page * 50).map((f) => (
                          <tr key={f.bank.id}>
                            <td>
                              {f.bank.date}
                              <small>
                                {data!.accounts.find(
                                  (a) => a.code === f.bank.account_code,
                                )?.name ?? f.bank.account_code}
                              </small>
                            </td>
                            <td>
                              {f.bank.reference || "No reference"}
                              <small>{f.bank.description}</small>
                            </td>
                            <td>
                              {money(
                                paise(f.bank.credit) > BigInt(0)
                                  ? f.bank.credit
                                  : f.bank.debit,
                              )}
                              <small>
                                {paise(f.bank.credit) > BigInt(0)
                                  ? "Money in"
                                  : "Money out"}
                              </small>
                            </td>
                            <td>
                              {f.payout ? (
                                <>
                                  {f.payout.reference}
                                  <small>
                                    {sourceNames[f.payout.source]} ·{" "}
                                    {f.payout.status}
                                    <br />
                                    {money(f.payout.amount)}
                                  </small>
                                </>
                              ) : f.candidates.length ? (
                                `${f.candidates.length} candidates`
                              ) : (
                                "No unique payout"
                              )}
                            </td>
                            <td>
                              <span
                                className={`treasury-badge ${f.outcome === "matched" ? "good" : "attention"}`}
                              >
                                {outcomes[f.outcome]}
                              </span>
                              {f.difference && (
                                <small>Difference {money(f.difference)}</small>
                              )}
                            </td>
                            <td>
                              {f.bank.matched_line_id
                                ? "Ledger matched"
                                : "Ledger match pending"}
                              {data!.reviews
                                .filter((r) => r.rowId === f.bank.id)
                                .slice(0, 3)
                                .map((r) => (
                                  <small key={r.id}>
                                    {r.date.slice(0, 10)} · {r.note}
                                  </small>
                                ))}
                              {canEdit && <Review rowId={f.bank.id} />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {shown.length > 50 && (
                  <div className="books-actions">
                    {page > 1 && (
                      <Link
                        href={href({
                          tab: "exceptions",
                          outcome: searchParams.outcome ?? "",
                          page: String(page - 1),
                        })}
                      >
                        Previous
                      </Link>
                    )}
                    <span>
                      Page {page} of {Math.ceil(shown.length / 50)} ·{" "}
                      {shown.length} rows
                    </span>
                    {page * 50 < shown.length && (
                      <Link
                        href={href({
                          tab: "exceptions",
                          outcome: searchParams.outcome ?? "",
                          page: String(page + 1),
                        })}
                      >
                        Next
                      </Link>
                    )}
                  </div>
                )}
                <p>
                  Partial payments, combined settlements, own-account transfers,
                  charges and tax deductions require review. They are never
                  cleared by approximate amount matching.
                </p>
              </section>
            )}
            {tab === "payouts" && (
              <section className="books-card">
                <h2>Existing payout sources · all dates</h2>
                <p>
                  These are distinct operational records and payment attempts,
                  not an accounts-payable total. Reimbursements linked to
                  payment requests are counted only in the request source.
                </p>
                <div className="books-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Records / attempts</th>
                        <th>Recorded as paid</th>
                        <th>Missing bank reference</th>
                        <th>Awaiting statement evidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(sourceNames).map(([key, label]) => {
                        const rows = data!.payouts.filter(
                          (p) => p.source === key,
                        );
                        return (
                          <tr key={key}>
                            <td>{label}</td>
                            <td>{rows.length}</td>
                            <td>{rows.filter((p) => paid(p.status)).length}</td>
                            <td>
                              {
                                rows.filter((p) => paid(p.status) && !referenceKey(p.utr))
                                  .length
                              }
                            </td>
                            <td>
                              {missing.filter((p) => p.source === key).length}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p>
                  General payment requests currently do not retain the
                  originating bank account. Even an exact UTR and amount match
                  remains flagged for bank-account verification.
                </p>
                <div className="books-actions">
                  <Link href="/payments/requests">Requests</Link>
                  <Link href="/payments/approvals">Approvals</Link>
                  <Link href="/payments/process">Payment processing</Link>
                </div>
              </section>
            )}
            {tab === "cashbook" && (
              <section className="books-card">
                <h2>Cashbook activity</h2>
                <p>
                  Read directly from the existing automatic import. Entries
                  below are the expense rows retained by Fin; totals here do not
                  establish the bank closing balance.
                </p>
                <div className="books-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Station</th>
                        <th>Reference</th>
                        <th>Expense</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cashbook
                        .filter((r) => r.date >= start && r.date <= end)
                        .sort((a, b) => b.date.localeCompare(a.date))
                        .slice(0, 200)
                        .map((r) => (
                          <tr key={r.id}>
                            <td>{r.date}</td>
                            <td>{r.station}</td>
                            <td>{r.reference || "Not supplied"}</td>
                            <td>{money(r.amount)}</td>
                            <td>{r.note}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <small>Latest 200 entries in the selected period.</small>
              </section>
            )}
            {tab === "import" && (
              <section className="books-card">
                <h2>Import a bank statement</h2>
                <p>
                  Use a bank-generated CSV or Excel file from FedNet, FedOne or
                  your bank. Review the selected account, period and column
                  mapping. Duplicate and overlapping periods are rejected by the
                  accounting database.
                </p>
                {!importAccounts.length && (
                  <p>Enable a configured bank from Cash & coverage first.</p>
                )}
                {canAdd ? (
                  <StatementImport accounts={importAccounts} />
                ) : (
                  <p>Your role has read access only.</p>
                )}
              </section>
            )}
            <small className="treasury-footer">
              Source data read{" "}
              {new Intl.DateTimeFormat("en-IN", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "Asia/Kolkata",
              }).format(new Date(data.readAt))}{" "}
              IST. Bank balances are statement-dated, not live API balances.
            </small>
          </>
        )}
      </div>
    </AppShell>
  );
}
