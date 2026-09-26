import type { ConnectAccount } from "@/lib/connect-auth";
import { supabaseAdmin } from "@/lib/supabase-admin";

const NATIVE_APP_UA_TOKEN = "DropXOneNative";
// MainActivity appends "DropXDevice/<sha256 of ANDROID_ID>" to the WebView's user agent, so the
// device identity rides on every request without any JS involvement.
const DEVICE_UA_PATTERN = /DropXDevice\/([a-f0-9]{16,64})/i;

export class DeviceBindingError extends Error {}

export function readDeviceIdentity(request: Request) {
  const userAgent = request.headers.get("user-agent") ?? "";
  const platform: "app" | "web" = userAgent.includes(NATIVE_APP_UA_TOKEN) ? "app" : "web";
  const deviceId = userAgent.match(DEVICE_UA_PATTERN)?.[1]?.toLowerCase() ?? null;
  // "(Linux; Android 16; motorola edge 60 pro Build/..." -> "motorola edge 60 pro"
  const deviceLabel = userAgent.match(/Android [\d.]+;\s*([^;)]+?)\s*(?:Build\/|[;)])/)?.[1]?.trim() || null;
  return { platform, deviceId, deviceLabel };
}

type BindingRow = { id: string; account_id: string; profile_type: string; device_id: string };

async function loadActiveBindings(accounts: ConnectAccount[]) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const result = await supabaseAdmin
    .from("connect_account_devices")
    .select("id, account_id, profile_type, device_id")
    .in("account_id", accounts.map((account) => account.id))
    .eq("platform", "app")
    .is("reset_at", null);
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as BindingRow[];
}

/**
 * Throws DeviceBindingError if any of these accounts is already bound to a different phone.
 * Call before anything irreversible (creating a session, changing a PIN), so a blocked phone
 * leaves no side effects behind.
 */
export async function assertDeviceAllowed(accounts: ConnectAccount[], request: Request) {
  const { platform, deviceId } = readDeviceIdentity(request);
  // Web access is not device-bound (browsers have no durable device identity); older app builds
  // that don't send a device ID yet are let through until everyone is on the updated app.
  if (platform !== "app" || !deviceId || !accounts.length) return;

  const bindings = await loadActiveBindings(accounts);
  if (bindings.some((binding) => binding.device_id !== deviceId)) {
    throw new DeviceBindingError(
      "This account is already active on another phone. Ask HR to reset your device, then sign in again."
    );
  }
}

/**
 * Records this phone as the account's bound device and signs out every other DropX One app
 * session on the same mobile number, so a phone that logged in before binding existed is cut off
 * too. Web sessions are left alone.
 */
export async function bindDevice({
  accounts,
  countryCode,
  mobile,
  request
}: {
  accounts: ConnectAccount[];
  countryCode: string;
  mobile: string;
  request: Request;
}) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { platform, deviceId, deviceLabel } = readDeviceIdentity(request);
  if (platform !== "app" || !deviceId || !accounts.length) return;

  const now = new Date().toISOString();
  const bindings = await loadActiveBindings(accounts);
  const boundKeys = new Set(bindings.map((binding) => `${binding.account_id}:${binding.profile_type}`));

  if (bindings.length) {
    const touch = await supabaseAdmin
      .from("connect_account_devices")
      .update({ last_seen_at: now, updated_at: now })
      .in("id", bindings.map((binding) => binding.id));
    if (touch.error) throw new Error(touch.error.message);
  }

  const missing = accounts.filter((account) => !boundKeys.has(`${account.id}:${account.profileType}`));
  if (missing.length) {
    const insert = await supabaseAdmin.from("connect_account_devices").insert(missing.map((account) => ({
      account_id: account.id,
      profile_type: account.profileType,
      device_id: deviceId,
      platform: "app",
      company_id: account.companyId,
      display_name: account.name,
      country_code: countryCode,
      mobile_number: mobile,
      device_label: deviceLabel
    })));
    // 23505: another request bound this account a moment ago. Re-check rather than fail.
    if (insert.error && insert.error.code !== "23505") throw new Error(insert.error.message);
    if (insert.error) await assertDeviceAllowed(accounts, request);
  }

  const sessions = await supabaseAdmin
    .from("connect_login_sessions")
    .select("id, user_agent")
    .eq("country_code", countryCode)
    .eq("mobile_number", mobile)
    .is("revoked_at", null);
  if (sessions.error) throw new Error(sessions.error.message);
  const otherAppSessions = (sessions.data ?? [])
    .filter((session: { user_agent: string | null }) => {
      const userAgent = session.user_agent ?? "";
      if (!userAgent.includes(NATIVE_APP_UA_TOKEN)) return false;
      return userAgent.match(DEVICE_UA_PATTERN)?.[1]?.toLowerCase() !== deviceId;
    })
    .map((session: { id: string }) => session.id);
  if (otherAppSessions.length) {
    const revoke = await supabaseAdmin
      .from("connect_login_sessions")
      .update({ revoked_at: now, updated_at: now })
      .in("id", otherAppSessions);
    if (revoke.error) throw new Error(revoke.error.message);
  }
}
