function trimEnv(value: string | undefined) {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

export function workforceAmazonWorkerConfig() {
  const baseUrl = trimEnv(process.env.WORKFORCE_AMAZON_WORKER_URL || process.env.WORKFORCE_WORKER_URL).replace(/\/$/, "");
  const adminKey = trimEnv(
    process.env.WORKFORCE_AMAZON_WORKER_KEY ||
      process.env.WORKFORCE_WORKER_ADMIN_KEY ||
      process.env.ADMIN_API_KEY,
  );
  return { baseUrl, adminKey, configured: Boolean(baseUrl && adminKey) };
}

export async function callWorkforceAmazonWorker<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { baseUrl, adminKey, configured } = workforceAmazonWorkerConfig();
  if (!configured) {
    throw new Error("The shared Amazon LSC and IDfy worker is not connected to OpsPulse.");
  }

  const response = await fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-key": adminKey,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  let payload: unknown = null;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch {
    payload = { error: body };
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Worker HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
