/** Fit the entire item into the available preview without enlarging small originals. */
export function evidenceFitWidth(itemWidth: number, itemHeight: number, availableWidth: number, availableHeight: number) {
  if (!(itemWidth > 0 && itemHeight > 0)) return Math.max(1, availableWidth);
  return itemWidth * Math.min(1, Math.max(1, availableWidth) / itemWidth, Math.max(1, availableHeight) / itemHeight);
}
