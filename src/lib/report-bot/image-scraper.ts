/**
 * Deterministic Dark Store completion scrapers.
 * OCR / message text in → structured Analysis out. No model judgment.
 */
import type { Analysis, AnalysisCheck, CheckStatus, ExtractedField, Verdict } from "@/lib/report-bot/logic";

export const SCRAPABLE_SLUGS = [
  "cycle-count-sbc-src",
  "expiry-removed",
  "stowing-pendency",
  "dg-fuel-level"
] as const;

export type ScrapableSlug = (typeof SCRAPABLE_SLUGS)[number];

export type ScrapableCandidate = {
  id: string;
  name: string;
  slug?: string | null;
  category?: string | null;
  rules: string[];
  feedback_hint?: string | null;
  auto_reply_policy?: "never" | "normal" | "silent" | null;
  requires_pass_to_close?: boolean;
  /** Today's request status when known — waiting rows beat already-received ones. */
  requestStatus?: string | null;
};

export type ScraperInput = {
  candidates: ScrapableCandidate[];
  businessDate: string;
  caption?: string | null;
  text?: string | null;
  bundleTexts?: string[];
  hasImage: boolean;
  /** Full OCR / scraped text from the screenshot (may be empty for text-only reports). */
  ocrText?: string;
};

const SLUG_SET = new Set<string>(SCRAPABLE_SLUGS);

export function isScrapableSlug(slug: string | null | undefined): slug is ScrapableSlug {
  return Boolean(slug && SLUG_SET.has(slug));
}

export function scrapableCandidates(candidates: ScrapableCandidate[]) {
  return candidates.filter((row) => isScrapableSlug(guessSlug(row)));
}

/** Prefer explicit slug; fall back to known report names. */
export function guessSlug(candidate: Pick<ScrapableCandidate, "slug" | "name">): ScrapableSlug | null {
  const slug = String(candidate.slug ?? "").trim().toLowerCase();
  if (isScrapableSlug(slug)) return slug;
  const name = String(candidate.name ?? "").toLowerCase();
  if (/cycle\s*count/.test(name) && /sbc|src/.test(name)) return "cycle-count-sbc-src";
  if (/expiry\s*removed/.test(name)) return "expiry-removed";
  if (/stowing\s*pendenc/.test(name)) return "stowing-pendency";
  if (/\bdg\b.*fuel|fuel\s*level/.test(name)) return "dg-fuel-level";
  return null;
}

