/** Links stay on the current product so OpsPulse uses its own mapping permissions. */
export function providerMappingHref(input: {
  providerId?: string; dropxId?: string; station: string; firstDate: string; lastDate: string;
}) {
  const firstMonth = input.firstDate.slice(0, 7);
  const month = firstMonth === input.lastDate.slice(0, 7) ? firstMonth : "all";
  return `/provider-id-mapping?q=${encodeURIComponent(input.providerId || input.dropxId || "")}`
    + `&station=${encodeURIComponent(input.station)}&month=${encodeURIComponent(month)}&mapping=all`;
}

export function providerMappingEntryFilters(
  params: { month?: string; mapping?: string } | undefined,
  today: string
) {
  const month = params?.month === "all" ? ""
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(params?.month ?? "") ? params!.month! : today.slice(0, 7);
  const mapping: "all" | "mapped" | "unmapped" = params?.mapping === "all" || params?.mapping === "mapped"
    ? params.mapping : "unmapped";
  return { month, mapping };
}
