/** Validate the exact ID as text: never truncate, strip characters or drop leading zeroes. */
export function fhrIdValidationMessage(value: string): string {
  if (!value) return "Enter the mandatory 12-digit FHR ID to continue.";
  if (!/^[0-9]+$/.test(value)) return "Use numbers only (0–9), without spaces or symbols. Copy the FHR ID, not the full URL.";
  if (value.length < 12) return `Enter all 12 digits to continue (${value.length}/12 entered).`;
  if (value.length > 12) return `FHR ID must be exactly 12 digits (${value.length} entered). Check the ID in Casper.`;
  return "";
}
