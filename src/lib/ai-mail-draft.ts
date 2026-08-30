export type AiMailDraft = {
  subject: string;
  body: string;
};

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function decodeDraftValue(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 5) throw new Error("AI returned an invalid draft.");

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("subject" in record || "body" in record) return record;

    for (const key of ["response", "result", "output"]) {
      if (record[key] !== undefined) {
        try {
          return decodeDraftValue(record[key], depth + 1);
        } catch {
          // Try the next supported response wrapper.
        }
      }
    }
  }

  if (typeof value !== "string") throw new Error("AI returned an invalid draft.");

  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [normalized];
  const objectStart = normalized.indexOf("{");
  const objectEnd = normalized.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) candidates.push(normalized.slice(objectStart, objectEnd + 1));

  for (const candidate of candidates) {
    try {
      return decodeDraftValue(JSON.parse(candidate), depth + 1);
    } catch {
      // Try the next normalized JSON candidate.
    }
  }

  throw new Error("AI could not format this draft. Please generate it again.");
}

export function parseAiMailDraft(value: unknown): AiMailDraft {
  const parsed = decodeDraftValue(value);
  const subject = clean(parsed.subject, 180);
  const body = clean(parsed.body, 12000);
  if (!subject || !body) throw new Error("AI returned an incomplete draft. Please generate it again.");
  return { subject, body };
}
