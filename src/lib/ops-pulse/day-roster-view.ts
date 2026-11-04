/** Sort shift buckets by start clock; Week off / unparsed labels stay last. */
export function sortDayRosterGroupLabels(labels: string[]) {
  const rank = (label: string) => {
    if (label === "Week off") return Number.POSITIVE_INFINITY;
    if (label === "Rostered") return Number.POSITIVE_INFINITY - 1;
    const match = /^(\d{2}):(\d{2})/.exec(label);
    return match ? Number(match[1]) * 60 + Number(match[2]) : Number.POSITIVE_INFINITY - 2;
  };
  return [...labels].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}
