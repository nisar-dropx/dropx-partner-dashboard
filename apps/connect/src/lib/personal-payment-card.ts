/** Explicit individual terms only. Existing mappings keep their current precedence. */
export function personalPaymentCard(mapping:{payment_values?:Record<string,unknown>|null;effective_from?:string|null;effective_to?:string|null;provider_id?:string|null;station_id?:string|null;pay_type?:string|null}){
 const v=mapping.payment_values;
 if(Number(v?.DROPX_PERSONAL_TERMS)!==1)return null;
 const read=(key:string)=>{const n=Number(v?.[key]??0);if(!Number.isFinite(n)||n<0)throw new Error('Invalid individual payment terms. Contact Workforce.');return n;};
 const daily=mapping.pay_type==='MG_PER_DAY';
 if(!daily&&mapping.pay_type!=='PER_PACKET')throw new Error('Unsupported individual payment terms.');
 const values=[read('MG_PER_DAY'),read('DELIVERY'),read('CRETURN'),read('SELLER_PICKUP'),read('SLLLER_RETURN')];
 return {id:'personal:'+mapping.effective_from+':'+mapping.pay_type+':'+values.join(':'),company_id:'',name:'Individual payment stage',provider_id:mapping.provider_id||'',station_id:mapping.station_id||null,designation_id:null,pay_type:daily?'fixed_daily' as const:'per_shipment' as const,effective_from:mapping.effective_from||'',effective_to:mapping.effective_to||null,delivery_rate:values[1],return_rate:values[2],mfn_rate:values[3],mfn_return_rate:values[4],fuel_rate:0,fixed_amount:values[0],guarantee_amount:0,status:'active' as const};
}
