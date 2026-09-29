import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { timeoutFetch } from '../utils/timeoutFetch';
import { DEFAULT_PORTAL_ACCOUNT } from '../config';
import type { StoredCloakSession } from '../types';

interface SessionRow {
  id: string;
  cookie: string;
  uploaded_by: string;
  status: 'active' | 'expired';
  created_at: string;
  expired_at: string | null;
  account_key?: string | null;
}

function normalizeAccountKey(accountKey?: string | null): string {
  const key = (accountKey ?? DEFAULT_PORTAL_ACCOUNT).trim();
  return key || DEFAULT_PORTAL_ACCOUNT;
}

function toStored(row: SessionRow): StoredCloakSession {
  return {
    id: row.id,
    cookie: row.cookie,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.created_at,
    status: row.status,
    expiredAt: row.expired_at,
    accountKey: row.account_key ?? DEFAULT_PORTAL_ACCOUNT,
  };
}

/**
 * Same shape and semantics as the shared `workforce_sessions` store, on
 * `cloak_sessions` / `cloak_login_state`. One active row per account_key;
 * every writer (cron, admin upload, token refresh) goes through upload().
 */
export class CloakSessionStore {
  private readonly client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
      global: { fetch: timeoutFetch() },
    });
  }

  async getActive(accountKey?: string): Promise<StoredCloakSession | null> {
    const { data, error } = await this.client
      .from('cloak_sessions')
      .select('*')
      .eq('status', 'active')
      .eq('account_key', normalizeAccountKey(accountKey))
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('CloakSessionStore.getActive failed', error);
      return null;
    }
    return data ? toStored(data as SessionRow) : null;
  }

  async upload(cookie: string, uploadedBy: string, accountKey?: string): Promise<StoredCloakSession> {
    const key = normalizeAccountKey(accountKey);
    await this.client
      .from('cloak_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('status', 'active')
      .eq('account_key', key);

    const { data, error } = await this.client
      .from('cloak_sessions')
      .insert({ cookie, uploaded_by: uploadedBy, status: 'active', account_key: key })
      .select('*')
      .single();
    if (error || !data) {
      throw new Error(`Failed to store cloak session: ${error?.message ?? 'unknown'}`);
    }
    return toStored(data as SessionRow);
  }

  async markExpired(id: string): Promise<void> {
    const { error } = await this.client
      .from('cloak_sessions')
      .update({ status: 'expired', expired_at: new Date().toISOString() })
      .eq('id', id);
    if (error) console.error('CloakSessionStore.markExpired failed', error);
  }

  /** Single-flight browser login across cron + admin calls. Fails open on DB errors. */
  async tryAcquireLoginLock(accountKey?: string, ttlSeconds = 150): Promise<boolean> {
    const key = normalizeAccountKey(accountKey);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const until = new Date(now + ttlSeconds * 1000).toISOString();

    const { data: updated, error } = await this.client
      .from('cloak_login_state')
      .update({ login_locked_until: until, updated_at: nowIso })
      .eq('account_key', key)
      .or(`login_locked_until.is.null,login_locked_until.lte."${nowIso}"`)
      .select('account_key')
      .maybeSingle();
    if (error) {
      console.error('CloakSessionStore.tryAcquireLoginLock failed', error);
      return true;
    }
    if (updated) return true;

    const { data: existing } = await this.client
      .from('cloak_login_state')
      .select('login_locked_until')
      .eq('account_key', key)
      .maybeSingle();
    const lockedUntil = existing?.login_locked_until ? Date.parse(existing.login_locked_until as string) : 0;
    if (lockedUntil && lockedUntil > now) return false;

    const { error: insertError } = await this.client
      .from('cloak_login_state')
      .insert({ account_key: key, login_locked_until: until, updated_at: nowIso });
    if (insertError) {
      if ((insertError as { code?: string }).code === '23505') return false;
      console.error('CloakSessionStore.tryAcquireLoginLock insert failed', insertError);
    }
    return true;
  }

  async releaseLoginLock(result: { ok: true } | { ok: false; error: string }, accountKey?: string): Promise<void> {
    const key = normalizeAccountKey(accountKey);
    const patch: Record<string, unknown> = {
      account_key: key,
      login_locked_until: null,
      updated_at: new Date().toISOString(),
    };
    if (result.ok) {
      patch.last_login_at = new Date().toISOString();
      patch.last_login_error = null;
    } else {
      patch.last_login_error = result.error.slice(0, 500);
    }
    const { error } = await this.client.from('cloak_login_state').upsert(patch, { onConflict: 'account_key' });
    if (error) console.error('CloakSessionStore.releaseLoginLock failed', error);
  }

  async getLoginState(accountKey?: string): Promise<{
    lastLoginAt: string | null;
    lastLoginError: string | null;
    loginLocked: boolean;
  }> {
    const { data } = await this.client
      .from('cloak_login_state')
      .select('last_login_at, last_login_error, login_locked_until')
      .eq('account_key', normalizeAccountKey(accountKey))
      .maybeSingle();
    const lockedUntil = data?.login_locked_until ? Date.parse(data.login_locked_until as string) : 0;
    return {
      lastLoginAt: (data?.last_login_at as string | null) ?? null,
      lastLoginError: (data?.last_login_error as string | null) ?? null,
      loginLocked: Boolean(lockedUntil && lockedUntil > Date.now()),
    };
  }
}
