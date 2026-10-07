import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { loadBetaStationSupport } from "@/lib/beta-station-support";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  try {
    const account = await requireConnectAccount(request.nextUrl.searchParams.get("profileType") as ConnectAccount["profileType"], request.nextUrl.searchParams.get("accountId") ?? "", { allowActivationOnly: true });
    if (!account.onboardingBeta || !account.activationStage?.startsWith("amazon_email_pilot:") || account.workspace !== "workforce") {
      return NextResponse.json({ error: "This contact is available only during private beta onboarding." }, { status: 403, headers });
    }
    if (!supabaseAdmin) throw new Error("Contact unavailable.");
    return NextResponse.json(await loadBetaStationSupport(supabaseAdmin, account.companyId, account.id), { headers });
  } catch {
    return NextResponse.json({ error: "We couldn’t load your station contact. Please try again." }, { status: 400, headers });
  }
}
