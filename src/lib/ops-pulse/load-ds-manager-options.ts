import "server-only";
import { loadPeopleReviewGraph } from "@/lib/ops-pulse/people-review-routing";
import { resolvePeopleReviewRoute } from "@/lib/ops-pulse/people-review-route";
import { darkStoreManagerReviewChain, reviewRole } from "@/lib/ops-pulse/review-policy";
import type { DsManagerOption } from "@/lib/ops-pulse/ds-scope";

type StoreRef = { locationId: string; code: string };

/**
 * City Manager / Regional Manager filter options for Dark Store Operations.
 * Built from People review routes (not Last Mile Cluster/AOM).
 */
export async function loadDsManagerOptions(companyId: string, stores: StoreRef[]): Promise<DsManagerOption[]> {
  if (!stores.length) return [];
  try {
    const graph = await loadPeopleReviewGraph(companyId);
    const options = new Map<string, { label: string; stations: Set<string> }>();

    for (const store of stores) {
      const code = String(store.code ?? "").trim().toUpperCase();
      if (!code) continue;
      const route = resolvePeopleReviewRoute(graph, store.locationId, { darkStore: true });
      if (route.error || !route.chain.length) continue;
      const managers = darkStoreManagerReviewChain(
        route.chain.map((stage) => ({
          role: stage.reviewerRole,
          personId: stage.personId,
          designationCode: null as string | null,
          name: stage.reviewerName
        }))
      ) as Array<{ role: string; personId: string; designationCode: string | null; name: string }>;
      for (const manager of managers) {
        const role = reviewRole(`${manager.designationCode ?? ""} ${manager.role}`);
        const kind = role === "regional" ? "rm" : "city";
        const value = `${kind}:${manager.personId}`;
        const label = kind === "rm" ? `${manager.name} (Regional)` : `${manager.name} (City)`;
        const entry = options.get(value) ?? { label, stations: new Set<string>() };
        entry.stations.add(code);
        options.set(value, entry);
      }
    }

    return [...options.entries()]
      .map(([value, entry]) => ({
        value,
        label: entry.label,
        stations: [...entry.stations].sort()
      }))
      .filter((option) => option.stations.length)
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (error) {
    console.warn("[ds-ops] manager filter unavailable", error instanceof Error ? error.message : error);
    return [];
  }
}
