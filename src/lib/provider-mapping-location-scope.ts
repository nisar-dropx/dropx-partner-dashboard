type Relation = { code?: string | null; name?: string | null };
type MappingLocation = { providers?: Relation | Relation[] | null; location_models?: Relation | Relation[] | null };

/** ID mapping is for last-mile delivery hubs, never Amazon Now / dark stores. */
export function isProviderMappingLocation(location: MappingLocation) {
  const provider = Array.isArray(location.providers) ? location.providers[0] : location.providers;
  const model = Array.isArray(location.location_models) ? location.location_models[0] : location.location_models;
  const providerCode = String(provider?.code || provider?.name || "").trim().toUpperCase();
  const modelCode = String(model?.code || model?.name || "").trim().toUpperCase();
  return (providerCode === "AMAZON" && ["EDSP", "XPT", "XPD"].includes(modelCode))
    || (providerCode === "FLIPKART" && ["ODH", "MDH"].includes(modelCode));
}
