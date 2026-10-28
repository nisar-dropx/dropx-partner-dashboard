import {workforceStationPolicy, type WorkforceStation} from "./workforce-register-policy";

/** Summary covers delivery workforce locations; HO and Amazon Now are separate. */
export function includeMappingSummaryStation(station: WorkforceStation & {is_ho?: boolean | null}) {
  return station.is_ho !== true && !workforceStationPolicy(station).excluded;
}
