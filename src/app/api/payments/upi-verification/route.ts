import { NextRequest, NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { callVerificationProvider } from "@/lib/verification-api-audit";

const IDSPAY_BASE_URL = "https://javabackend.idspay.in/api/v1/prod";
const IDSPAY_UPI_ENDPOINT = process.env.IDSPAY_UPI_VERIFICATION_ENDPOINT || "/srv2/upi-verification/simple";

type IdspayUpiResponse = {
  status?: { code?: unknown; type?: unknown; message?: unknown };
  message?: unknown;
  data?: {
    vpa_details?: { vpa?: unknown; account_holder_name?: unknown };
    result_code?: unknown;
    message?: unknown;
  };
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

async function idspayCredentials(companyId: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const settings = await supabaseAdmin
    .from("verification_api_settings")
    .select("api_id, is_enabled")
    .eq("company_id", companyId)
    .eq("provider_code", "idspay")
    .maybeSingle();
  if (settings.error) throw new Error(settings.error.message);
  if (!settings.data?.is_enabled) throw new Error("IDSPAY verification API is not enabled.");

  const [apiKey, tokenId] = await Promise.all([
    supabaseAdmin.rpc("get_verification_api_secret", { company_uuid: companyId, provider: "idspay", secret_kind: "api_key" }),
    supabaseAdmin.rpc("get_verification_api_secret", { company_uuid: companyId, provider: "idspay", secret_kind: "token_id" })
  ]);
  if (apiKey.error) throw new Error(apiKey.error.message);
  if (tokenId.error) throw new Error(tokenId.error.message);
  return { api_id: text(settings.data.api_id), api_key: text(apiKey.data), token_id: text(tokenId.data) };
}

export async function POST(request: NextRequest) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login required." }, { status: 401 });
    if (!hasPermission(authorization, "payment_requests", "add")) {
      return NextResponse.json({ error: "Permission required." }, { status: 403 });
    }

    const companyId = requireCompanyId(authorization);
    const payload = await request.json();
    const upiId = text(payload.upiId).toLowerCase();
    const contactNo = text(payload.contactNo);
    const email = text(payload.email).toLowerCase();
    if (!/^[a-z0-9._-]{2,256}@[a-z0-9.-]{2,64}$/i.test(upiId)) throw new Error("Invalid UPI ID.");

    const existing = await supabaseAdmin
      .from("payment_contacts")
      .select("id, account_holder_name")
      .eq("company_id", companyId)
      .ilike("upi_id", upiId)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      return NextResponse.json({
        verified: true,
        accountHolderName: existing.data.account_holder_name,
        message: "UPI ID verified.",
        source: "contact"
      });
    }

    const credentials = await idspayCredentials(companyId);
    const { response, body } = await callVerificationProvider({
      accountCode: authorization.email,
      actorLabel: authorization.fullName ?? authorization.email ?? "Dashboard user",
      actorUserId: authorization.userId,
      baseUrl: IDSPAY_BASE_URL,
      companyId,
      endpoint: IDSPAY_UPI_ENDPOINT,
      payload: { ...credentials, upi_id: upiId },
      profileName: authorization.fullName,
      profileType: "payment_contact",
      providerCode: "idspay",
      source: "dashboard",
      verificationKind: "upi"
    });
    const providerBody = body as IdspayUpiResponse;
    const details = providerBody?.data?.vpa_details;
    const message = text(providerBody?.message || providerBody?.status?.message || providerBody?.data?.message);
    const returnedUpiId = text(details?.vpa).toLowerCase();
    const accountHolderName = text(details?.account_holder_name);
    const verified = message.toLowerCase() === "vpa found" && returnedUpiId === upiId && Boolean(accountHolderName);
    if (!response.ok || !verified) {
      return NextResponse.json({ verified: false, error: message || "UPI ID verification failed." }, { status: 422 });
    }

    const now = new Date().toISOString();
    const contactWrite = await supabaseAdmin.from("payment_contacts").insert({
      company_id: companyId,
      contact_no: contactNo || null,
      email: email || null,
      upi_id: upiId,
      account_holder_name: accountHolderName,
      provider_code: "idspay",
      verified_at: now,
      verification_details: providerBody,
      created_by: authorization.userId,
      updated_at: now
    });
    if (contactWrite.error && !contactWrite.error.message.toLowerCase().includes("duplicate")) {
      throw new Error(contactWrite.error.message);
    }

    return NextResponse.json({ verified: true, accountHolderName, message: "UPI ID verified.", source: "api" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify UPI ID." }, { status: 400 });
  }
}
