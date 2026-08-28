export type MotivationHistoryEntry = {
  key: string;
  message: string;
};

const FALLBACK_MESSAGES = [
  "A thoughtful step today can create meaningful progress for everyone.",
  "Fresh energy and steady focus can make today feel rewarding.",
  "Every well-considered action adds strength to the work ahead.",
  "Let curiosity and calm confidence guide the next good step.",
  "Small wins gathered with care can shape a remarkable day.",
  "Today holds another chance to make useful progress with purpose.",
  "Clear thinking and kind collaboration can move good work forward.",
  "A steady rhythm often turns ordinary moments into meaningful progress.",
  "Good work grows when clarity, care, and consistency come together.",
  "One positive contribution can brighten the direction of an entire team.",
  "Thoughtful effort today can open the door to stronger possibilities.",
  "A calm start can become the foundation of a productive day.",
  "Each new hour offers room for progress, learning, and confidence.",
  "Your contribution matters, and today is another chance to build well.",
  "Purposeful moments, handled with care, can create lasting momentum.",
  "Steady attention can turn today's opportunities into meaningful outcomes.",
  "Let today be shaped by clarity, warmth, and forward movement.",
  "A bright idea and a steady hand can move the day forward."
] as const;

const OFF_LIMITS_LANGUAGE = /\b(?:religion|religious|god|faith|caste|race|skin|gender|sexual|politic|election|disability|disabled|body|weight|mental health|young|old|lazy|loser|weak|quota|underperform|hustle|sacrifice|warrior|hero|superstar|rockstar|good morning|good afternoon|good evening)\b/i;

export function normalizeMotivation(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulWords(value: string) {
  const ignored = new Set(["a", "an", "and", "can", "for", "in", "is", "of", "on", "the", "to", "with", "your"]);
  return new Set(normalizeMotivation(value).split(" ").filter((word) => word.length > 2 && !ignored.has(word)));
}

export function isTooSimilarMotivation(candidate: string, recent: string[]) {
  const normalizedCandidate = normalizeMotivation(candidate);
  if (!normalizedCandidate) return true;
  const candidateWords = meaningfulWords(candidate);

  return recent.some((message) => {
    const normalizedRecent = normalizeMotivation(message);
    if (!normalizedRecent) return false;
    if (normalizedCandidate === normalizedRecent) return true;

    const recentWords = meaningfulWords(message);
    const common = [...candidateWords].filter((word) => recentWords.has(word)).length;
    const total = new Set([...candidateWords, ...recentWords]).size;
    return total > 0 && common / total >= 0.62;
  });
}

export function isSafeProfessionalMotivation(value: string) {
  const message = value.replace(/\s+/g, " ").trim();
  const words = message.split(" ").filter(Boolean);
  return message.length >= 24 &&
    message.length <= 130 &&
    words.length >= 6 &&
    words.length <= 18 &&
    !OFF_LIMITS_LANGUAGE.test(message) &&
    !/[#@“”"]|https?:\/\//i.test(message) &&
    !/[\r\n]/.test(message);
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectFallbackMotivation(seed: string, recent: string[]) {
  const start = stableHash(seed) % FALLBACK_MESSAGES.length;
  for (let offset = 0; offset < FALLBACK_MESSAGES.length; offset += 1) {
    const message = FALLBACK_MESSAGES[(start + offset) % FALLBACK_MESSAGES.length];
    if (!isTooSimilarMotivation(message, recent)) return message;
  }
  return FALLBACK_MESSAGES[start];
}

export function motivationPeriod(hour: number) {
  if (hour < 5) return "overnight";
  if (hour < 10) return "early-morning";
  if (hour < 12) return "late-morning";
  if (hour < 16) return "afternoon";
  if (hour < 18) return "late-afternoon";
  if (hour < 21) return "evening";
  return "late-evening";
}

export function motivationSlotKey(date: Date) {
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${localDate}:${motivationPeriod(date.getHours())}`;
}
