export type UnplannedPerson = {
  person_id: string; assignment_id: string; worker_type: string; worker_id: string;
  worker_code: string; full_name: string; mobile: string | null; role_name: string | null;
  department_name: string | null; manager_name: string | null; next_manager_name: string | null;
  manager_person_ids: string[]; manager_assignment_id: string | null;
  location_id: string | null; station_code: string | null; station_name: string | null;
  cluster: string | null; region: string | null; attendance_date: string;
  shift_code: string | null; shift_start: string; shift_end: string;
};
export type UnplannedManager = { id: string; name: string; role: string | null; managerPersonIds: string[] };
export type UnplannedWorkspace = {
  date: string; checkedAt: string; graceMinutes: number; enabled: boolean;
  scope: "company" | "location" | "reporting"; viewerPersonId: string | null;
  rows: UnplannedPerson[]; managers: UnplannedManager[];
};
export type UnplannedFilters = { manager: string; location: string; cluster: string; region: string; search: string; direct: boolean };
export const emptyUnplannedFilters: UnplannedFilters = { manager: "", location: "", cluster: "", region: "", search: "", direct: false };
export function unplannedDate(input?: string, now = new Date()) {
  const today = new Date(now.getTime()+330*60000).toISOString().slice(0,10);
  const date = input || new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || date>today) throw Error("Choose a valid attendance date up to today.");
  return date;
}
export function filterUnplannedRows(data: UnplannedWorkspace, filters: UnplannedFilters) {
  if (filters.manager && !data.managers.some(m=>m.id===filters.manager)) throw Error("That manager is outside this view.");
  const search=filters.search.trim().toLowerCase();
  return data.rows.filter(row => (!filters.manager || row.manager_person_ids.includes(filters.manager))
    && (!filters.direct || row.manager_person_ids[0]===(filters.manager || data.viewerPersonId))
    && (!filters.location || row.location_id===filters.location)
    && (!filters.cluster || row.cluster===filters.cluster)
    && (!filters.region || row.region===filters.region)
    && (!search || [row.full_name,row.worker_code,row.mobile,row.station_code,row.role_name,row.manager_name,row.next_manager_name].some(s=>s?.toLowerCase().includes(search))));
}
export function unplannedFilters(params: URLSearchParams): UnplannedFilters {
  for (const key of ["date","manager","location","cluster","region","search","direct"]) if(params.getAll(key).length>1) throw Error("Choose one value per filter.");
  return {manager:params.get("manager")||"",location:params.get("location")||"",cluster:params.get("cluster")||"",region:params.get("region")||"",search:(params.get("search")||"").slice(0,200),direct:params.get("direct")==="1"};
}
export function unplannedQuery(date: string, filters: UnplannedFilters) {
  const params=new URLSearchParams({date});
  for(const [key,value] of Object.entries(filters)) if(value) params.set(key,value===true?"1":String(value));
  return params.toString();
}
