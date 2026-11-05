import { vehicleIsTerminal } from "@/lib/fleet/vehicle-status-policy";
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { hasActiveFleetMembership } from '@/lib/fleet-control';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadCodLocations, todayKolkata } from '@/lib/ops-pulse/cod';
import { readAllRows } from '@/lib/supabase-pagination';
import { isTeamLeadDesignation } from '@/lib/approval-designation-labels';
import type { StationContact, StationContacts } from '@/lib/fleet/station-summary';

export const dynamic = 'force-dynamic';
const clean = (value: unknown) => String(value ?? '').trim();
const coordinate = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

export async function GET() {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  const companyId = requireCompanyId(auth);
  if (!hasPermission(auth, 'fleet_vehicle_view', 'access') || !(auth.isMasterOwner || await hasActiveFleetMembership(companyId, auth.userId))) return Response.json({ error: 'Fleet vehicle access is required.' }, { status: 403 });
  const db = supabaseAdmin;
  if (!db) return Response.json({ error: 'Station contacts are temporarily unavailable.' }, { status: 503 });
  try {
    const scoped = await loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess);
    if (scoped.error) throw new Error(scoped.error);
    const codes = scoped.locations.map(s => s.station_code).filter(Boolean);
    if (!codes.length) return Response.json({ stations: [] });
    const [vehicles, policies] = await Promise.all([readAllRows(db.from('fleet_vehicles').select('station_code,status').eq('company_id', companyId).eq('ownership_type', 'own').in('station_code', codes).order('id')), readAllRows(db.from('fleet_vehicle_status_master').select('status_key,is_operational,is_terminal').eq('company_id', companyId).order('id'))]);
    if (vehicles.error || policies.error) throw new Error(vehicles.error?.message || policies.error?.message);
    const statusPolicies = (policies.data ?? []).map(p => ({ key: p.status_key, isOperational: p.is_operational, isTerminal: p.is_terminal }));
    const ownedCodes = new Set((vehicles.data ?? []).filter(v => !vehicleIsTerminal(v.status, statusPolicies)).map(v => clean(v.station_code).toUpperCase()));
    const locations = scoped.locations.filter(s => ownedCodes.has(clean(s.station_code).toUpperCase()));
    if (!locations.length) return Response.json({ stations: [] });
    const ids = locations.map(s => s.id);
    const day = todayKolkata();
    const [stations, assignments, designations] = await Promise.all([
      readAllRows(db.from('stations').select('id,station_code,station_name,address,address_line1,address_line2,city,state,latitude,longitude').eq('company_id', companyId).in('id', ids).order('id')),
      readAllRows(db.from('hr_work_assignments').select('id,engagement_id,location_id,designation_id,position_title').eq('company_id', companyId).eq('is_primary', true).in('location_id', ids).lte('effective_from', day).or(`effective_to.is.null,effective_to.gte.${day}`).order('effective_from', { ascending: false }).order('id')),
      readAllRows(db.from('designations').select('id,name,code').eq('company_id', companyId).order('id'))
    ]);
    if (stations.error) throw new Error(stations.error.message);
    let contactsError = assignments.error?.message || designations.error?.message;
    const teamByLocation = new Map<string, Map<string, StationContact>>();
    if (!contactsError && assignments.data?.length) {
      const engagementIds = [...new Set(assignments.data.map(a => a.engagement_id))];
      const engagements = await readAllRows(db.from('hr_engagements').select('id,person_id').eq('company_id', companyId).eq('status', 'active').in('id', engagementIds).lte('start_date', day).or(`end_date.is.null,end_date.gte.${day}`).order('id'));
      if (engagements.error) contactsError = engagements.error.message;
      const personIds = [...new Set((engagements.data ?? []).map(e => e.person_id))];
      const people = personIds.length ? await readAllRows(db.from('hr_people').select('id,display_name,primary_mobile').eq('company_id', companyId).eq('status', 'active').in('id', personIds).order('id')) : { data: [], error: null };
      if (people.error) contactsError = people.error.message;
      if (!contactsError) {
        const personById = new Map((people.data ?? []).map(p => [p.id, p]));
        const engagementById = new Map((engagements.data ?? []).map(e => [e.id, e]));
        const designationById = new Map((designations.data ?? []).map(d => [d.id, d]));
        for (const assignment of assignments.data) {
          const engagement = engagementById.get(assignment.engagement_id);
          const person = engagement && personById.get(engagement.person_id);
          if (!person) continue;
          const designation = designationById.get(assignment.designation_id);
          const role = clean(designation?.name || assignment.position_title) || 'Role not recorded';
          const team = teamByLocation.get(assignment.location_id) ?? new Map<string, StationContact>();
          if (!team.has(person.id)) team.set(person.id, { id: person.id, name: clean(person.display_name), phone: clean(person.primary_mobile), role, isTeamLead: isTeamLeadDesignation({ name: role, code: designation?.code ?? null }) });
          teamByLocation.set(assignment.location_id, team);
        }
      }
    }
    const stationById = new Map((stations.data ?? []).map(s => [s.id, s]));
    const result: StationContacts[] = locations.map(location => {
      const station = stationById.get(location.id);
      return { code: clean(location.station_code).toUpperCase(), name: clean(location.station_name), region: clean(location.region), cluster: clean(location.cluster || location.cluster_manager), address: clean(station?.address) || [station?.address_line1, station?.address_line2, station?.city, station?.state].map(clean).filter(Boolean).join(', '), latitude: coordinate(station?.latitude), longitude: coordinate(station?.longitude), team: [...(teamByLocation.get(location.id)?.values() ?? [])].sort((a,b) => Number(b.isTeamLead) - Number(a.isTeamLead) || a.name.localeCompare(b.name)) };
    });
    return Response.json({ stations: result, contactsError: contactsError ? 'People contacts could not be loaded. Refresh to try again.' : null }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Fleet station contacts:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json({ error: 'Unable to load station contacts. Please retry.' }, { status: 500 });
  }
}
