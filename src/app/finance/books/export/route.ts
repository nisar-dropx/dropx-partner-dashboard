import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { booksContext, period, trialBalance } from "@/lib/finance360/server";
import { decimal, paise, statements, csvCell } from "@/lib/finance360/model";
import type { Summary } from "@/lib/finance360/types";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const ctx = await booksContext();
  const template = request.nextUrl.searchParams.get("template");
  if (template) {
    if (!["journal", "bank"].includes(template))
      return new NextResponse("Unknown template", { status: 400 });
    const columns =
      template === "journal"
        ? [
            "date",
            "reference",
            "narration",
            "account_code",
            "account_name",
            "account_type",
            "debit",
            "credit",
          ]
        : ["date", "description", "reference", "debit", "credit", "balance"];
    return new NextResponse(columns.map(csvCell).join(",") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="dropx-${template}-template.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  }
  try {
    const { start, end } = period(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const rows = await trialBalance(ctx, start, end);
    const result = await ctx.db.rpc("finance360_summary", {
      p_company: ctx.companyId,
      p_end: end,
    });
    if (result.error) throw new Error("Unable to load report status.");
    const summary = result.data as Summary;
    if (!summary.journals || !rows.length)
      return new NextResponse(
        "No posted accounting data for this period. Import and verify the source books before exporting financials.",
        { status: 409 },
      );
    const s = statements(rows);
    if (s.difference !== BigInt(0) || s.balanceDifference !== BigInt(0))
      return new NextResponse(
        "The books do not balance. Correct the entries before exporting.",
        { status: 409 },
      );
    const book = XLSX.utils.book_new();
    // Keep very large amounts as exact decimal text; normal amounts remain usable Excel numbers.
    const amount = (v: string) => (Math.abs(Number(v)) <= 9e12 ? Number(v) : v);
    function sheet(name: string, values: (string | number)[][]) {
      const ws = XLSX.utils.aoa_to_sheet(values);
      for (const key of Object.keys(ws)) {
        if (!key.startsWith("!") && ws[key].t === "n")
          ws[key].z = "#,##0.00;[Red](#,##0.00)";
      }
      ws["!cols"] = Array.from(
        { length: Math.max(...values.map((r) => r.length)) },
        (_, i) => ({ wch: i === 0 ? 46 : 26 }),
      );
      XLSX.utils.book_append_sheet(book, ws, name);
    }
    const reportNotes = [
      ["DROPX · DRAFT PROVISIONAL FINANCIALS"],
      ["Financial period", start, end],
      ["Currency", "INR"],
      ["Generated at (UTC)", new Date().toISOString()],
      ["Basis", "Posted accounting entries only; not audited or certified."],
      [
        "Coverage declared from",
        summary.settings?.coverage_from ?? "Not declared",
      ],
      [
        "Coverage declared through",
        summary.settings?.coverage_through ?? "Not declared",
      ],
      ["Bank reconciliation", "Pending accountant review"],
      ["Unmatched imported bank transactions", summary.unmatched],
      [
        "Bank coverage",
        "Latest imported statements only; may not include all accounts or cover the report date.",
      ],
      [
        "Adjustments",
        "Unposted accruals, tax and depreciation adjustments excluded.",
      ],
      [
        "Operational data",
        "Existing operational P&L, payroll, assets and payment requests do not automatically post here.",
      ],
      [
        "Use",
        "Accountant review of migration, completeness, classification and reconciliation is required before bank submission.",
      ],
    ];
    sheet("Read first", reportNotes);
    sheet("Trial balance", [
      ["TRIAL BALANCE · DRAFT · INR"],
      ["Period", start, end],
      [
        "Code",
        "Account",
        "Type",
        "Opening Dr / (Cr)",
        "Period debit",
        "Period credit",
        "Closing Dr / (Cr)",
      ],
      ...rows.map((r) => [
        r.code,
        r.name,
        r.type,
        amount(r.opening),
        amount(r.debit),
        amount(r.credit),
        amount(r.closing),
      ]),
      [
        "Closing net difference",
        "",
        "",
        "",
        "",
        "",
        amount(decimal(s.difference)),
      ],
    ]);
    sheet("Profit and loss", [
      ["PROFIT & LOSS · DRAFT · INR"],
      ["Period", start, end],
      ["Ledger", "Type", "Amount"],
      ...rows
        .filter((r) => r.type === "income" || r.type === "expense")
        .map((r) => [
          r.name,
          r.type,
          amount(
            decimal(
              r.type === "income"
                ? paise(r.credit) - paise(r.debit)
                : paise(r.debit) - paise(r.credit),
            ),
          ),
        ]),
      ["Total income", "", amount(decimal(s.income))],
      ["Total expenses", "", amount(decimal(s.expenses))],
      [
        "Net result after posted expenses / taxes",
        "",
        amount(decimal(s.profit)),
      ],
    ]);
    sheet("Balance sheet", [
      ["BALANCE SHEET · DRAFT · INR"],
      ["As at", end],
      ["Ledger", "Type", "Amount"],
      ...rows
        .filter((r) => !["income", "expense"].includes(r.type))
        .map((r) => [
          r.name,
          r.type,
          amount(
            decimal(
              paise(r.closing, true) *
                (r.type === "asset" ? BigInt(1) : -BigInt(1)),
            ),
          ),
        ]),
      [
        "Accumulated result in unclosed books",
        "equity",
        amount(decimal(s.accumulatedProfit)),
      ],
      ["Total assets", "", amount(decimal(s.assets))],
      [
        "Liabilities + equity + result",
        "",
        amount(decimal(s.liabilities + s.equity + s.accumulatedProfit)),
      ],
      ["Balance difference", "", amount(decimal(s.balanceDifference))],
    ]);
    sheet("Bank schedule", [
      ["BANK POSITION · STATEMENT BASIS · INR"],
      ["Report date", end],
      [
        "Ledger",
        "Statement through",
        "Statement balance",
        "Book balance as at report date",
      ],
      ...summary.banks.map((b) => [
        b.account_code,
        b.period_end,
        amount(b.closing),
        rows.find((r) => r.code === b.account_code)
          ? amount(rows.find((r) => r.code === b.account_code)!.closing)
          : "No posted balance",
      ]),
      [
        "Reconciliation",
        "Pending review; statement and ledger dates may differ.",
      ],
    ]);
    sheet("Loan schedule", [
      ["LOANS · LENDER STATEMENT BASIS · INR"],
      ["Report date", end],
      [
        "Facility",
        "Lender",
        "Ledger",
        "Statement as of",
        "Principal outstanding",
        "Interest due",
        "EMI",
        "Next due",
      ],
      ...summary.loans.map((l) => [
        l.facility,
        l.lender,
        l.account_code,
        l.as_of,
        amount(l.principal),
        amount(l.interest_due),
        amount(l.emi),
        l.next_due ?? "",
      ]),
    ]);
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="DropX-draft-provisional-${end}.xlsx"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error(
      "Finance accounting export failed",
      error instanceof Error ? error.message : "Unknown",
    );
    return new NextResponse(
      "Unable to generate the accounting report. Please retry.",
      { status: 500 },
    );
  }
}
