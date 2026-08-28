export type MotivationHistoryEntry = {
  key: string;
  message: string;
};

export type DashboardMotivationContext = "workday" | "birthday" | "sick_leave" | "leave" | "weekly_off";

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

const CONTEXT_FALLBACK_MESSAGES = {
  workday: FALLBACK_MESSAGES,
  birthday: [
    "Wishing you a birthday filled with bright moments and meaningful memories.",
    "May your birthday bring warm smiles, fresh possibilities, and joyful moments.",
    "May this birthday open a year of bright and meaningful possibilities.",
    "Warm birthday wishes for a day that feels genuinely special and joyful.",
    "Celebrate your day with warmth, joy, and plenty of bright moments.",
    "May your special day bring smiles, calm joy, and fresh beginnings."
  ],
  sick_leave: [
    "Take today gently; rest and recovery deserve your full attention.",
    "May today bring the quiet rest and steady recovery you need.",
    "Give yourself room to rest; everything else can wait for now.",
    "A calm day of rest can be a meaningful step toward recovery.",
    "Let today move softly, with enough space for rest and recovery.",
    "Rest without pressure today, and allow recovery to set the pace."
  ],
  leave: [
    "Enjoy this pause, and let today move comfortably at your pace.",
    "Make space for what matters today, with no rush and no pressure.",
    "May this leave day feel calm, refreshing, and entirely your own.",
    "Step away fully today; a genuine pause has value of its own.",
    "Let this day offer fresh space, easy moments, and a slower rhythm.",
    "Take the day as it comes, with room to pause and recharge."
  ],
  weekly_off: [
    "Let today be a genuine pause, with room to recharge fully.",
    "Your weekly pause is here; enjoy a calmer rhythm today.",
    "Step away from routine and give today a lighter pace.",
    "Make this off day refreshing, unhurried, and entirely your own.",
    "A quiet reset today can make the week ahead feel brighter.",
    "Pause, recharge, and enjoy the freedom of an unhurried day."
  ]
} as const satisfies Record<DashboardMotivationContext, readonly string[]>;

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

export function selectFallbackMotivation(
  seed: string,
  recent: string[],
  context: DashboardMotivationContext = "workday"
) {
  const messages = CONTEXT_FALLBACK_MESSAGES[context];
  const start = stableHash(seed) % messages.length;
  for (let offset = 0; offset < messages.length; offset += 1) {
    const message = messages[(start + offset) % messages.length];
    if (!isTooSimilarMotivation(message, recent)) return message;
  }
  return messages[start];
}

function dateParts(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { month: Number(iso[2]), day: Number(iso[3]) };
  const display = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return display ? { month: Number(display[2]), day: Number(display[1]) } : null;
}

export function dashboardMotivationContext({
  date = new Date(),
  dateOfBirth = "",
  status = "",
  statusKind,
  statusLabel = ""
}: {
  date?: Date;
  dateOfBirth?: string;
  status?: string;
  statusKind?: "attendance" | "leave";
  statusLabel?: string | null;
}): DashboardMotivationContext {
  const birthday = dateParts(dateOfBirth);
  if (birthday && birthday.month === date.getMonth() + 1 && birthday.day === date.getDate()) return "birthday";

  const attendanceState = `${status} ${statusLabel ?? ""}`.toLowerCase().replaceAll("_", " ");
  if (statusKind === "leave") {
    return /\b(?:sick|medical|illness|sl)\b/.test(attendanceState) ? "sick_leave" : "leave";
  }
  if (/\b(?:weekly off|week off|rest day|scheduled off|wo|off)\b/.test(attendanceState)) return "weekly_off";
  return "workday";
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

export function motivationSlotKey(date: Date, context: DashboardMotivationContext = "workday") {
  const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${localDate}:${motivationPeriod(date.getHours())}:${context}`;
}
