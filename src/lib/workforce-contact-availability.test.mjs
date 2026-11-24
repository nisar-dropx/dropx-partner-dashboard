import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source=stripTypeScriptTypes(readFileSync(new URL('./workforce-contact-availability.ts',import.meta.url),'utf8').replace(/^import .*supabase-admin.*;\r?\n/m,''));
const factory=new Function('supabaseAdmin',source.replace(/export /g,'')+';return {checkWorkforceEmailAvailability,checkWorkforceMobileAvailability,assertWorkforceContactsAvailable};');
const existing={id:'old',company_id:'company',email:'shared_name@example.com',mobile:'9876543210',mobile_country_code:'91',full_name:'Existing person',dropx_id:'CHM7061'};
function setup(records){
  const queries=[];
  const db={from(table){queries.push(table);const filters=[];let limit=5;
    const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},
      ilike(k,v){const literal=v.replace(/\\([\\%_])/g,'$1').toLowerCase();filters.push(r=>String(r[k]).toLowerCase()===literal);return q;},
      limit(n){limit=n;return q;},then(resolve){return Promise.resolve({data:(records[table]??[]).filter(r=>filters.every(f=>f(r))).slice(0,limit),error:null}).then(resolve);}};
    return q;}};
  return {...factory(db),queries};
}
test('contacts shared by another category are available; same-category matches block',async()=>{
  const f=setup({contractors:[existing]});
  const input={companyId:'company',register:'workforce',email:existing.email,mobile:existing.mobile};
  await f.assertWorkforceContactsAvailable(input);
  assert.deepEqual(f.queries,['workforce','workforce']);
  assert.equal((await f.checkWorkforceEmailAvailability({...input,register:'contractors',email:'SHARED_NAME@EXAMPLE.COM'})).status,'taken');
  assert.equal((await f.checkWorkforceMobileAvailability({...input,register:'contractors'})).status,'taken');
  await assert.rejects(()=>f.assertWorkforceContactsAvailable({...input,register:'contractors'}),/already registered/);
});
test('edit excludes only itself in the selected category and preserves company and country isolation',async()=>{
  const f=setup({contractors:[existing]});
  const input={companyId:'company',register:'contractors',excludeRegister:'contractors',excludeId:'old',email:existing.email,mobile:existing.mobile};
  await f.assertWorkforceContactsAvailable(input);
  assert.equal((await f.checkWorkforceEmailAvailability({...input,excludeId:null,companyId:'other'})).status,'available');
  assert.equal((await f.checkWorkforceMobileAvailability({...input,excludeId:null,mobileCountryCode:'971'})).status,'available');
  assert.equal((await f.checkWorkforceEmailAvailability({...input,excludeId:null,email:'sharedXname@example.com'})).status,'available');
});
test('invalid contacts are rejected before querying',async()=>{
  const f=setup({});
  assert.equal((await f.checkWorkforceEmailAvailability({companyId:'company',email:'bad'})).status,'invalid');
  assert.equal((await f.checkWorkforceMobileAvailability({companyId:'company',mobile:'1'})).status,'invalid');
  assert.deepEqual(f.queries,[]);
});
