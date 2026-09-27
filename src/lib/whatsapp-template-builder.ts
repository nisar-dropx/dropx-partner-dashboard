export type TemplateDraft = {
  name: string; language: string; category: string; body: string;
  header: string; footer: string; samples: Record<string, string>;
  buttonText: string; buttonUrl: string;
};
export const templateLanguages = [
  ["en", "English"], ["en_US", "English (US)"], ["hi", "Hindi"],
  ["ml", "Malayalam"], ["ta", "Tamil"], ["te", "Telugu"],
  ["kn", "Kannada"], ["bn", "Bengali"], ["mr", "Marathi"], ["or", "Odia"]
] as const;
export function bodyVariables(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1])))].sort((a,b) => a-b);
}
export function buildTemplatePayload(draft: TemplateDraft) {
  const name = String(draft.name ?? "").trim();
  const body = String(draft.body ?? "").trim();
  const header = String(draft.header ?? "").trim();
  const footer = String(draft.footer ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(name)) throw new Error("Use a lowercase template name with letters, numbers and underscores.");
  if (!templateLanguages.some(([code]) => code === draft.language)) throw new Error("Select a supported language.");
  if (!["UTILITY", "MARKETING"].includes(draft.category)) throw new Error("Select Utility or Marketing.");
  if (!body || body.length > 1024) throw new Error("Message must contain 1–1,024 characters.");
  if (header.length > 60 || footer.length > 60) throw new Error("Header and footer must be at most 60 characters.");
  if (/[{}]/.test(header + footer)) throw new Error("Use plain text in the header and footer. Add variables to the message.");
  if (/[{}]/.test(body.replace(/\{\{\d+\}\}/g, ""))) throw new Error("Use numbered variables such as {{1}} and {{2}}.");
  const variables = bodyVariables(body);
  if (variables.some((n,i) => n !== i+1)) throw new Error("Variables must start at {{1}} and have no gaps.");
  if (/^\{\{\d+\}\}|\{\{\d+\}\}$/.test(body)) throw new Error("Add message text before and after variables.");
  if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) throw new Error("Separate variables with meaningful message text.");
  const examples = variables.map(n => String(draft.samples?.[String(n)] ?? "").trim());
  if (examples.some(value => !value || value.length > 200 || /[{}]/.test(value))) throw new Error("Add a short fictional example for every variable.");
  const components: Record<string, unknown>[] = [];
  if (header) components.push({type:"HEADER",format:"TEXT",text:header});
  components.push({type:"BODY",text:body,...(examples.length ? {example:{body_text:[examples]}} : {})});
  if (footer) components.push({type:"FOOTER",text:footer});
  const buttonText = String(draft.buttonText ?? "").trim(), buttonUrl = String(draft.buttonUrl ?? "").trim();
  if (buttonText || buttonUrl) {
    if (!buttonText || buttonText.length > 25) throw new Error("Button label must contain 1–25 characters.");
    let url: URL;
    try { url = new URL(buttonUrl); } catch { throw new Error("Enter a valid HTTPS button URL."); }
    if (url.protocol !== "https:" || url.username || url.password || /[{}]/.test(buttonUrl) || buttonUrl.length > 2000) throw new Error("Use a fixed HTTPS button URL without credentials or variables.");
    components.push({type:"BUTTONS",buttons:[{type:"URL",text:buttonText,url:buttonUrl}]});
  }
  return {name,language:draft.language,category:draft.category,parameter_format:"POSITIONAL",components};
}

