import { createHash, randomUUID } from "crypto";
import { cookies } from "next/headers";
import { supabaseAdmin } from "./supabase-admin";

export class ConnectCredentialError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type IssuedConnectSession = {
  id: string;
  token: string;
  expiresAt: Date;
};

function requestIp(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    null;
}

function secretHash(value: string) {
  const salt = randomUUID();
  const hash = createHash("sha256").update(`${salt}:${value}`).digest("hex");
  return `${salt}:${hash}`;
}

function verifySecretHash(value: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  return createHash("sha256").update(`${salt}:${value}`).digest("hex") === hash;
}

function missingCredentialRpc(error: unknown, rpcName: string) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes(rpcName.toLowerCase()) &&
    (message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find"));
}

function credentialError(code: unknown) {
  switch (code) {
    case "pin_setup_required":
      return new ConnectCredentialError("PIN not created. Please verify OTP and create a PIN.");
    case "pin_locked":
      return new ConnectCredentialError("PIN is temporarily locked. Please try later or reset PIN.", 429);
    case "invalid_pin":
      return new ConnectCredentialError("Invalid PIN.");
    case "otp_expired":
      return new ConnectCredentialError("OTP expired. Please resend OTP.");
    case "otp_locked":
      return new ConnectCredentialError("Too many attempts. Please resend OTP.", 429);
    case "invalid_otp":
      return new ConnectCredentialError("Invalid OTP.");
    case "otp_missing":
      return new ConnectCredentialError("OTP not found or already used. Please resend OTP.");
    default:
      return new ConnectCredentialError("Authentication state changed. Please try again.", 409);
  }
}

function pendingSession() {
  const id = randomUUID();
  const token = randomUUID() + randomUUID();
  return {
    id,
    token,
    sessionHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
  };
}

async function issueCredentialBoundSession(
  rpcName: "connect_authenticate_pin_and_create_session" | "connect_set_pin_and_create_session",
  args: Record<string, unknown>
) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const session = pendingSession();
  const result = await supabaseAdmin.rpc(rpcName, {
    ...args,
    p_session_id: session.id,
    p_session_hash: session.sessionHash,
    p_expires_at: session.expiresAt.toISOString()
  });
  if (result.error) {
    if (missingCredentialRpc(result.error, rpcName)) return null;
    throw new Error(result.error.message);
  }
  const outcome = result.data as { ok?: boolean; code?: string } | null;
  if (!outcome?.ok) throw credentialError(outcome?.code);
  return {
    id: session.id,
    token: session.token,
    expiresAt: session.expiresAt
  } satisfies IssuedConnectSession;
}

