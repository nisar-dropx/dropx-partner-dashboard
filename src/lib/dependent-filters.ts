/** Data-dependent options for a COMPLETE, permission-scoped dataset or aggregate.
 * Never pass only the currently displayed page. Multi-select is OR within a
 * dimension and AND across dimensions. Each dimension ignores its own selection.
 * Selected zero-match values remain removable; changing a filter never widens it.
 */
export type FacetDimension<T> = {
  selected: readonly string[];
  normalize?: (value: string) => string;
  values: (row: T) => string | readonly string[] | null | undefined;
};
export function facetRows<T, K extends string>(
  rows: readonly T[], dimensions: Record<K, FacetDimension<T>>,
  matchesContext: (row: T) => boolean = () => true
) {
  const keys = Object.keys(dimensions) as K[];
  const normalize = (key: K, value: string) => dimensions[key].normalize?.(value) ?? value;
  const selections = keys.map(key => new Set(dimensions[key].selected.map(value => normalize(key, value))));
  const available = Object.fromEntries(keys.map(key => [key, new Set<string>()])) as Record<K, Set<string>>;
  const matching: T[] = [];
  for (const row of rows) {
    if (!matchesContext(row)) continue;
    const values = keys.map(key => {
      const value = dimensions[key].values(row);
      return typeof value === "string" ? [value] : value ?? [];
    });
    let failures = 0;
    let failedAt = -1;
    for (let i = 0; i < keys.length; i++) {
      if (selections[i].size && !values[i].some(value => selections[i].has(normalize(keys[i], value)))) {
        failures++; failedAt = i;
        if (failures > 1) break;
      }
    }
    if (failures === 0) matching.push(row);
    if (failures > 1) continue;
    for (let i = 0; i < keys.length; i++) {
      if (failures === 0 || failedAt === i) {
        for (const value of values[i]) if (value) available[keys[i]].add(value);
      }
    }
  }
  return {
    rows: matching,
    available,
    values(key: K) {
      return [...new Set([...available[key], ...dimensions[key].selected])].sort((a, b) => a.localeCompare(b));
    },
    options<O extends { value: string }>(key: K, options: readonly O[]): O[] {
      const allowed = new Set([...available[key], ...dimensions[key].selected].map(value => normalize(key, value)));
      return options.filter(option => allowed.has(normalize(key, option.value)));
    }
  };
}
