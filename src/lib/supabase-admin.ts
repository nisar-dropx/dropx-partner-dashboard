import { createClient } from "@supabase/supabase-js";
import { noStoreFetch, timeoutFetch } from "./timeout-fetch";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = Boolean(supabaseUrl && serviceRoleKey);

export const supabaseAdmin = isSupabaseAdminConfigured
  ? createClient(supabaseUrl!, serviceRoleKey!, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      global: {
        // Next.js can cache server-side fetches outside POST route handlers.
        // Supabase service-role calls include lease/claim RPCs and must always
        // reach PostgREST instead of replaying an earlier empty response.
        fetch: timeoutFetch(noStoreFetch())
      }
    })
  : null;
