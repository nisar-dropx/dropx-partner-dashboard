import { getAuthorization, hasPermission } from "@/lib/authorization";
import { loadOpsUnplannedLeaves } from "@/lib/ops-pulse/unplanned-leaves-data";
import { filterUnplannedRows, unplannedDate, unplannedFilters } from "@/lib/ops-pulse/unplanned-leaves";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"private, no-store"};
export async function GET(request: Request) {
  const auth=await getAuthorization();
  if(!auth || !hasPermission(auth,"ops_unplanned_leaves","access")) return Response.json({error:"Unplanned Leaves access is required."},{status:403,headers});
  const params=new URL(request.url).searchParams;
  let date: string, filters: ReturnType<typeof unplannedFilters>;
  try {date=unplannedDate(params.get("date")||undefined);filters=unplannedFilters(params);}
  catch {return Response.json({error:"Choose a valid date and filters."},{status:400,headers});}
  try {
    const data=await loadOpsUnplannedLeaves(auth,date);
    if(filters.manager && !data.managers.some(m=>m.id===filters.manager)) return Response.json({error:"That manager is not available in your reporting scope for this date."},{status:403,headers});
    const rows=filterUnplannedRows(data,filters);
    if(params.get("format")==="xlsx") {
      const XLSX=await import("xlsx");
      const sheet=XLSX.utils.json_to_sheet(rows.map(r=>({
        Date:r.attendance_date,Name:r.full_name,"People ID":r.worker_code,Role:r.role_name,Department:r.department_name,
        "Reporting manager":r.manager_name||data.managers.find(m=>m.id===r.manager_person_ids[0])?.name||"",
        "Next-level manager":r.next_manager_name||data.managers.find(m=>m.id===r.manager_person_ids[1])?.name||"",
        Location:r.station_code,"Location name":r.station_name,Cluster:r.cluster||"",Region:r.region,Contact:r.mobile,
        Shift:r.shift_code,"Shift start (IST)":r.shift_start,"Shift end (IST)":r.shift_end,
        "Next-day shift end":r.shift_end<=r.shift_start?"Yes":"No",
        Status:"No punch · confirm","Checked at":data.checkedAt
      })));
      const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,"Unplanned Leaves");
      return new Response(XLSX.write(book,{type:"buffer",bookType:"xlsx"}),{headers:{...headers,"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="unplanned-leaves-${date}.xlsx"`}});
    }
    return Response.json({...data,rows},{headers});
  } catch {return Response.json({error:"Attendance could not be checked. Please retry or ask HR to verify your reporting profile."},{status:503,headers});}
}
