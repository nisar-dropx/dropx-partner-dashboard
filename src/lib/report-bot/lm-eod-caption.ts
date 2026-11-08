type DsrRow = Record<string, string | number> & { Station: string };

type PerformanceBand = {
  label: string;
  icon: string;
  matches: (percentage: number) => boolean;
};

const performanceBands: PerformanceBand[] = [
  { label: "Outstanding (>95%)", icon: "🏆", matches: value => value > 95 },
  { label: "Great (>93–95%)", icon: "🟢", matches: value => value > 93 && value <= 95 },
  { label: "Good / watch (88–93%)", icon: "🟠", matches: value => value >= 88 && value <= 93 },
  { label: "Needs focus (83–<88%)", icon: "🟥", matches: value => value >= 83 && value < 88 },
  { label: "Immediate focus (<83%)", icon: "🚨", matches: value => value < 83 },
];

const percentage = (value: string | number | undefined) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

function groupedRows(rows: DsrRow[]) {
  return performanceBands.map(band => ({
    ...band,
    rows: rows
      .map(row => ({ station: String(row.Station).trim().toUpperCase(), percentage: percentage(row["DSR %"]) }))
      .filter((row): row is { station: string; percentage: number } => Boolean(row.station) && row.percentage !== null && band.matches(row.percentage))
      .sort((left, right) => right.percentage - left.percentage || left.station.localeCompare(right.station)),
  }));
}

export function eodDsrMentionStations(rows: DsrRow[]) {
  const groups = groupedRows(rows);
  return {
    recognition: groups.slice(0, 2).flatMap(group => group.rows.map(row => row.station)),
    focus: groups.slice(3).flatMap(group => group.rows.map(row => row.station)),
  };
}

export function eodDsrPerformanceCaption(
  title: string,
  rows: DsrRow[],
  recognitionNumbers: string[] = [],
  focusNumbers: string[] = [],
) {
  const sections = groupedRows(rows)
    .filter(group => group.rows.length)
    .map(group => `${group.icon} *${group.label}*: ${group.rows.map(row => `${row.station} ${row.percentage.toFixed(1)}%`).join(" · ")}`);
  const recognitionTags = [...new Set(recognitionNumbers)].map(number => `@${number}`).join(" ");
  const focusTags = [...new Set(focusNumbers)].map(number => `@${number}`).join(" ");
  return [
    `*${title}*`,
    "",
    ...sections,
    recognitionTags ? `👏 *Great performance — TL & Cluster/AOM*: ${recognitionTags}` : "",
    focusTags ? `🎯 *Needs focus — TL & Cluster/AOM*: ${focusTags}` : "",
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}
