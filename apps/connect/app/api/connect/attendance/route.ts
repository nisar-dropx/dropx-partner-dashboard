import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";

const dashboardUrl =
  process.env.DASHBOARD_URL?.replace(/\/$/, "") ||
  "https://dashboard.dropxlogistics.com";

export async function GET(request: NextRequest) {
  try {
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
    const target = new URL("/api/connect/attendance", dashboardUrl);
    request.nextUrl.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    const response = await fetch(target, {
      cache: "no-store",
      headers: { cookie: request.headers.get("cookie") ?? "" }
    });
    const raw = await response.text();
    if (!response.ok || !supabaseAdmin) return new NextResponse(raw, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
    });
    const payload = JSON.parse(raw) as { rows?: Array<Record<string, unknown>> };
    const leaveTypes = await supabaseAdmin.from("hr_leave_types")
      .select("attendance_code,attendance_label,is_paid")
      .eq("company_id", account.companyId);
    if (leaveTypes.error) throw new Error(leaveTypes.error.message);
    const labels = new Map((leaveTypes.data ?? []).map((type) => [type.attendance_code, type]));
    payload.rows = (payload.rows ?? []).map((row) => {
      const configured = labels.get(String(row.status ?? ""));
      return {
        ...row,
        statusLabel: configured?.attendance_label ?? row.statusLabel ?? null,
        statusKind: configured ? "leave" : row.statusKind ?? "attendance",
        isPaidLeave: configured?.is_paid ?? null
      };
    });
    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load attendance." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  const target = new URL("/api/connect/attendance", dashboardUrl);
  const contentType = request.headers.get("content-type") ?? "";
  const response = await fetch(target, {
    method: "POST",
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      ...(contentType ? { "content-type": contentType } : {})
    },
    body: await request.arrayBuffer()
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}
