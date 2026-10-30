import "server-only";

export const ACCOUNTING_COMPANY = "43866344-b550-4e8a-9a2d-9d23f3d8a997";
export function accountingConfigured() {
  return Boolean(
    process.env.ACCOUNTING_WORKER_URL &&
    (process.env.ACCOUNTING_API_KEY?.length ?? 0) >= 32,
  );
}
export async function accountingRequest(
  company: string,
  actor: string,
  path: string,
  body?: unknown,
) {
  if (company !== ACCOUNTING_COMPANY)
    throw Error("Accounting sync is not configured for this company.");
  if (!accountingConfigured())
    throw Error("Accounting worker is not connected yet.");
  const base = new URL(process.env.ACCOUNTING_WORKER_URL!);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  )
    throw Error("Invalid accounting worker configuration.");
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    redirect: "error",
    headers: {
      authorization: `Bearer ${process.env.ACCOUNTING_API_KEY}`,
      "x-company-id": company,
      "x-actor-id": actor,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(
      typeof result.error === "string"
        ? result.error
        : "Accounting sync failed.",
    );
  return result;
}
