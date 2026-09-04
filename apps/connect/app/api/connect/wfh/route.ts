import { NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "../../../../src/lib/connect-auth";
import {
  cancelConnectWfhRequest,
  createConnectWfhRequest,
  listConnectWfhRequests,
  type WfhWorkerType
} from "../../../../src/lib/connect-wfh-data";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function workerType(profileType: string): WfhWorkerType | null {
  return profileType === "employee" || profileType === "contractor" ? profileType : null;
}

async function accountFromRequest(url: URL, body?: Record<string, unknown>) {
  const accountId = clean(body?.accountId ?? url.searchParams.get("accountId"));
  const profileType = clean(body?.profileType ?? url.searchParams.get("profileType"));
  if (!accountId || !profileType) throw new Error("Account is required.");
  const supportedType = workerType(profileType);
  if (!supportedType) throw new Error("Work from home is available for employees and independent contractors.");
  const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId);
  return { account, workerType: supportedType };
}

export async function GET(request: Request) {
  try {
    const { account, workerType: type } = await accountFromRequest(new URL(request.url));
    return NextResponse.json(await listConnectWfhRequests(account.companyId, account.id, type), {
      headers: { "Cache-Control": "private, no-store" }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load work from home." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const result = await createConnectWfhRequest({
      companyId: account.companyId,
      workerId: account.id,
      workerType: type,
      fromDate: clean(body.fromDate),
      toDate: clean(body.toDate),
      reason: clean(body.reason)
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to submit work from home." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const { account, workerType: type } = await accountFromRequest(new URL(request.url), body);
    const result = await cancelConnectWfhRequest({
      companyId: account.companyId,
      workerId: account.id,
      workerType: type,
      requestId: clean(body.requestId)
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to withdraw work from home." }, { status: 400 });
  }
}