async function insertLegacySession({
  countryCode,
  mobile,
  request,
  session = pendingSession()
}: {
  countryCode: string;
  mobile: string;
  request: Request;
  session?: ReturnType<typeof pendingSession>;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const insertResult = await supabaseAdmin.from("connect_login_sessions").insert({
    id: session.id,
    country_code: countryCode,
    mobile_number: mobile,
    session_hash: session.sessionHash,
    expires_at: session.expiresAt.toISOString(),
    request_ip: requestIp(request),
    user_agent: request.headers.get("user-agent")
  });
  if (insertResult.error) throw new Error(insertResult.error.message);
  return { id: session.id, token: session.token, expiresAt: session.expiresAt } satisfies IssuedConnectSession;
}

async function authenticatePinLegacy({
  countryCode,
  mobile,
  pin,
  request
}: {
  countryCode: string;
  mobile: string;
  pin: string;
  request: Request;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const pinResult = await supabaseAdmin
    .from("connect_user_pins")
    .select("id, pin_hash, attempt_count, locked_until, reset_required")
    .eq("country_code", countryCode)
    .eq("mobile_number", mobile)
    .maybeSingle();
  if (pinResult.error) throw new Error(pinResult.error.message);
  const pinRow = pinResult.data;
  if (!pinRow || pinRow.reset_required) throw credentialError("pin_setup_required");
  if (pinRow.locked_until && new Date(pinRow.locked_until).getTime() > Date.now()) {
    throw credentialError("pin_locked");
  }
  if (!verifySecretHash(pin, pinRow.pin_hash)) {
    const attempts = (pinRow.attempt_count ?? 0) + 1;
    const updateResult = await supabaseAdmin.from("connect_user_pins").update({
      attempt_count: attempts,
      locked_until: attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null,
      updated_at: new Date().toISOString()
    }).eq("id", pinRow.id);
    if (updateResult.error) throw new Error(updateResult.error.message);
    throw credentialError(attempts >= 5 ? "pin_locked" : "invalid_pin");
  }
  const resetResult = await supabaseAdmin.from("connect_user_pins").update({
    attempt_count: 0,
    locked_until: null,
    updated_at: new Date().toISOString()
  }).eq("id", pinRow.id);
  if (resetResult.error) throw new Error(resetResult.error.message);
  return insertLegacySession({ countryCode, mobile, request });
}

async function setPinWithOtpLegacy({
  countryCode,
  mobile,
  otp,
  pin,
  request
}: {
  countryCode: string;
  mobile: string;
  otp: string;
  pin: string;
  request: Request;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const otpResult = await supabaseAdmin
    .from("connect_whatsapp_otp_requests")
    .select("id, otp_hash, expires_at, used_at, attempt_count, max_attempts, status")
    .eq("country_code", countryCode)
    .eq("mobile_number", mobile)
    .eq("status", "pending")
    .in("purpose", ["connect_login", "connect_pin_reset"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (otpResult.error) throw new Error(otpResult.error.message);
  const otpRow = otpResult.data;
  if (!otpRow || otpRow.used_at) throw credentialError("otp_missing");
  if (new Date(otpRow.expires_at).getTime() < Date.now()) {
    const expiredResult = await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
      status: "expired",
      updated_at: new Date().toISOString()
    }).eq("id", otpRow.id);
    if (expiredResult.error) throw new Error(expiredResult.error.message);
    throw credentialError("otp_expired");
  }
  if (otpRow.attempt_count >= otpRow.max_attempts) throw credentialError("otp_locked");
  if (!verifySecretHash(otp, otpRow.otp_hash)) {
    const attempts = otpRow.attempt_count + 1;
    const updateResult = await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
      attempt_count: attempts,
      updated_at: new Date().toISOString()
    }).eq("id", otpRow.id);
    if (updateResult.error) throw new Error(updateResult.error.message);
    throw credentialError(attempts >= otpRow.max_attempts ? "otp_locked" : "invalid_otp");
  }
  const verifiedResult = await supabaseAdmin.from("connect_whatsapp_otp_requests").update({
    status: "verified",
    used_at: new Date().toISOString(),
    attempt_count: otpRow.attempt_count + 1,
    updated_at: new Date().toISOString()
  }).eq("id", otpRow.id);
  if (verifiedResult.error) throw new Error(verifiedResult.error.message);
  const pinResult = await supabaseAdmin.from("connect_user_pins").upsert({
    country_code: countryCode,
    mobile_number: mobile,
    pin_hash: secretHash(pin),
    attempt_count: 0,
    locked_until: null,
    reset_required: false,
    updated_at: new Date().toISOString()
  }, { onConflict: "country_code,mobile_number" });
  if (pinResult.error) throw new Error(pinResult.error.message);
  return insertLegacySession({ countryCode, mobile, request });
}

export async function authenticateConnectPin({
  countryCode,
  mobile,
  pin,
  request
}: {
  countryCode: string;
  mobile: string;
  pin: string;
  request: Request;
}) {
  const session = await issueCredentialBoundSession("connect_authenticate_pin_and_create_session", {
    p_country_code: countryCode,
    p_mobile_number: mobile,
    p_pin: pin,
    p_request_ip: requestIp(request),
    p_user_agent: request.headers.get("user-agent")
  });
  return session ?? authenticatePinLegacy({ countryCode, mobile, pin, request });
}

export async function setConnectPinWithOtp({
  countryCode,
  mobile,
  otp,
  pin,
  request
}: {
  countryCode: string;
  mobile: string;
  otp: string;
  pin: string;
  request: Request;
}) {
  const session = await issueCredentialBoundSession("connect_set_pin_and_create_session", {
    p_country_code: countryCode,
    p_mobile_number: mobile,
    p_otp: otp,
    p_new_pin_hash: secretHash(pin),
    p_request_ip: requestIp(request),
    p_user_agent: request.headers.get("user-agent")
  });
  return session ?? setPinWithOtpLegacy({ countryCode, mobile, otp, pin, request });
}

export function activateConnectSession(session: IssuedConnectSession) {
  cookies().set("dropx_connect_session", session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    expires: session.expiresAt
  });
}

export async function revokeIssuedConnectSession(session: IssuedConnectSession) {
  if (!supabaseAdmin) return;
  await supabaseAdmin.from("connect_login_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", session.id)
    .is("revoked_at", null);
}
