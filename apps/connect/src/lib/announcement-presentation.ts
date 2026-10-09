type TextPart = { text: string; bold: boolean };
export type AnnouncementParagraph = { callout: boolean; parts: TextPart[] };

function phrases(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= 2000))].slice(0, 10) : [];
}

/** Plain text stays plain text. Formatting never evaluates HTML or Markdown. */
export function announcementParagraphs(body: string, presentation?: unknown): AnnouncementParagraph[] {
  const options = presentation && typeof presentation === "object"
    ? presentation as { emphasis?: unknown; callouts?: unknown } : {};
  const emphasis = phrases(options.emphasis).sort((a, b) => b.length - a.length);
  const callouts = phrases(options.callouts);
  const matcher = emphasis.length ? new RegExp(`(${emphasis.map(text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g") : null;
  return body.split(/\n\s*\n/).filter(paragraph => paragraph.trim()).map(paragraph => ({
    callout: callouts.some(text => paragraph.includes(text)),
    parts: (matcher ? paragraph.split(matcher) : [paragraph]).filter(Boolean).map(text => ({ text, bold: emphasis.includes(text) }))
  }));
}
