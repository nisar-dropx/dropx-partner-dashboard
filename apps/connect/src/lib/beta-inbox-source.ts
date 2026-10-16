import { receivedMailMatches, plainMail } from './beta-inbox';

type ReceivedMail = { id: string; to: string[]; message_id: string; text?: string; html?: string };
const indexes = new Map<string, { id: string; expires: number }>();
// Metadata-only, bounded cache. Email contents/codes never persist in this cache.
export async function betaReceivedMail(address: string, messageId: string) {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return null;
  const get = async (path: string) => {
    const response = await fetch(`https://api.resend.com/emails/receiving${path}`, {
      headers: { Authorization: `Bearer ${key}` }, cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('Email source unavailable');
    return response.json();
  };
  const cacheKey = `${address.toLowerCase()}:${messageId}`;
  const saved = indexes.get(cacheKey);
  let id = saved && saved.expires > Date.now() ? saved.id : null;
  let after = '';
  const deadline = Date.now() + 15000;
  // Old saved excerpts remain readable if the upstream archive is unavailable.
  for (let page = 0; !id && page < 10 && Date.now() < deadline; page++) {
    const list = await get(`?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`) as { data: ReceivedMail[]; has_more: boolean };
    for (const mail of list.data ?? []) {
      if (!mail.to?.some(to => to.toLowerCase() === address.toLowerCase())) continue;
      if (indexes.size >= 1000) indexes.clear();
      indexes.set(`${address.toLowerCase()}:${mail.message_id}`, { id: mail.id, expires: Date.now() + 3600_000 });
      if (receivedMailMatches(mail, address, messageId)) id = mail.id;
    }
    if (id || !list.has_more || !list.data?.length) break;
    after = list.data[list.data.length - 1].id;
    await new Promise(resolve => setTimeout(resolve, 550));
  }
  if (!id) return null;
  const mail = await get(`/${encodeURIComponent(id)}`) as ReceivedMail;
  if (!receivedMailMatches(mail, address, messageId)) throw new Error('Email identity mismatch');
  return { body: (mail.text || plainMail(mail.html || '')).slice(0, 100_000), linkContent: `${mail.text || ''} ${mail.html || ''}`.slice(0, 200_000) };
}
