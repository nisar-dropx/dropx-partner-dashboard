import { NextResponse } from "next/server";
import { requireConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { canViewInterimSalary } from "@/lib/interim-salary";
import { loadInterimSalaries } from "@/lib/interim-salary-data";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const profileType = url.searchParams.get("profileType");
  if (profileType !== "employee" && profileType !== "contractor") return NextResponse.json({ error: "Salary is available only in your People workspace." }, { status: 403, headers });
  let account;
  try { account = await requireConnectAccount(profileType, url.searchParams.get("accountId") ?? ""); }
  catch { return NextResponse.json({ error: "This salary account is unavailable. Please sign in again." }, { status: 403, headers }); }
  if (!canViewInterimSalary(account)) return NextResponse.json({ error: "Salary is unavailable for this workspace." }, { status: 403, headers });
  try {
    if (!supabaseAdmin) throw new Error("Database unavailable");
    const salaries = await loadInterimSalaries(supabaseAdmin, account);
    return NextResponse.json({ salaries }, { headers });
  } catch {
    return NextResponse.json({ error: "Unable to load salary details. Please retry." }, { status: 503, headers });
  }
}
