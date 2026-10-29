import test from "node:test";
import assert from "node:assert/strict";
import { visibleDashboardNotices } from "./dashboard-notices.ts";
test("loss notice ends when read or expired, without changing other announcements", () => {
 const notice={id:"1",title:"Loss recovery updated",body:"",created_at:"2026-10-29",event_code:"LOSS_RECOVERY_UPDATED",data:{showOnDashboard:true,dashboardUntil:"2026-11-01T00:00:00Z"}};
 const now=Date.parse("2026-10-29T00:00:00Z");
 assert.equal(visibleDashboardNotices([notice],now).length,1);
 assert.equal(visibleDashboardNotices([{...notice,read_at:"2026-10-29"}],now).length,0);
 assert.equal(visibleDashboardNotices([notice],Date.parse("2026-11-02")).length,0);
 assert.equal(visibleDashboardNotices([{...notice,event_code:"announcement",read_at:"2026-10-29"}],now).length,1);
});
