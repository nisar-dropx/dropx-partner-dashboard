import test from "node:test";
import assert from "node:assert/strict";
import {buildTemplatePayload,bodyVariables} from "./whatsapp-template-builder.ts";
import {templateGraphRequest,listMetaTemplates} from "./whatsapp-template-meta.ts";
const draft={name:"station_update",language:"en",category:"UTILITY",body:"Hello {{1}}, your station {{2}} update is ready.",header:"Station update",footer:"DropX",samples:{"1":"Example Associate","2":"TEST"},buttonText:"Open DropX One",buttonUrl:"https://one.dropxlogistics.com"};
test("builds Meta positional examples, header, footer and CTA",()=>{
 const value=buildTemplatePayload(draft);
 assert.equal(value.name,"station_update");
 assert.deepEqual(value.components[1].example,{body_text:[["Example Associate","TEST"]]});
 assert.equal(value.components[3].buttons[0].url,"https://one.dropxlogistics.com");
});
test("plain messages and repeated variables work",()=>{
 assert.deepEqual(bodyVariables("Hi {{1}}, {{1}} please see {{2}}."),[1,2]);
 assert.equal(buildTemplatePayload({...draft,body:"Your update is ready.",header:"",footer:"",buttonText:"",buttonUrl:""}).components.length,1);
});
for(const [label,patch] of [
 ["uppercase name",{name:"Bad Name"}],["blank message",{body:" "}],["too long",{body:"a".repeat(1025)}],
 ["unsupported language",{language:"unknown"}],["authentication category",{category:"AUTHENTICATION"}],
 ["variable gap",{body:"Hello {{2}}, update ready."}],["zero variable",{body:"Hello {{0}}, update ready."}],
 ["named variable",{body:"Hello {{name}}, update ready."}],["missing sample",{samples:{}}],
 ["variable at edge",{body:"{{1}} your update is ready."}],["adjacent variables",{body:"Hi {{1}} {{2}}, update ready."}],
 ["bad CTA",{buttonUrl:"javascript:alert(1)"}],["credential CTA",{buttonUrl:"https://user:secret@example.com"}],
 ["dynamic CTA",{buttonUrl:"https://example.com/{{1}}"}],["long header",{header:"a".repeat(61)}]
])test("rejects "+label,()=>assert.throws(()=>buildTemplatePayload({...draft,...patch})));
test("Meta create sends only configured template, never a message",async()=>{
 let seen;
 const result=await templateGraphRequest("v25.0","123","token",{payload:buildTemplatePayload(draft)},async(url,init)=>{
  seen={url:String(url),...init};return new Response(JSON.stringify({id:"999",status:"PENDING",category:"UTILITY"}),{status:200});
 });
 assert.equal(result.status,"PENDING");assert.equal(seen.method,"POST");
 assert.equal(seen.url,"https://graph.facebook.com/v25.0/123/message_templates");
 assert.equal(JSON.parse(seen.body).name,"station_update");
});
test("Meta pagination stays on configured Graph endpoint",async()=>{
 let n=0;
 const rows=await listMetaTemplates("v25.0","123","token",async(url)=>{
  n++;assert.equal(new URL(url).hostname,"graph.facebook.com");
  if(n===1)return new Response(JSON.stringify({data:[{id:"1",name:"one",status:"PENDING"}],paging:{next:"https://untrusted.example/?access_token=secret",cursors:{after:"cursor2"}}}));
  assert.equal(new URL(url).searchParams.get("after"),"cursor2");
  return new Response(JSON.stringify({data:[{id:"2",name:"two",status:"REJECTED",rejected_reason:"INVALID_FORMAT"}]}));
 });
 assert.equal(rows.length,2);assert.equal(rows[1].status,"REJECTED");
});
test("Meta permission errors are surfaced without tokens",async()=>{
 await assert.rejects(()=>templateGraphRequest("v25.0","123","SECRET",{},async()=>new Response(JSON.stringify({error:{message:"Invalid token SECRET"}}),{status:403})),/Invalid token \[redacted\]/);
});
test("incomplete pagination fails instead of invalidating live templates",async()=>{
 await assert.rejects(()=>listMetaTemplates("v25.0","123","token",async()=>new Response(JSON.stringify({data:[],paging:{next:"https://graph.facebook.com",cursors:{after:"same"}}}))),/incomplete/);
});
test("invalid account is rejected before network access",async()=>{
 await assert.rejects(()=>templateGraphRequest("v25.0","../me","token",{},async()=>{throw Error("must not fetch");}),/configuration/);
});
test("malformed Meta response cannot clear saved approval statuses",async()=>{
 await assert.rejects(()=>listMetaTemplates("v25.0","123","token",async()=>new Response(JSON.stringify({}))),/incomplete template list/);
});
