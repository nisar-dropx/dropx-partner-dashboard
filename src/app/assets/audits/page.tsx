import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { AuditDesk } from "./audit-desk";
import "../assets.css";
export const dynamic="force-dynamic";
export default async function AssetAuditPage(){const authorization=await requirePagePermission("asset_audits","access");const companyId=requireCompanyId(authorization);if(!supabaseAdmin)throw new Error("Asset audit service is unavailable.");const [locations,sessions]=await Promise.all([loadCodLocations(companyId,authorization.locationScopeIds,authorization.hasAllLocationAccess),supabaseAdmin.from("asset_audit_sessions").select("id,audit_number,title,status,expected_count,scanned_count,damaged_count,created_at,location_id").eq("company_id",companyId).order("created_at",{ascending:false}).limit(30)]);if(sessions.error)throw new Error("Unable to load the asset audit register.");const allowed=(sessions.data??[]).filter((item)=>authorization.hasAllLocationAccess||!item.location_id||authorization.locationScopeIds.includes(item.location_id));return <AppShell active="Asset Audits" pageCode="asset_audits"><div className="asset-control"><PageHead eyebrow="Operations · asset control" title="Asset audit register" subtitle="Select a location, scan the physical label and record condition or damage at the point of verification." /><AuditDesk locations={locations.locations.map((location)=>({id:location.id,label:`${location.station_code} · ${location.station_name||location.city||"Location"}`}))} sessions={allowed} canStart={hasPermission(authorization,"asset_audits","add")} canComplete={hasPermission(authorization,"asset_audits","edit")} /></div></AppShell>}
