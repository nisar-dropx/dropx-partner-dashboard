import "server-only";
import { loadReviewCod } from "./review-cod-data";
import { buildCodRca } from "./review-cod-rca";

/** Caller must first authorize the review's company and exact station. */
export async function loadCodRca(companyId: string, stationCode: string) {
  const { snapshot } = await loadReviewCod(companyId, stationCode);
  if (snapshot.error || !snapshot.summary) throw Error("Unable to verify COD ageing. Refresh the COD report before completing the review.");
  return buildCodRca(snapshot);
}
