export type FleetAdHocSource = {
  category: "Van" | "DA";
  resourceCategory?: "Van" | "DA" | "Driver";
};

export function fleetAdHocRequestType(entry: FleetAdHocSource): "Van" | "Driver" | null {
  if (entry.category === "Van") return "Van";
  if (entry.resourceCategory === "Driver") return "Driver";
  return null;
}
