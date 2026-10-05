import {supabaseAdmin} from '@/lib/supabase-admin';
import type {SizeRule} from '@/lib/payment-volume';
export async function loadShipmentSizeRule(company:string){
 const result=await supabaseAdmin!.from('report_import_master').select('description').eq('company_id',company).eq('source_code','capacity_shipment_size_rule').eq('is_active',true).maybeSingle();
 try{return {rule:result.data?JSON.parse(result.data.description||'{}') as SizeRule:null,error:result.error?.message||null};}catch{return {rule:null,error:'Invalid size rule'};}
}
