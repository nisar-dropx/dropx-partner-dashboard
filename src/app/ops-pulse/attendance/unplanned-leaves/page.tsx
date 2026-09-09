import { AppShell } from "@/components/app-shell";
import { OpsUnplannedLeaves } from "@/components/ops-unplanned-leaves";
import { requirePagePermission } from "@/lib/authorization";
import { loadOpsUnplannedLeaves } from "@/lib/ops-pulse/unplanned-leaves-data";
import { unplannedFilters } from "@/lib/ops-pulse/unplanned-leaves";
export const dynamic="force-dynamic";
export const maxDuration=60;
export default async function UnplannedLeavesPage({searchParams}: {searchParams?:Record<string,string|string[]|undefined>}) {
  const auth=await requirePagePermission("ops_unplanned_leaves","access");
  const params=new URLSearchParams();
  for(const [key,value] of Object.entries(searchParams??{})) for(const item of Array.isArray(value)?value:value?[value]:[]) params.append(key,item);
  let content;
  try {
    const filters=unplannedFilters(params);
    const data=await loadOpsUnplannedLeaves(auth,filters);
    content=<OpsUnplannedLeaves initial={data} initialFilters={filters}/>;
  } catch(e) {
    content=<section className="panel" style={{padding:24}}><h1>Unplanned Leaves</h1><p role="alert">{e instanceof Error?e.message:"Attendance could not be loaded."}</p><a className="button secondary" href="/attendance/unplanned-leaves">Reset filters</a></section>;
  }
  return <AppShell active="Attendance" pageCode="ops_unplanned_leaves">{content}</AppShell>;
}
