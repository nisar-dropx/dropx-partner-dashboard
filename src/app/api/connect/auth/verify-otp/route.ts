import { NextResponse } from "next/server";
import { normalizeMobile, verifyOtpHash } from "@/lib/connect-otp";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AccountRow = {
  id: string;
  company_id: string;
  full_name: string | null;
  email?: string | null;
  employee_id?: string | null;
  dropx_id?: string | null;
  role?: string | null;
  profile_type: "user" | "field_executive";
};

type ProfileMatchResult = {
  data: Array<{
    id: string;
    company_id: string;
    full_name: string | null;
    email?: string | null;
    employee_id?: string | null;
    role?: string | null;
  }> | null;
  error: { message?: string } | null;
};

type ExecutiveMatchResult = {
  data: Array<{
    id: string;
    company_id: string;
    full_name: string | null;
    email?: string | null;
    dropx_id?: string | null;
    designation?: string | null;
  }> | null;
  error: { message?: string } | null;
};

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

function accountLabel(account: AccountRow, companyNameById: Map<string, string>) {
  const companyName = companyNameById.get(account.company_id) ?? "Company";
  const id = account.employee_id || account.dropx_id || account.email || "";
  return [companyName, account.full_name, id].filter(Boolean).join(" - ");
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

export async function POST(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const body = await request.json().catch(() => ({})) as { mobile?: unknown; countryCode?: unknown; otp?: unknown };
    const countryCode = String(body.countryCode ?? "91").replace(/\D/g, "") || "91";
    const mobile = normalizeMobile(body.mobile, countryCode);
    const otp = String(body.otp ?? "").replace(/\D/g, "");
    if (!mobile || mobile.length < 11) {
      return NextResponse.json({ error: "Enter a valid mobile number." }, { status: 400 });
    }
    if (!/^\d{6}$/.test(otp)) {
      return NextResponse.json({ error: "Enter the 6 digit OTP." }, { status: 400 });
    }

    const otpResult = await supabaseAdmin
      .from("connect_whatsapp_otp_requests")
      .select("id, company_id, otp_hash, expires_at, used_at, attempt_count, max_attempts, status")
      .eq("purpose", "connect_login")
      .eq("country_code", countryCode)
      .eq("mobile_number", mobile)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (otpResult.error) throw new Error(otpResult.error.message);
    const otpRow = otpResult.data;
    if (!otpRow) {
      return NextResponse.json({ error: "OTP not found or already used. Please resend OTP." }, { status: 400 });
    }
    if (otpRow.used_at) {
      return NextResponse.json({ error: "OTP already used. Please resend OTP." }, { status: 400 });
    }
    if (new Date(otpRow.expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        status: "expired",
        updated_at: new Date().toISOString(),
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent")
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "OTP expired. Please resend OTP." }, { status: 400 });
    }
    if (otpRow.attempt_count >= otpRow.max_attempts) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        status: "failed",
        updated_at: new Date().toISOString()
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Too many attempts. Please resend OTP." }, { status: 429 });
    }

    const isValid = verifyOtpHash(otp, otpRow.otp_hash);
    if (!isValid) {
      await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
        attempt_count: otpRow.attempt_count + 1,
        updated_at: new Date().toISOString(),
        request_ip: requestIp(request),
        user_agent: request.headers.get("user-agent")
      }).eq("id", otpRow.id);
      return NextResponse.json({ error: "Invalid OTP." }, { status: 400 });
    }

    await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
      status: "verified",
      used_at: new Date().toISOString(),
      attempt_count: otpRow.attempt_count + 1,
      updated_at: new Date().toISOString(),
      request_ip: requestIp(request),
      user_agent: request.headers.get("user-agent")
    }).eq("id", otpRow.id);

    const localMobile = mobile.startsWith(countryCode) ? mobile.slice(countryCode.length) : mobile;
    let [profilesResult, executivesResult]: [ProfileMatchResult, ExecutiveMatchResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, company_id, full_name, email, employee_id, role, is_active, mobile_country_code")
        .eq("is_active", true)
        .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
      supabaseAdmin
        .from("workforce")
        .select("id, company_id, full_name, email, dropx_id, designation, is_active, mobile_country_code")
        .eq("is_active", true)
        .or(`mobile_country_code.eq.${countryCode},mobile_country_code.is.null`)
        .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
    ]);
    if (isMissingColumnError(profilesResult.error) || isMissingColumnError(executivesResult.error)) {
      [profilesResult, executivesResult] = await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("id, company_id, full_name, email, employee_id, role, is_active")
          .eq("is_active", true)
          .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`),
        supabaseAdmin
          .from("workforce")
          .select("id, company_id, full_name, email, dropx_id, designation, is_active")
          .eq("is_active", true)
          .or(`mobile.eq.${mobile},mobile.eq.${localMobile}`)
      ]);
    }
    if (profilesResult.error) throw new Error(profilesResult.error.message);
    if (executivesResult.error) throw new Error(executivesResult.error.message);

    const accounts: AccountRow[] = [
      ...((profilesResult.data ?? []).map((profile) => ({
        id: profile.id,
        company_id: profile.company_id,
        full_name: profile.full_name,
        email: profile.email,
        employee_id: profile.employee_id,
        role: profile.role,
        profile_type: "user" as const
      }))),
      ...((executivesResult.data ?? []).map((executive) => ({
        id: executive.id,
        company_id: executive.company_id,
        full_name: executive.full_name,
        email: executive.email,
        dropx_id: executive.dropx_id,
        role: executive.designation,
        profile_type: "field_executive" as const
      })))
    ].filter((account) => account.company_id);

    const companyIds = Array.from(new Set(accounts.map((account) => account.company_id)));
    const companiesResult = companyIds.length
      ? await supabaseAdmin.from("companies").select("id, name, code").in("id", companyIds).eq("is_active", true)
      : { data: [], error: null };
    if (companiesResult.error) throw new Error(companiesResult.error.message);
    const companyNameById = new Map((companiesResult.data ?? []).map((company) => [company.id, company.name || company.code || "Company"]));

    return NextResponse.json({
      ok: true,
      accounts: accounts
        .filter((account) => companyNameById.has(account.company_id))
        .map((account) => ({
          id: account.id,
          companyId: account.company_id,
          profileType: account.profile_type,
          name: account.full_name,
          email: account.email ?? null,
          reference: account.employee_id || account.dropx_id || null,
          role: account.role ?? null,
          companyName: companyNameById.get(account.company_id),
          label: accountLabel(account, companyNameById)
        }))
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to verify OTP." }, { status: 500 });
  }
}
