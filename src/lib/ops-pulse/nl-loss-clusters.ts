import type { LocationOperationalHierarchy } from "../people-operational-hierarchy-core";

/** Current People ownership is independent of the historical loss-file month. */
export function nlPeopleClusters(
  stations: { id: string }[],
  hierarchy: ReadonlyMap<string, LocationOperationalHierarchy>
) {
  const byStation = new Map<string, { cluster: string; clusterKeys: string[] }>();
  const options = new Map<string, string>();
  for (const station of stations) {
    const current = hierarchy.get(station.id);
    const managers = current?.clusterManagers ?? [];
    const owners = managers.length ? managers : (current?.areaOperationsManagers ?? []);
    const entries = [...new Map(owners.map((person) => [
      `${managers.length ? "cm" : "aom"}:${person.personId}`,
      `${person.name}${managers.length ? "" : " (AOM)"}`,
    ])).entries()];
    if (!entries.length) entries.push(["unmapped", "Not mapped in People"]);
    entries.forEach(([key, label]) => options.set(key, label));
    byStation.set(station.id, {
      cluster: entries.map(([, label]) => label).join(" · "),
      clusterKeys: entries.map(([key]) => key),
    });
  }
  return {
    byStation,
    options: [...options].map(([value, label]) => ({ value, label }))
      .sort((a, b) => Number(a.value === "unmapped") - Number(b.value === "unmapped") || a.label.localeCompare(b.label)),
  };
}
