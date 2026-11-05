import {createHmac, timingSafeEqual} from 'node:crypto';

export const PAYTAP_FIELDS = ['eventType','status','transactionId','vehicleNumber','transactionAt','quantity','amount','product','currency','stationName','odometer'] as const;
export type PaytapMapping = {paths:Partial<Record<typeof PAYTAP_FIELDS[number],string>>; paymentTypes:string[]; successStatuses:string[]; fuelProducts:string[]; amountDivisor:1|100; estimateMissingQuantity?:boolean};
export const EMPTY_PAYTAP_MAPPING:PaytapMapping = {paths:{},paymentTypes:[],successStatuses:[],fuelProducts:[],amountDivisor:1};
export function validateMapping(value:unknown):PaytapMapping {
 const v=value as PaytapMapping;
 if(!v||typeof v!=='object'||!v.paths||typeof v.paths!=='object'||![1,100].includes(v.amountDivisor))throw Error('Choose the amount unit and payment field paths.');
 const paths:PaytapMapping['paths']={};
 for(const key of PAYTAP_FIELDS){const path=v.paths[key];if(path){if(typeof path!=='string'||path.length>200||!path.split('.').every(x=>/^[a-zA-Z0-9_-]+$/.test(x)&&!['__proto__','constructor','prototype'].includes(x)))throw Error(`Invalid ${key} field path.`);paths[key]=path;}}
 for(const key of ['paymentTypes','successStatuses','fuelProducts'] as const)if(!Array.isArray(v[key])||v[key].length>30||v[key].some(x=>typeof x!=='string'||x.length>100))throw Error('Choose valid event, success and fuel values.');
 return {paths,paymentTypes:v.paymentTypes.map(x=>x.trim()).filter(Boolean),successStatuses:v.successStatuses.map(x=>x.trim()).filter(Boolean),fuelProducts:v.fuelProducts.map(x=>x.trim()).filter(Boolean),amountDivisor:v.amountDivisor,estimateMissingQuantity:v.estimateMissingQuantity===true};
}
export function mappingReady(m:PaytapMapping){return PAYTAP_FIELDS.slice(0,9).every(k=>k==='quantity'&&m.estimateMissingQuantity||m.paths[k])&&m.paymentTypes.length>0&&m.successStatuses.length>0&&m.fuelProducts.length>0;}
export function verifyPaytap(raw:Buffer,timestamp:string|null,signature:string|null,secret:string,now=Date.now()){
 if(!timestamp||!/^\d{10,12}$/.test(timestamp)||!signature||! /^[a-fA-F0-9]{64}$/.test(signature)||Math.abs(now/1000-Number(timestamp))>300)return false;
 const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
 return timingSafeEqual(expected,Buffer.from(signature,'hex'));
}
function field(body:unknown,path?:string):unknown {return path?.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as Record<string,unknown>)[k]:undefined,body);}
const scalar=(value:unknown)=>typeof value==='string'||typeof value==='number'?String(value).trim():'';
/** Parse money/qty scalars; strip ₹/INR/commas from statement exports. */
const number=(value:unknown)=>{
 if(typeof value==='number')return value;
 if(typeof value!=='string')return NaN;
 const cleaned=value.trim().replace(/^INR/i,'').replace(/[₹,\s]/g,'');
 return /^\d+(\.\d+)?$/.test(cleaned)?Number(cleaned):NaN;
};
export type PaytapFuel = {transaction_id:string;vehicle_no:string;card_ending?:string|null;transaction_at:string;transaction_date:string;fuel_quantity:number;fuel_amount:number;rate:number;product:string;station_name:string|null;odometer:number|null};
export type PaytapParseResult = {state:string;reason:string;fuel?:PaytapFuel};

/** PayTap Core business webhook: flat payment JSON with card_ending / ext_txn_id / txn_date. */
export function isPaytapCorePayment(body:Record<string,unknown>){
 return body.card_ending!=null&&body.ext_txn_id!=null&&body.txn_status!=null&&body.type!=='webhook.test'&&!(typeof body.imageUrl==='string'&&typeof body.extTxnId==='string');
}

/** Compact IST wall-clock `YYYYMMDDHHmmss` → Date (UTC instant). */
export function parsePaytapCompactIst(value:string):Date|null{
 if(!/^\d{14}$/.test(value))return null;
 const y=Number(value.slice(0,4)),mo=Number(value.slice(4,6)),d=Number(value.slice(6,8)),h=Number(value.slice(8,10)),mi=Number(value.slice(10,12)),s=Number(value.slice(12,14));
 if(mo<1||mo>12||d<1||d>31||h>23||mi>59||s>59)return null;
 const utc=Date.UTC(y,mo-1,d,h,mi,s)-330*60000;
 if(!Number.isFinite(utc))return null;
 const at=new Date(utc);
 // Round-trip guard against invalid calendar dates (e.g. 31 Feb).
 const ist=new Date(at.getTime()+330*60000);
 if(ist.getUTCFullYear()!==y||ist.getUTCMonth()+1!==mo||ist.getUTCDate()!==d)return null;
 return at;
}

