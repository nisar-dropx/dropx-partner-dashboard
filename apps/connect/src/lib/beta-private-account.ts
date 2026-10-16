import type { NextRequest } from 'next/server';
import { requireConnectAccount, type ConnectAccount } from './connect-auth';
import { supabaseAdmin } from './supabase-admin';
import { isIsolatedAmazonOtpAccount } from './beta-amazon-otp';
import { resolveConnectPreview } from './connect-preview';

/** The browser supplies an account selector, never a mailbox or an IDfy identity. */
export async function requireBetaPrivateAccount(request: NextRequest) {
  if (await resolveConnectPreview()) throw new Error('Private mail is unavailable in preview');
  const account = await requireConnectAccount(
    request.nextUrl.searchParams.get('profileType') as ConnectAccount['profileType'],
    request.nextUrl.searchParams.get('accountId') ?? '', { allowActivationOnly: true },
  );
  if (!isIsolatedAmazonOtpAccount(account) || !supabaseAdmin) throw new Error('Private beta account required');
  const candidate = await supabaseAdmin.from('workforce_amazon_email_pilot_candidates')
    .select('id,company_id,alias_email,inbox_status,continuation_status')
    .eq('company_id', account.companyId).eq('id', account.id).is('closed_at', null).maybeSingle();
  if (candidate.error || !candidate.data || candidate.data.inbox_status === 'suspended') throw new Error('Mailbox unavailable');
  return { account, candidate: candidate.data, db: supabaseAdmin };
}
