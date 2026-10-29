import * as XLSX from "xlsx";
import { getAuthorization } from "@/lib/authorization";
import { loadLossDebits } from "@/lib/ops-pulse/loss-debit-data";
import {
  filterLossDebits,
  summarizeLossDebits,
} from "@/lib/ops-pulse/loss-debit-review";
import { indiaMonth } from '@/lib/ops-pulse/loss-recovery-queue-policy';
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return new Response("Access denied", { status: 403 });
    const q = new URL(request.url).searchParams,
      f = {
        month: q.get("month") || "", salaryScope: q.get('salaryScope') || '', currentMonth: indiaMonth(),
        station: q.get("station") || "",
        person: q.get("person") || "",
        designation: q.get("designation") || "",
      };
    const all = await loadLossDebits(auth),
      rows = filterLossDebits(all, f),
      book = XLSX.utils.book_new();
    const add = (name: string, data: unknown[][]) => {
      const sheet = XLSX.utils.aoa_to_sheet(data);
      sheet["!cols"] = data[0].map(() => ({ wch: 24 }));
      XLSX.utils.book_append_sheet(book, sheet, name);
    };
    add("Station summary", [
      ["Station", "People", "Shipments", "Deducted", "Draft payroll"],
      ...summarizeLossDebits(rows, "station").map((g) => [
        g.label,
        g.people,
        g.shipments,
        g.deducted,
        g.draft,
      ]),
    ]);
    add("People", [
      ["Name", "Details", "Station", "Salary month", "Shipments", "Deducted", "Draft payroll"],
      ...summarizeLossDebits(rows, "person_month").map((g) => [
        g.label,
        g.detail, g.stations, g.payrollMonth,
        g.shipments,
        g.deducted,
        g.draft,
      ]),
    ]);
    add("Shipment details", [
      [
        "Station",
        "Employee ID",
        "Name",
        "Designation",
        "Shipment ID",
        "Loss month",
        "Salary month",
        "Amount",
        "Status",
      ],
      ...rows.map((r) => [
        r.station_code,
        r.employee_code,
        r.full_name,
        r.designation,
        r.shipment_id || r.case_key.replace(/^slp:/, ""),
        r.loss_month,
        r.payroll_month,
        r.amount,
        r.is_deducted ? "Deducted" : "Draft payroll",
      ]),
    ]);
    add("Monthly history", [
      ["Payroll month", "People", "Shipments", "Deducted", "Draft payroll"],
      ...summarizeLossDebits(
        filterLossDebits(all, { ...f, month: "", salaryScope: '' }),
        "month",
      ).map((g) => [g.key, g.people, g.shipments, g.deducted, g.draft]),
    ]);
    return new Response(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
      {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition":
            'attachment; filename="OpsPulse-Recovery.xlsx"',
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Export failed" },
      { status: 403 },
    );
  }
}
