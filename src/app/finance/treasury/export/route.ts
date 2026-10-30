import { booksContext, period } from "@/lib/finance360/server";
import { loadTreasury } from "@/lib/finance/treasury/data";
import { outcomes } from "@/lib/finance/treasury/model";
import { csvCell } from "@/lib/finance360/model";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const ctx = await booksContext();
  const { start, end } = period(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  try {
    const data = await loadTreasury(ctx);
    const rows: unknown[][] = [
      [
        "Date",
        "Bank ledger",
        "UTR",
        "Narration",
        "Debit",
        "Credit",
        "Outcome",
        "Source",
        "Payout reference",
        "Expected amount",
        "Difference",
        "Books matched",
      ],
    ];
    for (const f of data.findings.filter(
      (f) => f.bank.date >= start && f.bank.date <= end,
    ))
      rows.push([
        f.bank.date,
        f.bank.account_code,
        f.bank.reference,
        f.bank.description,
        f.bank.debit,
        f.bank.credit,
        outcomes[f.outcome],
        f.payout?.source,
        f.payout?.reference,
        f.payout?.amount,
        f.difference,
        f.bank.matched_line_id ? "Yes" : "No",
      ]);
    return new Response(
      "\ufeff" +
        rows
          .map((r) =>
            r
              .map((v) =>
                csvCell(
                  typeof v === "string" && /^\s*[=+\-@]/.test(v) ? "'" + v : v,
                ),
              )
              .join(","),
          )
          .join("\r\n"),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="fin-reconciliation-${start}-${end}.csv"`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch {
    return Response.json(
      {
        error:
          "Reconciliation export unavailable. No partial file has been generated.",
      },
      { status: 503 },
    );
  }
}
