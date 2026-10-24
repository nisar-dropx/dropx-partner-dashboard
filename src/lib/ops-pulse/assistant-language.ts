export const ASSISTANT_LANGUAGES = {
  "en-IN": "English", "hi-IN": "Hindi", "ml-IN": "Malayalam", "te-IN": "Telugu", "ta-IN": "Tamil"
} as const;
export type AssistantLanguage = keyof typeof ASSISTANT_LANGUAGES;
export function assistantLanguage(value: unknown): AssistantLanguage {
  return typeof value === "string" && Object.hasOwn(ASSISTANT_LANGUAGES, value) ? value as AssistantLanguage : "en-IN";
}
export function textMatchesLanguage(text: string, language: AssistantLanguage) {
  const scripts = { "hi-IN": /\p{Script=Devanagari}/u, "ml-IN": /\p{Script=Malayalam}/u, "te-IN": /\p{Script=Telugu}/u, "ta-IN": /\p{Script=Tamil}/u };
  if (language === "en-IN") return !/[\u0900-\u0d7f]/u.test(text);
  const script = scripts[language];
  const letters = [...text].filter(char => /\p{L}/u.test(char));
  // A station code or person's name may remain in English; an English answer with just a greeting may not.
  return letters.filter(char => script.test(char)).length >= Math.max(2, letters.length * .25);
}
export function matchingAssistantVoice<T extends { lang: string }>(voices: T[], language: AssistantLanguage): T | undefined {
  const normalize = (value: string) => value.toLowerCase().replaceAll("_", "-");
  return voices.find(v => normalize(v.lang) === normalize(language)) ?? voices.find(v => normalize(v.lang).split("-")[0] === language.split("-")[0]);
}
