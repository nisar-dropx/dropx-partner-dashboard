export const PAN_PRIMARY_ENDPOINT = "/pan/verification";
export const PAN_FALLBACK_ENDPOINT = "/srv2/validation/pan/father-details";

export type PanVerificationCredentials = {
  api_id: string;
  api_key: string;
  token_id: string;
};

type PanAuditContext = {
  accountCode?: string | null;
  accountId?: string | null;
  actorLabel?: string | null;
  actorUserId?: string | null;
  baseUrl: string;
  companyId: string;
  profileName?: string | null;
  profileType?: string | null;
  providerCode: string;
  source: string;
  verificationKind: string;
};

type ProviderCallInput = PanAuditContext & {
  endpoint: string;
  isSuccessfulResponse?: (response: Response, body: unknown) => boolean;
  payload: Record<string, unknown>;
  projectResponse?: (body: unknown) => unknown;
  timeoutMs?: number;
};

type ProviderCallResult = {
  response: Response;
  body: unknown;
};

type ProviderCaller = (input: ProviderCallInput) => Promise<ProviderCallResult>;

export type PanFallbackReason =
  | "network_error"
  | "http_error"
  | "api_failure"
  | "blank_holder_name";

type PanProviderResult = {
  apiSuccess: boolean;
  body: unknown;
  fallbackReason?: PanFallbackReason;
  name: string;
  rawStatus: unknown;
  source: "primary" | "fallback";
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compact(value: unknown) {
  return text(value).replace(/\s+/g, " ");
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseStatus(body: unknown) {
  return record(record(body).status);
}

function responseSucceeded(response: Response, body: unknown, primary: boolean) {
  if (!response.ok) return false;

  const root = record(body);
  const status = record(root.status);
  const statusType = text(status.type).toLowerCase();
  const statusCode = Number(status.code);
  if (["failed", "failure", "error"].includes(statusType)) return false;
  if (Number.isFinite(statusCode) && statusCode !== 0 && statusCode !== 200) return false;

  const statusSucceeded = statusType === "success";
  if (!primary) return statusSucceeded;

  const data = record(root.data);
  const dataStatusCode = Number(data.status_code);
  if (data.success === false) return false;
  if (Number.isFinite(dataStatusCode) && dataStatusCode !== 0 && dataStatusCode !== 200) return false;
  return statusSucceeded || data.success === true;
}

function normalizePan(value: unknown) {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function primaryPanName(body: unknown) {
  const providerData = record(record(record(body).data).data);
  return compact(providerData.full_name ?? providerData.fullName);
}

export function fallbackPanName(body: unknown) {
  return compact(record(record(body).data).fullname);
}

export function projectFallbackPanResponse(body: unknown) {
  const root = record(body);
  const status = record(root.status);
  const data = record(root.data);

  // The provider also returns DOB, Aadhaar, address, and contact fields. They
  // are not needed for name verification and must not enter the audit cache.
  return {
    status: {
      code: status.code ?? null,
      type: text(status.type),
      message: text(status.message)
    },
    message: text(root.message),
    error: text(root.error),
    data: {
      pan: normalizePan(data.pan),
      fullname: compact(data.fullname),
      message: text(data.message)
    }
  };
}

export function primaryPanFallbackReason({
  response,
  body
}: ProviderCallResult): Exclude<PanFallbackReason, "network_error"> | null {
  if (!response.ok) return "http_error";
  if (!responseSucceeded(response, body, true)) return "api_failure";
  if (!primaryPanName(body)) return "blank_holder_name";
  return null;
}

export function isUsableFallbackPanResult({
  response,
  body,
  panNumber
}: ProviderCallResult & { panNumber: string }) {
  if (!responseSucceeded(response, body, false)) return false;
  const data = record(record(body).data);
  return Boolean(fallbackPanName(body)) && normalizePan(data.pan) === normalizePan(panNumber);
}

function isProviderTransportError(error: unknown) {
  return error instanceof Error && error.name === "VerificationProviderTransportError";
}

export async function verifyPanWithFallback({
  callProvider,
  auditContext,
  credentials,
  panNumber,
  timeoutMs = 10_000
}: {
  callProvider: ProviderCaller;
  auditContext: PanAuditContext;
  credentials: PanVerificationCredentials;
  panNumber: string;
  timeoutMs?: number;
}): Promise<PanProviderResult> {
  let primaryResult: ProviderCallResult | null = null;
  let fallbackReason: PanFallbackReason;

  try {
    primaryResult = await callProvider({
      ...auditContext,
      endpoint: PAN_PRIMARY_ENDPOINT,
      isSuccessfulResponse: (response, body) => responseSucceeded(response, body, true),
      payload: { ...credentials, pan_number: panNumber },
      timeoutMs
    });
    // Name matching is intentionally performed by the route only after this
    // selection. A nonblank primary holder name never triggers the fallback.
    const reason = primaryPanFallbackReason(primaryResult);
    if (!reason) {
      return {
        apiSuccess: true,
        body: primaryResult.body,
        name: primaryPanName(primaryResult.body),
        rawStatus: responseStatus(primaryResult.body),
        source: "primary"
      };
    }
    fallbackReason = reason;
  } catch (error) {
    if (!isProviderTransportError(error)) throw error;
    fallbackReason = "network_error";
  }

  const fallbackResult = await callProvider({
    ...auditContext,
    endpoint: PAN_FALLBACK_ENDPOINT,
    isSuccessfulResponse: (response, body) => responseSucceeded(response, body, false),
    payload: { ...credentials, pan: panNumber },
    projectResponse: projectFallbackPanResponse,
    timeoutMs
  });
  const apiSuccess = isUsableFallbackPanResult({
    ...fallbackResult,
    panNumber
  });

  return {
    apiSuccess,
    body: fallbackResult.body,
    fallbackReason,
    name: apiSuccess ? fallbackPanName(fallbackResult.body) : "",
    rawStatus: responseStatus(fallbackResult.body),
    source: "fallback"
  };
}
