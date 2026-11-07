type Location = { id: string; station_code: string };
type Owner = { workspace: string; location_id: string | null };

export function discoveryLocations(
  subject: string,
  owner: Owner | undefined,
  locations: Location[],
  all: boolean,
) {
  if (owner && owner.workspace !== "last_mile") return [];
  if (owner?.location_id)
    return locations.filter((location) => location.id === owner.location_id);
  const codes = new Set(subject.toUpperCase().split(/[^A-Z0-9]+/));
  return locations.filter(
    (location) => all || codes.has(location.station_code.toUpperCase()),
  );
}
