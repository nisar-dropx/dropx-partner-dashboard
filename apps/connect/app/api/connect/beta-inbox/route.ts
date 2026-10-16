import { NextRequest, NextResponse } from 'next/server';
import { requireBetaPrivateAccount } from '@/lib/beta-private-account';
import { betaMailLinks, mailCode, mailCategory, senderAddress, type BetaMail } from '@/lib/beta-inbox';
import { betaReceivedMail } from '@/lib/beta-inbox-source';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
export async function GET(request: NextRequest) {
  let context;
  try { context = await requireBetaPrivateAccount(request); }
  catch { return NextResponse.json({ error: 'Sign in to your own beta account to open its inbox.' }, { status: 403, headers }); }
  const { account, candidate, db } = context;
  try {
    const id = request.nextUrl.searchParams.get('messageId');
    if (id) {
      if (!/^[\da-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Message not found.' }, { status: 404, headers });
      const result = await db.from('workforce_amazon_email_pilot_messages').select('id,sender,subject,preview,received_at,action_url,action_urls,internet_message_id')
        .eq('company_id', account.companyId).eq('candidate_id', account.id).eq('id', id).maybeSingle();
      if (result.error) throw new Error('Message unavailable');
      if (!result.data) return NextResponse.json({ error: 'Message not found.' }, { status: 404, headers });
      const mail = result.data as BetaMail;
      const full = await betaReceivedMail(candidate.alias_email, mail.internet_message_id!).catch(() => null);
      const body = full?.body || mail.preview;
      let code = mailCode(mail,body), superseded = false;
      if (code) {
        const recent = await db.from('workforce_amazon_email_pilot_messages').select('id,sender,subject,received_at')
          .eq('company_id',account.companyId).eq('candidate_id',account.id).gt('received_at',mail.received_at)
          .order('received_at',{ascending:false}).limit(30);
        superseded = Boolean(recent.error || recent.data?.some(m => mailCategory(m)==='Account access'
          && /(^|\.)amazon\.(in|com|co\.uk)$/.test(senderAddress(m.sender).split('@')[1]??'')));
        if (superseded) code = null;
      }
      // Never return the internal provider ID or arbitrary upstream JSON.
      return NextResponse.json({ id: mail.id, sender: mail.sender, subject: mail.subject, received_at: mail.received_at,
        preview: mail.preview, body, excerpt: !full, links: betaMailLinks(mail, full?.linkContent || body), code, superseded }, { headers });
    }
    const offset = Number(request.nextUrl.searchParams.get('offset') || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) return NextResponse.json({ error: 'Invalid page.' }, { status: 400, headers });
    const result = await db.from('workforce_amazon_email_pilot_messages').select('id,sender,subject,received_at')
      .eq('company_id', account.companyId).eq('candidate_id', account.id)
      .order('received_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 29);
    if (result.error) throw new Error('Inbox unavailable');
    return NextResponse.json({ email: candidate.alias_email, messages: result.data, nextOffset: result.data.length === 30 ? offset + 30 : null,
      checkedAt: new Date().toISOString() }, { headers });
  } catch { return NextResponse.json({ error: 'Your inbox could not load. Please retry.' }, { status: 503, headers }); }
}
