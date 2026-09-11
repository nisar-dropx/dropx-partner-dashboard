import { cookies, headers } from "next/headers";
import type { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { timeoutFetch } from "./timeout-fetch";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAuthKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const COOKIE_CHUNK_SIZE = 3000;
const MAX_COOKIE_CHUNKS = 8;
const ENCODED_COOKIE_PREFIX = "b64-";

function encodeCookieValue(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return ENCODED_COOKIE_PREFIX + btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeCookieValue(value: string) {
  if (!value.startsWith(ENCODED_COOKIE_PREFIX)) return value;
  const encoded = value.slice(ENCODED_COOKIE_PREFIX.length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function cookieDomain() {
  const host = headers().get("x-forwarded-host")?.split(":")[0].toLowerCase() ??
    headers().get("host")?.split(":")[0].toLowerCase() ??
    "";

  return host.endsWith("dropxlogistics.com") ? ".dropxlogistics.com" : undefined;
}

export function createServerSupabaseClient(response?: NextResponse, forceOpsStorage?: boolean) {
  if (!supabaseUrl || !supabaseAuthKey) return null;

  const cookieStore = cookies();
  const host = headers().get("x-forwarded-host")?.split(":")[0].toLowerCase() ??
    headers().get("host")?.split(":")[0].toLowerCase() ??
    "";
  const hasOpsSessionCookie = Boolean(
    cookieStore.get("dropx-ops-auth-v3")?.value ||
    cookieStore.get("dropx-ops-auth-v3.0")?.value
  );
  const useOpsStorage = forceOpsStorage ??
    (host === "ops.dropxlogistics.com" || hasOpsSessionCookie);
  const cookieOptions = {
    ...(useOpsStorage ? {} : { domain: cookieDomain() }),
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  };

  const getStoredValue = (key: string) => {
    const legacyValue = cookieStore.get(key)?.value;
    if (legacyValue) return decodeCookieValue(legacyValue);

    let value = "";
    for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
      const chunk = cookieStore.get(`${key}.${index}`)?.value;
      if (!chunk) break;
      value += chunk;
    }
    return value ? decodeCookieValue(value) : null;
  };

  const writeStoredCookie = (
    name: string,
    value: string,
    options: typeof cookieOptions | (typeof cookieOptions & { maxAge: number })
  ) => {
    response?.cookies.set(name, value, options);
    try {
      cookieStore.set(name, value, options);
    } catch {
      // Server components cannot mutate the request cookie store. Route
      // handlers still persist through the explicit response above.
    }
  };

  const clearStoredValue = (key: string) => {
    writeStoredCookie(key, "", { ...cookieOptions, maxAge: 0 });
    for (let index = 0; index < MAX_COOKIE_CHUNKS; index += 1) {
      writeStoredCookie(`${key}.${index}`, "", { ...cookieOptions, maxAge: 0 });
    }
  };

  const setStoredValue = (key: string, value: string) => {
    clearStoredValue(key);
    const encodedValue = encodeCookieValue(value);
    const chunks = encodedValue.match(new RegExp(`.{1,${COOKIE_CHUNK_SIZE}}`, "g")) ?? [];
    chunks.forEach((chunk, index) => {
      writeStoredCookie(`${key}.${index}`, chunk, cookieOptions);
    });
  };

  return createClient(supabaseUrl, supabaseAuthKey, {
    auth: {
      flowType: "pkce",
      ...(useOpsStorage ? { storageKey: "dropx-ops-auth-v3" } : {}),
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage: {
        getItem: getStoredValue,
        setItem: setStoredValue,
        removeItem: clearStoredValue
      }
    },
    global: {
      fetch: timeoutFetch()
    }
  });
}
