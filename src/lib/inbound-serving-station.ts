// A receiving hub is not necessarily the station delivering the shipment.
// Never turn an explicitly named, unmapped destination into the selected hub.
export function inboundServingStation(raw: Record<string, unknown>, fallbackStation: string) {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const fields = new Map(Object.entries(raw).map(([name, value]) => [key(name), String(value ?? '').trim()]));
  const aliases = ['Destination Station Code', 'Destination Station', 'Delivery Station Code', 'Delivery Station', 'Station Code', 'Station'];
  for (const alias of aliases) {
    const value = fields.get(key(alias));
    if (value) return { stationCode: value.toUpperCase().replace(/\s+/g, ''), sourceField: alias, explicit: true };
  }
  return { stationCode: fallbackStation, sourceField: 'upload_station', explicit: false };
}
