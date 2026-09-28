import 'server-only';
import { unstable_noStore as noStore } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolvePeopleReviewRoute, type PeopleReviewGraph, type PeopleReviewRoute } from './people-review-route';

// Paginate every source: a partial People graph must never silently choose a different approver.
export async function allRoutingRows(query: any) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await query.range(offset, offset + 999);
    if (result.error) throw new Error(`People routing is unavailable: ${result.error.message}`);
    rows.push(...(result.data ?? []));
    if ((result.data ?? []).length < 1000) return rows;
  }
}
export async function loadPeopleReviewGraph(companyId: string, db: SupabaseClient = supabaseAdmin!): Promise<PeopleReviewGraph> {
  noStore();
  if (!db) throw new Error('Review routing service is unavailable.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const effective = (q: any) => q.lte('effective_from', today).or(`effective_to.is.null,effective_to.gte.${today}`);
  const [assignments, engagements, people, designations, mappings, relationships, links, profiles, memberships, oversight] = await Promise.all([
    allRoutingRows(effective(db.from('hr_work_assignments').select('id,engagement_id,location_id,designation_id,position_title').eq('company_id', companyId).eq('is_primary', true)).order('id')),
    allRoutingRows(db.from('hr_engagements').select('id,person_id').eq('company_id', companyId).eq('status', 'active').lte('start_date', today).or(`end_date.is.null,end_date.gte.${today}`).order('id')),
    allRoutingRows(db.from('hr_people').select('id,display_name').eq('company_id', companyId).eq('status', 'active').order('id')),
    allRoutingRows(db.from('designations').select('id,code,name').eq('company_id', companyId).eq('is_active', true).order('id')),
    allRoutingRows(db.from('hr_designation_mappings').select('designation_id,can_be_reporting_manager').eq('company_id', companyId).order('designation_id')),
    allRoutingRows(effective(db.from('hr_reporting_relationships').select('id,subject_assignment_id,manager_assignment_id').eq('company_id', companyId).eq('is_primary', true).eq('relationship_type', 'solid_line')).order('id')),
    allRoutingRows(db.from('hr_user_person_links').select('id,person_id,user_id').eq('company_id', companyId).eq('status', 'active').order('id')),
    allRoutingRows(db.from('profiles').select('id').eq('company_id', companyId).eq('is_active', true).order('id')),
    allRoutingRows(db.from('company_product_memberships').select('id,user_id,has_all_location_access,location_scope_ids').eq('company_id', companyId).eq('product_code', 'operations').eq('is_active', true).order('id')),
    allRoutingRows(db.from('ops_performance_review_oversight_roles').select('id,match_text').eq('company_id', companyId).eq('is_active', true).eq('tier', 'full').order('id'))
  ]);
  const engagementById = new Map(engagements.map(r => [r.id, r]));
  const personById = new Map(people.map(r => [r.id, r]));
  const designationById = new Map(designations.map(r => [r.id, r]));
  const managerIds = new Set(mappings.filter(r => r.can_be_reporting_manager).map(r => r.designation_id));
  const activeUsers = new Set(profiles.map(r => r.id));
  const normalized = (value: string) => ` ${value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
  return {
    people: assignments.flatMap(a => {
      const engagement = engagementById.get(a.engagement_id);
      const person = engagement && personById.get(engagement.person_id);
      const designation = designationById.get(a.designation_id);
      if (!person || !designation) return [];
      const personLinks = links.filter(l => l.person_id === person.id && activeUsers.has(l.user_id));
      const access = memberships.filter(m => personLinks.some(l => l.user_id === m.user_id));
      const label = normalized(`${designation.code} ${designation.name}`);
      return [{ id: a.id, personId: person.id, name: person.display_name, designationId: designation.id,
        code: designation.code ?? '', role: designation.name || a.position_title || 'Reporting manager', locationId: a.location_id,
        canManage: managerIds.has(designation.id), oversight: oversight.some(o => o.match_text?.trim() && label.includes(normalized(o.match_text))),
        userIds: [...new Set(personLinks.filter(l => access.some(m => m.user_id === l.user_id)).map(l => String(l.user_id)))],
        scopeIds: [...new Set(access.flatMap(m => (m.location_scope_ids ?? []) as string[]))], allLocations: access.some(m => m.has_all_location_access) }];
    }),
    relationships: relationships.map(r => ({ subjectId: r.subject_assignment_id, managerId: r.manager_assignment_id }))
  };
}
export async function loadPeopleReviewRoute(companyId: string, stationId: string) {
  return resolvePeopleReviewRoute(await loadPeopleReviewGraph(companyId), stationId);
}
export async function syncPeopleReviewRoutes(companyId: string, options: { reviewId?: string; reviewIds?: string[]; stationCodes?: string[]; from?: string; to?: string } = {}, db: SupabaseClient = supabaseAdmin!) {
  noStore();
  if (!db) throw new Error('Review routing service is unavailable.');
  let query = db.from('ops_performance_reviews').select('id,station_id').eq('company_id', companyId)
    .eq('review_type', 'daily_operations').in('status', ['open', 'in_review']).order('id');
  if (options.reviewId) query = query.eq('id', options.reviewId);
  if (options.reviewIds) {
    if (!options.reviewIds.length) return;
    query = query.in("id", options.reviewIds);
  }
  if (options.stationCodes) {
    if (!options.stationCodes.length) return;
    query = query.in('station_code', options.stationCodes);
  }
  if (options.from) query = query.gte('source_date', options.from);
  if (options.to) query = query.lte('source_date', options.to);
  const reviews = await allRoutingRows(query);
  if (!reviews.length) return;
  const graph = await loadPeopleReviewGraph(companyId, db);
  const routes = new Map<string, PeopleReviewRoute>();
  const pending = reviews.map(review => {
    let route = routes.get(review.station_id);
    if (!route) { route = resolvePeopleReviewRoute(graph, review.station_id); routes.set(review.station_id, route); }
    return { reviewId: review.id, chain: route.chain, error: route.error };
  });
  for (let offset = 0; offset < pending.length; offset += 100) {
    const result = await db.rpc('ops_sync_people_review_routes', { p_company: companyId, p_routes: pending.slice(offset, offset + 100) });
    if (result.error) throw new Error(`Review routing could not be refreshed: ${result.error.message}`);
  }
}
