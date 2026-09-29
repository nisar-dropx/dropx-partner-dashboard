import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';
import type { WorkforceSessionStore } from './WorkforceSessionStore';
import { SupabaseWorkforceSessionStore } from './SupabaseWorkforceSessionStore';
import { CloakSessionStore } from './CloakSessionStore';
import { timeoutFetch } from '../utils/timeoutFetch';

export function createWorkforceSessionStore(env: Env): WorkforceSessionStore {
  return new SupabaseWorkforceSessionStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createCloakSessionStore(env: Env): CloakSessionStore {
  return new CloakSessionStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Dashboard DB — where loss_report_* live (the Ops pages read them there). */
export function createDashboardSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { fetch: timeoutFetch() },
  });
}