function normalizeOcr(text: string) {
  return String(text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[|¦]/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .trim()
    .slice(0, 40_000);
}

function isWaitingRequest(status: string | null | undefined) {
  return !status || ["pending", "overdue", "missed"].includes(status);
}

function combinedMessageText(input: ScraperInput) {
  return [input.text, input.caption, ...(input.bundleTexts ?? [])]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function field(label: string, value: string | number | null | undefined): ExtractedField | null {
  if (value === null || value === undefined || value === "") return null;
  return { label, value: String(value) };
}

function fieldsOf(...items: Array<ExtractedField | null>): ExtractedField[] {
  return items.filter((item): item is ExtractedField => Boolean(item));
}

function check(rule: string, status: CheckStatus, note: string): AnalysisCheck {
  return { rule, status, note };
}

function verdictFromChecks(checks: AnalysisCheck[]): Verdict {
  if (checks.some((row) => row.status === "unclear")) return "needs_review";
  if (checks.some((row) => row.status === "fail")) return "fail";
  return "pass";
}

function analysis(partial: {
  matched: ScrapableCandidate;
  checks: AnalysisCheck[];
  fields: ExtractedField[];
  summary: string;
  feedback?: string;
  confidence?: number;
  is_report?: boolean;
}): Analysis {
  const verdict = partial.is_report === false ? "not_report" : verdictFromChecks(partial.checks);
  const isReport = partial.is_report !== false;
  const hint = partial.matched.feedback_hint?.trim() || "";
  let feedback = partial.feedback ?? "";
  if (!feedback && isReport) {
    if (verdict === "pass") feedback = "Looks good — thank you.";
    else if (verdict === "fail") feedback = hint || "Please complete the remaining items and share a fresh update.";
    else feedback = "Could not fully read this evidence. Please resend a clearer screenshot.";
  }
  return {
    is_report: isReport,
    matched_report_type_id: isReport ? partial.matched.id : null,
    verdict,
    confidence: partial.confidence ?? (verdict === "needs_review" ? 0.55 : 0.95),
    checks: partial.checks,
    extracted_summary: partial.summary,
    extracted_fields: partial.fields,
    feedback,
    open_actions: [],
    source: "scraper"
  };
}

/** Pull an integer that appears near a label in OCR text. */
export function quantityNearLabel(ocrText: string, labels: RegExp[]): number | null {
  const text = normalizeOcr(ocrText);
  if (!text) return null;
  for (const label of labels) {
    // Allow OCR noise (newlines, colons, "tasks") between label and digits.
    const near = new RegExp(`${label.source}[^0-9OolI]{0,48}([0-9OolI]{1,6})`, "i");
    const match = near.exec(text);
    if (match) {
      const digits = match[1].replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
      if (/^\d+$/.test(digits)) return Number(digits);
    }
    const reverse = new RegExp(`([0-9OolI]{1,6})[^0-9OolI]{0,24}${label.source}`, "i");
    const reverseMatch = reverse.exec(text);
    if (reverseMatch) {
      const digits = reverseMatch[1].replace(/[Oo]/g, "0").replace(/[Il]/g, "1");
      if (/^\d+$/.test(digits)) return Number(digits);
    }
  }
  return null;
}

export function parseCycleCountOcr(ocrText: string) {
  const text = normalizeOcr(ocrText);
  const looksLike = /unified\s*cycle\s*count|boh\s*guided|simple\s*bin\s*count/i.test(text);
  const boh = quantityNearLabel(text, [/boh\s*guided/i, /cycle\s*count/i]);
  const sbc = quantityNearLabel(text, [/simple\s*bin\s*count/i, /\bsbc\b/i]);
  const src = quantityNearLabel(text, [/ad\s*hoc/i, /\bsrc\b/i]);
  return { looksLike, boh, sbc, src, text };
}

export function analyseCycleCount(candidate: ScrapableCandidate, ocrText: string): Analysis {
  const parsed = parseCycleCountOcr(ocrText);
  const rules = candidate.rules.length ? candidate.rules : [
    "Read the Cycle Count, SBC and SRC task quantities from the device screenshot.",
    "Pass only when all three quantities are exactly 0.",
    "Any positive, missing, cropped or unreadable quantity remains pending; never assume it is zero."
  ];
  if (!parsed.looksLike && parsed.boh === null && parsed.sbc === null) {
    return analysis({
      matched: candidate,
      checks: [
        check(rules[0], "unclear", "Screenshot does not show the Unified Cycle Count / BOH Guided / Simple Bin Count screen."),
        check(rules[1], "unclear", "Cannot verify quantities from this image."),
        check(rules[2], "unclear", "Missing quantities stay pending.")
      ],
      fields: fieldsOf(field("Menu", "Not cycle-count screen")),
      summary: "Image is not a Cycle Count / SBC / SRC completion screen.",
      confidence: 0.9
    });
  }
  const missing: string[] = [];
  if (parsed.boh === null) missing.push("BOH Guided / Cycle Count");
  if (parsed.sbc === null) missing.push("Simple Bin Count (SBC)");
  if (parsed.src === null) missing.push("Ad Hoc / SRC");
  const values = [parsed.boh, parsed.sbc, parsed.src];
  const allZero = values.every((value) => value === 0);
  const anyPositive = values.some((value) => value !== null && value > 0);
  const checks: AnalysisCheck[] = [
    check(
      rules[0],
      missing.length ? "unclear" : "pass",
      missing.length
        ? `Could not read: ${missing.join(", ")}.`
        : `BOH Guided ${parsed.boh}, Simple Bin Count ${parsed.sbc}, Ad Hoc/SRC ${parsed.src}.`
    ),
    check(
      rules[1],
      missing.length ? "unclear" : allZero ? "pass" : "fail",
      missing.length
        ? "Missing quantity — cannot pass."
        : allZero
          ? "All three quantities are 0."
          : `Quantities are not all zero (BOH ${parsed.boh}, SBC ${parsed.sbc}, SRC ${parsed.src}).`
    ),
    check(
      rules[2],
      missing.length || anyPositive ? (missing.length ? "unclear" : "fail") : "pass",
      missing.length
        ? "Unreadable quantities remain pending."
        : anyPositive
          ? "Positive quantities remain pending."
          : "No positive or missing quantities."
    )
  ];
  return analysis({
    matched: candidate,
    checks,
    fields: fieldsOf(
      field("BOH Guided", parsed.boh),
      field("Simple Bin Count", parsed.sbc),
      field("Ad Hoc / SRC", parsed.src)
    ),
    summary: missing.length
      ? `Cycle count screen read partially; missing ${missing.join(", ")}.`
      : `Cycle count screen: BOH Guided ${parsed.boh}, SBC ${parsed.sbc}, SRC ${parsed.src}.`
  });
}

const MONTH_NAME_TO_NUM: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};

function pushCalendarDate(found: Set<string>, year: number, month: number, day: number) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return;
  found.add(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

function parseOneDateToken(token: string): string | null {
  const found = new Set<string>();
  const iso = /^\s*(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\b|T|\s|$)/.exec(token);
  if (iso) {
    pushCalendarDate(found, Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return [...found][0] ?? null;
  }
  const us = /^\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2})\b/.exec(token);
  if (us) {
    const a = Number(us[1]);
    const b = Number(us[2]);
    const year = Number(us[3]);
    if (a > 12) pushCalendarDate(found, year, b, a);
    else if (b > 12) pushCalendarDate(found, year, a, b);
    else pushCalendarDate(found, year, a, b);
    return [...found][0] ?? null;
  }
  const named = /^\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/.exec(token)
    || /^\s*([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d{2})\b/.exec(token);
  if (named) {
    if (/^\d/.test(named[1])) {
      const month = MONTH_NAME_TO_NUM[named[2].toLowerCase()];
      if (month) pushCalendarDate(found, Number(named[3]), month, Number(named[1]));
    } else {
      const month = MONTH_NAME_TO_NUM[named[1].toLowerCase()];
      if (month) pushCalendarDate(found, Number(named[3]), month, Number(named[2]));
    }
    return [...found][0] ?? null;
  }
  return null;
}

/** Parse calendar dates from OCR; returns YYYY-MM-DD when possible. */
export function parseExpiryDates(ocrText: string): string[] {
  const text = normalizeOcr(ocrText);
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g)) {
    pushCalendarDate(found, Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of text.matchAll(/\b(\d{1,2})[-\/.](\d{1,2})[-\/.](20\d{2})\b/g)) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const year = Number(match[3]);
    // Prefer MDY for Amazon US-style dashboards; fall back to DMY when day>12.
    if (a > 12) pushCalendarDate(found, year, b, a);
    else if (b > 12) pushCalendarDate(found, year, a, b);
    else pushCalendarDate(found, year, a, b);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(20\d{2})\b/g)) {
    const month = MONTH_NAME_TO_NUM[match[2].toLowerCase()];
    if (month) pushCalendarDate(found, Number(match[3]), month, Number(match[1]));
  }
  return [...found].sort();
}

