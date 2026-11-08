import test from 'node:test';
import assert from 'node:assert/strict';
import {idfyRequestedFields} from './idfy-request-fields.ts';
const field=(name,value='Saved',extra={})=>({name:`block[${name}]`,value,required:true,disabled:false,readOnly:false,...extra});
test('address requests focus the three corrections and retain other saved fields',()=>{
 const fields=[field('a_add'),field('a_lan','',{required:false}),field('a_lno'),field('a_pin'),field('a_type','Current',{disabled:true}),field('a_pos','',{required:false})];
 for(const text of ['Kindly help us with the candidate detailed address, the nearest current house location & an alternate contact number','Help us with the detailed address along with the nearest landmark. Also provide an alternate contact number']){
  const result=idfyRequestedFields(fields,text);
  assert.deepEqual(result.primary.map(f=>f.name),['block[a_add]','block[a_lan]','block[a_lno]']);
  assert.deepEqual(result.other.map(f=>f.name),['block[a_pin]','block[a_pos]']);
 }
 assert.equal(fields[0].value,'Saved');
});
test('missing required fields remain visible and unfamiliar requests expose all editable controls',()=>{
 const fields=[field('a_add'),field('a_pin',''),field('a_lno','123'),field('locked','',{readOnly:true})];
 assert.deepEqual(idfyRequestedFields(fields,'Correct address').primary.map(f=>f.name),['block[a_add]','block[a_pin]']);
 assert.equal(idfyRequestedFields(fields,'Correct the reference information').primary.length,3);
});
