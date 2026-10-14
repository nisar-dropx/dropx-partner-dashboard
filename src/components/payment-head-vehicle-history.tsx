import { supabaseAdmin } from '@/lib/supabase-admin';

export async function PaymentHeadVehicleHistory({ companyId, headId }: { companyId: string; headId: string }) {
  const result = await supabaseAdmin!.from('payment_head_vehicle_policy_changes')
    .select('id,previous_scope,new_scope,changed_at,profiles:actor_id(full_name)')
    .eq('company_id', companyId).eq('payment_head_id', headId).order('changed_at', { ascending: false }).limit(20);
  if (result.error) return <p role="status">Vehicle-policy change history is temporarily unavailable.</p>;
  if (!result.data?.length) return null;
  const label = (value: string | null) => value === 'owned_station' ? 'Company-owned vehicle required' : value === 'none' ? 'No vehicle required' : 'Not configured';
  return <details style={{ margin: '12px 0' }}><summary>Vehicle requirement history · latest 20 changes</summary>
    <ul>{result.data.map(row => {
      const actor = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
      return <li key={row.id}>{label(row.previous_scope)} → {label(row.new_scope)} · {actor?.full_name || 'System configuration'} · {new Date(row.changed_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</li>;
    })}</ul>
  </details>;
}