export type ExpiryDueRow = {
  date: string;
  quantity: number | null;
  source: "expiration" | "shrink" | "row";
};

/**
 * Row-oriented expiry evidence from Excel photos, Ihm web dashboards, or pasted tables.
 * Prefers same-line quantity after the date; also accepts Quantity / Qty columns and
 * "Total Expired Items: N" summaries.
 */
export function parseExpiryDueRows(ocrText: string, businessDate: string): {
  looksLike: boolean;
  dates: string[];
  dueRows: ExpiryDueRow[];
  totalExpired: number | null;
} {
  const raw = String(ocrText ?? "").replace(/\u00a0/g, " ");
  const text = normalizeOcr(raw);
  const looksLike = /expir|shrink|inventory\s*expiration|expiration\s*audit|ihm\s*inventory|fcsku|fnsku|\basin\b|bin\s*:|total\s*expired|du-aa-\d+/i.test(text);
  const dates = parseExpiryDates(text);
  const totalMatch = /total\s*expired\s*items?\s*[:=]?\s*(\d{1,6})/i.exec(text);
  const totalExpired = totalMatch ? Number(totalMatch[1]) : null;

  const dueRows: ExpiryDueRow[] = [];
  const lines = raw.split(/\r?\n/).map((line) => line.replace(/[|¦]/g, " ").replace(/[ \t]+/g, " ").trim()).filter(Boolean);

  for (const line of lines) {
    if (/^(bin\s*name|product|expiration|shrink|quantity|asin|fcsku|fnsku|age|unit)\b/i.test(line) && !/\d{4}/.test(line)) continue;
    const dateMatches = [...line.matchAll(/\b(?:20\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[-\/.]\d{1,2}[-\/.]20\d{2}|\d{1,2}\s+[A-Za-z]{3,9}\s+20\d{2})\b/g)];
    if (!dateMatches.length) continue;

    let quantity: number | null = null;
    const qtyLabeled = /\b(?:qty|quantity)\b[^0-9]{0,12}(\d{1,7}(?:\.\d+)?)/i.exec(line)
      || /(\d{1,7}(?:\.\d+)?)\s*(?:unit|units|pcs?)\b/i.exec(line);
    if (qtyLabeled) quantity = Math.floor(Number(qtyLabeled[1]));

    // Excel / web row: date … date … quantity … unit
    if (quantity === null) {
      const afterLastDate = line.slice((dateMatches[dateMatches.length - 1]?.index ?? 0) + dateMatches[dateMatches.length - 1][0].length);
      const trailingQty = /(\d{1,7}(?:\.\d+)?)/.exec(afterLastDate);
      if (trailingQty) quantity = Math.floor(Number(trailingQty[1]));
    }

    for (const match of dateMatches) {
      const date = parseOneDateToken(match[0]);
      if (!date || date > businessDate) continue;
      const before = line.slice(0, match.index ?? 0).toLowerCase();
      const source = /shrink/.test(before) ? "shrink"
        : /expir/.test(before) ? "expiration"
          : "row";
      dueRows.push({ date, quantity, source });
    }
  }

  // Flat OCR blob with no reliable line breaks: keep legacy near-date quantity.
  if (!dueRows.length) {
    for (const date of dates.filter((value) => value <= businessDate)) {
      const [y, m, d] = date.split("-");
      const variants = [date, `${Number(m)}/${Number(d)}/${y}`, `${m}/${d}/${y}`, `${d}/${m}/${y}`];
      let quantity: number | null = null;
      for (const token of variants) {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const after = new RegExp(`${escaped}[^\\d]{0,64}(\\d{1,7}(?:\\.\\d+)?)`, "i").exec(text);
        if (after) {
          quantity = Math.floor(Number(after[1]));
          break;
        }
      }
      dueRows.push({ date, quantity, source: "row" });
    }
  }

  return { looksLike, dates, dueRows, totalExpired };
}

