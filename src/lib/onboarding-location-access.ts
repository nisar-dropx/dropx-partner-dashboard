type OnboardingLocation = {
  id: string;
  hide_from_location_list?: boolean | null;
  parent_station_id?: string | null;
};

type LocationAuthorization = {
  hasAllLocationAccess: boolean;
  locationScopeIds: string[];
};

export function filterOnboardingLocations<T extends OnboardingLocation>(
  locations: T[],
  authorization: LocationAuthorization
) {
  const allowedIds = new Set(
    authorization.hasAllLocationAccess
      ? locations.map((location) => location.id)
      : authorization.locationScopeIds
  );

  // A station owner can operate the satellite locations nested beneath the
  // station. Keep walking the location tree so this also works for a deeper
  // hierarchy, while never granting access to a sibling or parent station.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const location of locations) {
      if (location.parent_station_id && allowedIds.has(location.parent_station_id) && !allowedIds.has(location.id)) {
        allowedIds.add(location.id);
        expanded = true;
      }
    }
  }

  return locations.filter((location) => allowedIds.has(location.id) && !location.hide_from_location_list);
}
