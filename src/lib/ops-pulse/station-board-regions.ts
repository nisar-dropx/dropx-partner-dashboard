/** Fixed Ops Pulse regions for the Station board compact views. */
export type StationBoardRegionId = "KL" | "AP" | "ODCG" | "OTHER";

export type StationBoardRegion = {
  id: StationBoardRegionId;
  label: string;
  stations: readonly string[];
};

export const STATION_BOARD_REGIONS: readonly StationBoardRegion[] = [
  {
    id: "KL",
    label: "KL",
    stations: ["KTUB", "KTUR", "KOZA", "KTUO", "KLZA", "QLDA", "PEUA", "KGQE", "KBWE", "KGQA", "KGQC", "TLPA", "TLPB", "KLZH"],
  },
  {
    id: "AP",
    label: "AP",
    stations: ["GNTI", "GNTF", "NLRC", "NLRF", "XAPL", "GDRD", "NLRE", "XAPH", "GYMC", "TIRC", "XAPI"],
  },
  {
    id: "ODCG",
    label: "OD & CG",
    stations: ["JDBD", "JGBA", "RPRN", "JUGD", "SPBE", "JUGF", "KDJE", "KDJG", "KANA"],
  },
] as const;

const REGION_BY_STATION = new Map<string, StationBoardRegionId>();
for (const region of STATION_BOARD_REGIONS) {
  for (const code of region.stations) REGION_BY_STATION.set(code, region.id);
}

export function regionForStation(stationCode: string): StationBoardRegionId {
  return REGION_BY_STATION.get(String(stationCode || "").trim().toUpperCase()) ?? "OTHER";
}

export function regionLabel(id: StationBoardRegionId): string {
  if (id === "OTHER") return "Other";
  return STATION_BOARD_REGIONS.find((region) => region.id === id)?.label ?? id;
}

export function stationsInRegion(id: StationBoardRegionId | "ALL"): readonly string[] | null {
  if (id === "ALL") return null;
  if (id === "OTHER") return [];
  return STATION_BOARD_REGIONS.find((region) => region.id === id)?.stations ?? [];
}
