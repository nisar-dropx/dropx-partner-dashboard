import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import { loadConnectReturnedRosterEditor, updateConnectReturnedRosterCell } from "../../../../src/lib/connect-manager-approvals";

function clean(value: unknown) { return String(value ?? "").trim(); }

async function selectedAccount(request: Request, body?: Record<string, unknown>) {
  const url = new URL(request.url);
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  if (profileType !== "user" && profileType !== "employee" && profileType !== "contractor") throw new Error("Returned roster editing is not available for this account.");
  return requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
}

export async function GET(request: Request) {
  try {
    const account = await selectedAccount(request);
    const planId = clean(new URL(request.url).searchParams.get("planId"));
    const editor = await loadConnectReturnedRosterEditor(account, planId);
    return NextResponse.json(editor, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load returned roster." }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const account = await selectedAccount(request, body);
    const notice = await updateConnectReturnedRosterCell(account, body);
    return NextResponse.json({ ok: true, notice });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update roster cell." }, { status: 400 });
  }
}
