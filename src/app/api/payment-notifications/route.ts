import { NextResponse } from "next/server";
import { getAuthorization } from "@/lib/authorization";
import { emptyPaymentNotificationSnapshot, loadPaymentNotificationSnapshot } from "@/lib/payment-notification-counts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
  const authorization = await getAuthorization();
  if (!authorization) {
    return NextResponse.json(emptyPaymentNotificationSnapshot(), { status: 401 });
  }

  const snapshot = await loadPaymentNotificationSnapshot(authorization);
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Notifications are temporarily unavailable. Please retry." }, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "private, no-store" } });
  }
}