export function normalizePaytapCardEnding(value:unknown):string{
 const digits=scalar(value).replace(/\D/g,'');
 return digits.length>=4?digits.slice(-4):'';
}

function parsePaytapCore(body:Record<string,unknown>,mapping:PaytapMapping):PaytapParseResult{
 const crdr=scalar(body.crdr).toUpperCase();
 // Core debit fuel is POS; empty type is treated as POS so nested mapping allowlists cannot block Core.
 const txnType=(scalar(body.transaction_type)||'POS').toUpperCase();
 const status=scalar(body.txn_status).toUpperCase();
 const description=scalar(body.description).toUpperCase();
 if(crdr==='CREDIT'||txnType==='B2C'||description.includes('CASHBACK')||description.includes('SURGE_CHARGE')){
  return {state:'ignored',reason:'Non-fuel PayTap credit/cashback retained without creating a fuel record.'};
 }
 if(crdr&&crdr!=='DEBIT')return {state:'review',reason:'Only DEBIT card payments are imported as fuel.'};
 // Always accept Core POS + PAYMENT_SUCCESS even when nested field-mapping lists differ.
 const allowedTypes=[...new Set(['POS',...mapping.paymentTypes.map(x=>x.trim().toUpperCase()).filter(Boolean)])];
 const allowedStatuses=[...new Set(['PAYMENT_SUCCESS',...mapping.successStatuses.map(x=>x.trim().toUpperCase()).filter(Boolean)])];
 if(!allowedTypes.includes(txnType))return {state:'review',reason:'Event type is not an approved fuel payment type.'};
 if(!allowedStatuses.includes(status))return {state:'review',reason:'Payment is not confirmed successful. Failed, pending and reversal events need review.'};
 const id=scalar(body.ext_txn_id);
 const card=normalizePaytapCardEnding(body.card_ending);
 // Core amounts are rupees; ignore nested amountDivisor=100 from legacy mapping.
 const amount=number(body.amount);
 const merchant=scalar(body.merchant_name).slice(0,200)||null;
 const at=parsePaytapCompactIst(scalar(body.txn_date));
 const plate=scalar(body.vehicle_reg_hint||body.vehicle_no).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);
 if(!id||id.length>200||card.length!==4||!at)return {state:'review',reason:'Missing transaction ID, card ending or PayTap timestamp.'};
 if(!Number.isFinite(amount)||Math.round(amount*100)<=0||amount>=1e10)return {state:'review',reason:'Fuel amount is missing or invalid.'};
 // Core payloads never include litres; always amount-only until dated location prices fill quantity.
 const day=new Date(at.getTime()+330*60000).toISOString().slice(0,10);
 return {state:'ready',reason:'Verified PayTap Core fuel payment',fuel:{
  transaction_id:id,vehicle_no:plate,card_ending:card,transaction_at:at.toISOString(),transaction_date:day,
  fuel_quantity:0,fuel_amount:Math.round(amount*100)/100,rate:0,product:'',station_name:merchant,odometer:null
 }};
}

export function parsePaytap(body:Record<string,unknown>,mapping:PaytapMapping):PaytapParseResult{
 if(body.type==='webhook.test')return {state:'test',reason:'Signature verified. Test events do not create fuel records.'};
 if(typeof body.imageUrl==='string'&&typeof body.extTxnId==='string')return {state:'attachment',reason:'Receipt event retained with transaction reference; no fuel entry created.'};
 if(isPaytapCorePayment(body))return parsePaytapCore(body,mapping);
 if(!mappingReady(mapping))return {state:'review',reason:'Payment field mapping has not been verified. Configure it from a real payment event.'};
 const get=(k:typeof PAYTAP_FIELDS[number])=>field(body,mapping.paths[k]);
 if(!mapping.paymentTypes.includes(scalar(get('eventType'))))return {state:'review',reason:'Event type is not an approved fuel payment type.'};
 if(!mapping.successStatuses.includes(scalar(get('status'))))return {state:'review',reason:'Payment is not confirmed successful. Failed, pending and reversal events need review.'};
 if(!mapping.fuelProducts.includes(scalar(get('product'))))return {state:'review',reason:'Product is not an approved fuel product.'};
 if(scalar(get('currency'))!=='INR')return {state:'review',reason:'Only INR fuel payments are supported.'};
 const id=scalar(get('transactionId')),plate=scalar(get('vehicleNumber')).toUpperCase().replace(/[^A-Z0-9]/g,''),date=scalar(get('transactionAt'));
 const quantityMissing=get('quantity')==null||get('quantity')==='';
 const estimate=quantityMissing&&mapping.estimateMissingQuantity===true;
 const qty=estimate?0:number(get('quantity')),amount=number(get('amount'))/mapping.amountDivisor,odo=get('odometer')==null?null:number(get('odometer'));
 if(!id||id.length>200||!plate||plate.length>20||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(date)||!Number.isFinite(Date.parse(date)))return {state:'review',reason:'Missing transaction ID, vehicle number or timestamp with timezone.'};
 if((!estimate&&(!Number.isFinite(qty)||Math.round(qty*1000)<=0||qty>=1e9))||!Number.isFinite(amount)||Math.round(amount*100)<=0||amount>=1e10||(!estimate&&amount/qty>=1e9)||(odo!==null&&(!Number.isFinite(odo)||odo<0||odo>=1e11)))return {state:'review',reason:'Fuel litres, amount or odometer is missing or invalid.'};
 const at=new Date(date);const day=new Date(at.getTime()+330*60000).toISOString().slice(0,10);
 return {state:'ready',reason:'Verified fuel payment',fuel:{transaction_id:id,vehicle_no:plate,transaction_at:at.toISOString(),transaction_date:day,fuel_quantity:Math.round(qty*1000)/1000,fuel_amount:Math.round(amount*100)/100,rate:estimate?0:Math.round(amount/qty*1000)/1000,product:scalar(get('product')),station_name:scalar(get('stationName')).slice(0,200)||null,odometer:odo}};
}

