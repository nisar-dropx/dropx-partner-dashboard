export type BetaMail = {
  id: string; sender: string; subject: string; preview: string; received_at: string;
  action_url?: string | null; action_urls?: unknown; internet_message_id?: string;
};
export type BetaMailDetail = BetaMail & { body: string; excerpt: boolean; links: Array<{ url: string; label: string }>; code: string | null; superseded?: boolean };

export function senderAddress(sender: string) {
  return (sender.trim().match(/<([^<>]+)>$/)?.[1] ?? sender.trim()).toLowerCase();
}
export function mailCategory(mail: Pick<BetaMail, 'sender' | 'subject'>) {
  if (/password|reset|sign[ -]?in|authentication|verification code|verify your.*account|security code|otp/i.test(mail.subject)) return 'Account access';
  if (/(^|\.)idfy\.(com|in)$/.test(senderAddress(mail.sender).split('@')[1] ?? '')) return 'IDfy';
  return 'Amazon & updates';
}
export function plainMail(html: string) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:br\s*\/?|\/p|\/div|\/tr|\/li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) => { const n = parseInt(hex || dec, hex ? 16 : 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; })
    .replace(/\n\s*\n\s*\n/g, '\n\n').trim().slice(0, 100_000);
}

// Render mail as text; only real service domains receive clickable actions.
export function betaMailLinks(mail: BetaMail, content: string) {
  const domain = senderAddress(mail.sender).split('@')[1] ?? '';
  const amazon = /(^|\.)amazon\.(in|com|co\.uk)$/.test(domain);
  const idfy = /(^|\.)idfy\.(com|in)$/.test(domain);
  if (!amazon && !idfy) return [];
  const raw = [mail.action_url, ...(Array.isArray(mail.action_urls) ? mail.action_urls : []),
    ...(content.match(/https:\/\/[^\s<>"']+/gi) ?? [])];
  const links = new Map<string, { url: string; label: string }>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    try {
      const url = new URL(item.replace(/&amp;/gi, '&').replace(/[\]).,;]+$/, ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      const host = url.hostname;
      if (amazon && /(^|\.)amazon\.(in|com|co\.uk)$/.test(host)
        && (/^\/ap\//.test(url.pathname) || /^\/account-management\/invitation/.test(url.pathname))) {
        links.set(url.href, { url: url.href, label: /password|reset/i.test(mail.subject + url.pathname) ? 'Open Amazon password reset' : 'Open Amazon link' });
      } else if (idfy && ((host === 'portal.idfy.com' && url.pathname === '/tokens' && url.searchParams.has('p'))
        || (host === 'capture.kyc.idfy.com' && /^\/v2\/captures\/?$/.test(url.pathname) && url.searchParams.has('t'))
        || (host === '360.idfy.com' && /^\/noauth\/[^/]+/.test(url.pathname))
        || (host === 'register.eshram.gov.in'))) {
        links.set(url.href, { url: url.href, label: host === 'register.eshram.gov.in' ? 'Open e-Shram' : 'Open IDfy request' });
      }
    } catch { /* Ignore malformed email links. */ }
  }
  return [...links.values()].slice(0, 12);
}

export function mailCode(mail: BetaMail, body: string, now = Date.now()) {
  if (!/(^|\.)amazon\.(in|com|co\.uk)$/.test(senderAddress(mail.sender).split('@')[1] ?? '')) return null;
  const age = now - Date.parse(mail.received_at);
  if (!Number.isFinite(age) || age < -60_000 || age > 10 * 60_000) return null;
  const codes = [...new Set([...body.matchAll(/(?:one[ -]time password\s*(?:\(OTP\))?|\bOTP\b|verification code|security code)\s*(?:is\b)?\s*[:：-]?\s*(\d{6})(?!\d)/gi)].map(m => m[1]))];
  return codes.length === 1 ? codes[0] : null;
}

export function receivedMailMatches(mail: { to?: string[]; message_id?: string; id?: string }, address: string, messageId: string) {
  return Array.isArray(mail.to) && mail.to.some(to => senderAddress(to) === address.trim().toLowerCase())
    && (mail.message_id === messageId || mail.id === messageId);
}
