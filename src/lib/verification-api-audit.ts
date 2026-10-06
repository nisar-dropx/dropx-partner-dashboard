import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

type AuditContext = {
  accountCode?: string | null;
  accountId?: string | null;
  actorLabel?: string | null;
  actorUserId?: string | null;
  companyId: string;
  profileName?: string | null;
  profileType?: string | null;
  source: string;
  verificationKind: string;
};

export type ProviderCall = AuditContext & {
  baseUrl: string;
  endpoint: string;
  isSuccessfulResponse?: (response: Response, body: unknown) => boolean;
  payload: Record<string, unknown>;
  projectResponse?: (body: unknown) => unknown;
  providerCode: string;
  timeoutMs?: number;
};

export class VerificationProviderTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationProviderTransportError";
  }
}

type CacheClaim = {
  action: "cached" | "claimed" | "processing";
  http_status: number | null;
  is_success: boolean | null;
  log_id: string;
  response_data: unknown;
};

const credentialKeys = new Set([
  "api_id",
  "api_key",
  "token_id",
  "authorization",
  "access_token",
  "secret",
  "password"
]);

function text(value: unknown) {
  return String(value ?? "").trim();
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !credentialKeys.has(key.toLowerCase()))
      .map(([key, child]) => [key, sanitize(child)])
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function inputHash(input: ProviderCall, requestData: unknown) {
  return createHash("sha256")
    .update([
      input.companyId,
      input.providerCode.toLowerCase(),
      input.verificationKind.toLowerCase(),
      input.endpoint,
      canonicalJson(requestData)
    ].join("|"))
    .digest("hex");
}

function responseFromCache(status: number | null, body: unknown) {
  const responseStatus = status && status >= 200 && status <= 599 ? status : 200;
  return new Response(JSON.stringify(body ?? {}), {
    status: responseStatus,
    headers: { "Content-Type": "application/json" }
  });
}

function isCacheMigrationMissing(message: string) {
  const value = message.toLowerCase();
  return value.includes("claim_verification_api_request") &&
    (value.includes("does not exist") || value.includes("schema cache"));
}

function firstValue(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = record[key];
    if (typeof direct === "string" || typeof direct === "number" || typeof direct === "boolean") {
      const found = text(direct);
      if (found) return found;
    }
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      const found = firstValue(child, keys);
      if (found) return found;
    }
  }
  return "";
}

function providerSucceeded(response: Response, body: unknown) {
  if (!response.ok) return false;
  const statusType = firstValue(body, ["type", "status"]).toLowerCase();
  if (statusType === "failed" || statusType === "failure" || statusType === "error") return false;
  return true;
}

