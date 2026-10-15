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
  if (result.error) throw new Error(result.error.message);
  const outcome = result.data as { ok?: boolean; code?: string } | null;
  if (!outcome?.ok) throw credentialError(outcome?.code);
  return {
    id: session.id,
    token: session.token,
    expiresAt: session.expiresAt
  } satisfies IssuedConnectSession;
}

export function authenticateConnectPin({
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
  return issueCredentialBoundSession("connect_authenticate_pin_and_create_session", {
    p_country_code: countryCode,
    p_mobile_number: mobile,
    p_pin: pin,
    p_request_ip: requestIp(request),
    p_user_agent: request.headers.get("user-agent")
  });
}

export function setConnectPinWithOtp({
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
  return issueCredentialBoundSession("connect_set_pin_and_create_session", {
    p_country_code: countryCode,
    p_mobile_number: mobile,
    p_otp: otp,
    p_new_pin_hash: secretHash(pin),
    p_request_ip: requestIp(request),
    p_user_agent: request.headers.get("user-agent")
  });
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
