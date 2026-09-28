export function excludeFinanceRecipients(recipients: string[], financeEmails: Iterable<string>) {
  const blocked = new Set(Array.from(financeEmails, (email) => email.trim().toLowerCase()));
  return recipients.filter((email) => !blocked.has(email.trim().toLowerCase()));
}