function responseRecord(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function resultCode(value: unknown) {
  const root = responseRecord(value);
  const data = responseRecord(root.data);
  const result = responseRecord(root.result);
  const status = responseRecord(root.status);
  return text(root.result_code || data.code || result.code || root.code || status.code);
}

function resultMessage(value: unknown) {
  const root = responseRecord(value);
  const data = responseRecord(root.data);
  const result = responseRecord(root.result);
  const status = responseRecord(root.status);
  return text(data.message || result.message || root.message || root.error || status.message);
}

function cacheDurationHours(response: Response) {
  const retryable = response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500;
  return retryable ? 3 / 60 : 24;
}

async function claimProviderCall(input: ProviderCall, requestData: unknown, hash: string) {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.rpc("claim_verification_api_request", {
    p_account_code: input.accountCode || null,
    p_account_id: input.accountId || null,
    p_actor_label: input.actorLabel || null,
    p_actor_user_id: input.actorUserId || null,
    p_company_id: input.companyId,
    p_endpoint: input.endpoint,
    p_input_hash: hash,
    p_profile_name: input.profileName || null,
    p_profile_type: input.profileType || null,
    p_provider_code: input.providerCode,
    p_request_data: requestData,
    p_source: input.source,
    p_verification_kind: input.verificationKind
  });
  if (error) {
    if (isCacheMigrationMissing(error.message)) return null;
    throw new Error(`Unable to check verification cache: ${error.message}`);
  }
  const claim = Array.isArray(data) ? data[0] : data;
  return claim ? claim as CacheClaim : null;
}

async function completeProviderCall(
  logId: string,
  response: Response | null,
  body: unknown,
  durationMs: number,
  cacheForHours: number,
  isSuccess: boolean
) {
  if (!supabaseAdmin) return;
  const responseData = body && typeof body === "object" ? body : { value: body };
  const completedAt = new Date();
  const cacheExpiresAt = new Date(completedAt.getTime() + cacheForHours * 60 * 60 * 1000);
  const { error } = await supabaseAdmin
    .from("verification_api_audit_logs")
    .update({
      cache_expires_at: cacheExpiresAt.toISOString(),
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      http_status: response?.status ?? null,
      is_success: isSuccess,
      request_status: "completed",
      response_data: sanitize(responseData),
      result_code: resultCode(responseData),
      result_message: resultMessage(responseData)
    })
    .eq("id", logId);
  if (error) {
    console.error("Unable to complete verification audit:", error.message);
  }
}

async function writeAudit(
  input: AuditContext & {
    durationMs: number;
    endpoint: string;
    httpStatus: number | null;
    isSuccess: boolean;
    providerCode: string;
    requestData: unknown;
    responseData: unknown;
  }
) {
  if (!supabaseAdmin) return;
  const responseData = input.responseData && typeof input.responseData === "object"
    ? input.responseData
    : { value: input.responseData };
  const { error } = await supabaseAdmin.from("verification_api_audit_logs").insert({
    company_id: input.companyId,
    provider_code: input.providerCode,
    request_status: "completed",
    verification_kind: input.verificationKind,
    endpoint: input.endpoint,
    source: input.source,
    profile_type: input.profileType || null,
    account_id: input.accountId || null,
    account_code: input.accountCode || null,
    profile_name: input.profileName || null,
    actor_user_id: input.actorUserId || null,
    actor_label: input.actorLabel || null,
    request_data: sanitize(input.requestData),
    response_data: sanitize(responseData),
    http_status: input.httpStatus,
    is_success: input.isSuccess,
    result_code: resultCode(responseData),
    result_message: resultMessage(responseData),
    duration_ms: input.durationMs
  });
  if (error) {
    const message = error.message.toLowerCase();
    if (!message.includes("verification_api_audit_logs")) {
      console.error("Unable to write verification API audit log:", error.message);
    }
  }
}

export async function callVerificationProvider(input: ProviderCall) {
  const requestData = sanitize(input.payload);
  const hash = inputHash(input, requestData);
  const claim = await claimProviderCall(input, requestData, hash);
  if (claim?.action === "cached") {
    const body = input.projectResponse
      ? input.projectResponse(claim.response_data)
      : claim.response_data;
    const response = responseFromCache(claim.http_status, body);
    return { response, body };
  }
  if (claim?.action === "processing") {
    throw new Error("This verification is already in progress.");
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(`${input.baseUrl}${input.endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.payload),
      signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined
    });
    const rawBody = await response.json().catch(() => ({}));
    const body = input.projectResponse ? input.projectResponse(rawBody) : rawBody;
    const isSuccess = input.isSuccessfulResponse
      ? input.isSuccessfulResponse(response, body)
      : providerSucceeded(response, body);
    if (claim?.log_id) {
      await completeProviderCall(
        claim.log_id,
        response,
        body,
        Date.now() - startedAt,
        cacheDurationHours(response),
        isSuccess
      );
    } else {
      await writeAudit({
        ...input,
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
        isSuccess,
        requestData: input.payload,
        responseData: body
      });
    }
    return { response, body };
  } catch (error) {
    const errorBody = { error: error instanceof Error ? error.message : "Provider request failed." };
    if (claim?.log_id) {
      // A short cache prevents rapid retries after a connection-level failure.
      await completeProviderCall(
        claim.log_id,
        null,
        errorBody,
        Date.now() - startedAt,
        5 / 60,
        false
      );
    } else {
      await writeAudit({
        ...input,
        durationMs: Date.now() - startedAt,
        httpStatus: null,
        isSuccess: false,
        requestData: input.payload,
        responseData: errorBody
      });
    }
    throw new VerificationProviderTransportError(
      error instanceof Error ? error.message : "Provider request failed."
    );
  }
}
