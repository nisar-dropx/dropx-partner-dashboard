import { NextRequest, NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { callVerificationProvider } from "@/lib/verification-api-audit";

const IDSPAY_BASE_URL = "https://javabackend.idspay.in/api/v1/prod";

type IdspayBankResponse = {
  data?: {
    beneValidationResp?: {
      metaData?: { status?: unknown };
      resourceData?: { creditorName?: unknown };
    };
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
  return {
    api_id: text(settings.data.api_id),
    api_key: text(apiKey.data),
    token_id: text(tokenId.data)
  };
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
    const bankAccountNo = text(payload.bankAccountNo).toUpperCase();
    const ifsc = text(payload.ifsc).toUpperCase();
    const contactNo = text(payload.contactNo);
    const email = text(payload.email).toLowerCase();
    if (!/^[A-Z0-9]{4,30}$/.test(bankAccountNo)) throw new Error("Invalid bank account number.");
    if (!/^[A-Z0-9]{11}$/.test(ifsc)) throw new Error("Invalid IFSC.");

    const existing = await supabaseAdmin
      .from("payment_contacts")
      .select("id, account_holder_name")
      .eq("company_id", companyId)
      .eq("created_by", authorization.userId)
      .ilike("bank_account_no", bankAccountNo)
      .ilike("ifsc", ifsc)
      .maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) {
      return NextResponse.json({
        verified: true,
        accountHolderName: existing.data.account_holder_name,
        message: "Bank account verified.",
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
      endpoint: "/idfc/beneficiary",
      payload: { ...credentials, creditorAccountId: bankAccountNo, ifscCode: ifsc },
      profileName: authorization.fullName,
      profileType: "payment_contact",
      providerCode: "idspay",
      source: "dashboard",
      verificationKind: "bank"
    });
    const providerBody = body as IdspayBankResponse;
    const validation = providerBody?.data?.beneValidationResp ?? {};
    const verified = text(validation?.metaData?.status).toUpperCase() === "SUCCESS";
    const accountHolderName = text(validation?.resourceData?.creditorName);
    if (!response.ok || !verified || !accountHolderName) {
      return NextResponse.json({ verified: false, error: "Bank verification failed." }, { status: 422 });
    }

    const contactWrite = await supabaseAdmin.from("payment_contacts").insert({
      company_id: companyId,
      contact_no: contactNo || null,
      email: email || null,
      bank_account_no: bankAccountNo,
      ifsc,
      account_holder_name: accountHolderName,
      provider_code: "idspay",
      verified_at: new Date().toISOString(),
      verification_details: providerBody,
      created_by: authorization.userId,
      updated_at: new Date().toISOString()
    });
    if (contactWrite.error && !contactWrite.error.message.toLowerCase().includes("duplicate")) {
      throw new Error(contactWrite.error.message);
    }

    return NextResponse.json({ verified: true, accountHolderName, message: "Bank account verified.", source: "api" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify bank account." }, { status: 400 });
  }
}
