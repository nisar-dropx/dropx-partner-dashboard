export type PayoutSubjectLocationGroup<T> = {
  subjectId: string;
  locationId: string;
  items: T[];
};

export function payoutSubjectLocationKey(subjectId: unknown, locationId: unknown) {
  return JSON.stringify([String(subjectId ?? ""), String(locationId ?? "")]);
}

export function groupPayoutItemsBySubjectLocation<T>(
  items: T[],
  subjectIdFor: (item: T) => unknown,
  locationIdFor: (item: T) => unknown
) {
  const groups = new Map<string, PayoutSubjectLocationGroup<T>>();
  for (const item of items) {
    const subjectId = String(subjectIdFor(item) ?? "");
    const locationId = String(locationIdFor(item) ?? "");
    const key = payoutSubjectLocationKey(subjectId, locationId);
    const current = groups.get(key);
    if (current) current.items.push(item);
    else groups.set(key, { subjectId, locationId, items: [item] });
  }
  return [...groups.values()];
}
