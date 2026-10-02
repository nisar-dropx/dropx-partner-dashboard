import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPartnerOnboardingStates } from "./partner-onboarding";
import { clientIdPartnerState, type ClientIdPartnerState, type AmazonProfileLink, type AmazonRosterRecord, type AmazonObservation } from "./workforce-client-id-partner-state";

export async function loadClientIdPartnerStates(db: SupabaseClient, companyId: string, workforceIds: string[]) {
  const states = new Map<string, ClientIdPartnerState>();
  // Call only for unmapped, registration-complete workers; avoid loading full
  // partner history for the already-mapped workforce on every navigation.
  for (let offset = 0; offset < workforceIds.length; offset += 100) {
    const ids = workforceIds.slice(offset, offset + 100);
    const [linksResult, observationsResult, flows] = await Promise.all([
      db.from("workforce_amazon_portal_links").select("workforce_id,amazon_provider_id,transporter_id,last_synced_at").eq("company_id", companyId).in("workforce_id", ids),
      db.from("workforce_amazon_observations").select("workforce_id,provider_profile_id,progress,provider_status,observed_at").eq("company_id", companyId).in("workforce_id", ids),
      loadPartnerOnboardingStates(db, companyId, ids),
    ]);
    if (linksResult.error || observationsResult.error) throw new Error("Unable to verify existing Amazon IDs. Please retry before sending an invitation.");
    const links = linksResult.data as AmazonProfileLink[];
    // The roster is shared worker data, so fetch only exact profiles already
    // linked to these company-scoped workforce records. Never match by name.
    const profileIds = [...new Set(links.map(link => link.amazon_provider_id).filter((id): id is string => Boolean(id)))];
    const rosterResult = profileIds.length
      ? await db.from("workforce_associates").select("provider_id,transporter_id,operational_status,synced_at").in("provider_id", profileIds)
      : { data: [] as AmazonRosterRecord[], error: null };
    if (rosterResult.error) throw new Error("Unable to verify the LSC roster. Please retry before sending an invitation.");
    for (const id of ids) {
      const link = links.find(item => item.workforce_id === id);
      const roster = (rosterResult.data as AmazonRosterRecord[]).find(item => item.provider_id === link?.amazon_provider_id && item.transporter_id === link?.transporter_id);
      const observation = (observationsResult.data as AmazonObservation[]).find(item => item.workforce_id === id);
      const state = clientIdPartnerState(link, roster, observation, flows.get(id));
      if (state) states.set(id, state);
    }
  }
  return states;
}
