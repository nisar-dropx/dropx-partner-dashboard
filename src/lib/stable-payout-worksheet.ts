import { randomUUID } from "node:crypto";

export type PayoutDependencyVersion = { hash: string | null; error: string | null };
export type PayoutWorksheetRows<Row> = { rows: Row[]; error: string | null };

export const MAX_PAYOUT_WORKSHEET_LOAD_ATTEMPTS = 2;
export const PROVISIONAL_PAYOUT_DEPENDENCY_PREFIX = "revalidate:";

export function isProvisionalPayoutDependencyHash(value: string | null | undefined) {
  return String(value ?? "").startsWith(PROVISIONAL_PAYOUT_DEPENDENCY_PREFIX);
}

export async function loadStablePayoutWorksheet<Row>(input: {
  loadRows: () => Promise<PayoutWorksheetRows<Row>>;
  loadDependency: () => Promise<PayoutDependencyVersion>;
  maxAttempts?: number;
  allowProvisionalOnChurn?: boolean;
}) {
  const maxAttempts = Math.max(1, input.maxAttempts ?? MAX_PAYOUT_WORKSHEET_LOAD_ATTEMPTS);
  let latestRows: Row[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await input.loadDependency();
    if (before.error || !before.hash) {
      return {
        rows: latestRows,
        error: before.error || "Payout worksheet version is unavailable.",
        dependencyHash: null as string | null
      };
    }

    const loaded = await input.loadRows();
    latestRows = loaded.rows;
    if (loaded.error) return { rows: latestRows, error: loaded.error, dependencyHash: null as string | null };

    const after = await input.loadDependency();
    if (after.error || !after.hash) {
      return {
        rows: latestRows,
        error: after.error || "Payout worksheet version is unavailable.",
        dependencyHash: null as string | null
      };
    }
    if (before.hash === after.hash) {
      return { rows: latestRows, error: null as string | null, dependencyHash: after.hash };
    }
  }

  if (input.allowProvisionalOnChurn) {
    return {
      rows: latestRows,
      error: null as string | null,
      dependencyHash: `${PROVISIONAL_PAYOUT_DEPENDENCY_PREFIX}${randomUUID()}`
    };
  }

  return {
    rows: latestRows,
    error: "Payout inputs are still updating. Refresh to review the latest amounts.",
    dependencyHash: null as string | null
  };
}
