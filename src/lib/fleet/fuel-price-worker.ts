import {supabaseAdmin} from '@/lib/supabase-admin';
import {searchFuelPrice} from './fuel-price-search';
export async function runFuelPriceLookup(companyId:string,id:string){
 if(!supabaseAdmin)throw Error('Database unavailable.');
 const credentials=await supabaseAdmin.rpc('fleet_fuel_price_credentials',{p_company:companyId});
 if(credentials.error)throw Error('Fuel price settings are unavailable.');
 const config=credentials.data?.[0];
 const key=config?.api_key||process.env.OPENAI_API_KEY;
 if(!config||!key)throw Error('Enable internet prices and save an OpenAI API key in PayTap settings.');
 const claim=await supabaseAdmin.rpc('fleet_fuel_price_claim',{p_company:companyId,p_id:id});
 if(claim.error)throw Error('Could not claim the price lookup.');
 const price=claim.data?.[0];
 if(!price)return {message:'Already sourced, being searched, or in retry cooldown.'};
 let result;
 try{result=await searchFuelPrice({city:price.city,price_date:price.price_date,fuel_type:price.fuel_type},config.model,key);}
 catch(e){result={rate:null,url:null,title:null,evidence:null,reason:e instanceof Error?e.message:'Internet lookup failed.'};}
 const saved=await supabaseAdmin.rpc('fleet_fuel_price_finish',{p_company:companyId,p_id:id,p_rate:result.rate,p_url:result.url,p_title:result.title,p_evidence:result.evidence,p_model:config.model,p_reason:result.reason});
 if(saved.error)throw Error('Could not save the sourced price. It will remain pending.');
 return {message:result.rate?`₹${result.rate}/L sourced for ${price.city} on ${price.price_date}. Pending estimates updated.`:result.reason};
}
