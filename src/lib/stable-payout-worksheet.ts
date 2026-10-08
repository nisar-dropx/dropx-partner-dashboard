export type PayoutDependencyVersion = { hash: string | null; error: string | null };
export type PayoutWorksheetRows<Row> = { rows: Row[]; error: string | null };

export const MAX_PAYOUT_WORKSHEET_LOAD_ATTEMPTS = 2;

export async function loadStablePayoutWorksheet<Row>(input: {
  loadRows: () => Promise<PayoutWorksheetRows<Row>>;
  loadDependency: () => Promise<PayoutDependencyVersion>;
  maxAttempts?: number;
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

  return {
    rows: latestRows,
    error: "Payout inputs are still updating. Refresh to review the latest amounts.",
    dependencyHash: null as string | null
  };
}
