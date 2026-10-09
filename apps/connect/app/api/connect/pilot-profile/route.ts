import { betaJourney } from "@/lib/beta-journey";
import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectSessionCookieName, findConnectSessionAccounts } from "../../../../src/lib/connect-auth";
import { supabaseAdmin } from "../../../../src/lib/supabase-admin";
import { userFacingError } from "../../../../src/lib/user-facing-error";

const enabledFields = [
  "gender","date_of_birth","aadhaar_number","pan_number","address","state_code","pincode","landmark",
  "bank_account_no","ifsc","emergency_contact_number","emergency_contact_name","emergency_contact_relation",
  "aadhaar_front","aadhaar_back","pan_upload","profile_photo"
];
const requiredFields = [
  "date_of_birth","aadhaar_number","pan_number","address","state_code","pincode","bank_account_no","ifsc",
  "emergency_contact_number","emergency_contact_name","emergency_contact_relation","aadhaar_front","aadhaar_back",
  "pan_upload","profile_photo"
];

async function requirePilot(candidateId: string) {
  if (!supabaseAdmin) throw new Error("Registration is temporarily unavailable.");
  const token = cookies().get(connectSessionCookieName)?.value;
  if (!token) throw new Error("Connect session expired. Please log in again.");
  const sessionHash = createHash("sha256").update(token).digest("hex");
  const sessionResult = await supabaseAdmin.from("connect_login_sessions")
    .select("country_code,mobile_number,expires_at,revoked_at").eq("session_hash", sessionHash).maybeSingle();
  const session = sessionResult.data;
  if (sessionResult.error || !session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error("Connect session expired. Please log in again.");
  }
  const accounts = await findConnectSessionAccounts(session.country_code, session.mobile_number);
  const account = accounts.find(item => item.id === candidateId && item.onboardingBeta && item.activationStage?.startsWith("amazon_email_pilot:"));
  if (!account) throw new Error("Private beta profile is not available for this login.");
  return account;
}

export async function GET(request: Request) {
  try {
    if (!supabaseAdmin) throw new Error("Registration is temporarily unavailable.");
    const candidateId = new URL(request.url).searchParams.get("candidateId") ?? "";
    const account = await requirePilot(candidateId);
    const [candidate, registration] = await Promise.all([
      supabaseAdmin.from("workforce_amazon_email_pilot_candidates")
        .select("id,full_name,mobile,alias_email,biometric_id,reported_on,continuation_status,stations(station_code,station_name),designations(code,name)")
        .eq("company_id", account.companyId).eq("id", account.id).is("closed_at", null).maybeSingle(),
      supabaseAdmin.from("workforce_amazon_email_pilot_registrations")
        .select("status,return_note").eq("company_id", account.companyId).eq("candidate_id", account.id).maybeSingle()
    ]);
    if (candidate.error || !candidate.data) throw new Error("Private beta candidate was not found.");
    const station = Array.isArray(candidate.data.stations) ? candidate.data.stations[0] : candidate.data.stations;
    const designation = Array.isArray(candidate.data.designations) ? candidate.data.designations[0] : candidate.data.designations;
    return NextResponse.json({ ok: true, profile: {
      id: candidate.data.id,
      betaRegistrationReady: betaJourney({continuationStatus:candidate.data.continuation_status,registrationStatus:registration.data?.status}).ready,
      readOnly: {
        biometricId: candidate.data.biometric_id,
        fullName: candidate.data.full_name,
        email: candidate.data.alias_email,
        location: station?.station_code ?? station?.station_name ?? "-",
        designation: designation?.name ?? designation?.code ?? "-",
        dateOfJoin: candidate.data.reported_on,
        mobile: `+91 ${candidate.data.mobile}`
      },
      editable: {},
      statutoryApplicability: [],
      fieldRules: { enabled: enabledFields, required: requiredFields },
      uploads: { aadhaarFront:false,aadhaarBack:false,pan:false,dlFront:false,dlBack:false,photo:false },
      uploadUrls: {},
      status: registration.data?.status ?? "pending",
      returnRemarks: registration.data?.return_note ?? "",
      agreement: null
    }});
  } catch (error) {
    return NextResponse.json({ error: userFacingError(error, "Unable to load beta registration.") }, { status: 400 });
  }
}
