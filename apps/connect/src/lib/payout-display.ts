import type {PublishedPayoutEarning} from './published-payout-breakdown';
export function payoutEarningGroup(line:PublishedPayoutEarning){
  if(/KM_RUN|KM_RATE|KILOMET|\bFUEL\b/i.test(`${line.code} ${line.label}`))return 'Fuel allowance';
  if(['per_month','per_day','per_hour'].includes(line.basis))return 'Salary & guaranteed pay';
  return 'Activity pay & additions';
}
export function payoutUnit(line:PublishedPayoutEarning){
  if(/KM_RUN|KM_RATE|KILOMET|\bKM\b/i.test(`${line.code} ${line.label}`))return 'km';
  if(line.basis==='per_month')return 'month';
  if(line.basis==='per_day')return 'day';
  if(line.basis==='per_hour')return 'hour';
  if(/DELIVERY|RETURN|MFN|PACKET|SHIPMENT|PICKUP/i.test(`${line.code} ${line.label}`))return 'package';
  return 'unit';
}
export function payoutEarningGroups(lines:PublishedPayoutEarning[]){
  return ['Salary & guaranteed pay','Fuel allowance','Activity pay & additions'].map(title=>({title,lines:lines.filter(l=>l.amount!==0&&payoutEarningGroup(l)===title)})).filter(g=>g.lines.length);
}
