import "server-only";

import { createSign } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

type PushNotification = {
  id: string;
  companyId: string;
  profileType: string;
  accountId: string;
  title: string;
  body: string;
  route?: string | null;
  data?: Record<string, unknown>;
};

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function firebaseConfig() {
  return {
    projectId: process.env.FIREBASE_PROJECT_ID?.trim() ?? "",
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim() ?? "",
    privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n").trim()
  };
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

async function firebaseAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const config = firebaseConfig();
  if (!config.projectId || !config.clientEmail || !config.privateKey) return "";

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
    iss: config.clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging"
  }));
  const unsignedToken = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const assertion = `${unsignedToken}.${signer.sign(config.privateKey, "base64url")}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      assertion,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer"
    }),
    cache: "no-store"
  });
  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "Firebase access token request failed.");
  }

  cachedAccessToken = payload.access_token;
  cachedAccessTokenExpiresAt = Date.now() + Math.max(60, (payload.expires_in ?? 3600) - 300) * 1000;
  return cachedAccessToken;
}

function pushData(notification: PushNotification) {
  const values: Record<string, string> = {
    notificationId: notification.id,
    route: notification.route ?? "",
    profileType: notification.profileType,
    accountId: notification.accountId
  };
  for (const [key, value] of Object.entries(notification.data ?? {})) {
    values[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return values;
}

export async function deliverNotificationPush(notification: PushNotification) {
  if (!supabaseAdmin) return;

  const config = firebaseConfig();
  if (!config.projectId || !config.clientEmail || !config.privateKey) {
    await supabaseAdmin
      .from("mob_app_notifications")
      .update({ push_status: "not_configured", push_error: null })
      .eq("id", notification.id);
    return;
  }

  const tokenResult = await supabaseAdmin
    .from("mob_app_device_tokens")
    .select("id, push_token, platform")
    .eq("company_id", notification.companyId)
    .eq("profile_type", notification.profileType)
    .eq("account_id", notification.accountId)
    .in("platform", ["android", "ios"])
    .eq("is_active", true)
    .not("push_token", "is", null);
  if (tokenResult.error) {
    await supabaseAdmin
      .from("mob_app_notifications")
      .update({ push_status: "failed", push_error: tokenResult.error.message })
      .eq("id", notification.id);
    return;
  }

  const tokens = (tokenResult.data ?? []).filter((row) => Boolean(row.push_token));
  if (tokens.length === 0) {
    await supabaseAdmin
      .from("mob_app_notifications")
      .update({ push_status: "pending", push_error: "No active device token." })
      .eq("id", notification.id);
    return;
  }

  try {
    const accessToken = await firebaseAccessToken();
    const results = await Promise.all(tokens.map(async (row) => {
      const message: Record<string, unknown> = {
        token: row.push_token,
        notification: {
          title: notification.title,
          body: notification.body
        },
        data: pushData(notification)
      };
      if (row.platform === "ios") {
        message.apns = {
          headers: { "apns-priority": "10" },
          payload: { aps: { sound: "default", alert: { title: notification.title, body: notification.body } } }
        };
      } else {
        message.android = {
          priority: "high",
          notification: {
            channel_id: "dropx_one_notifications",
            sound: "default"
          }
        };
      }

      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ message }),
          cache: "no-store"
        }
      );
      const payload = await response.json().catch(() => ({})) as {
        error?: { message?: string; details?: Array<{ errorCode?: string }> };
      };
      const errorCode = payload.error?.details?.find((detail) => detail.errorCode)?.errorCode;
      if (errorCode === "UNREGISTERED") {
        await supabaseAdmin!
          .from("mob_app_device_tokens")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
      return {
        ok: response.ok,
        error: payload.error?.message || (response.ok ? "" : `Firebase HTTP ${response.status}`)
      };
    }));

    const delivered = results.some((result) => result.ok);
    const errors = results.filter((result) => !result.ok).map((result) => result.error).filter(Boolean);
    await supabaseAdmin
      .from("mob_app_notifications")
      .update({
        push_status: delivered ? "sent" : "failed",
        push_error: errors.length > 0 ? errors.join("; ").slice(0, 1000) : null
      })
      .eq("id", notification.id);
  } catch (error) {
    await supabaseAdmin
      .from("mob_app_notifications")
      .update({
        push_status: "failed",
        push_error: String((error as { message?: unknown })?.message ?? error).slice(0, 1000)
      })
      .eq("id", notification.id);
  }
}
