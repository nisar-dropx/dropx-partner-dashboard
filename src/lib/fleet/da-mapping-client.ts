import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {timeoutFetch} from '@/lib/timeout-fetch';
import {fleetAuditFetch} from './audit-fetch';
// Scoped client keeps actor attribution identical in Fleet and OpsPulse without changing other APIs.
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
export const mappingAdmin=url&&key?createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false},global:{fetch:fleetAuditFetch(timeoutFetch())}}):null;