export function analyseExpiryRemoved(candidate: ScrapableCandidate, ocrText: string, businessDate: string): Analysis {
  const rules = candidate.rules.length ? candidate.rules : [
    "Check the Expiration column against today in Asia/Kolkata.",
    "Check the quantity for every current or past-date row.",
    "Pass only when there are no current or past-date rows with quantity above 0."
  ];
  const parsed = parseExpiryDueRows(ocrText, businessDate);
  if (!parsed.looksLike && !parsed.dates.length && parsed.totalExpired === null) {
    return analysis({
      matched: candidate,
      checks: [
        check(rules[0], "unclear", "Screenshot does not look like an expiry dashboard."),
        check(rules[1], "unclear", "No expiration dates could be read."),
        check(rules[2], "unclear", "Cannot verify clearance from this image.")
      ],
      fields: fieldsOf(field("Business Date", businessDate)),
      summary: "Image is not an expiry-removed dashboard screenshot."
    });
  }

  // Explicit empty summary from Amazon / Ops text tables.
  if (parsed.totalExpired === 0 && !parsed.dueRows.some((row) => (row.quantity ?? 0) > 0)) {
    return analysis({
      matched: candidate,
      checks: [
        check(rules[0], "pass", `Total Expired Items is 0 for ${businessDate}.`),
        check(rules[1], "pass", "No expired quantity remaining."),
        check(rules[2], "pass", "Expiry clearance confirmed.")
      ],
      fields: fieldsOf(field("Business Date", businessDate), field("Total Expired Items", 0)),
      summary: `Expiry clear for ${businessDate} (Total Expired Items: 0).`
    });
  }

  const dueRows = parsed.dueRows;
  const dueDates = [...new Set(dueRows.map((row) => row.date))].sort();
  const positiveDue = dueRows.some((row) => (row.quantity ?? 0) > 0)
    || (parsed.totalExpired !== null && parsed.totalExpired > 0);
  const qtyUnclear = dueDates.length > 0
    && !positiveDue
    && parsed.totalExpired === null
    && dueRows.every((row) => row.quantity === null);
  const earliest = parsed.dates[0] ?? null;
  const latest = parsed.dates.length ? parsed.dates[parsed.dates.length - 1] : null;
  const checks: AnalysisCheck[] = [
    check(
      rules[0],
      parsed.dates.length || parsed.totalExpired !== null ? "pass" : "unclear",
      parsed.dates.length
        ? `Read expiration/shrink dates from ${earliest} to ${latest} (business date ${businessDate}).`
        : parsed.totalExpired !== null
          ? `Total Expired Items reported as ${parsed.totalExpired}.`
          : "No expiration dates were readable."
    ),
    check(
      rules[1],
      !dueDates.length && !(parsed.totalExpired && parsed.totalExpired > 0)
        ? "pass"
        : positiveDue
          ? "fail"
          : qtyUnclear
            ? "unclear"
            : "pass",
      !dueDates.length && !(parsed.totalExpired && parsed.totalExpired > 0)
        ? "No current or past-date rows visible."
        : positiveDue
          ? `Current/past-date rows still show quantity above 0 (${dueDates.join(", ") || `total ${parsed.totalExpired}`}).`
          : qtyUnclear
            ? `Current/past dates visible (${dueDates.join(", ")}) but quantity could not be confirmed as 0.`
            : "Current/past-date rows show quantity 0."
    ),
    check(
      rules[2],
      !dueDates.length && !(parsed.totalExpired && parsed.totalExpired > 0)
        ? "pass"
        : positiveDue
          ? "fail"
          : qtyUnclear
            ? "unclear"
            : "pass",
      !dueDates.length && !positiveDue && !qtyUnclear
        ? "No current/past-date stock remaining on the visible rows."
        : "Expiry clearance is not confirmed."
    )
  ];
  return analysis({
    matched: candidate,
    checks,
    fields: fieldsOf(
      field("Business Date", businessDate),
      field("Earliest Expiration Date", earliest),
      field("Latest Expiration Date", latest),
      field("Current/past dates visible", dueDates.length ? dueDates.join(", ") : "none"),
      parsed.totalExpired !== null ? field("Total Expired Items", parsed.totalExpired) : null
    ),
    summary: !dueDates.length && !(parsed.totalExpired && parsed.totalExpired > 0)
      ? `Expiry dashboard clear for ${businessDate}; visible dates start at ${earliest ?? "n/a"}.`
      : `Expiry dashboard still shows current/past dates: ${dueDates.join(", ") || `total ${parsed.totalExpired}`}.`
  });
}

