export type CurrentLocationRow = {
  id: string;
  parent_station_id?: string | null;
  is_active?: boolean | null;
  hide_from_location_list?: boolean | null;
};

/**
 * Current operational surfaces use only locations that are active and visible.
 * Historical rows may still join the stations table directly for audit display.
 */
export function isCurrentLocation(location: CurrentLocationRow) {
  return location.is_active === true && location.hide_from_location_list !== true;
}

/** Preserve inherited child-station access while removing inactive/hidden scopes. */
export function currentLocationScopeIds(
  locations: CurrentLocationRow[],
  configuredScopeIds: string[]
) {
  const accessible = new Set(configuredScopeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const location of locations) {
      if (location.parent_station_id && accessible.has(location.parent_station_id) && !accessible.has(location.id)) {
        accessible.add(location.id);
        changed = true;
      }
    }
  }
  return locations.filter((location) => accessible.has(location.id) && isCurrentLocation(location)).map((location) => location.id);
}
