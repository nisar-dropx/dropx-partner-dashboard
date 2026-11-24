import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db=new PGlite();
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const company=id(1);
await db.exec(`create role anon;create role authenticated;create table workforce_categories(code text);
insert into workforce_categories values('pickers');`);
for(const table of ['employees','contractors','workforce','helpers','vendors','workforce_pickers']){
  await db.exec(`create table ${table}(id uuid primary key,company_id uuid,full_name text,email text,mobile text,mobile_country_code text);`);
}
await db.exec(`insert into workforce values('${id(2)}','${company}','Grandfathered A','old@example.com','9000000000','91'),
('${id(3)}','${company}','Grandfathered B','old@example.com','9000000000','91');`);
const migration=readFileSync(new URL('../supabase/migrations/20261124105416_category_scoped_people_contacts.sql',import.meta.url),'utf8');
await db.exec(migration);await db.exec(migration);
async function insert(table,n,email='shared@example.com',mobile='9876543210',country='91',tenant=company){
  return db.query(`insert into ${table} values($1,$2,'Test',$3,$4,$5)`,[id(n),tenant,email,mobile,country]);
}
for(const [i,table] of ['employees','contractors','workforce','helpers','vendors','workforce_pickers'].entries()) await insert(table,10+i);
await assert.rejects(()=>insert('workforce',30,' SHARED@EXAMPLE.COM ','8888888888'),/Email is already registered in this category/);
await assert.rejects(()=>insert('workforce',31,'another@example.com','98765 43210','+91'),/Mobile number is already registered in this category/);
await insert('workforce',32,'another@example.com','9876543210','971');
await insert('workforce',33,'shared@example.com','9876543210','91',id(99));
await db.exec(`update workforce set full_name='Edited' where id='${id(2)}';update workforce set email=' OLD@example.com ' where id='${id(2)}'`);
await assert.rejects(()=>db.exec(`update workforce set email='shared@example.com' where id='${id(2)}'`),/Email is already registered/);
await db.exec(`update workforce set email='fixed@example.com',mobile='8999999999' where id='${id(2)}'`);
await db.exec(`update workforce set full_name='Other edit' where id='${id(12)}'`);
assert.equal((await db.query(`select count(*)::int n from workforce where email='shared@example.com' and company_id='${company}'`)).rows[0].n,1);
await db.close();
console.log('PASS category contacts: cross-category reuse, same-category blocks, case/phone normalization, company/country isolation, unchanged legacy duplicates, correction and repeat migration.');
