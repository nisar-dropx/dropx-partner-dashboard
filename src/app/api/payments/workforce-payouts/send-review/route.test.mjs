import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import * as windowPolicy from "../../../../../lib/payout-dispute-window.ts";
import { disputeWindowDays } from "../../../../../lib/payout-dispute-workflow-settings.ts";

const company = "00000000-0000-4000-8000-000000000001";
const worker = "00000000-0000-4000-8000-000000000002";
const station = "00000000-0000-4000-8000-000000000003";
const source = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

function fixture({days=2, canEdit=true, policyError=false}={}) {
  const calls=[]; const reads=[];
  const snapshot={schema_version:2,source:"workforce_payout_worksheet",dependency_hash:"dep",run:{period_start:"2026-10-01",period_end:"2026-10-31"},item:{workforce_id:worker,station_id:station,net_amount:100},lines:[],worksheet:{}};
  const db={
    from(table) {
      reads.push(table);
      const values={
        workforce_payout_dispute_workflows:{review_window_days:days},
        whatsapp_notification_configs:{id:"config",app_notification_enabled:true,is_enabled:true,whatsapp_profile_id:"profile",template_id:"template",template_name:"payout",template_language:"en",variable_mappings:{}},
        workforce:[{id:worker,full_name:"Sample",mobile:"9999999999",mobile_country_code:"91"}],
        whatsapp_settings:{is_enabled:true},
        whatsapp_profiles:{id:"profile",is_active:true,phone_number_id:"phone"},
        whatsapp_template_cache:{template_id:"template",name:"payout",language:"en",components:[]}
      };
      if (!(table in values)) throw Error(`Unexpected table ${table}`);
      const result={data:values[table],error:policyError&&table==="workforce_payout_dispute_workflows"?{message:"offline"}:null};
      const q={select:()=>q,eq:()=>q,is:()=>q,in:()=>q,maybeSingle:async()=>result,then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject)};
      return q;
    },
    async rpc(name,args) {
      if(name==="get_whatsapp_profile_access_token") return {data:"test-only",error:null};
      assert.equal(name,"workforce_publish_payout_notifications"); calls.push(args);
      return {data:{published:1,publication_ids:["publication"],whatsapp_publication_ids:[],app_notification_ids:[]},error:null};
    }
  };
  const mocks={
    "@/lib/payout-dispute-window":windowPolicy,
    "@/lib/payout-dispute-workflow-settings":{disputeWindowDays},
    "@vercel/functions":{waitUntil:()=>{throw Error("No delivery should be scheduled by fixture");}},
    "@/lib/supabase-admin":{supabaseAdmin:db},
    "@/lib/access-surface":{currentAdminAccessSurface:()=>"dashboard"},
    "@/lib/authorization":{getAuthorization:async()=>({userId:company,hasAllLocationAccess:false,locationScopeIds:[station]}),hasPermission:()=>canEdit},
    "@/lib/company-scope":{requireCompanyId:()=>company},
    "@/lib/workforce-payout-review-token":{workforcePayoutReviewTokenDetails:()=>({dependencyHash:"dep",calculationHash:"calc",publicationSnapshotHash:"snapshot",locationSetHash:"locations",status:"ready"})},
    "@/lib/workforce-payout-publication":{workforcePayoutLocationSetHash:()=>"locations",workforcePayoutPublicationSnapshotHash:()=>"snapshot"},
    "@/lib/stable-payout-worksheet":{isProvisionalPayoutDependencyHash:()=>false},
    "@/lib/workforce-payout-publication-limits":{chunkValues:(v)=>[v],MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION:100,MAX_WORKFORCE_PAYOUT_PUBLICATION_RPC_BYTES:1000000,WORKFORCE_NOTIFICATION_RECIPIENT_QUERY_CHUNK:100,serializedJsonByteLength:(v)=>JSON.stringify(v).length},
    "@/lib/workforce-payout-whatsapp":{WORKFORCE_PAYOUT_WHATSAPP_EVENT:"payout",normalizeWorkforceWhatsAppRecipient:()=>"919999999999",buildWorkforcePayoutTemplateComponents:()=>[],workforcePayoutWhatsAppValues:({reviewUntil})=>({review_deadline:reviewUntil})}
  };
  const mod={exports:{}};
  new Function("require","module","exports",output)((id)=>mocks[id]??{},mod,mod.exports);
  const body={periodStart:"2026-10-01",periodEnd:"2026-10-31",sendWhatsAppNotification:false,items:[{subjectType:"workforce",subjectId:worker,locationId:station,reviewToken:"signed",calculationSnapshot:snapshot}]};
  return {calls,reads,body,post:(overrides={},origin="https://dashboard.example")=>mod.exports.POST(new Request("https://dashboard.example/api/payments/workforce-payouts/send-review",{method:"POST",headers:{origin,"content-type":"application/json"},body:JSON.stringify({...body,...overrides})}))};
}

test("publishing passes the chosen deadline to the atomic writer and both notification modes",async()=>{
  for(const hours of [1,12,24,36,48,720]) for(const notify of [false,true]) {
    const f=fixture({days:7}); const before=Date.now();
    const response=await f.post({disputeWindowHours:hours,sendWhatsAppNotification:notify});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
    assert.equal(f.calls.length,1);
    const args=f.calls[0]; const end=Date.parse(args.p_review_until);
    assert.ok(end>=before+hours*3600000&&end<=Date.now()+hours*3600000);
    assert.equal(args.p_items[0].notification_config_snapshot.resolved_values.review_deadline,args.p_review_until);
    assert.equal(args.p_items[0].notification_config_snapshot.whatsapp_notification_enabled,notify);
    assert.deepEqual(args.p_locations,[station]);
    assert.equal(args.p_items[0].calculation_snapshot.item.net_amount,100);
  }
});

test("invalid supplied hours fail before reading data or publishing",async()=>{
  for(const hours of [null,false,true,[],{},"",0,-1,1.5,721,"24x"]) {
    const f=fixture(); const response=await f.post({disputeWindowHours:hours});
    assert.equal(response.status,400); assert.equal(f.calls.length,0); assert.equal(f.reads.length,0);
  }
});

test("legacy callers keep company defaults; policy outages and permissions still fail closed",async()=>{
  for(const [days,hours] of [[3,72],[null,48]]) {
    const f=fixture({days}); const before=Date.now(); assert.equal((await f.post()).status,200);
    assert.ok(Date.parse(f.calls[0].p_review_until)>=before+hours*3600000);
  }
  const outage=fixture({policyError:true}); assert.equal((await outage.post({disputeWindowHours:24})).status,503); assert.equal(outage.calls.length,0);
  const denied=fixture({canEdit:false}); assert.equal((await denied.post({disputeWindowHours:24})).status,403); assert.equal(denied.reads.length,0);
  const origin=fixture(); assert.equal((await origin.post({},"https://other.example")).status,403); assert.equal(origin.reads.length,0);
});
