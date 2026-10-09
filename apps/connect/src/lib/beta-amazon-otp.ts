export type AmazonOtpMessage = {
  id: string; sender: string; subject: string; preview: string; received_at: string;
};
export type AmazonOtp = {
  id: string; code: string | null; receivedAt: string;
  state: "received" | "older" | "unreadable";
};
export type AmazonOtpResponse = { latest: AmazonOtp | null; checkedAt: string };
export type AmazonOtpWait = { messageId: string | null; receivedAt: string | null; startedAt: number };

// A display limit, not a claim about Amazon's expiry policy. Amazon decides validity.
export const amazonOtpDisplayWindowMs = 10 * 60 * 1000;

export function isIsolatedAmazonOtpAccount(account: {
  workspace?: string; profileType?: string; onboardingBeta?: boolean;
  activationStage?: string | null; readOnlyPreview?: boolean;
}) {
  return account.workspace === "workforce" && account.profileType === "workforce"
    && account.onboardingBeta === true && !account.readOnlyPreview
    && account.activationStage?.startsWith("amazon_email_pilot:") === true;
}

function isAmazonVerification(message: AmazonOtpMessage) {
  const sender = message.sender.trim().toLowerCase();
  const address = sender.match(/<([^<>]+)>$/)?.[1] ?? sender;
  return /^account-update@amazon\.(?:in|co\.uk|com)$/.test(address)
    && /(?:verify your (?:new )?amazon account|amazon (?:email )?verification|amazon authentication)/i.test(message.subject)
    && /(?:one[ -]time password|\bOTP\b|verification code|security code)/i.test(message.preview);
}

/** Only the latest relevant email is considered. Never fall back to a superseded code. */
export function latestAmazonOtp(messages: AmazonOtpMessage[], now = Date.now()): AmazonOtp | null {
  const message = messages.filter(item => isAmazonVerification(item)
    && Number.isFinite(Date.parse(item.received_at)) && Date.parse(item.received_at) <= now + 60_000)
    .sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at) || b.id.localeCompare(a.id))[0];
  if (!message) return null;
  const base = { id: message.id, receivedAt: message.received_at };
  if (now - Date.parse(message.received_at) > amazonOtpDisplayWindowMs) return { ...base, state: "older", code: null };
  const text = message.preview.replace(/\s+/g, " ");
  const matches = [...text.matchAll(/(?:one[ -]time password\s*(?:\(OTP\))?|\bOTP\b|verification code|security code)\s*(?:is\b)?\s*[:：-]?\s*(\d{6})(?!\d)/gi)];
  const codes = [...new Set(matches.map(match => match[1]))];
  return codes.length === 1 ? { ...base, state: "received", code: codes[0] }
    : { ...base, state: "unreadable", code: null };
}

export function amazonOtpView(latest: AmazonOtp | null, wait: AmazonOtpWait | null, now = Date.now()) {
  if (wait && (!latest || latest.id === wait.messageId
    || Date.parse(latest.receivedAt) <= (wait.receivedAt ? Date.parse(wait.receivedAt) : wait.startedAt))) {
    return { state: "waiting" as const, code: null, delayed: now - wait.startedAt >= 90_000 };
  }
  if (!latest) return { state: "empty" as const, code: null, delayed: false };
  if (latest.state === "older" || now - Date.parse(latest.receivedAt) > amazonOtpDisplayWindowMs) {
    return { state: "older" as const, code: null, delayed: false };
  }
  return { state: latest.state, code: latest.code, delayed: false };
}
