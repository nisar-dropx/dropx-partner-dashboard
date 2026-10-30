/** Highest N from ONBOARD-N codes. Ignores timestamp/non-numeric suffixes. */
export function maxOnboardingCampaignNumber(codes: Array<string | null | undefined>) {
  let maxNumber = 0;
  for (const code of codes) {
    const match = String(code ?? "").trim().match(/^ONBOARD-(\d+)$/i);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > maxNumber) maxNumber = value;
  }
  return maxNumber;
}

export function nextOnboardingCampaignCodeFallback(codes: Array<string | null | undefined>) {
  // Never use COUNT(*)+1: gaps or a max above the row count reuse an existing
  // code and trip whatsapp_campaigns_campaign_code_key before Meta send.
  return `ONBOARD-${maxOnboardingCampaignNumber(codes) + 1}`;
}

export function isDuplicateCampaignCodeError(message: unknown) {
  const text = String(message ?? "").toLowerCase();
  return text.includes("whatsapp_campaigns_campaign_code_key") ||
    (text.includes("duplicate key") && text.includes("campaign_code"));
}