/** Build a Core-shaped body from a fleet_card statement / export row. */
export function statementRowToPaytapBody(row:Record<string,unknown>):Record<string,unknown>|null{
 const key=(...names:string[])=>{
  for(const name of names){
   const found=Object.keys(row).find(k=>k.trim().toLowerCase()===name.toLowerCase());
   if(found!=null&&row[found]!=null&&String(row[found]).trim()!=='')return row[found];
  }
  return undefined;
 };
 const amount=number(key('amount','txn amount','transaction amount','debit','debit amount'));
 const credit=number(key('credit','credit amount'));
 const crdrRaw=scalar(key('crdr','dr/cr','type','txn type','transaction type'));
 const card=normalizePaytapCardEnding(key('card_ending','card ending','card number','masked card','card no','card'));
 let ext=scalar(key('ext_txn_id','ext txn id','transaction id','txn id','rrn','reference','utr'));
 const merchant=scalar(key('merchant_name','merchant','merchant name','outlet','station'));
 const status=scalar(key('txn_status','status','payment status'))||'PAYMENT_SUCCESS';
 const vehicleHint=scalar(key('vehicle','vehicle number','vehicle reg','registration','reg no'));
 let txnDate=scalar(key('txn_date','transaction date','txn datetime','date time','datetime','date'));
 if(!ext){
  // Stable synthetic id when exports omit RRN: date+card+amount+merchant.
  if(!card||!Number.isFinite(amount)||!txnDate)return null;
  ext=`stmt_${txnDate.replace(/\D/g,'').slice(0,14)}_${card}_${Math.round(amount*100)}_${merchant.slice(0,24).replace(/\W+/g,'_')}`;
 }
 let crdr=crdrRaw.toUpperCase();
 if(!crdr){
  if(Number.isFinite(credit)&&credit>0&&!(Number.isFinite(amount)&&amount>0))crdr='CREDIT';
  else crdr='DEBIT';
 }
 if(crdr==='DR')crdr='DEBIT';
 if(crdr==='CR')crdr='CREDIT';
 const spent=crdr==='CREDIT'?(Number.isFinite(credit)?credit:amount):(Number.isFinite(amount)?amount:credit);
 if(!Number.isFinite(spent)||spent<=0||card.length!==4)return null;
 // Normalize date to compact IST.
 let compact='';
 if(/^\d{14}$/.test(txnDate))compact=txnDate;
 else{
  const parsed=Date.parse(txnDate);
  if(Number.isFinite(parsed)){
   const ist=new Date(parsed+330*60000);
   compact=`${ist.getUTCFullYear()}${String(ist.getUTCMonth()+1).padStart(2,'0')}${String(ist.getUTCDate()).padStart(2,'0')}${String(ist.getUTCHours()).padStart(2,'0')}${String(ist.getUTCMinutes()).padStart(2,'0')}${String(ist.getUTCSeconds()).padStart(2,'0')}`;
  }else{
   const m=txnDate.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
   if(!m)return null;
   let dd=Number(m[1]),mm=Number(m[2]),yy=Number(m[3]);
   if(yy<100)yy+=2000;
   // Prefer DD/MM/YYYY for India exports when day>12 or ambiguous.
   if(dd<=12&&mm>12){const t=dd;dd=mm;mm=t;}
   compact=`${yy}${String(mm).padStart(2,'0')}${String(dd).padStart(2,'0')}${String(Number(m[4]||0)).padStart(2,'0')}${String(Number(m[5]||0)).padStart(2,'0')}${String(Number(m[6]||0)).padStart(2,'0')}`;
  }
 }
 if(!parsePaytapCompactIst(compact))return null;
 return {
  ext_txn_id:ext,card_ending:card,amount:String(spent),crdr,txn_status:status.toUpperCase().includes('FAIL')?status:'PAYMENT_SUCCESS',
  transaction_type:crdr==='CREDIT'?'B2C':'POS',txn_date:compact,merchant_name:merchant||undefined,
  description:crdr==='CREDIT'?'STATEMENT_CREDIT':undefined,vehicle_reg_hint:vehicleHint||undefined
 };
}
