import * as XLSX from "xlsx";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { lossSchemaReady, nlStationScope } from "@/lib/ops-pulse/nl-loss";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
const reply = (error: string, status: number) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });

/** What the Cloak desk still has to file: every request stations have sent for the month. */
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "ops_loss_master", "edit") || !supabaseAdmin)
    return reply("Loss Recovery Master edit access is required.", 403);
  const month = new URL(request.url).searchParams.get("month") || "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !(await lossSchemaReady()))
    return reply("Invalid month.", 400);
  try {
    const scope = await nlStationScope(auth);
    const requests = await readAllRows(
      supabaseAdmin
        .from("nl_dispute_requests")
        .select("*")
        .eq("company_id", scope.company)
        .eq("month", month)
        .eq("status", "submitted")
        .order("case_key"),
    );
    if (requests.error) throw Error();
    const keys = (requests.data ?? []).map((r) => r.case_key as string);
    const cases = new Map<string, { station_code: string; amount: number; tid: string | null; reason: string | null; filed: string | null; stage: string | null }>();
    for (let i = 0; i < keys.length; i += 150) {
      const rows = await supabaseAdmin
        .from("nl_loss_month_cases")
        .select("case_key,station_code,amount,tid:details->>tid,reason:details->>category,filed:details->extra->>dispute_selected,stage:details->extra->>current_sla_stage")
        .eq("company_id", scope.company)
        .eq("month", month)
        .in("case_key", keys.slice(i, i + 150));
      if (rows.error) throw Error();
      for (const r of rows.data ?? []) cases.set(r.case_key, r);
    }
    const stations = new Map(scope.stations.map((s) => [s.source_code, s.station_code]));
    const origin = new URL(request.url).origin;
    const rows = (requests.data ?? [])
      // Out-of-scope stations are never exported. A decision already in Cloak means the request is filed,
      // except in eDSP2 where that decision is from the first round and a response is still owed.
      .filter((r) => {
        const c = cases.get(r.case_key);
        return !!c && stations.has(c.station_code) && (!c.filed || c.stage === "eDSP2");
      })
      .map((r) => {
        const c = cases.get(r.case_key)!;
        const files = (r.attachments ?? []) as { id: string; file_name: string }[];
        return [
          c.tid || r.case_key,
          stations.get(c.station_code),
          Number(c.amount),
          c.reason || "",
          c.stage || "",
          r.decision === "dispute" ? "YES" : "NO",
          r.reason,
          // Cloak has one remarks box; the CCTV link is filed inside it.
          [r.remarks, r.cctv_url].filter(Boolean).join("\n\n"),
          files
            .map((f) => `${origin}/api/ops-pulse/losses/recovery/attachments?purpose=dispute&month=${month}&case=${encodeURIComponent(r.case_key)}&id=${f.id}`)
            .join("\n"),
          r.updated_by_name,
          r.submitted_at ? new Date(r.submitted_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "",
        ];
      })
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])) || Number(b[2]) - Number(a[2]));
    const ws = XLSX.utils.aoa_to_sheet([
      ["TID", "Station", "Value", "Loss bucket", "Cloak stage", "Dispute (YES/NO)", "Dispute reason", "Partner remarks", "Proof files (sign in to OpsPulse)", "Sent by", "Sent at (IST)"],
      ...rows,
    ]);
    ws["!cols"] = [16, 9, 10, 26, 10, 14, 28, 70, 60, 22, 20].map((wch) => ({ wch }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, ws, "To file in Cloak");
    return new Response(XLSX.write(book, { type: "buffer", bookType: "xlsx" }), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="cloak-filing-queue-${month}.xlsx"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return reply("The filing queue could not be prepared. Please retry.", 500);
  }
}