export function parseStowingQuantity(messageText: string): number | null {
  const text = String(messageText ?? "").trim();
  if (!text) return null;
  const patterns = [
    /stowing\s*pendenc\w*[^0-9]{0,20}(\d{1,6})/i,
    /pendenc\w*[^0-9]{0,20}(\d{1,6})/i,
    /(?:^|\n)\s*(?:qty|quantity|count)?\s*[:=]?\s*(\d{1,6})\s*$/im,
    /(?:^|\n)\s*(\d{1,6})\s*(?:pcs?|units?|qty)?\s*$/im
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  // Bare number-only reply (common when replying to the reminder).
  if (/^\s*\d{1,6}\s*$/.test(text)) return Number(text.trim());
  return null;
}

export function analyseStowingPendency(candidate: ScrapableCandidate, messageText: string): Analysis {
  const rules = candidate.rules.length ? candidate.rules : [
    "Extract stowing pendency quantity from a reply or new message.",
    "Pass only when the quantity is exactly 0; a positive quantity remains pending."
  ];
  const qty = parseStowingQuantity(messageText);
  const mentions = /stowing|pendenc/i.test(messageText) || qty !== null;
  if (!mentions || qty === null) {
    return analysis({
      matched: candidate,
      checks: [
        check(rules[0], "unclear", "No stowing pendency quantity found in the message."),
        check(rules[1], "unclear", "Cannot pass without a readable quantity.")
      ],
      fields: fieldsOf(field("Message", messageText.slice(0, 120) || "(empty)")),
      summary: "No stowing pendency quantity could be scraped from the message."
    });
  }
  const checks: AnalysisCheck[] = [
    check(rules[0], "pass", `Stowing pendency quantity is ${qty}.`),
    check(rules[1], qty === 0 ? "pass" : "fail", qty === 0 ? "Quantity is 0." : `Quantity ${qty} is still pending.`)
  ];
  return analysis({
    matched: candidate,
    checks,
    fields: fieldsOf(field("Stowing pendency", qty)),
    summary: `Stowing pendency reported as ${qty}.`
  });
}

export function analyseDgFuel(candidate: ScrapableCandidate, input: { hasImage: boolean; ocrText: string; messageText: string }): Analysis {
  const rules = candidate.rules.length ? candidate.rules : ["A DG fuel level image is attached."];
  const named = /\bdg\b|fuel\s*level|diesel|generator/i.test(`${input.messageText}\n${input.ocrText}`);
  if (!input.hasImage) {
    return analysis({
      matched: candidate,
      checks: [check(rules[0], "fail", "No image attached.")],
      fields: [],
      summary: "DG fuel level requires an image."
    });
  }
  // Presence of an image for this open request is enough; OCR cues raise confidence.
  return analysis({
    matched: candidate,
    checks: [check(rules[0], "pass", named ? "DG/fuel image attached and labels recognised." : "DG fuel level image attached.")],
    fields: fieldsOf(field("Image", "attached"), named ? field("Labels", "DG/fuel cues found") : null),
    summary: "DG fuel level image received.",
    feedback: "",
    confidence: named ? 0.95 : 0.85
  });
}

/**
 * Pick which scrapable report this evidence is for.
 * Uses OCR signatures, message text, and the open candidate list.
 */
export function matchScrapable(input: ScraperInput): ScrapableCandidate | null {
  const list = scrapableCandidates(input.candidates);
  if (!list.length) return null;
  const ocr = normalizeOcr(input.ocrText ?? "");
  const message = combinedMessageText(input);
  const hay = `${message}\n${ocr}`.toLowerCase();

  const score = (candidate: ScrapableCandidate) => {
    const slug = guessSlug(candidate);
    let points = 0;
    if (slug === "cycle-count-sbc-src") {
      if (/unified\s*cycle\s*count|boh\s*guided|simple\s*bin\s*count/.test(hay)) points += 5;
      if (/cycle\s*count|sbc|src/.test(message.toLowerCase())) points += 2;
      if (input.hasImage) points += 1;
    }
    if (slug === "expiry-removed") {
      if (/expir|shrink|expiration\s*audit|ihm\s*inventory|total\s*expired|fcsku|fnsku/.test(hay)) points += 5;
      if (/expiry\s*removed|expiry\s*dashboard|expired\s*items/.test(message.toLowerCase())) points += 2;
      if (input.hasImage) points += 1;
      if (!input.hasImage && /asin|bin\s*:|total\s*expired|shrink\s*date/i.test(message)) points += 3;
    }
    if (slug === "stowing-pendency") {
      if (/stowing|pendenc/.test(message.toLowerCase())) points += 5;
      if (parseStowingQuantity(message) !== null) points += 3;
      if (!input.hasImage && parseStowingQuantity(message) !== null) points += 2;
      // Bare number + image is almost never stowing — prefer screenshot types.
      if (input.hasImage && !/stowing|pendenc/.test(message.toLowerCase())) points -= 4;
    }
    if (slug === "dg-fuel-level") {
      if (/\bdg\b|fuel\s*level|diesel/.test(hay)) points += 5;
      if (input.hasImage && list.length === 1) points += 2;
    }
    // Prefer requests still waiting over already-received (resubmit / bulk mix).
    if (isWaitingRequest(candidate.requestStatus)) points += 2;
    else if (candidate.requestStatus === "received") points -= 1;
    // Single open scrapable request with matching media kind gets a tie-break.
    if (list.length === 1) points += 1;
    return points;
  };

  const ranked = [...list].map((candidate) => ({ candidate, points: score(candidate) }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      // Stable tie-break: waiting request first, then name.
      return Number(isWaitingRequest(b.candidate.requestStatus)) - Number(isWaitingRequest(a.candidate.requestStatus));
    });
  if (!ranked[0] || ranked[0].points <= 0) {
    // Text-only stowing: prefer a waiting stowing request and a bare number.
    const stowing = list
      .filter((row) => guessSlug(row) === "stowing-pendency")
      .sort((a, b) => Number(isWaitingRequest(b.requestStatus)) - Number(isWaitingRequest(a.requestStatus)))[0];
    if (stowing && !input.hasImage && parseStowingQuantity(message) !== null) return stowing;
    // Image + single waiting scrapable request → that request.
    const waiting = list.filter((row) => isWaitingRequest(row.requestStatus));
    if (input.hasImage && waiting.length === 1) return waiting[0];
    if (input.hasImage && list.length === 1) return list[0];
    return null;
  }
  if (ranked.length > 1 && ranked[0].points === ranked[1].points && ranked[0].points < 3) return null;
  return ranked[0].candidate;
}

/** Run deterministic scrapers. Returns null when this evidence is not one of the four types. */
export function analyseWithImageScraper(input: ScraperInput): Analysis | null {
  const matched = matchScrapable(input);
  if (!matched) return null;
  const slug = guessSlug(matched);
  if (!slug) return null;
  const message = combinedMessageText(input);
  const ocr = input.ocrText ?? "";

  if (slug === "stowing-pendency") return analyseStowingPendency(matched, message || ocr);
  if (slug === "cycle-count-sbc-src") {
    if (!input.hasImage && !ocr) {
      return analysis({
        matched,
        checks: [check("Read the Cycle Count, SBC and SRC task quantities from the device screenshot.", "unclear", "No screenshot attached.")],
        fields: [],
        summary: "Cycle count report needs a device screenshot."
      });
    }
    return analyseCycleCount(matched, ocr || message);
  }
  if (slug === "expiry-removed") {
    const evidence = (ocr || message).trim();
    if (!evidence) {
      return analysis({
        matched,
        checks: [check("Check the Expiration column against today in Asia/Kolkata.", "unclear", "No expiry evidence attached.")],
        fields: fieldsOf(field("Business Date", input.businessDate)),
        summary: "Expiry removed report needs a dashboard screenshot, Excel photo, or pasted expiry table."
      });
    }
    return analyseExpiryRemoved(matched, evidence, input.businessDate);
  }
  if (slug === "dg-fuel-level") {
    return analyseDgFuel(matched, { hasImage: input.hasImage, ocrText: ocr, messageText: message });
  }
  return null;
}
