import { NextRequest, NextResponse } from "next/server";
import { requireConnectAccount, type ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { resolveConnectPreview } from "@/lib/connect-preview";
import { vehicleFuelTypeForClient } from "@/lib/vehicle-fuel";

const dashboardUrl =
  process.env.DASHBOARD_URL?.replace(/\/$/, "") ||
  "https://dashboard.dropxlogistics.com";

async function forward(request: NextRequest) {
  const target = new URL("/api/connect/verification", dashboardUrl);
  request.nextUrl.searchParams.forEach((value, key) =>
    target.searchParams.set(key, value)
  );
  const response = await fetch(target, {
    method: request.method,
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
      "content-type": request.headers.get("content-type") ?? "application/json"
    },
    body: request.method === "POST" ? await request.text() : undefined
  });
  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" }
  });
}

export async function GET(request: NextRequest) {
  // The dashboard proxy resolves only the actor's own login. A signed read-only
  // preview must instead use One's canonical, server-authorised target account.
  try {
    const preview = await resolveConnectPreview();
    if (!preview) return forward(request);
    const profileType = request.nextUrl.searchParams.get("profileType") ?? "";
    const accountId = request.nextUrl.searchParams.get("accountId") ?? "";
    const account = await requireConnectAccount(profileType as ConnectAccount["profileType"], accountId, { allowActivationOnly: true });
    if (!supabaseAdmin || account.companyId !== preview.companyId || account.id !== preview.id || account.profileType !== preview.profileType) {
      return NextResponse.json({ error: "Verification is unavailable for this preview." }, { status: 403 });
    }
    const result = await supabaseAdmin.from("connect_profile_verifications")
      .select("kind,input_key,verified,manual_review,block_submit,display_name,message,details,verified_at")
      .eq("company_id", account.companyId).eq("profile_type", account.profileType).eq("account_id", account.id);
    if (result.error) throw new Error("Unable to load profile checks. Please retry.");
    return NextResponse.json({ verifications: (result.data ?? []).map(row => {
      const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details as Record<string, unknown> : {};
      return { kind: row.kind, inputKey: row.input_key, verified: row.verified, manualReview: row.manual_review, blockSubmit: row.block_submit,
        name: row.display_name, message: row.message, details: row.details, verifiedAt: row.verified_at,
        fuelType: vehicleFuelTypeForClient(details.fuelType), expiryDate: String(details.expiryDate ?? ""),
        registrationExpiryDate: String(details.registrationExpiryDate ?? ""), insuranceExpiryDate: String(details.insuranceExpiryDate ?? ""), pollutionExpiryDate: String(details.pollutionExpiryDate ?? "") };
    }) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to load profile checks. Exit preview and try again." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
}
export const POST = forward;
