import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const value = (input: unknown) => Number(input ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (input: string | null) => input ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${input}T00:00:00`)) : "—";
const safe = (input: unknown) => String(input ?? "").replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] ?? character));

export async function GET(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Payment statements are unavailable right now.");
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") as "workforce";
    const statementId = request.nextUrl.searchParams.get("statementId") ?? "";
    const account = await requireConnectAccount(profileType, accountId);
    if (account.workspace !== "workforce" || account.profileType !== "workforce") throw new Error("This statement is only available in the Workforce workspace.");
    const item = await supabaseAdmin.from("workforce_payroll_items")
      .select("id,payroll_run_id,worker_name,dropx_id,station_code,shipment_count,work_days,base_amount,incentive_amount,adjustment_amount,deduction_amount,gross_amount,net_amount,workforce_payroll_runs!inner(run_number,period_start,period_end,status,payment_reference,payment_date,paid_at)")
      .eq("company_id", account.companyId).eq("workforce_id", account.id).eq("id", statementId).maybeSingle();
    if (item.error) throw new Error("Unable to open this payment statement.");
    if (!item.data) return new NextResponse("Statement not found", { status: 404 });
    const run = Array.isArray(item.data.workforce_payroll_runs) ? item.data.workforce_payroll_runs[0] : item.data.workforce_payroll_runs;
    if (!run || !["approved", "paid"].includes(String(run.status))) return new NextResponse("Statement is not published", { status: 403 });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>DropX payment statement</title><style>body{font:14px Arial,sans-serif;color:#172033;margin:40px;max-width:760px}header{display:flex;justify-content:space-between;border-bottom:3px solid #f65d2d;padding-bottom:20px}h1{margin:0;font-size:28px}small{color:#667085}table{width:100%;border-collapse:collapse;margin-top:28px}td{padding:12px;border-bottom:1px solid #e5e7eb}td:last-child{text-align:right;font-weight:600}.total td{font-size:18px;font-weight:800;border-top:2px solid #172033}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:26px 0}.meta div{background:#f7f8fb;padding:12px;border-radius:8px}.meta b{display:block;margin-top:4px}@media print{body{margin:20px}.no-print{display:none}}</style></head><body><header><div><small>DROPX ONE · PAYMENT STATEMENT</small><h1>${safe(run.run_number)}</h1></div><div><strong>${safe(item.data.worker_name)}</strong><br><small>${safe(item.data.dropx_id)} · ${safe(item.data.station_code || "Station pending")}</small></div></header><section class="meta"><div><small>Payment period</small><b>${date(run.period_start)} – ${date(run.period_end)}</b></div><div><small>Payment status</small><b>${String(run.status) === "paid" ? `Paid · ${date(run.payment_date ?? run.paid_at)}` : "Approved for payment"}</b></div><div><small>Shipments</small><b>${Number(item.data.shipment_count ?? 0).toLocaleString("en-IN")} · ${Number(item.data.work_days ?? 0)} active days</b></div><div><small>Payment reference</small><b>${safe(run.payment_reference || "Will appear after disbursal")}</b></div></section><table><tbody><tr><td>Base earnings</td><td>₹${value(item.data.base_amount)}</td></tr><tr><td>Incentives</td><td>₹${value(item.data.incentive_amount)}</td></tr><tr><td>Adjustments</td><td>₹${value(item.data.adjustment_amount)}</td></tr><tr><td>Deductions</td><td>−₹${value(item.data.deduction_amount)}</td></tr><tr><td>Gross amount</td><td>₹${value(item.data.gross_amount)}</td></tr><tr class="total"><td>Net payment</td><td>₹${value(item.data.net_amount)}</td></tr></tbody></table><p class="no-print"><button onclick="window.print()">Save as PDF</button></p><small>This is a system-generated payment statement. Live earnings are estimates until a payment cycle is approved.</small></body></html>`;
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Unable to open payment statement.", { status: 400 });
  }
}
