import test from "node:test";
import assert from "node:assert/strict";
import { activeOpsHref, searchOpsNavigation } from "./design-navigation.ts";

const nav = [
  { code: "home", label: "Command Center", href: "/", icon: "#" },
  { code: "operations", label: "Operations", icon: "O", children: [
    { label: "COD Status", href: "/cod/status" },
    { label: "Store Audits", href: "/store-audits" },
  ] },
  { code: "fleet", label: "Fleet", icon: "F", children: [
    { label: "Vehicles", href: "/fleet?tab=vehicles" },
    { label: "Tracking", href: "/fleet?tab=tracking" },
  ] },
];
test("menu search retains only authorized items and never mutates their routes", () => {
  const before = JSON.stringify(nav);
  assert.deepEqual(searchOpsNavigation(nav, "operations COD")[0].children, [nav[1].children[0]]);
  assert.deepEqual(searchOpsNavigation(nav, "fleet"), [nav[2]]);
  assert.deepEqual(searchOpsNavigation(nav, "user access"), []);
  assert.deepEqual(searchOpsNavigation(nav, "   "), nav);
  assert.equal(JSON.stringify(nav), before);
});
test("active page follows nested routes and query tabs without losing filters", () => {
  assert.equal(activeOpsHref(nav, "/store-audits", "audit=sample", "Operations"), "/store-audits");
  assert.equal(activeOpsHref(nav, "/store-audits/detail", "", ""), "/store-audits");
  assert.equal(activeOpsHref(nav, "/fleet", "tab=tracking&station=sample", "Fleet"), "/fleet?tab=tracking");
  assert.equal(activeOpsHref(nav, "/fleet", "", "Fleet"), "/fleet?tab=vehicles");
  assert.equal(activeOpsHref(nav, "/", "from=2026-10-01", ""), "/");
  assert.equal(activeOpsHref(nav, "/unavailable", "", ""), undefined);
});


test('attendance query selects Shift Attendance on both public and internal command-center routes',()=>{
  const items=[...nav,{code:'ops_rostering',label:'Shift Attendance',href:'/ops-pulse?view=manpower',icon:'S'},{code:'ops_rostering',label:'Rostering',href:'/rostering',icon:'S'}];
  for(const path of ['/','/ops-pulse']){
    assert.equal(activeOpsHref(items,path,'view=manpower&location=store&date=2026-10-20','Shift Attendance'),'/ops-pulse?view=manpower');
    assert.equal(activeOpsHref(items,path,'','Command Center'),'/');
  }
  assert.equal(activeOpsHref(items,'/rostering','','Rostering'),'/rostering');
});
