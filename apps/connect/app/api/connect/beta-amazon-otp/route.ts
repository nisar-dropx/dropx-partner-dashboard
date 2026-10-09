import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { isIsolatedAmazonOtpAccount, latestAmazonOtp } from "@/lib/beta-amazon-otp";
import { betaJourney } from "@/lib/beta-journey";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie" };

// Read-only inbox projection. No Amazon resend, account creation, or canonical writes.
export async function GET(request: NextRequest) {
  let account: ConnectAccount;
  try {
    account = await requireConnectAccount(
      request.nextUrl.searchParams.get("profileType") as ConnectAccount["profileType"],
      request.nextUrl.searchParams.get("accountId") ?? "", { allowActivationOnly: true }
    );
  } catch {
    return NextResponse.json({ error: "Sign in to your beta account to check the code." }, { status: 401, headers });
  }
  if (!isIsolatedAmazonOtpAccount(account)) {
    return NextResponse.json({ error: "This inbox is only available to its beta candidate." }, { status: 403, headers });
  }
  try {
    if (!supabaseAdmin) throw new Error("Inbox unavailable");
    const db = supabaseAdmin;
    const [candidate, registration] = await Promise.all([
      db.from("workforce_amazon_email_pilot_candidates").select("id,continuation_status")
        .eq("company_id", account.companyId).eq("id", account.id).is("closed_at", null).maybeSingle(),
      db.from("workforce_amazon_email_pilot_registrations").select("status")
        .eq("company_id", account.companyId).eq("candidate_id", account.id).maybeSingle()
    ]);
    if (candidate.error || registration.error) throw new Error("Inbox unavailable");
    if (!candidate.data || !betaJourney({ continuationStatus: candidate.data.continuation_status,
      registrationStatus: registration.data?.status }).invitationUnlocked) {
      return NextResponse.json({ error: "Complete your beta DropX registration before opening this inbox." }, { status: 403, headers });
    }
    const messages = await db.from("workforce_amazon_email_pilot_messages")
      .select("id,sender,subject,preview,received_at")
      .eq("company_id", account.companyId).eq("candidate_id", account.id)
      .gte("received_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("received_at", { ascending: false }).limit(100);
    if (messages.error) throw new Error("Inbox unavailable");
    return NextResponse.json({ latest: latestAmazonOtp(messages.data ?? []), checkedAt: new Date().toISOString() }, { headers });
  } catch {
    return NextResponse.json({ error: "We could not check your inbox. Please try again." }, { status: 503, headers });
  }
}
