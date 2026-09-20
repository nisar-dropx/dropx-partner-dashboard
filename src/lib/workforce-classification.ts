import {supabaseAdmin} from './supabase-admin';
import {readAllRows} from './supabase-pagination';
export async function workforceClassification(company:string) {
  if(!supabaseAdmin)throw new Error('Database is unavailable.');
  const result=await readAllRows(supabaseAdmin.from('designations').select('id,code,name,category:designation_categories!designations_designation_category_id_fkey(people_module)').eq('company_id',company).order('id'));
  if(result.error)throw new Error('The designation master could not be verified.');
  const rows=(result.data??[]).filter(row=>(Array.isArray(row.category)?row.category[0]:row.category)?.people_module==='delivery_network');
  const ids=new Set(rows.map(row=>row.id)),keys=new Set(rows.flatMap(row=>[row.code,row.name].map(value=>String(value??'').trim().toLowerCase()).filter(Boolean)));
  return (person:{designation_id?:string|null;designation?:string|null})=>person.designation_id?ids.has(person.designation_id):keys.has(String(person.designation??'').trim().toLowerCase());
}
