import "server-only";
import { redirect } from "next/navigation";
import { financeContext } from "@/lib/finance/data";
import { hasPermission } from "@/lib/authorization";
import { date, type TrialRow } from "./model";

export async function booksContext(write?: "add" | "edit") {
  const ctx = await financeContext("finance_books");
  if (!ctx.authorization.hasAllLocationAccess)
    redirect("/unauthorized?page=finance_books_company_scope");
  if (write && !hasPermission(ctx.authorization, "finance_books", write))
    throw new Error("Your role cannot make this accounting change.");
  return ctx;
}
export async function trialBalance(
  ctx: Awaited<ReturnType<typeof booksContext>>,
  start: string,
  end: string,
) {
  date(start);
  date(end);
  if (start > end)
    throw new Error("Period start must be on or before the report date.");
  const rows: TrialRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await ctx.db
      .rpc("finance360_trial", {
        p_company: ctx.companyId,
        p_start: start,
        p_end: end,
      })
      .range(offset, offset + 999);
    if (r.error)
      throw new Error(
        "Unable to load the accounting trial balance. Please retry.",
      );
    rows.push(...(r.data as TrialRow[]));
    if (r.data.length < 1000) break;
  }
  return rows;
}
export function period(params: Record<string, string | undefined>) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  let end = today;
  try {
    if (params.end) end = date(params.end);
  } catch {
    /* use today for invalid URL values */
  }
  let start = `${Number(end.slice(0, 4)) - (Number(end.slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
  try {
    if (params.start && date(params.start) <= end) start = params.start;
  } catch {
    /* use fiscal year */
  }
  return { start, end };
}
