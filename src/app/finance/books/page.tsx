import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission } from "@/lib/authorization";
import { booksContext, period, trialBalance } from "@/lib/finance360/server";
import {
  money,
  paise,
  statements,
  type TrialRow,
} from "@/lib/finance360/model";
import type { Account, Summary } from "@/lib/finance360/types";
import {
  AccountForm,
  AccountSelect,
  ImportForm,
  Input,
  JournalForm,
  Print,
  Reconcile,
  Refresh,
  SaveForm,
} from "./forms";
import "./workspace.css";
export const dynamic = "force-dynamic";
const tabs = [
  ["overview", "Overview"],
  ["journals", "Books & ledgers"],
  ["imports", "Import centre"],
  ["banks", "Banking"],
  ["loans", "Loans"],
  ["reports", "Financial statements"],
  ["controls", "Controls & audit"],
];
function Reports({
  rows,
  start,
  end,
  summary,
}: {
  rows: TrialRow[];
  start: string;
  end: string;
  summary: Summary;
}) {
  const s = statements(rows);
  if (!summary.journals)
    return (
      <div className="books-empty">
        <h2>Financials are waiting for the accounting data</h2>
        <p>
          Import the opening balances and vouchers, then compare the trial
          balance to Tally before preparing the bank pack.
        </p>
        <Link href="/finance/books?tab=imports">Open import centre →</Link>
      </div>
    );
  return (
    <>
      <div className="books-notice">
        <strong>
          Draft provisional financials · {start} to {end}
        </strong>
        <p>
          Based only on posted entries in this workspace. Reconciliation and
          accountant review remain required.{" "}
          {summary.settings?.coverage_through
            ? `Imported coverage declared through ${summary.settings.coverage_through}.`
            : "Completeness of imported books has not been confirmed."}{" "}
          {summary.unmatched} imported bank transactions remain unmatched.
          Bank/loan statements may not cover all accounts or the report date.
        </p>
      </div>
      {s.difference !== BigInt(0) && (
        <p className="books-error">
          Trial balance difference: {money(s.difference)}. Do not use these
          statements until corrected.
        </p>
      )}
      <div className="books-two">
        <section className="books-card">
          <h2>Profit & loss</h2>
          <p className="books-muted">For the selected period · ₹</p>
          {rows
            .filter((r) => r.type === "income" || r.type === "expense")
            .map((r) => (
              <div className="books-value" key={r.code}>
                <span>{r.name}</span>
                <b>
                  {money(
                    r.type === "income"
                      ? paise(r.credit) - paise(r.debit)
                      : paise(r.debit) - paise(r.credit),
                  )}
                </b>
              </div>
            ))}
          <div className="books-value">
            <span>Total income</span>
            <b>{money(s.income)}</b>
          </div>
          <div className="books-value">
            <span>Total expenses</span>
            <b>{money(s.expenses)}</b>
          </div>
          <div className="books-value books-total">
            <span>Net result after posted expenses / taxes</span>
            <b>{money(s.profit)}</b>
          </div>
          <small>
            Unposted accruals, depreciation and tax adjustments are excluded.
          </small>
        </section>
        <section className="books-card">
          <h2>Balance sheet</h2>
          <p className="books-muted">As at {end} · ₹</p>
          {(["asset", "liability", "equity"] as const).map((type) => (
            <div key={type}>
              <h3>
                {type === "asset"
                  ? "Assets"
                  : type === "liability"
                    ? "Liabilities"
                    : "Partners’ capital / equity"}
              </h3>
              {rows
                .filter((r) => r.type === type)
                .map((r) => (
                  <div className="books-value" key={r.code}>
                    <span>{r.name}</span>
                    <b>
                      {money(
                        paise(r.closing, true) *
                          (type === "asset" ? BigInt(1) : -BigInt(1)),
                      )}
                    </b>
                  </div>
                ))}
            </div>
          ))}
          <div className="books-value">
            <span>Accumulated result in unclosed books</span>
            <b>{money(s.accumulatedProfit)}</b>
          </div>
          <div className="books-value books-total">
            <span>Total assets</span>
            <b>{money(s.assets)}</b>
          </div>
          <div className="books-value books-total">
            <span>Liabilities + equity + result</span>
            <b>{money(s.liabilities + s.equity + s.accumulatedProfit)}</b>
          </div>
        </section>
      </div>
      <section className="books-card">
        <h2>Trial balance</h2>
        <TrialTable rows={rows} />
      </section>
      <div className="books-actions books-no-print">
        <Link
          className="books-primary"
          href={`/finance/books/export?start=${start}&end=${end}`}
        >
          Download provisional workbook
        </Link>
        <Print />
      </div>
    </>
  );
}
function TrialTable({ rows }: { rows: TrialRow[] }) {
  return (
    <div className="books-scroll">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Ledger</th>
            <th>Type</th>
            <th>Opening Dr / (Cr)</th>
            <th>Period debits</th>
            <th>Period credits</th>
            <th>Closing Dr / (Cr)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td>
                <Link
                  href={`/finance/books?tab=journals&account=${encodeURIComponent(r.code)}`}
                >
                  {r.code}
                </Link>
              </td>
              <td>{r.name}</td>
              <td>{r.type}</td>
              <td>{money(r.opening)}</td>
              <td>{money(r.debit)}</td>
              <td>{money(r.credit)}</td>
              <td>{money(r.closing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default async function BooksPage({
  searchParams = {},
}: {
  searchParams?: Record<string, string | undefined>;
}) {
  const ctx = await booksContext();
  const { start, end } = period(searchParams);
  const tab = tabs.some(([id]) => id === searchParams.tab)
    ? searchParams.tab!
    : "overview";
  const page = Math.floor(
    Math.max(1, Math.min(100000, Number(searchParams.page) || 1)),
  );
  const offset = (Math.floor(page) - 1) * 50;
  const canAdd = hasPermission(ctx.authorization, "finance_books", "add"),
    canEdit = hasPermission(ctx.authorization, "finance_books", "edit");
  let summary: Summary | null = null,
    trial: TrialRow[] = [],
    accounts: Account[] = [],
    loadError = "";
  type DataRow = Record<string, unknown>;
  let data: DataRow[] = [],
    count = 0,
    selectedStatement = "",
    bankStatements: DataRow[] = [];
  try {
    const result = await ctx.db.rpc("finance360_summary", {
      p_company: ctx.companyId,
      p_end: end,
    });
    if (result.error) throw new Error("Unable to load accounting status.");
    summary = result.data as Summary;
    trial = await trialBalance(ctx, start, end);
    for (let n = 0; ; n += 1000) {
      const r = await ctx.db
        .from("finance360_accounts")
        .select("code,name,type")
        .eq("company_id", ctx.companyId)
        .order("code")
        .range(n, n + 999);
      if (r.error) throw new Error("Unable to load the chart of accounts.");
      accounts.push(...r.data);
      if (r.data.length < 1000) break;
    }
    if (tab === "journals") {
      let q = ctx.db
        .from("finance360_journals")
        .select(
          "id,date,reference,narration,reversal_of,finance360_lines!inner(id,account_code,debit,credit)",
          { count: "exact" },
        )
        .eq("company_id", ctx.companyId)
        .gte("date", start)
        .lte("date", end);
      if (searchParams.account)
        q = q.eq("finance360_lines.account_code", searchParams.account);
      if (searchParams.q)
        q = q.ilike("reference", `%${searchParams.q.slice(0, 100)}%`);
      const r = await q
        .order("date", { ascending: false })
        .order("id")
        .range(offset, offset + 49);
      if (r.error) throw new Error("Unable to load vouchers.");
      data = r.data ?? [];
      count = r.count ?? 0;
    } else if (tab === "banks") {
      const s = await ctx.db
        .from("finance360_bank_statements")
        .select("id,account_code,period_start,period_end,opening,closing")
        .eq("company_id", ctx.companyId)
        .lte("period_end", end)
        .order("period_end", { ascending: false })
        .limit(100);
      if (s.error) throw new Error("Unable to load bank statements.");
      bankStatements = s.data ?? [];
      selectedStatement = bankStatements.some(
        (s) => s.id === searchParams.statement,
      )
        ? searchParams.statement!
        : String(bankStatements[0]?.id ?? "");
      if (selectedStatement) {
        let q = ctx.db
          .from("finance360_bank_rows")
          .select(
            "id,row_number,date,description,reference,debit,credit,balance,matched_line_id",
            { count: "exact" },
          )
          .eq("company_id", ctx.companyId)
          .eq("statement_id", selectedStatement);
        if (searchParams.unmatched === "yes") q = q.is("matched_line_id", null);
        const r = await q.order("row_number").range(offset, offset + 49);
        if (r.error) throw new Error("Unable to load transactions.");
        data = r.data ?? [];
        count = r.count ?? 0;
      }
    } else if (tab === "imports" || tab === "controls") {
      const r = await ctx.db
        .from(tab === "imports" ? "finance360_imports" : "finance360_audit")
        .select("*", { count: "exact" })
        .eq("company_id", ctx.companyId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(offset, offset + 49);
      if (r.error)
        throw new Error("Unable to load the import / audit history.");
      data = r.data ?? [];
      count = r.count ?? 0;
    }
  } catch (e) {
    loadError = (e as Error).message;
  }
  const href = (values: Record<string, string>) =>
    `/finance/books?${new URLSearchParams({ ...(Object.fromEntries(Object.entries(searchParams).filter(([, v]) => typeof v === "string")) as Record<string, string>), start, end, ...values })}`;
  const totals = statements(trial);
  return (
    <AppShell active="Accounting, Banks & Loans" pageCode="finance_books">
      <div className="books-workspace">
        <PageHead
          eyebrow="DROPX FINANCE"
          title="Accounting, banks & loans"
          subtitle="Your books, cash position and financial statements in one workspace."
          action={<Refresh />}
        />
        <nav className="books-tabs" aria-label="Accounting views">
          {tabs.map(([id, label]) => (
            <Link
              key={id}
              href={href({ tab: id, page: "1" })}
              aria-current={tab === id ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <form className="books-period books-no-print">
          <input type="hidden" name="tab" value={tab} />
          <Input
            label="Financial period from"
            name="start"
            type="date"
            value={start}
          />
          <Input label="Position as at" name="end" type="date" value={end} />
          <button>Apply dates</button>
          <span>INR · Refreshes every 60 seconds while open</span>
        </form>
        {loadError || !summary ? (
          <div role="alert" className="books-error">
            <strong>Accounting data could not be loaded</strong>
            <p>
              {loadError} Refresh to retry. No zero balances have been
              substituted.
            </p>
          </div>
        ) : (
          <>
            {tab === "overview" && (
              <>
                <section className="books-hero">
                  <div>
                    <span>THE FINANCIAL POSITION</span>
                    <h2>
                      {summary.journals
                        ? "A clear view of your books."
                        : "Ready for your accounting data."}
                    </h2>
                    <p>
                      {summary.journals
                        ? `${summary.journals.toLocaleString()} posted vouchers through ${end}. Check statement dates and reconciliation before relying on balances.`
                        : "Bring across the opening balances and vouchers from Tally to begin. Your existing payment and asset workspaces remain available."}
                    </p>
                    <Link
                      href={href({
                        tab: summary.journals ? "reports" : "imports",
                      })}
                    >
                      {summary.journals
                        ? "Review financial statements"
                        : "Start the accounting import"}{" "}
                      →
                    </Link>
                  </div>
                  <div className="books-hero-asof">
                    <span>REPORT DATE</span>
                    <strong>{end}</strong>
                    <small>
                      {summary.settings?.coverage_through
                        ? `Coverage declared: ${summary.settings.coverage_through}`
                        : "Imported coverage not yet confirmed"}
                    </small>
                  </div>
                </section>
                <div className="books-metrics">
                  <article>
                    <span>Book profit / (loss)</span>
                    <strong>
                      {summary.journals
                        ? money(totals.profit)
                        : "Awaiting import"}
                    </strong>
                    <small>
                      {start} to {end}
                    </small>
                  </article>
                  <article>
                    <span>Bank statements</span>
                    <strong>{summary.banks.length} accounts</strong>
                    <small>Latest imported position; feeds not connected</small>
                  </article>
                  <article>
                    <span>Loan facilities</span>
                    <strong>
                      {summary.loans.length
                        ? money(
                            summary.loans.reduce(
                              (s, l) => s + paise(l.principal),
                              BigInt(0),
                            ),
                          )
                        : "Awaiting statements"}
                    </strong>
                    <small>Principal from latest uploaded snapshots</small>
                  </article>
                  <article>
                    <span>To reconcile</span>
                    <strong>{summary.unmatched}</strong>
                    <small>
                      {summary.banks.length
                        ? "Unmatched imported bank transactions"
                        : "Bank statements not imported"}
                    </small>
                  </article>
                </div>
                <div className="books-two">
                  <section className="books-card">
                    <h2>Bank position</h2>
                    {summary.banks.length ? (
                      summary.banks.map((b) => (
                        <div className="books-value" key={b.account_code}>
                          <span>
                            {accounts.find((a) => a.code === b.account_code)
                              ?.name ?? b.account_code}
                            <small>
                              Statement through {b.period_end}
                              {b.period_end < end
                                ? " · older than report date"
                                : ""}
                            </small>
                          </span>
                          <b>{money(b.closing)}</b>
                        </div>
                      ))
                    ) : (
                      <p className="books-muted">
                        Upload bank statements to see dated account balances. A
                        missing statement is not a zero balance.
                      </p>
                    )}
                    <Link href={href({ tab: "banks" })}>
                      Banking & reconciliation →
                    </Link>
                  </section>
                  <section className="books-card">
                    <h2>Bank provisional pack · 6 October</h2>
                    <p>
                      Trial balance, P&L, balance sheet, bank and loan schedules
                      with source coverage and reconciliation notes.
                    </p>
                    <Link href="/finance/books?tab=reports&start=2026-04-01&end=2026-10-06">
                      Open the requested period →
                    </Link>
                    <p className="books-muted">
                      Awaiting accountant exports from DROPX 2026–27 and opening
                      balance verification against the previous year closing
                      books.
                    </p>
                  </section>
                </div>
                <section className="books-card">
                  <h2>Connected Finance workspaces</h2>
                  <div className="books-link-grid">
                    <Link href="/master/assets">Asset register →</Link>
                    <Link href="/payments/requests">Payment requests →</Link>
                    <Link href="/finance/business?tab=revenue">
                      Revenue & billing →
                    </Link>
                    <Link href="/finance/business?tab=pnl">
                      Operational P&L →
                    </Link>
                  </div>
                  <p className="books-muted">
                    Operational payments and assets do not automatically post
                    accounting entries yet. Review and post approved source
                    entries once to prevent double counting.
                  </p>
                </section>
              </>
            )}
            {tab === "journals" && (
              <>
                <section className="books-card">
                  <h2>Books & ledgers</h2>
                  <form className="books-period">
                    <input type="hidden" name="tab" value="journals" />
                    <input type="hidden" name="start" value={start} />
                    <input type="hidden" name="end" value={end} />
                    <label>
                      Ledger
                      <select
                        name="account"
                        defaultValue={searchParams.account ?? ""}
                      >
                        <option value="">All ledgers</option>
                        {accounts.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Input
                      label="Voucher reference"
                      name="q"
                      required={false}
                      value={searchParams.q}
                    />
                    <button>Search</button>
                  </form>
                  {!data.length ? (
                    <p className="books-muted">
                      No vouchers in this period or filter.
                    </p>
                  ) : (
                    <div className="books-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Date / reference</th>
                            <th>Narration</th>
                            <th>Ledger</th>
                            <th>Debit</th>
                            <th>Credit</th>
                            <th>Correction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.map((j) =>
                            (
                              j.finance360_lines as {
                                id: string;
                                account_code: string;
                                debit: number;
                                credit: number;
                              }[]
                            ).map((l, i) => (
                              <tr key={l.id}>
                                <td>
                                  {String(j.date)}
                                  <small>{String(j.reference)}</small>
                                </td>
                                <td>
                                  {String(j.narration)}
                                  {Boolean(j.reversal_of) && (
                                    <small>Reversal voucher</small>
                                  )}
                                </td>
                                <td>
                                  {accounts.find(
                                    (a) => a.code === l.account_code,
                                  )?.name ?? l.account_code}
                                </td>
                                <td>{money(String(l.debit))}</td>
                                <td>{money(String(l.credit))}</td>
                                <td>
                                  {canEdit && i === 0 && (
                                    <details>
                                      <summary>Reverse</summary>
                                      <SaveForm
                                        action="reversal"
                                        label="Post reversal"
                                      >
                                        <input
                                          name="journal_id"
                                          type="hidden"
                                          value={String(j.id)}
                                        />
                                        <Input
                                          label="Reversal reference"
                                          name="reference"
                                        />
                                        <Input
                                          label="Reversal date"
                                          name="date"
                                          type="date"
                                          value={end}
                                        />
                                        <Input
                                          label="Reason"
                                          name="narration"
                                        />
                                      </SaveForm>
                                    </details>
                                  )}
                                </td>
                              </tr>
                            )),
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                {canAdd && (
                  <details className="books-card">
                    <summary>+ New voucher</summary>
                    <p className="books-muted">
                      Use for receipts, payments, purchases, sales, adjustments
                      and opening balances. Posted vouchers cannot be
                      overwritten.
                    </p>
                    <JournalForm accounts={accounts} today={end} />
                  </details>
                )}
                <details className="books-card">
                  <summary>
                    Chart of accounts · {accounts.length} ledgers
                  </summary>
                  {canAdd && <AccountForm />}
                  <div className="books-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Name</th>
                          <th>Classification</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accounts.map((a) => (
                          <tr key={a.code}>
                            <td>{a.code}</td>
                            <td>{a.name}</td>
                            <td>{a.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
            {tab === "imports" && (
              <>
                <section className="books-card">
                  <h2>Bring the Tally books across</h2>
                  <p>
                    Native .1800 ZIP backups require Tally to export readable
                    data. Request All Masters and Vouchers XML, plus detailed
                    trial balance, P&L and balance sheet for 1 April–6 October
                    2026 from the accountant.
                  </p>
                  <p className="books-muted">
                    This uploader currently accepts the mapped CSV / Excel
                    template below. XML conversion and opening-balance
                    reconciliation must be checked before posting. Include all
                    ledger splits and taxes, retain stable voucher references,
                    and import the opening balance journal once. Historical ITRs
                    are reference documents, not current-year ledger data.
                  </p>
                </section>
                {canAdd && (
                  <section className="books-card">
                    <h2>Import vouchers</h2>
                    <ImportForm kind="journal" accounts={accounts} />
                  </section>
                )}
                <section className="books-card">
                  <h2>Source history</h2>
                  <div className="books-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Received</th>
                          <th>Type</th>
                          <th>Source</th>
                          <th>Fingerprint</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map((r) => (
                          <tr key={String(r.id)}>
                            <td>
                              {String(r.created_at)
                                .slice(0, 19)
                                .replace("T", " ")}
                            </td>
                            <td>{String(r.kind)}</td>
                            <td>{String(r.filename)}</td>
                            <td>
                              <code>{String(r.sha256).slice(0, 16)}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!data.length && (
                    <p className="books-muted">
                      No accounting sources imported yet.
                    </p>
                  )}
                </section>
              </>
            )}
            {tab === "banks" && (
              <>
                {canAdd && (
                  <details className="books-card">
                    <summary>+ Upload daily bank statement</summary>
                    <p className="books-muted">
                      Create the bank or overdraft ledger in Books & ledgers
                      first. CSV and Excel are supported; bank PDF conversion
                      and automatic feeds are not connected.
                    </p>
                    <ImportForm kind="bank" accounts={accounts} />
                  </details>
                )}
                <section className="books-card">
                  <h2>Statement transactions</h2>
                  <form className="books-period">
                    <input name="tab" type="hidden" value="banks" />
                    <input name="start" type="hidden" value={start} />
                    <input name="end" type="hidden" value={end} />
                    <label>
                      Statement (latest 100)
                      <select name="statement" defaultValue={selectedStatement}>
                        {bankStatements.map((s) => (
                          <option key={String(s.id)} value={String(s.id)}>
                            {String(s.account_code)} · {String(s.period_start)}{" "}
                            — {String(s.period_end)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Show
                      <select
                        name="unmatched"
                        defaultValue={searchParams.unmatched ?? ""}
                      >
                        <option value="">All transactions</option>
                        <option value="yes">Unmatched only</option>
                      </select>
                    </label>
                    <button>Apply</button>
                  </form>
                  {bankStatements
                    .filter((s) => s.id === selectedStatement)
                    .map((s) => (
                      <p key={String(s.id)} className="books-notice">
                        Opening: {money(String(s.opening))} · Closing:{" "}
                        {money(String(s.closing))} · Statement through{" "}
                        {String(s.period_end)}. Reconciliation compares each
                        transaction to its ledger entry; this is not a live bank
                        feed.
                      </p>
                    ))}
                  {!data.length ? (
                    <p className="books-muted">
                      No statement transactions for this selection.
                    </p>
                  ) : (
                    <div className="books-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Description / reference</th>
                            <th>Money out</th>
                            <th>Money in</th>
                            <th>Balance</th>
                            <th>Reconciliation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.map((r) => (
                            <tr key={String(r.id)}>
                              <td>{String(r.date)}</td>
                              <td>
                                {String(r.description)}
                                <small>{String(r.reference)}</small>
                              </td>
                              <td>{money(String(r.debit))}</td>
                              <td>{money(String(r.credit))}</td>
                              <td>{money(String(r.balance))}</td>
                              <td>
                                {canEdit ? (
                                  <Reconcile
                                    rowId={String(r.id)}
                                    matched={Boolean(r.matched_line_id)}
                                  />
                                ) : r.matched_line_id ? (
                                  "Matched"
                                ) : (
                                  "Pending"
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </>
            )}
            {tab === "loans" && (
              <>
                <section className="books-card">
                  <h2>Loans & repayment position</h2>
                  <p className="books-muted">
                    Latest lender statement per facility, on or before {end}.
                    These snapshots do not post to the accounting ledger.
                  </p>
                  {!summary.loans.length ? (
                    <p>No lender statements recorded yet.</p>
                  ) : (
                    <div className="books-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Facility / lender</th>
                            <th>Statement as of</th>
                            <th>Principal</th>
                            <th>Interest due</th>
                            <th>EMI</th>
                            <th>Next due</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.loans.map((l) => (
                            <tr key={l.facility}>
                              <td>
                                {l.facility}
                                <small>{l.lender}</small>
                              </td>
                              <td>{l.as_of}</td>
                              <td>{money(l.principal)}</td>
                              <td>{money(l.interest_due)}</td>
                              <td>{money(l.emi)}</td>
                              <td>{l.next_due ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                {canAdd && (
                  <details className="books-card">
                    <summary>+ Record lender statement</summary>
                    <SaveForm action="loan" label="Save lender position">
                      <div className="books-fields">
                        <Input
                          name="facility"
                          label="Unique facility / loan reference"
                        />
                        <Input name="lender" label="Lender" />
                        <AccountSelect
                          accounts={accounts}
                          types={["liability"]}
                        />
                        <Input
                          name="as_of"
                          label="Statement as of"
                          type="date"
                          value={end}
                        />
                        <Input
                          name="principal"
                          label="Principal outstanding (₹)"
                          type="number"
                        />
                        <Input
                          name="interest_due"
                          label="Interest due (₹)"
                          type="number"
                        />
                        <Input name="emi" label="EMI (₹)" type="number" />
                        <Input
                          name="next_due"
                          label="Next due date"
                          type="date"
                          required={false}
                        />
                        <Input name="filename" label="Source statement name" />
                        <Input
                          name="note"
                          label="Statement notes / adjustments"
                        />
                      </div>
                    </SaveForm>
                  </details>
                )}
              </>
            )}
            {tab === "reports" && (
              <Reports rows={trial} start={start} end={end} summary={summary} />
            )}
            {tab === "controls" && (
              <>
                <div className="books-two">
                  <section className="books-card">
                    <h2>Imported book coverage</h2>
                    <p>
                      Confirmed coverage:{" "}
                      {summary.settings?.coverage_from ?? "Not declared"} →{" "}
                      {summary.settings?.coverage_through ?? "Not declared"}
                    </p>
                    <p className="books-muted">
                      Declare only after comparing the imported trial balance
                      and voucher totals with the source books, including
                      opening balances. This is separate from bank
                      reconciliation.
                    </p>
                    {canEdit && (
                      <SaveForm
                        action="coverage"
                        label="Confirm imported coverage"
                      >
                        <div className="books-fields">
                          <Input
                            name="start"
                            label="Coverage from"
                            type="date"
                            value={start}
                          />
                          <Input
                            name="end"
                            label="Complete through"
                            type="date"
                            value={end}
                          />
                          <Input
                            name="reason"
                            label="Reconciliation reference / note"
                          />
                        </div>
                      </SaveForm>
                    )}
                  </section>
                  <section className="books-card">
                    <h2>Period lock</h2>
                    <p>
                      Locked through:{" "}
                      {summary.settings?.locked_through ?? "No period locked"}
                    </p>
                    <p className="books-muted">
                      Stops backdated voucher posting and reversals through this
                      date. Locks can only move forward here; finish reviewing
                      the books first.
                    </p>
                    {canEdit && (
                      <SaveForm
                        action="lock"
                        label="Lock period"
                        confirm="The books for this period have been reviewed. Prevent further backdated postings."
                      >
                        <Input name="date" label="Lock through" type="date" />
                        <Input name="reason" label="Close / review reference" />
                      </SaveForm>
                    )}
                  </section>
                </div>
                <section className="books-card">
                  <h2>Audit trail</h2>
                  <div className="books-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Recorded (UTC)</th>
                          <th>Action</th>
                          <th>User</th>
                          <th>Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.map((r) => (
                          <tr key={String(r.id)}>
                            <td>
                              {String(r.created_at)
                                .slice(0, 19)
                                .replace("T", " ")}
                            </td>
                            <td>{String(r.action)}</td>
                            <td>
                              <code>{String(r.actor_id).slice(0, 8)}</code>
                            </td>
                            <td>
                              {String(
                                (r.detail as Record<string, unknown>)
                                  ?.reference ??
                                  (r.detail as Record<string, unknown>)
                                    ?.filename ??
                                  (r.detail as Record<string, unknown>)
                                    ?.reason ??
                                  "",
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="books-notice">
                  <strong>Migration readiness</strong>
                  <p>
                    Available: balanced books, CSV / Excel voucher imports,
                    ledger reports, bank uploads and transaction matching, loan
                    snapshots, provisional statements, locks and audit trail.
                    Pending before retiring Tally: verified historical
                    migration, automated operational posting, invoice /
                    receivable / payable workflows, statutory tax returns and
                    e-invoicing, depreciation schedules, cash-flow
                    classification, bank feeds, and an accountant-approved
                    parallel close.
                  </p>
                </section>
              </>
            )}
            {["journals", "banks", "imports", "controls"].includes(tab) &&
              count > 0 && (
                <div className="books-pager">
                  <span>
                    {offset + 1}–{Math.min(offset + 50, count)} of {count}
                  </span>
                  {page > 1 && (
                    <Link href={href({ page: String(page - 1) })}>
                      ← Previous
                    </Link>
                  )}
                  {offset + 50 < count && (
                    <Link href={href({ page: String(page + 1) })}>Next →</Link>
                  )}
                </div>
              )}
          </>
        )}
      </div>
    </AppShell>
  );
}
