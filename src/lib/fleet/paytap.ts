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
const number=(value:unknown)=>typeof value==='number'?value:typeof value==='string'&&/^\d+(\.\d+)?$/.test(value.trim())?Number(value):NaN;
export type PaytapFuel = {transaction_id:string;vehicle_no:string;transaction_at:string;transaction_date:string;fuel_quantity:number;fuel_amount:number;rate:number;product:string;station_name:string|null;odometer:number|null};
export function parsePaytap(body:Record<string,unknown>,mapping:PaytapMapping):{state:string;reason:string;fuel?:PaytapFuel}{
 if(body.type==='webhook.test')return {state:'test',reason:'Signature verified. Test events do not create fuel records.'};
 if(typeof body.imageUrl==='string'&&typeof body.extTxnId==='string')return {state:'attachment',reason:'Receipt event retained with transaction reference; no fuel entry created.'};
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
