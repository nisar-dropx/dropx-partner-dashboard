import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { ALL_SNAPSHOTS, loadPotentialLossRows } from "@/lib/ops-pulse/loss-reports";
export const dynamic = "force-dynamic";

/** Potential Package Loss as Amazon sent it (every original column), scoped to the user's stations. */
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_losses", "access"))
    return Response.json({ error: "Access denied." }, { status: 403 });
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "csv" ? "csv" : "xlsx";
  const raw = url.searchParams.get("period") ?? "";
  const period = raw === ALL_SNAPSHOTS || !/^\d{4}-\d{2}-\d{2}$/.test(raw) ? null : raw;
  try {
    const { headers, rows } = await loadPotentialLossRows(auth, period);
    // Older snapshots may carry columns the newest file dropped; keep them all, newest layout first.
    const columns = [...new Set([...headers, ...rows.flatMap((r) => Object.keys(r.extra ?? {}))])];
    const aoa = [
      ["Snapshot", ...columns],
      ...rows.map((r) => [r.period ?? "", ...columns.map((c) => r.extra?.[c] ?? "")]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    const name = `potential-package-loss-${period ?? "all"}`;
    const noStore = { "Cache-Control": "private, no-store" };
    if (format === "csv")
      return new Response("﻿" + XLSX.utils.sheet_to_csv(sheet), {
        headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}.csv"` },
      });
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Potential loss");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new Response(new Uint8Array(bytes), {
      headers: {
        ...noStore,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${name}.xlsx"`,
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Download failed." }, { status: 500 });
  }
}
