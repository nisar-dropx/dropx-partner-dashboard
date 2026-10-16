import { NextResponse } from "next/server";
import {
  activateConnectSession,
  ConnectCredentialError,
  findConnectAccounts,
  normalizeConnectMobile,
  revokeIssuedConnectSession,
  sameConnectAccountIdentitySet,
  setConnectPinWithOtp
} from "@/lib/connect-auth";
import { ConnectMobileValidationError } from "@/lib/country-codes";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown; otp?: unknown; pin?: unknown };
    const { countryCode, mobile } = normalizeConnectMobile(body.mobile, body.countryCode);
    const otp = String(body.otp ?? "").replace(/\D/g, "");
    const pin = String(body.pin ?? "").replace(/\D/g, "");
    if (!mobile || mobile.length < 7) return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    if (!/^\d{6}$/.test(otp)) return NextResponse.json({ error: "Enter the 6 digit OTP." }, { status: 400 });
    if (!/^\d{6}$/.test(pin)) return NextResponse.json({ error: "Create a 6 digit PIN." }, { status: 400 });

    const accounts = await findConnectAccounts(countryCode, mobile);
    if (!accounts.length) {
      return NextResponse.json({
        error: "You don't have access to DropX Connect. Contact HR or your platform administrator for access."
      }, { status: 403 });
    }
    const session = await setConnectPinWithOtp({ countryCode, mobile, otp, pin, request });
    let freshAccounts: typeof accounts;
    try {
      freshAccounts = await findConnectAccounts(countryCode, mobile, { fresh: true });
      if (!freshAccounts.length || !sameConnectAccountIdentitySet(accounts, freshAccounts)) {
        throw new ConnectCredentialError("Authentication state changed. Please try again.", 409);
      }
    } catch (error) {
      await revokeIssuedConnectSession(session);
      throw error;
    }
    activateConnectSession(session);
    return NextResponse.json({ ok: true, accounts: freshAccounts });
  } catch (error) {
    if (error instanceof ConnectMobileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConnectCredentialError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create PIN." }, { status: 500 });
  }
}
